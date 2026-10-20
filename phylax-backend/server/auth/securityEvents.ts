import {randomUUID} from 'node:crypto';
import {execute,query,withTransaction} from '../db.js';
import {sendMail} from '../notifications/mail.js';
import type {Config} from '../config.js';

/** Durable outbox: do not delay authentication responses on provider latency. Transactional notices are not
 * shift-alert subscriptions; use only current verified or explicitly supplied previous verified addresses. */
export async function securityEvent(_config:Config,accountId:string,kind:string,previousEmail?:string|null,client?:import("pg").PoolClient){
 const record=async(c:import("pg").PoolClient)=>{
  const event=(await c.query<{id:string}>('INSERT INTO security_events(account_id,kind) VALUES($1,$2) RETURNING id',[accountId,kind])).rows[0];
  const a=(await c.query<{email:string|null;email_verified:boolean}>('SELECT email,email_verified FROM accounts WHERE id=$1',[accountId])).rows[0];
  for(const to of new Set([previousEmail,...(a?.email_verified?[a.email]:[])].filter((s):s is string=>!!s)))await c.query('INSERT INTO security_notices(event_id,account_id,target_email,kind) VALUES($1,$2,$3,$4)',[event.id,accountId,to,kind]);
 };
 if(client)await record(client);else await withTransaction(record);
}
export async function dispatchSecurityNotices(config:Config,stopping:()=>boolean){
 const token=randomUUID(),start=Date.now();
 await execute('DELETE FROM security_notices WHERE expires_at<=now()');
 const rows=await query<{id:string;event_id:string;account_id:string;target_email:string;kind:string}>(`WITH q AS(SELECT id FROM security_notices WHERE expires_at>now() AND attempts<48
 AND (claimed_at IS NULL OR claimed_at<now()-interval '15 minutes')
 AND (last_attempt_at IS NULL OR last_attempt_at<now()-least(3600,power(2,least(attempts,12))*30)*interval '1 second') ORDER BY created_at LIMIT 20 FOR UPDATE SKIP LOCKED)
 UPDATE security_notices n SET claimed_at=now(),claim_token=$1 FROM q WHERE q.id=n.id RETURNING n.*`,[token]);
 let i=0;
 async function worker(){while(!stopping()&&i<rows.length&&Date.now()-start<15000){const n=rows[i++];
  const result=await sendMail(config,{to:n.target_email,accountId:n.account_id,idempotencyKey:`security-${n.id}`,subject:'Phylax account security change',kind:'transactional',text:`A security change occurred: ${n.kind.replaceAll('_',' ')}. If this was not you, sign in using an email link and review/revoke unfamiliar access. ${config.APP_URL}/account`});
  if(result.ok)await withTransaction(async c=>{await c.query('SELECT id FROM security_events WHERE id=$1 FOR UPDATE',[n.event_id]);await c.query('DELETE FROM security_notices WHERE id=$1 AND claim_token=$2',[n.id,token]);await c.query('UPDATE security_events SET notice_accepted_at=now() WHERE id=$1 AND NOT EXISTS(SELECT 1 FROM security_notices WHERE event_id=$1)',[n.event_id]);});
  else await execute('UPDATE security_notices SET attempts=attempts+1,last_attempt_at=now(),claimed_at=NULL,claim_token=NULL WHERE id=$1 AND claim_token=$2',[n.id,token]);
 }}
 try{await Promise.all([worker(),worker()]);}finally{await execute('UPDATE security_notices SET claimed_at=NULL,claim_token=NULL WHERE claim_token=$1',[token]);}
}
