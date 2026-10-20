import {describe,it,expect} from 'vitest';
import {mkdtempSync,writeFileSync,readFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {randomBytes} from 'node:crypto';
describe('authenticated backup envelope',()=>{
 it('round trips binary data, rejects tampering and a wrong key',()=>{
  const dir=mkdtempSync(join(tmpdir(),'phylax-crypto-'));const key=join(dir,'key'),plain=join(dir,'plain'),encrypted=join(dir,'backup.enc'),restored=join(dir,'restored');
  const cli=fileURLToPath(new URL('../deploy/backup-crypto.mjs',import.meta.url));const data=randomBytes(2*1024*1024);
  const run=(...args:string[])=>spawnSync(process.execPath,[cli,...args],{env:{...process.env,BACKUP_KEY_FILE:key},encoding:'utf8'});
  try{
   writeFileSync(key,randomBytes(32).toString('hex'),{mode:0o600});writeFileSync(plain,data);expect(run('encrypt',plain,encrypted).status).toBe(0);expect(run('verify',encrypted).status).toBe(0);expect(run('decrypt',encrypted,restored).status).toBe(0);expect(readFileSync(restored).equals(data)).toBe(true);
   const original=readFileSync(encrypted),tampered=Buffer.from(original);tampered[50]^=1;writeFileSync(encrypted,tampered);expect(run('verify',encrypted).status).toBe(1);
   writeFileSync(encrypted,original);writeFileSync(key,randomBytes(32).toString('hex'));expect(run('verify',encrypted).status).toBe(1);
  }finally{rmSync(dir,{recursive:true,force:true});}
 });
 it('fails remote retention on per-object AWS errors even when the CLI exits zero',()=>{
  const dir=mkdtempSync(join(tmpdir(),'phylax-retention-'));
  try{
   writeFileSync(join(dir,'aws'),`#!/bin/sh
if [ "$2" = "list-objects-v2" ];then
 echo '{"Contents":[{"Key":"phylax/phylax-20200101T000000Z-1.dump.enc","LastModified":"2020-01-01T00:00:00Z"}]}'
else
 echo '{"Errors":[{"Key":"phylax/phylax-20200101T000000Z-1.dump.enc","Code":"AccessDenied"}]}'
fi
`,{mode:0o755});
   const script=fileURLToPath(new URL('../deploy/remote-retention.mjs',import.meta.url));
   const result=spawnSync(process.execPath,[script],{env:{...process.env,PATH:dir+':'+process.env.PATH,BACKUP_S3_BUCKET:'s3://test',BACKUP_S3_PREFIX:'phylax',BACKUP_REMOTE_DAYS:'30'},encoding:'utf8'});
   expect(result.status).not.toBe(0);expect(result.stderr).toContain('object deletion failures');
  }finally{rmSync(dir,{recursive:true,force:true});}
 });
});
