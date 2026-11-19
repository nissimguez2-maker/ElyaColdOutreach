import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {openStore,putRecord,getRecord,controls} from '../src/store.mjs';
import {digest,canonical} from '../src/values.mjs';
import {CONTINUATION_ID,validateContinuationManifest} from '../src/acceptance-continuation-contract.mjs';
import {armAcceptance,claimAcceptance,assertAcceptance,cancelAcceptance,closeAcceptance} from '../src/acceptance-authority.mjs';
import {runAcceptanceSequence} from '../src/acceptance-controller.mjs';
import {blockNetwork} from './helpers/network-block.mjs';
const manifest=JSON.parse(readFileSync('work/acceptance-continuation-v1/manifest.json','utf8'));
const oldId='elya-acceptance-manifest-v1',fingerprints=[{path:'src/acceptance-continuation-contract.mjs',sha256:digest(readFileSync('src/acceptance-continuation-contract.mjs'))}];
function fixture(t){
 blockNetwork(t);const db=openStore(':memory:');t.after(()=>db.close());
 putRecord(db,'acceptance_authorization',oldId,{status:'CLOSED',reason:'TELEGRAM_SEGMENT_NOT_PASSED'});
 putRecord(db,'telegram_writing_cursor','primary',{nextOffset:64381646});
 putRecord(db,'acceptance_telegram',oldId,{status:'BLOCKED',finalCursor:64381646,remoteAcknowledgment:{lastApiConfirmedOffset:64381646},cleanup:{confirmed:true}});
 const before={old:getRecord(db,'acceptance_authorization',oldId),controls:controls(db)};
 return {db,before};
}
test('exact reviewed continuation manifest rejects changed scopes and preserves the original write',()=>{
 validateContinuationManifest(manifest);
 const original=JSON.parse(readFileSync('work/acceptance-manifest-v1/manifest.json','utf8'));
 assert.equal(canonical(manifest.instantly.writeArguments),canonical(original.instantly.writeArguments));
 for(const mutate of [m=>m.telegram.maxObservableRequests++,m=>m.telegram.initialLocalOffset++,m=>m.limits.businessDataCallsAcrossBothLaunches++,m=>m.instantly.writeArguments.custom_variables.pilot_subject_1='changed',m=>m.telegram.packetHashes[1]='0'.repeat(64)]){const m=structuredClone(manifest);mutate(m);assert.throws(()=>validateContinuationManifest(m),/MANIFEST_MISMATCH/);}
});
test('fresh one-use continuation starts allowance at claim and never reopens old authorization',t=>{
 const {db,before}=fixture(t);const grant=armAcceptance(db,manifest,fingerprints,1000);
 assert.equal(grant.id,CONTINUATION_ID);assert.equal(grant.historicalPrefixRetirementApproved,false);
 const claimed=claimAcceptance(db,manifest,9000000);assert.equal(Date.parse(claimed.deadlineAt),9480000);
 assertAcceptance(db,manifest,9000001);assert.throws(()=>claimAcceptance(db,manifest,9000002),/ALREADY_USED/);
 closeAcceptance(db,{id:CONTINUATION_ID,status:'BLOCKED',reason:'OFFLINE_FIXTURE'},9000003);
 assert.equal(getRecord(db,'acceptance_authorization',CONTINUATION_ID).status,'CLOSED');
 assert.throws(()=>armAcceptance(db,manifest,fingerprints),/ALREADY_EXISTS/);
 assert.deepEqual(getRecord(db,'acceptance_authorization',oldId),before.old);assert.deepEqual(controls(db),before.controls);
});
test('continuation requires preserved closed history and actual final cursor',t=>{
 for(const change of [db=>putRecord(db,'telegram_writing_cursor','primary',{nextOffset:64381642}),db=>putRecord(db,'acceptance_authorization',oldId,{status:'CLAIMED'}),db=>putRecord(db,'acceptance_telegram',oldId,{finalCursor:64381646,cleanup:{confirmed:false}})]){
  const {db}=fixture(t);change(db);assert.throws(()=>armAcceptance(db,manifest,fingerprints),/CONTINUATION_PRIOR_STATE/);
  assert.equal(getRecord(db,'acceptance_authorization',CONTINUATION_ID),null);
 }
});
test('cancellation and protected-state changes block new dispatch without preventing fresh-grant closure',t=>{
 const {db,before}=fixture(t);armAcceptance(db,manifest,fingerprints,1000);claimAcceptance(db,manifest,2000);
 cancelAcceptance(db,2100,CONTINUATION_ID);assert.throws(()=>assertAcceptance(db,manifest,2200),/CANCELLED/);
 closeAcceptance(db,{id:CONTINUATION_ID,status:'BLOCKED',reason:'CANCELLED'},2300);
 assert.deepEqual(getRecord(db,'acceptance_authorization',oldId),before.old);
});
test('a blocked normal-user preclaim closes only the new unstarted grant and cannot be replayed',t=>{
 const {db,before}=fixture(t);armAcceptance(db,manifest,fingerprints,1000);
 putRecord(db,'acceptance_authorization',oldId,{...before.old,unexpectedChange:true});
 assert.throws(()=>claimAcceptance(db,manifest,2000),/PROTECTED_STATE_CHANGED/);
 closeAcceptance(db,{id:CONTINUATION_ID,status:'BLOCKED',reason:'ACCEPTANCE_PROTECTED_STATE_CHANGED',notLaunched:true,liveCalls:0},2100);
 assert.equal(getRecord(db,'acceptance_authorization',CONTINUATION_ID).status,'CLOSED');
 assert.throws(()=>claimAcceptance(db,manifest,2200),/ALREADY_USED/);
});
test('manifest-read failures have an open authority store and close the fresh grant without dispatch',t=>{
 // The actual CLI must establish db before the fallible read; the fixture then
 // exercises its existing closure branch for each distinct read/parse/contract error.
 const cli=readFileSync('src/acceptance-continuation-cli.mjs','utf8');
 assert.ok(cli.indexOf('db=new DatabaseSync(dbPath)')<cli.indexOf('const manifest=validateContinuationManifest'));
 assert.ok(cli.indexOf("?.status!=='APPROVED'")<cli.indexOf('const manifest=validateContinuationManifest'));
 for(const read of [()=>{throw Error('ENOENT');},()=>JSON.parse('{'),()=>validateContinuationManifest({...manifest,changed:true})]){
  const {db,before}=fixture(t);armAcceptance(db,manifest,fingerprints,1000);
  try{read();assert.fail('fixture must reject');}catch{closeAcceptance(db,{id:CONTINUATION_ID,status:'BLOCKED',reason:'LOCAL_PREFLIGHT_FAILED',notLaunched:true,liveCalls:0},2000);}
  assert.equal(getRecord(db,'acceptance_authorization',CONTINUATION_ID).status,'CLOSED');assert.throws(()=>claimAcceptance(db,manifest,2100),/ALREADY_USED/);
  assert.deepEqual(getRecord(db,'acceptance_authorization',oldId),before.old);
 }
});
test('continuation controller requires BOTH exact Telegram outcomes plus cleanup before either provider phase',async t=>{
 for(const mode of ['pass','missing-stale','missing-changes','cleanup','uncertain']){
  const {db,before}=fixture(t);armAcceptance(db,manifest,fingerprints,1000);let calls=[];
  const telegram={status:mode==='uncertain'?'UNCERTAIN':'PASSED',scenarios:{staleVersion:{status:mode==='missing-stale'?'PENDING':'PASS'},requestChanges:{status:mode==='missing-changes'?'PENDING':'PASS'}},cleanup:{confirmed:mode!=='cleanup'}};
  const result=await runAcceptanceSequence({db,manifest,root:process.cwd(),now:()=>2000,telegram:async()=>telegram,instantly:async({phase})=>{calls.push(phase);return {status:'PASSED',cleanup:{confirmed:true}};}});
  assert.equal(result.id,CONTINUATION_ID);assert.equal(result.status,mode==='pass'?'PASS':'BLOCKED');assert.deepEqual(calls,mode==='pass'?[1,2]:[]);
  assert.equal(getRecord(db,'acceptance_authorization',CONTINUATION_ID).status,'CLOSED');assert.deepEqual(getRecord(db,'acceptance_authorization',oldId),before.old);
 }
});
