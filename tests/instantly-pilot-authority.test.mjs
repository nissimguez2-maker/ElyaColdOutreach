import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync,mkdtempSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {Worker} from 'node:worker_threads';
import {openStore,getRecord,putRecord,controls,transaction} from '../src/store.mjs';
import {armAcceptance,claimAcceptance,assertFreshAcceptance,assertAcceptance,closeAcceptance,cancelAcceptance} from '../src/acceptance-authority.mjs';
import {digest,canonical} from '../src/values.mjs';
import {blockNetwork} from './helpers/network-block.mjs';

const at=Date.parse('2026-11-18T18:00:00Z'),root=resolve('.');
async function fixture(t,{file=false}={}){
 const network=blockNetwork(t);t.after(()=>assert.equal(network.attempts,0));
 const scope=await import('../src/instantly-pilot-scope.mjs').catch(()=>null);
 assert.equal(typeof scope?.buildInactiveSetupManifest,'function','fixed inactive setup scope must exist');
 const m=scope.buildInactiveSetupManifest(readFileSync('work/inactive-one-step-pilot-v1/proposal.json','utf8'));
 const path=file?join(mkdtempSync(join(tmpdir(),'elya-inactive-authority-')),'isolated.sqlite'):':memory:';
 const db=openStore(path);t.after(()=>db.close());
 putRecord(db,'contact','fixture-held',{verification:'CATCH_ALL',held:true});
 putRecord(db,'telegram_writing_cursor','primary',{nextOffset:64381648});
 const sources=scope.INACTIVE_SETUP_SOURCES.map(path=>({path,sha256:digest(readFileSync(join(root,path)))}));
 const approval={type:'EXPLICIT_LIVE_EXECUTION_APPROVAL',manifestHash:digest(canonical(m)),reference:'ISOLATED OFFLINE FIXTURE ONLY',approvedAt:new Date(at).toISOString()};
 const options={root,now:()=>at+1000,invocationId:'fixture-owner'};
 return {scope,m,db,path,sources,approval,options};
}
function arm(f){return armAcceptance(f.db,f.m,f.sources,at,{executionApproval:f.approval});}
const protectedState=db=>({controls:controls(db),contact:getRecord(db,'contact','fixture-held'),cursor:getRecord(db,'telegram_writing_cursor','primary'),budgets:db.prepare('SELECT * FROM budgets').all(),operations:db.prepare('SELECT * FROM operations').all()});

test('fixed inactive setup arm binds explicit approval, complete calls, source hashes and unchanged protected controls',async t=>{
 const f=await fixture(t),before=protectedState(f.db);
 assert.throws(()=>armAcceptance(f.db,f.m,f.sources,at),/EXPLICIT_EXECUTION_APPROVAL_REQUIRED/);
 assert.equal(getRecord(f.db,'acceptance_authorization',f.m.id),null);
 const grant=arm(f);
 assert.equal(grant.status,'APPROVED');assert.equal(grant.startedAt,null);assert.equal(grant.deadlineAt,null);
 assert.equal(grant.boundAt,'2026-11-18T18:00:00.000Z');assert.equal(grant.expiresAt,'2026-11-19T18:00:00.000Z');
 assert.equal(grant.authorizationBinding.callSequenceHash,digest(canonical(f.m.calls)));
 assert.equal(grant.manifestHash,digest(canonical(f.m)));
 assert.deepEqual(protectedState(f.db),before);
 assert.equal(f.db.prepare("SELECT count(*) n FROM journal WHERE event='ACCEPTANCE_APPROVED_NOT_STARTED'").get().n,1);
});

test('claim requires invocation ownership but not an operator-child entry hook; the deadline is exactly sixty seconds',async t=>{
 const f=await fixture(t);arm(f);
 assert.throws(()=>claimAcceptance(f.db,f.m,at+500,{root,now:()=>at+500}),/INVOCATION_ID_REQUIRED/);
 assert.equal(getRecord(f.db,'acceptance_authorization',f.m.id).status,'APPROVED');
 const grant=claimAcceptance(f.db,f.m,at+500,f.options);
 assert.equal(grant.claimInvocationId,'fixture-owner');assert.equal(grant.startedAt,'2026-11-18T18:00:00.500Z');assert.equal(grant.deadlineAt,'2026-11-18T18:01:00.500Z');
 assertAcceptance(f.db,f.m,at+60499);assert.throws(()=>assertAcceptance(f.db,f.m,at+60500),/DEADLINE/);
 assert.throws(()=>claimAcceptance(f.db,f.m,at+1000,{...f.options,invocationId:'duplicate'}),/CLAIMED|USED/);
});

for(const [name,offset,reason]of [
 ['expired',86400000,'ACCEPTANCE_VALIDITY_EXPIRED'],
 ['insufficient remaining validity',86400000-149999,'ACCEPTANCE_VALIDITY_INSUFFICIENT'],
 ['before binding',-1,'ACCEPTANCE_VALIDITY_TIME_INVALID'],
])test(`${name} refuses readiness and launch without consuming approval`,async t=>{
 const f=await fixture(t);arm(f);const before=JSON.stringify(f.db.prepare('SELECT * FROM records ORDER BY kind,id').all());
 assert.throws(()=>assertFreshAcceptance(f.db,f.m,at+offset),e=>e.message===reason);
 assert.throws(()=>claimAcceptance(f.db,f.m,at+offset,{...f.options,now:()=>at+offset}),e=>e.message===reason);
 assert.equal(JSON.stringify(f.db.prepare('SELECT * FROM records ORDER BY kind,id').all()),before);
});

test('exactly150 seconds remaining permits claim but does not extend the execution ceiling',async t=>{
 const f=await fixture(t);arm(f);const start=at+86400000-150000;
 const g=claimAcceptance(f.db,f.m,start,{...f.options,now:()=>start});assert.equal(Date.parse(g.deadlineAt),start+60000);
 assert.throws(()=>assertAcceptance(f.db,f.m,start+60000),/DEADLINE/);
});

test('missing approval and missing protected source fingerprints cannot produce a grant',async t=>{
 const f=await fixture(t);assert.throws(()=>assertFreshAcceptance(f.db,f.m,at),/MISSING/);
 assert.throws(()=>claimAcceptance(f.db,f.m,at,f.options),/MISSING/);
 assert.throws(()=>armAcceptance(f.db,f.m,f.sources.slice(1),at,{executionApproval:f.approval}),/FINGERPRINTS_REQUIRED/);
 assert.equal(getRecord(f.db,'acceptance_authorization',f.m.id),null);
});

for(const [name,mutate]of [
 ['target',m=>{m.calls[0].arguments.id='unapproved';}],
 ['write payload',m=>{m.calls[2].arguments.daily_limit=2;}],
 ['extra operation',m=>{m.calls.push(m.calls[0]);}],
 ['deadline',m=>{m.limits.totalMs=60001;}],
 ['activation',m=>{m.calls[2].tool='instantly_ai.activate_campaign';}],
])test(`changed ${name} is rejected without a claim`,async t=>{
 const f=await fixture(t);arm(f);const altered=structuredClone(f.m);mutate(altered);
 assert.throws(()=>claimAcceptance(f.db,altered,at+500,f.options));
 assert.equal(getRecord(f.db,'acceptance_authorization',f.m.id).status,'APPROVED');
});

for(const mode of ['binding','manifestHash','source','controls','originalRecord'])test(`current ${mode} mismatch stops claim`,async t=>{
 const f=await fixture(t);
 if(mode==='source'){f.sources=f.sources.map((s,i)=>i? s:{...s,sha256:'0'.repeat(64)});}
 arm(f);const grant=getRecord(f.db,'acceptance_authorization',f.m.id);
 if(mode==='binding')putRecord(f.db,'acceptance_authorization',f.m.id,{...grant,authorizationBinding:{...grant.authorizationBinding,callSequenceHash:'0'.repeat(64)}});
 if(mode==='manifestHash')putRecord(f.db,'acceptance_authorization',f.m.id,{...grant,manifestHash:'0'.repeat(64)});
 if(mode==='controls')f.db.exec('UPDATE controls SET stopped=0');
 if(mode==='originalRecord')putRecord(f.db,'telegram_writing_cursor','primary',{nextOffset:1});
 assert.throws(()=>claimAcceptance(f.db,f.m,at+500,f.options));
 assert.equal(getRecord(f.db,'acceptance_authorization',f.m.id).status,'APPROVED');
});

for(const [status,reason,finished]of [['PASS','READBACK_CONFIRMED',at+10000],['BLOCKED','LEAD_UPDATE_FAILED',at+10000],['UNRESOLVED','WRITE_OUTCOME_UNCERTAIN',at+10000],['BLOCKED','DEADLINE',at+61000]])test(`${reason} closes with owner and durable result; cannot rearm or replay`,async t=>{
 const f=await fixture(t);arm(f);const before=protectedState(f.db);claimAcceptance(f.db,f.m,at+500,f.options);
 assert.throws(()=>closeAcceptance(f.db,{id:f.m.id,status,reason,claimInvocationId:'other'},finished),/NOT_OWNER/);
 const result={id:f.m.id,status,reason,claimInvocationId:'fixture-owner'};closeAcceptance(f.db,result,finished);
 assert.deepEqual(getRecord(f.db,'acceptance_result',f.m.id),result);
 assert.equal(getRecord(f.db,'acceptance_authorization',f.m.id).status,'CLOSED');
 assert.throws(()=>assertFreshAcceptance(f.db,f.m,finished),/CLOSED/);
 assert.throws(()=>armAcceptance(f.db,f.m,f.sources,finished,{executionApproval:f.approval}),/ALREADY_EXISTS/);
 assert.throws(()=>claimAcceptance(f.db,f.m,finished,{...f.options,now:()=>finished}),/CLOSED/);
 assert.deepEqual(protectedState(f.db),before);
 assert.equal(f.db.prepare("SELECT count(*) n FROM journal WHERE subject=? AND event='ACCEPTANCE_CLOSED'").get(f.m.id).n,1);
});

test('only current owner may cancel and cancellation blocks later actions while allowing closure',async t=>{
 const f=await fixture(t);arm(f);claimAcceptance(f.db,f.m,at+500,f.options);
 assert.throws(()=>cancelAcceptance(f.db,at+1000,f.m.id,'other'),/NOT_OWNER/);
 assert.equal(cancelAcceptance(f.db,at+1000,f.m.id,'fixture-owner'),true);
 assert.throws(()=>assertAcceptance(f.db,f.m,at+1500),/CANCELLED/);
 closeAcceptance(f.db,{id:f.m.id,status:'BLOCKED',reason:'CANCELLED',claimInvocationId:'fixture-owner'},at+1500);
 assert.equal(getRecord(f.db,'acceptance_authorization',f.m.id).status,'CLOSED');
});

test('an outer transaction can atomically claim with session creation or roll both back',async t=>{
 const f=await fixture(t);arm(f);
 assert.throws(()=>transaction(f.db,()=>{
  claimAcceptance(f.db,f.m,at+500,f.options);
  putRecord(f.db,'inactive_setup_session',f.m.id,{status:'OPEN'});
  throw Error('FIXTURE_ABORT_CLAIM_AND_SESSION');
 }),/FIXTURE_ABORT_CLAIM_AND_SESSION/);
 assert.equal(getRecord(f.db,'acceptance_authorization',f.m.id).status,'APPROVED');
 assert.equal(getRecord(f.db,'inactive_setup_session',f.m.id),null);
 assert.equal(f.db.prepare("SELECT count(*) n FROM journal WHERE event='ACCEPTANCE_LAUNCHED_ONCE'").get().n,0);
 transaction(f.db,()=>{claimAcceptance(f.db,f.m,at+500,f.options);putRecord(f.db,'inactive_setup_session',f.m.id,{status:'OPEN'});});
 assert.equal(getRecord(f.db,'acceptance_authorization',f.m.id).status,'CLAIMED');
 assert.equal(getRecord(f.db,'inactive_setup_session',f.m.id).status,'OPEN');
});

test('an outer transaction closes result and session together, preserving ownership on rollback',async t=>{
 const f=await fixture(t);arm(f);claimAcceptance(f.db,f.m,at+500,f.options);
 putRecord(f.db,'inactive_setup_session',f.m.id,{status:'OPEN'});
 const result={id:f.m.id,status:'UNRESOLVED',reason:'WRITE_OUTCOME_UNCERTAIN',claimInvocationId:'fixture-owner'};
 assert.throws(()=>transaction(f.db,()=>{
  putRecord(f.db,'inactive_setup_session',f.m.id,{status:'CLOSED',writeOutcome:'UNCERTAIN'});
  closeAcceptance(f.db,result,at+61000);
  throw Error('FIXTURE_ABORT_RESULT_AND_SESSION');
 }),/FIXTURE_ABORT_RESULT_AND_SESSION/);
 assert.equal(getRecord(f.db,'acceptance_authorization',f.m.id).status,'CLAIMED');
 assert.equal(getRecord(f.db,'inactive_setup_session',f.m.id).status,'OPEN');
 assert.equal(getRecord(f.db,'acceptance_result',f.m.id),null);
 assert.equal(f.db.prepare("SELECT count(*) n FROM journal WHERE event='ACCEPTANCE_CLOSED'").get().n,0);
 transaction(f.db,()=>{putRecord(f.db,'inactive_setup_session',f.m.id,{status:'CLOSED',writeOutcome:'UNCERTAIN'});closeAcceptance(f.db,result,at+61000);});
 assert.equal(getRecord(f.db,'acceptance_authorization',f.m.id).status,'CLOSED');
 assert.deepEqual(getRecord(f.db,'acceptance_result',f.m.id),result);
 assert.equal(getRecord(f.db,'inactive_setup_session',f.m.id).writeOutcome,'UNCERTAIN');
});

test('simultaneous SQLite claimants produce one durable owner and a harmless losing refusal',{timeout:15000},async t=>{
 const f=await fixture(t,{file:true});arm(f);
 const barrier=new SharedArrayBuffer(4),signal=new Int32Array(barrier),workers=[];
 const code=`const {parentPort,workerData}=require('node:worker_threads');(async()=>{
 const {DatabaseSync}=await import('node:sqlite');const {claimAcceptance}=await import(workerData.moduleUrl);
 const db=new DatabaseSync(workerData.path);db.exec('PRAGMA busy_timeout=5000; PRAGMA synchronous=FULL;');
 parentPort.postMessage({type:'ready'});Atomics.wait(new Int32Array(workerData.barrier),0,0,10000);
 let outcome;try{const grant=claimAcceptance(db,workerData.manifest,workerData.at,{root:workerData.root,now:()=>workerData.at,invocationId:workerData.owner});outcome={status:'CLAIMED',owner:grant.claimInvocationId};}
 catch(e){outcome={status:'REFUSED',reason:e.message};}finally{db.close();}parentPort.postMessage({type:'done',outcome});})().catch(e=>{parentPort.postMessage({type:'error',error:e.message});});`;
 const pending=['first','second'].map(owner=>{
  let readyResolve,readyReject,doneResolve,doneReject;
  const ready=new Promise((resolve,reject)=>{readyResolve=resolve;readyReject=reject;}),done=new Promise((resolve,reject)=>{doneResolve=resolve;doneReject=reject;});done.catch(()=>{});
  const worker=new Worker(code,{eval:true,workerData:{moduleUrl:new URL('../src/acceptance-authority.mjs',import.meta.url).href,path:f.path,manifest:f.m,root,at:at+1000,owner,barrier}});workers.push(worker);
  worker.on('message',m=>{if(m.type==='ready')readyResolve();else if(m.type==='done')doneResolve(m.outcome);else{readyReject(Error(m.error));doneReject(Error(m.error));}});
  worker.on('error',e=>{readyReject(e);doneReject(e);});return {ready,done};
 });
 t.after(async()=>{await Promise.all(workers.map(w=>w.terminate()));});
 await Promise.all(pending.map(p=>p.ready));Atomics.store(signal,0,1);Atomics.notify(signal,0);
 const outcomes=await Promise.all(pending.map(p=>p.done));assert.equal(outcomes.filter(o=>o.status==='CLAIMED').length,1);assert.equal(outcomes.filter(o=>o.reason==='ACCEPTANCE_AUTHORIZATION_CLAIMED').length,1);
 const owner=getRecord(f.db,'acceptance_authorization',f.m.id).claimInvocationId;assert.equal(owner,outcomes.find(o=>o.status==='CLAIMED').owner);
 assert.equal(f.db.prepare("SELECT count(*) n FROM journal WHERE event='ACCEPTANCE_LAUNCHED_ONCE'").get().n,1);
 closeAcceptance(f.db,{id:f.m.id,status:'BLOCKED',reason:'FIXTURE_FINISHED',claimInvocationId:owner},at+2000);
});
