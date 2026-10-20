#!/usr/bin/env node
import {spawnSync} from 'node:child_process';
const bucket=process.env.BACKUP_S3_BUCKET?.replace(/^s3:\/\//,'').replace(/\/$/,'');
const prefix=process.env.BACKUP_S3_PREFIX;
if(!bucket||bucket.includes('/')||!prefix||prefix.includes('..'))throw Error('use a bucket-only s3://bucket and a dedicated nonempty prefix');
const extra=process.env.BACKUP_S3_ENDPOINT?['--endpoint-url',process.env.BACKUP_S3_ENDPOINT]:[];
function aws(args){const r=spawnSync('aws',[...args,...extra],{encoding:'utf8',maxBuffer:16*1024*1024});if(r.status!==0)throw Error('authenticated remote retention failed');return r.stdout;}
// AWS CLI paginates automatically; do not pass --no-paginate.
const contents=JSON.parse(aws(['s3api','list-objects-v2','--bucket',bucket,'--prefix',prefix+'/'])).Contents??[];
const cutoff=Date.now()-Number(process.env.BACKUP_REMOTE_DAYS??30)*86400000;
const Objects=contents.filter(o=>o.Key.startsWith(prefix+'/')&&/^phylax-\d{8}T\d{6}Z-\d+\.dump\.enc$/.test(o.Key.slice(prefix.length+1))&&Date.parse(o.LastModified)<cutoff).map(o=>({Key:o.Key}));
for(let i=0;i<Objects.length;i+=1000){const result=JSON.parse(aws(['s3api','delete-objects','--bucket',bucket,'--delete',JSON.stringify({Objects:Objects.slice(i,i+1000),Quiet:true})]));if(result.Errors?.length)throw Error("Remote retention reported object deletion failures");}
