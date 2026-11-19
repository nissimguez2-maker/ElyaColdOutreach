import test from 'node:test';import assert from 'node:assert/strict';
import {mkdtempSync,readdirSync,readFileSync,writeFileSync,mkdirSync} from 'node:fs';import {join} from 'node:path';import {tmpdir} from 'node:os';
import * as entry from '../src/instantly-qa-v2-entry.mjs';import {blockNetwork} from './helpers/network-block.mjs';
import {DatabaseSync} from 'node:sqlite';
test('pre-database CLI refusals have separate sanitized evidence without any database or authority',t=>{
 const network=blockNetwork(t),root=mkdtempSync(join(tmpdir(),'elya-v2-open-'));
 assert.equal(typeof entry.recordInstantlyQaOpenRefusal,'function');
 const first=entry.recordInstantlyQaOpenRefusal({root,error:Error('EXISTING_DATABASE_REQUIRED'),startedAtMs:1000,now:()=>1001});
 const second=entry.recordInstantlyQaOpenRefusal({root,error:Error('Bearer DO_NOT_LOG_PRIVATE_VALUE'),startedAtMs:1002,now:()=>1003});
 assert.notEqual(first.attemptId,second.attemptId);assert.equal(first.firstFailingStage,'LOCAL_CLI_OPEN');assert.equal(first.attemptExternalActivity,'NOT_STARTED');assert.equal(first.authorizationStatus,'NOT_READ');assert.equal(second.reason,'LOCAL_EXECUTION_ERROR_REQUIRES_SAVED_EVIDENCE');
 const dir=join(root,'work/instantly-qa-acceptance-v2/attempts'),files=readdirSync(dir);assert.equal(files.length,2);assert.ok(files.every(f=>!readFileSync(join(dir,f),'utf8').includes('DO_NOT_LOG_PRIVATE_VALUE')));assert.equal(network.attempts,0);
});
for(const mode of ['missing table','invalid grant JSON'])test(`opened database ${mode} fails before command admission and can record refusal`,async t=>{
 blockNetwork(t);const root=mkdtempSync(join(tmpdir(),'elya-v2-open-')),db=new DatabaseSync(':memory:');t.after(()=>db.close());
 // An invalid/non-project database, not a bypass of the real schema constraints.
 if(mode==='invalid grant JSON'){db.exec('CREATE TABLE records(kind TEXT,id TEXT,data_json TEXT)');db.prepare('INSERT INTO records VALUES(?,?,?)').run('acceptance_authorization','elya-instantly-qa-acceptance-v2','{');}
 let admitted=false,refusal;
 try{await entry.runInstantlyQaV2Entry({db,root,runtime:{},now:()=>1001,startedAtMs:1000,onInvocation:()=>{admitted=true;}});assert.fail('invalid database must refuse');}
 catch(error){assert.equal(admitted,false);refusal=entry.recordInstantlyQaOpenRefusal({root,error,startedAtMs:1000,now:()=>1001});}
 assert.equal(refusal.attemptExternalActivity,'NOT_STARTED');assert.equal(refusal.authorizationStatus,'NOT_READ');assert.equal(readdirSync(join(root,'work/instantly-qa-acceptance-v2/attempts')).length,1);
});
test('pre-database refusal reports unavailable evidence without claiming a durable log',t=>{
 blockNetwork(t);const root=mkdtempSync(join(tmpdir(),'elya-v2-open-')),dir=join(root,'work/instantly-qa-acceptance-v2');mkdirSync(dir,{recursive:true});writeFileSync(join(dir,'attempts'),'blocked');
 const result=entry.recordInstantlyQaOpenRefusal({root,error:Error('EXISTING_DATABASE_REQUIRED'),startedAtMs:1000,now:()=>1001});assert.equal(result.attemptEvidenceError,'INSTANTLY_QA_ATTEMPT_EVIDENCE_PERSISTENCE_FAILED');assert.equal(result.exitCode,2);
});
