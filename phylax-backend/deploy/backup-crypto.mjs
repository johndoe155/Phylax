#!/usr/bin/env node
import {createCipheriv,createDecipheriv,randomBytes} from 'node:crypto';
import {readFileSync,createReadStream,createWriteStream,statSync,openSync,readSync,closeSync} from 'node:fs';
import {pipeline} from 'node:stream/promises';
import {Writable} from 'node:stream';
const [mode,source,destination]=process.argv.slice(2);
try {
 const key=Buffer.from(readFileSync(process.env.BACKUP_KEY_FILE,'utf8').trim(),'hex');
 if(key.length!==32)throw Error('key must be 32 random bytes encoded as 64 hexadecimal characters');
 if(mode==='encrypt'){
  const nonce=randomBytes(12),cipher=createCipheriv('aes-256-gcm',key,nonce),out=createWriteStream(destination,{mode:0o600,flags:'wx'});
  out.write(Buffer.concat([Buffer.from('PHYLBK1\n'),nonce]));
  cipher.setAAD(Buffer.from('PHYLBK1\n'));
  await pipeline(createReadStream(source),cipher,out,{end:false});out.end(cipher.getAuthTag());
  await new Promise((resolve,reject)=>{out.on('finish',resolve);out.on('error',reject);});
 } else if(mode==='decrypt'||mode==='verify'){
  const size=statSync(source).size;if(size<36)throw Error('truncated backup');
  const fd=openSync(source,'r'),header=Buffer.alloc(20),tag=Buffer.alloc(16);readSync(fd,header,0,20,0);readSync(fd,tag,0,16,size-16);closeSync(fd);
  if(header.subarray(0,8).toString()!=='PHYLBK1\n')throw Error('unknown backup format');
  const decipher=createDecipheriv('aes-256-gcm',key,header.subarray(8));decipher.setAAD(header.subarray(0,8));decipher.setAuthTag(tag);
  const out=mode==='verify'?new Writable({write(_chunk,_enc,cb){cb();}}):createWriteStream(destination,{mode:0o600,flags:'wx'});
  await pipeline(createReadStream(source,{start:20,end:size-17}),decipher,out);
 }else throw Error('usage: backup-crypto.mjs encrypt|decrypt|verify source [destination]');
}catch(e){console.error('Backup encryption/authentication failed:',e.message);process.exitCode=1;}
