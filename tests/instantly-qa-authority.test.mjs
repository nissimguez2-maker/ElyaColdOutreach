import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {openStore,putRecord,getRecord,controls,transaction} from '../src/store.mjs';
import {digest,canonical} from '../src/values.mjs';
import {INSTANTLY_QA_ID,validateInstantlyQaManifest} from '../src/instantly-qa-contract.mjs';
import {armAcceptance,claimAcceptance,assertAcceptance,cancelAcceptance,closeAcceptance} from '../src/acceptance-authority.mjs';
import {runAcceptanceSequence} from '../src/acceptance-controller.mjs';
import {blockNetwork} from './helpers/network-block.mjs';

const manifest=JSON.parse(readFileSync('work/instantly-qa-acceptance-v1/manifest.json','utf8'));
const priorId='elya-acceptance-continuation-v1';
const fingerprints=[{path:'src/instantly-qa-contract.mjs',sha256:digest(readFileSync('src/instantly-qa-contract.mjs'))}];
function fixture(t){
 blockNetwork(t);const db=openStore(':memory:');t.after(()=>db.close());
 putRecord(db,'acceptance_authorization',priorId,{status:'CLOSED'});
 putRecord(db,'acceptance_result',priorId,{authorizationStatus:'CLOSED',telegram:{status:'PASSED',cleanup:{confirmed:true},scenarios:{staleVersion:{status:'PASS'},requestChanges:{status:'PASS'}}}});
 putRecord(db,'telegram_writing_cursor','primary',{nextOffset:64381648});
 putRecord(db,'telegram_consumer_owner','primary',{status:'RELEASED'});
 return db;
}

test('Instantly-only manifest binds exact seven calls, values, pins and time limits',()=>{
 validateInstantlyQaManifest(manifest);
 const old=JSON.parse(readFileSync('work/acceptance-continuation-v1/manifest.json','utf8'));
 assert.equal(canonical(manifest.instantly.writeArguments),canonical(old.instantly.writeArguments));
 for(const mutate of [m=>m.id+='-again',m=>m.calls.reverse(),m=>m.instantly.leadId='other',m=>m.instantly.writeArguments.custom_variables.pilot_body_1+='changed',m=>m.limits.sessionTotalMs++,m=>m.contracts.approvedContracts.pop(),m=>m.limits.telegramRequests=1]){
  const copy=structuredClone(manifest);mutate(copy);assert.throws(()=>validateInstantlyQaManifest(copy),/MANIFEST_MISMATCH/);
 }
});

test('Instantly-only grant starts 150-second allowance at claim and cannot reopen',t=>{
 const db=fixture(t),before=controls(db);const grant=armAcceptance(db,manifest,fingerprints,1000);
 assert.equal(grant.startedAt,null);assert.equal(grant.deadlineAt,null);assert.equal(grant.historicalPrefixRetirementApproved,false);
 const active=claimAcceptance(db,manifest,9000000);assert.equal(Date.parse(active.deadlineAt),9150000);
 assertAcceptance(db,manifest,9149999);assert.throws(()=>assertAcceptance(db,manifest,9150000),/DEADLINE/);
 assert.throws(()=>claimAcceptance(db,manifest,9000001),/AUTHORIZATION_CLAIMED/);
 closeAcceptance(db,{id:INSTANTLY_QA_ID,status:'BLOCKED',reason:'OFFLINE_TEST'},9150001);
 assert.throws(()=>armAcceptance(db,manifest,fingerprints),/ALREADY_EXISTS/);assert.deepEqual(controls(db),before);
 assert.equal(getRecord(db,'acceptance_authorization',priorId).status,'CLOSED');
});

test('binding requires the actual closed, successful and cleaned-up prior Telegram outcomes',t=>{
 for(const change of [
  db=>putRecord(db,'acceptance_authorization',priorId,{status:'CLAIMED'}),
  db=>putRecord(db,'acceptance_result',priorId,{telegram:{status:'BLOCKED',cleanup:{confirmed:true}}}),
  db=>{const r=getRecord(db,'acceptance_result',priorId);r.telegram.cleanup.confirmed=false;putRecord(db,'acceptance_result',priorId,r);},
  db=>{const r=getRecord(db,'acceptance_result',priorId);delete r.telegram.scenarios.requestChanges;putRecord(db,'acceptance_result',priorId,r);},
 ]){const db=fixture(t);change(db);assert.throws(()=>armAcceptance(db,manifest,fingerprints),/INSTANTLY_QA_PRIOR_EVIDENCE/);assert.equal(getRecord(db,'acceptance_authorization',INSTANTLY_QA_ID),null);}
});

test('Instantly-only scope protects Telegram cursor/ownership and all existing records',t=>{
 for(const kind of ['telegram_writing_cursor','telegram_consumer_owner']){
  const db=fixture(t);armAcceptance(db,manifest,fingerprints,1000);claimAcceptance(db,manifest,2000);
  putRecord(db,kind,'primary',{changed:true});assert.throws(()=>assertAcceptance(db,manifest,2001),/PROTECTED_STATE_CHANGED/);
  closeAcceptance(db,{id:INSTANTLY_QA_ID,status:'BLOCKED',reason:'PROTECTED_STATE_CHANGED'},2002);
 }
});

test('cancellation and prelaunch failures close only the new grant with no replay',t=>{
 for(const started of [false,true]){
  const db=fixture(t);armAcceptance(db,manifest,fingerprints,1000);
  if(started){claimAcceptance(db,manifest,2000);cancelAcceptance(db,2001,INSTANTLY_QA_ID);assert.throws(()=>assertAcceptance(db,manifest,2002),/CANCELLED/);}
  closeAcceptance(db,{id:INSTANTLY_QA_ID,status:'BLOCKED',reason:'LOCAL_PRECONDITION',...(started?{}:{notLaunched:true,liveCalls:0})},2003);
  assert.equal(getRecord(db,'acceptance_authorization',INSTANTLY_QA_ID).status,'CLOSED');assert.throws(()=>claimAcceptance(db,manifest,2004),/AUTHORIZATION_CLOSED/);
 }
});

test('controller never invokes Telegram and closes after two cleaned phases',async t=>{
 const db=fixture(t),before=controls(db);armAcceptance(db,manifest,fingerprints,1000);const phases=[];
 const r=await runAcceptanceSequence({db,manifest,root:process.cwd(),now:()=>2000,telegram:async()=>{throw Error('TELEGRAM_MUST_NOT_RUN');},instantly:async({phase})=>{phases.push(phase);return {status:'PASSED',cleanup:{confirmed:true}};}});
 assert.equal(r.status,'PASS');assert.deepEqual(phases,[1,2]);assert.equal(r.telegram.status,'NOT_APPLICABLE');assert.equal(r.authenticationCategory,'Existing Codex connector authentication');
 assert.equal(getRecord(db,'acceptance_authorization',INSTANTLY_QA_ID).status,'CLOSED');assert.deepEqual(controls(db),before);
});

test('first-phase failure, uncertain outcome or cleanup failure blocks phase two',async t=>{
 for(const value of [{status:'FAILED',cleanup:{confirmed:true}},{status:'UNCERTAIN',cleanup:{confirmed:true}},{status:'PASSED',cleanup:{confirmed:false}}]){
  const db=fixture(t);armAcceptance(db,manifest,fingerprints,1000);const phases=[];
  const r=await runAcceptanceSequence({db,manifest,root:process.cwd(),now:()=>2000,instantly:async({phase})=>{phases.push(phase);return value;}});
  assert.equal(r.status,'BLOCKED');assert.equal(r.firstFailingStage,'INSTANTLY_PHASE_1');assert.deepEqual(phases,[1]);assert.equal(r.authorizationStatus,'CLOSED');
 }
});

test('controller reserves full 60-second launch and 10-second closure within the 150-second command',async t=>{
 const db=fixture(t);armAcceptance(db,manifest,fingerprints,1000);let time=2000;const phases=[];
 const r=await runAcceptanceSequence({db,manifest,root:process.cwd(),now:()=>time,instantly:async({phase})=>{phases.push(phase);time=83001;return {status:'PASSED',cleanup:{confirmed:true}};}});
 assert.equal(r.status,'BLOCKED');assert.equal(r.reason,'INSUFFICIENT_SESSION_TIME_FOR_CONTAINED_LAUNCH');assert.equal(r.firstFailingStage,'INSTANTLY_PHASE_2_PREFLIGHT');assert.deepEqual(phases,[1]);assert.equal(r.authorizationStatus,'CLOSED');
});

test('preclaim closure cannot close a grant claimed after an earlier APPROVED observation',t=>{
 const db=fixture(t);armAcceptance(db,manifest,fingerprints,1000);assert.equal(getRecord(db,'acceptance_authorization',INSTANTLY_QA_ID).status,'APPROVED');
 claimAcceptance(db,manifest,2000);const before=getRecord(db,'acceptance_authorization',INSTANTLY_QA_ID);
 assert.throws(()=>closeAcceptance(db,{id:INSTANTLY_QA_ID,status:'BLOCKED',reason:'OLD_PRECLAIM_ERROR',notLaunched:true,liveCalls:0},2001),/UNSTARTED_CLOSURE_LOST_OWNERSHIP/);
 assert.deepEqual(getRecord(db,'acceptance_authorization',INSTANTLY_QA_ID),before);assert.equal(getRecord(db,'acceptance_result',INSTANTLY_QA_ID),null);
});

test('baseline verification, snapshot and arm can share one transaction and roll back together',t=>{
 const db=fixture(t);const before=db.prepare('SELECT count(*) n FROM journal').get().n;
 assert.throws(()=>transaction(db,()=>{armAcceptance(db,manifest,fingerprints,1000);assert.equal(db.isTransaction,true);throw Error('POST_BIND_PRESERVATION_FAILURE');}),/POST_BIND_PRESERVATION_FAILURE/);
 assert.equal(getRecord(db,'acceptance_authorization',INSTANTLY_QA_ID),null);assert.equal(db.prepare('SELECT count(*) n FROM journal').get().n,before);
 transaction(db,()=>armAcceptance(db,manifest,fingerprints,1000));assert.equal(getRecord(db,'acceptance_authorization',INSTANTLY_QA_ID).status,'APPROVED');
});
