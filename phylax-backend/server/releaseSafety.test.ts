import {beforeAll,afterAll,beforeEach,describe,it,expect,vi} from 'vitest';
import {securityEvent,dispatchSecurityNotices} from './auth/securityEvents.js';
import {assertWindowCapacity} from './routes/shifts.js';
import {COOKIE_NAME} from './auth/sessions.js';
import {createHash,createHmac} from 'node:crypto';
import type {Server} from 'node:http';
import type {Response} from 'express';
import {setupDatabase,teardownDatabase,truncateAll,TEST_DATABASE_URL,makeAccount,makeShift,dayFromNow} from './test-helpers.js';
import {queryOne,execute,migrate,databaseReceiptHash} from './db.js';
import {createScheduler,MAX_ATTEMPTS,humanDuration} from './scheduler.js';
import {createApp} from './app.js';
import {sendMail} from './notifications/mail.js';
import {sendSms} from './notifications/sms.js';
import {budget} from './notifications/control.js';
import {createSession,resolveSession,destroyAllSessions} from './auth/sessions.js';
import {signCsrfToken} from './csrf.js';
import {hashToken} from './auth/tokens.js';
import {validSvix,validTwilio,reconcileDeliveryEvents} from './routes/webhooks.js';
import type {Config} from './config.js';

it('authenticates raw Resend payloads, timestamp and rotating signatures',()=>{
 const secret='whsec_'+Buffer.from('a-secret-key').toString('base64'),raw=Buffer.from('{"test":1}'),ts=String(Math.floor(Date.now()/1000));
 const sig=createHmac('sha256',Buffer.from('a-secret-key')).update(`evt.${ts}.`).update(raw).digest('base64');
 expect(validSvix(secret,'evt',ts,`v1,wrong v1,${sig}`,raw)).toBe(true);
 expect(validSvix(secret,'evt',ts,`v1,${sig}`,Buffer.from('{}'))).toBe(false);
 expect(validSvix(secret,'evt','1',`v1,${sig}`,raw)).toBe(false);
});
it('checks Twilio signature against the exact public URL and sorted form fields',()=>{
 const params={MessageSid:'SM123',MessageStatus:'delivered'},url='https://phylax.test/api/webhooks/twilio';
 const sig=createHmac('sha1','secret').update(url+'MessageSidSM123MessageStatusdelivered').digest('base64');
 expect(validTwilio('secret',url,params,sig)).toBe(true);expect(validTwilio('secret',url+'?spoof',params,sig)).toBe(false);
});
it('never rounds a closed cutoff into a fictitious minute of remaining time',()=>{
 expect(humanDuration(0)).toBe('now');expect(humanDuration(-5)).toBe('now');expect(humanDuration(119)).toBe('1 hours 59 minutes');
});

describe.skipIf(!TEST_DATABASE_URL)('release safety with real PostgreSQL',()=>{
 let config:Config,server:Server,base:string;
 const secret='whsec_'+Buffer.from('local-webhook-secret').toString('base64');
 beforeAll(async()=>{config={...(await setupDatabase())!,MAIL_PROVIDER:'resend',RESEND_API_KEY:'test',RESEND_WEBHOOK_SECRET:secret,SMS_PROVIDER:'disabled',OPS_TOKEN:'operator-token'};server=createApp({config}).listen(0,'127.0.0.1');await new Promise<void>(r=>server.on('listening',r));base=`http://127.0.0.1:${(server.address() as {port:number}).port}`;});
 afterAll(async()=>{if(server)await new Promise<void>(r=>server.close(()=>r()));await teardownDatabase();});
 beforeEach(async()=>{vi.restoreAllMocks();vi.unstubAllGlobals();await truncateAll();await execute('TRUNCATE rate_buckets,notification_deliveries,delivery_events,delivery_suppressions');await execute('UPDATE scheduler_state SET scan_cursor=NULL,completed_at=NULL,error_code=NULL');});
 async function callback(id:string,type:string,providerId:string){const body=JSON.stringify({type,data:{email_id:providerId}}),ts=String(Math.floor(Date.now()/1000));const signature=createHmac('sha256',Buffer.from('local-webhook-secret')).update(`${id}.${ts}.${body}`).digest('base64');return fetch(base+'/api/webhooks/resend',{method:'POST',headers:{'Content-Type':'application/json','svix-id':id,'svix-timestamp':ts,'svix-signature':'v1,'+signature},body});}
 it('stores only a session digest and keeps the current device on global revocation',async()=>{
  const a=await makeAccount({});let raw='';const response={cookie(_name:string,value:string){raw=value;}};
  await createSession(response as unknown as Response,a.id,{secure:false,sameSite:'lax',ttlMs:3600000});
  expect((await queryOne<{id:string}>('SELECT id FROM sessions'))!.id).toBe(hashToken(raw));expect((await resolveSession(raw))?.account.id).toBe(a.id);expect(await resolveSession(hashToken(raw))).toBeNull();
  expect(await destroyAllSessions(a.id,raw)).toBe(0);
 });
 it('enforces durable budgets atomically under concurrent workers',async()=>{
  const results=await Promise.all(Array.from({length:30},()=>budget('a-shared-target',5,3600)));expect(results.filter(Boolean)).toHaveLength(5);
 });
 it('rejects unauthenticated callbacks without creating events',async()=>{
  expect((await fetch(base+'/api/webhooks/resend',{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'})).status).toBe(401);
  expect((await queryOne<{n:number}>('SELECT count(*)::int n FROM delivery_events'))!.n).toBe(0);
 });
 it('handles early, duplicate and out-of-order delivered/bounce callbacks; suppresses bounced targets',async()=>{
  const a=await makeAccount({});expect((await callback('early','email.delivered','mail-1')).status).toBe(204);
  const realFetch=globalThis.fetch;vi.stubGlobal('fetch',vi.fn(async()=>new Response(JSON.stringify({id:'mail-1'}),{status:200})));
  expect((await sendMail(config,{to:a.email,subject:'Test',text:'No secret',accountId:a.id})).ok).toBe(true);vi.stubGlobal('fetch',realFetch);
  await reconcileDeliveryEvents();expect((await queryOne<{status:string}>('SELECT status FROM notification_deliveries'))!.status).toBe('delivered');
  expect((await callback('bounce','email.bounced','mail-1')).status).toBe(204);expect((await callback('bounce','email.bounced','mail-1')).status).toBe(204);await callback('late-delivery','email.delivered','mail-1');
  expect((await queryOne<{status:string}>('SELECT status FROM notification_deliveries'))!.status).toBe('bounced');
  // The reason is specific now: `recipient_suppressed_<why>`, so "why did my alerts stop?" is answerable from
   // the reminder's error column and the log without reading the database.
   expect((await sendMail(config,{to:a.email,subject:'Again',text:'must not send'})).error).toBe('recipient_suppressed_bounced');
 });
 it('does not expose provider response bodies or allow unauthenticated SMS relay requests',async()=>{
  const a=await makeAccount({});const spy=vi.fn(async()=>new Response('private recipient / credential detail',{status:400}));vi.stubGlobal('fetch',spy);
  expect((await sendMail(config,{to:a.email,subject:'Test',text:'x'})).error).toBe('provider_http_400');
  await sendSms({...config,SMS_PROVIDER:'webhook',SMS_WEBHOOK_URL:'https://relay.test',SMS_WEBHOOK_TOKEN:'relay-secret'}, {to:'+2348012345678',body:'test'});
  expect(spy.mock.calls.length).toBe(2);
  const options=(spy.mock.calls as unknown as [string,RequestInit][])[1][1];expect((options.headers as Record<string,string>).Authorization).toBe('Bearer relay-secret');
 });
 it('retries beyond the old four-attempt budget and expires obsolete work',async()=>{
  const a=await makeAccount({});await makeShift(a.id,{date:dayFromNow(1),start:480,end:900});await makeShift(a.id,{date:dayFromNow(1),start:500,end:920,facility:'Other'});
  const s=createScheduler({...config,MAIL_PROVIDER:'disabled'});try{
   await s.runOnce();await execute("UPDATE reminders SET attempts=4,last_attempt_at=now()-interval '2 hours' WHERE kind='overlap'");await s.runOnce();
   expect((await queryOne<{attempts:number}>("SELECT attempts FROM reminders WHERE kind='overlap'"))!.attempts).toBe(5);
   await execute("UPDATE reminders SET attempts=$1 WHERE kind='overlap'",[MAX_ATTEMPTS]);await s.runOnce();expect((await queryOne<{status:string}>("SELECT status FROM reminders WHERE kind='overlap'"))!.status).toBe('dead');
   const r=(await queryOne<{id:string}>("SELECT id FROM reminders WHERE kind='overlap'"))!;
   expect((await fetch(base+`/api/ops/reminders/${r.id}/replay`,{method:'POST',headers:{'X-Ops-Token':'operator-token'}})).status).toBe(200);
   await execute("UPDATE reminders SET expires_at=now()-interval '1 second'");await s.runOnce();expect((await queryOne<{status:string}>("SELECT status FROM reminders WHERE kind='overlap'"))!.status).toBe('expired');
  }finally{await s.stop();}
 });
 it('processes more than ten accounts per tick and records heartbeat',async()=>{
  for(let i=0;i<32;i++){const a=await makeAccount({});await makeShift(a.id,{date:dayFromNow(1),start:480,end:900});await makeShift(a.id,{date:dayFromNow(1),start:500,end:920,facility:'Other'});}
  const s=createScheduler({...config,MAIL_PROVIDER:'log'});const start=Date.now();try{const stats=await s.runOnce();expect(stats.sent).toBe(32);expect(Date.now()-start).toBeLessThan(10000);expect((await queryOne<{completed_at:Date|null}>('SELECT completed_at FROM scheduler_state'))!.completed_at).not.toBeNull();}finally{await s.stop();}
 });
 it('detects modified applied migrations without applying any changes',async()=>{
  await execute("UPDATE schema_migrations SET checksum='tampered' WHERE version='010_release_safety'");try{await expect(migrate()).rejects.toThrow('checksum mismatch');}finally{await execute("UPDATE schema_migrations SET checksum=NULL WHERE version='010_release_safety'");await migrate();}
 });

 it('persists verified security notice destinations, retries failure, claims concurrently and expires safely',async()=>{
  const a=await makeAccount({});await securityEvent(config,a.id,'password_changed','previous@phylax.test');
  expect((await queryOne<{n:number}>('SELECT count(*)::int n FROM security_notices'))!.n).toBe(2);
  vi.stubGlobal('fetch',vi.fn(async()=>new Response('{}',{status:503})));
  await dispatchSecurityNotices(config,()=>false);
  expect((await queryOne<{n:number}>('SELECT count(*)::int n FROM security_notices WHERE attempts=1 AND claimed_at IS NULL'))!.n).toBe(2);
  await execute("UPDATE security_notices SET last_attempt_at=now()-interval '2 hours'");
  const send=vi.fn(async()=>new Response(JSON.stringify({id:crypto.randomUUID()}),{status:200}));vi.stubGlobal('fetch',send);
  await Promise.all([dispatchSecurityNotices(config,()=>false),dispatchSecurityNotices(config,()=>false)]);
  expect(send).toHaveBeenCalledTimes(2);expect((await queryOne<{n:number}>('SELECT count(*)::int n FROM security_notices'))!.n).toBe(0);
  expect((await queryOne('SELECT notice_accepted_at FROM security_events WHERE notice_accepted_at IS NOT NULL'))).toBeTruthy();
  await execute('UPDATE accounts SET email_verified=false WHERE id=$1',[a.id]);await securityEvent(config,a.id,'test_unverified');
  expect((await queryOne<{n:number}>('SELECT count(*)::int n FROM security_notices'))!.n).toBe(0);
  await securityEvent(config,a.id,'expired','old@phylax.test');await execute("UPDATE security_notices SET expires_at=now()-interval '1 second'");await dispatchSecurityNotices(config,()=>false);expect(send).toHaveBeenCalledTimes(2);
 });
 it('bounds a 500-shift dense schedule to account digests, not 124750 pair notifications',async()=>{
  const a=await makeAccount({emailEnabled:true});
  await execute(`INSERT INTO shifts(account_id,platform,facility,label,start_minute,end_minute,date) SELECT $1,'Test','Facility '||g,'Dense',480,960,current_date+1 FROM generate_series(1,500) g`,[a.id]);
  vi.stubGlobal('fetch',vi.fn(async()=>new Response(JSON.stringify({id:crypto.randomUUID()}),{status:200})));
  const scheduler=createScheduler(config),start=performance.now();const result=await scheduler.runOnce();await scheduler.stop();
  expect(result.ticked).toBe(true);expect(result.conflicts).toBe(1);expect(scheduler.health().lastError).toBeNull();
  expect((await queryOne<{n:number}>('SELECT count(*)::int n FROM reminders WHERE account_id=$1',[a.id]))!.n).toBeLessThanOrEqual(2);
  // A local timing note for the dense-schedule guard, not a claim about production hardware.
  // eslint-disable-next-line no-console
  console.log('DENSE_500_LOCAL_MS',Math.round(performance.now()-start));
 });
 it('charges budgets by SMS segments rather than treating long messages as one unit',async()=>{
  expect(await budget('segments',5,3600,3)).toBe(true);expect(await budget('segments',5,3600,3)).toBe(false);expect(await budget('segments',5,3600,2)).toBe(true);expect(await budget('segments',5,3600,1)).toBe(false);
 });

 it('enforces a rolling window even when existing shifts lie outside the naive +/-14 days',async()=>{
  const a=await makeAccount({});await execute(`INSERT INTO shifts(account_id,platform,facility,label,start_minute,end_minute,date) SELECT $1,'Test','Facility','Day',480,960,current_date FROM generate_series(1,500)`,[a.id]);
  await expect(assertWindowCapacity(a.id,dayFromNow(20))).rejects.toMatchObject({code:'window_capacity'});
  await expect(assertWindowCapacity(a.id,dayFromNow(29))).resolves.toBeUndefined();
 });
 it('replays import and atomic shift+tile requests successfully at capacity without duplicates',async()=>{
  const a=await makeAccount({});let raw='';await createSession({cookie(_n:string,v:string){raw=v;}} as unknown as Response,a.id,{secure:false,sameSite:'lax',ttlMs:3600000});
  // Signed with the test config's secret: csrfMiddleware refuses to ADOPT an unsigned cookie, because an
  // unsigned one is exactly what a sibling subdomain can plant (see csrf.ts).
  const csrf=signCsrfToken('0123456789012345678901234567890123456789012345678901234567890123',config.SESSION_SECRET);
  const headers={'Content-Type':'application/json','Cookie':`${COOKIE_NAME}=${raw}; phylax_csrf=${csrf}`,'X-CSRF-Token':csrf};
  async function post(path:string,body:unknown){for(let i=0;i<5;i++){const r=await fetch(base+path,{method:'POST',headers,body:JSON.stringify(body)});if(r.status!==409)return r;await new Promise(r=>setTimeout(r,5));}throw Error('guard did not release');}
  await execute(`INSERT INTO shifts(account_id,platform,facility,label,start_minute,end_minute,date) SELECT $1,'Test','Facility','Day',480,960,current_date+3 FROM generate_series(1,499)`,[a.id]);
  const row={platform:'Test',facility:'Imported',label:'Day',date:dayFromNow(3),start:480,end:960};const body={requestId:crypto.randomUUID(),shifts:[row]};
  expect((await post('/api/shifts/import',body)).status).toBe(201);expect((await post('/api/shifts/import',body)).status).toBe(201);
  await execute(`INSERT INTO patterns(account_id,facility,label,start_minute,end_minute) SELECT $1,'Tile','Day',480,960 FROM generate_series(1,199)`,[a.id]);
  const atomic={...row,id:crypto.randomUUID(),date:dayFromNow(40),pattern:{id:crypto.randomUUID(),facility:'Saved',label:'Day',start:480,end:960}};
  expect((await post('/api/shifts',atomic)).status).toBe(201);expect((await post('/api/shifts',atomic)).status).toBe(201);
  expect((await queryOne<{n:number}>('SELECT count(*)::int n FROM shifts WHERE account_id=$1',[a.id]))!.n).toBe(501);
  expect((await queryOne<{n:number}>('SELECT count(*)::int n FROM patterns WHERE account_id=$1',[a.id]))!.n).toBe(200);
 });

 it('starts a new passkey signup explicitly without creating an account before credential proof',async()=>{
  const csrf=signCsrfToken('abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789',config.SESSION_SECRET);
  const headers={'Content-Type':'application/json','Cookie':`phylax_csrf=${csrf}`,'X-CSRF-Token':csrf};
  const start=await fetch(base+'/api/auth/passkey/register/start',{method:'POST',headers,body:'{}'});expect(start.status).toBe(200);expect(await start.json()).toEqual({status:'needs-account',pending:{method:'passkey'}});
  const pending=start.headers.getSetCookie().find(c=>c.startsWith('phylax_pending='))!.split(';')[0];
  const options=await fetch(base+'/api/auth/passkey/register/options',{method:'POST',headers:{...headers,Cookie:headers.Cookie+'; '+pending},body:'{}'});
  expect(options.status).toBe(200);expect((await options.json()).challenge).toBeTruthy();
  expect((await queryOne<{n:number}>('SELECT count(*)::int n FROM accounts'))!.n).toBe(0);
  const invalid=await fetch(base+'/api/account',{method:'POST',headers:{...headers,Cookie:headers.Cookie+'; '+pending},body:JSON.stringify({displayName:'Test Owner',consent:{termsVersion:'2026-10-17.2',privacyVersion:'2026-10-17.2',acceptedAt:new Date().toISOString()}})});
  expect(invalid.status).toBe(400);expect((await invalid.json()).error.code).toBe('passkey_required');
 });
});

// The backup receipt is the gate on a production migration: the application refuses to run one without a receipt
// whose databaseHash it recognises. Four tools write or read that hash, and a disagreement between any two of them
// shows up on a real host as "tampered receipt" with nothing tampered with — so they are pinned together here,
// against the one shared implementation in deploy/db-hash.mjs.
describe('the backup receipt hash is one derivation, not four',()=>{
  const url='postgresql://phylax:hunter2@127.0.0.1:5432/phylax';
  const reference=(key:string)=>{
    const h=createHash('sha256');
    if(key)h.update(`phylax-db-hash-v1:${key}:`);
    return h.update(url).digest('hex');
  };
  for(const key of ['','a-different-key']){
    it(`agrees for ${key?`a keyed`:'an unkeyed'} receipt`,async()=>{
      const {databaseHash}=await import('../deploy/db-hash.mjs') as {databaseHash:(u:string)=>string};
      process.env.DATABASE_HASH_KEY=key;
      expect(databaseHash(url)).toBe(reference(key));
      expect(databaseReceiptHash(url)).toBe(reference(key));
      delete process.env.DATABASE_HASH_KEY;
    });
  }
  it('is not the bare digest once a key is set',async()=>{
    const {databaseHash}=await import('../deploy/db-hash.mjs') as {databaseHash:(u:string)=>string};
    process.env.DATABASE_HASH_KEY='a-different-key';
    expect(databaseHash(url)).not.toBe(reference(''));
    delete process.env.DATABASE_HASH_KEY;
  });
});
