import test from 'node:test';
import assert from 'node:assert/strict';
import {Worker} from 'node:worker_threads';
import {copyFileSync,existsSync,mkdirSync,mkdtempSync,readFileSync,readdirSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {dirname,join} from 'node:path';
import {openStore,putRecord,getRecord,controls} from '../src/store.mjs';
import {armAcceptance,closeAcceptance} from '../src/acceptance-authority.mjs';
import {digest} from '../src/values.mjs';
import {blockNetwork} from './helpers/network-block.mjs';

const id='elya-instantly-qa-acceptance-v2',boundAt=Date.parse('2026-11-18T00:00:00.000Z'),atMs=boundAt+1000;
function fixture(t){
 const network=blockNetwork(t),root=mkdtempSync(join(tmpdir(),'elya-v2-concurrency-')),db=openStore(join(root,'data/elya.sqlite'));t.after(()=>db.close());
 t.after(()=>assert.equal(network.attempts,0));
 const manifestPath='work/instantly-qa-acceptance-v2/manifest.json',manifest=JSON.parse(readFileSync(manifestPath,'utf8'));
 const paths=[manifestPath,manifest.contracts.baselineSource,'src/acceptance-authority.mjs'];
 for(const path of paths){mkdirSync(dirname(join(root,path)),{recursive:true});copyFileSync(path,join(root,path));}
 const sources=paths.map(path=>({path,sha256:digest(readFileSync(join(root,path)))}));
 putRecord(db,'acceptance_authorization','elya-acceptance-continuation-v1',{status:'CLOSED'});
 putRecord(db,'acceptance_result','elya-acceptance-continuation-v1',{authorizationStatus:'CLOSED',telegram:{status:'PASSED',cleanup:{confirmed:true},scenarios:{staleVersion:{status:'PASS'},requestChanges:{status:'PASS'}}}});
 putRecord(db,'acceptance_authorization','elya-instantly-qa-acceptance-v1',{status:'CLOSED'});
 putRecord(db,'telegram_writing_cursor','primary',{nextOffset:64381648});
 armAcceptance(db,manifest,sources,boundAt,{executionApproval:{type:'EXPLICIT_LIVE_EXECUTION_APPROVAL',manifestHash:'17aba6391533f3052ebc0e996ebcf52d1829a3b802131ca0b1c4a3665d4a7767',reference:'offline concurrency fixture',approvedAt:new Date(boundAt).toISOString()}});
 const snapshot=()=>({records:db.prepare('SELECT * FROM records ORDER BY kind,id').all(),history:db.prepare('SELECT * FROM record_history ORDER BY rowid').all(),journal:db.prepare('SELECT * FROM journal ORDER BY id').all()});
 return {root,db,network,snapshot};
}
async function race(t,root,mode){
 const barrier=new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT),signal=new Int32Array(barrier),workers=[];
 const pending=['one','two'].map(suffix=>{
  const invocationId=`offline-${mode}-${suffix}`;
  const worker=new Worker(new URL('./helpers/v2-claim-worker.mjs',import.meta.url),{workerData:{root,atMs,invocationId,barrier,mode}});workers.push(worker);
  let readyResolve,readyReject,doneResolve,doneReject,readyObserved=false,doneObserved=false;
  const ready=new Promise((resolve,reject)=>{readyResolve=resolve;readyReject=reject;}),done=new Promise((resolve,reject)=>{doneResolve=resolve;doneReject=reject;});
  // A startup failure must reject readiness without an unhandled done promise.
  done.catch(()=>{});
  worker.on('message',message=>{if(message.type==='ready'){readyObserved=true;readyResolve(message);}if(message.type==='done'){doneObserved=true;if(!readyObserved)readyReject(Error(message.result.reason??'FIXTURE_WORKER_NOT_READY'));doneResolve(message.result);}});
  worker.on('error',error=>{readyReject(error);doneReject(error);});
  worker.on('exit',code=>{if(code!==0||!readyObserved||!doneObserved){const error=Error(`FIXTURE_WORKER_EXIT_${code}`);readyReject(error);doneReject(error);}});
  return {ready,done};
 });
 t.after(async()=>{await Promise.all(workers.map(worker=>worker.terminate()));});
 const ready=await Promise.all(pending.map(worker=>worker.ready));assert.equal(new Set(ready.map(worker=>worker.threadId)).size,2);
 // A worker reaching wait after release observes the stored signal immediately.
 // Neither worker can claim before both database connections report ready.
 Atomics.store(signal,0,1);Atomics.notify(signal,0);
 const results=await Promise.all(pending.map(worker=>worker.done));assert.ok(results.every(result=>result.networkAttempts===0),JSON.stringify(results));
 return results;
}

test('two SQLite claimants have one owner; losing claims and concurrent duplicate CLI entries cannot change that owner',{timeout:20000},async t=>{
 const f=fixture(t),before=f.snapshot(),beforeControls=controls(f.db),claims=await race(t,f.root,'claim');
 const winners=claims.filter(result=>result.outcome==='CLAIMED'),losers=claims.filter(result=>result.outcome==='DENIED');
 assert.equal(winners.length,1,JSON.stringify(claims));assert.equal(losers.length,1,JSON.stringify(claims));
 const [winner]=winners,[loser]=losers;assert.equal(loser.reason,'ACCEPTANCE_AUTHORIZATION_CLAIMED');assert.equal(loser.nonownerCancel,'ACCEPTANCE_CANCELLATION_NOT_OWNER');assert.equal(loser.unstartedClose,'ACCEPTANCE_UNSTARTED_CLOSURE_LOST_OWNERSHIP');assert.equal(loser.nonownerClose,'ACCEPTANCE_CLOSURE_NOT_OWNER');assert.equal(loser.protectedFromLoser,true);
 const grant=getRecord(f.db,'acceptance_authorization',id);assert.equal(grant.status,'CLAIMED');assert.equal(grant.claimInvocationId,winner.invocationId);assert.equal(grant.cancellationRequestedAt,null);assert.equal(grant.closedAt,null);
 assert.equal(grant.startedAt,new Date(atMs).toISOString());assert.equal(grant.deadlineAt,new Date(atMs+150000).toISOString());
 const afterClaim=f.snapshot();assert.deepEqual(afterClaim.history.slice(0,before.history.length),before.history);assert.equal(afterClaim.history.length,before.history.length+1);assert.equal(afterClaim.journal.length,before.journal.length+1);
 assert.deepEqual(afterClaim.records.filter(row=>row.id!==id),before.records.filter(row=>row.id!==id));
 const launches=afterClaim.journal.filter(row=>row.subject===id&&row.event==='ACCEPTANCE_LAUNCHED_ONCE');assert.equal(launches.length,1);assert.equal(getRecord(f.db,'acceptance_result',id),null);assert.deepEqual(controls(f.db),beforeControls);
 const entries=await race(t,f.root,'duplicate-entry');
 for(const entry of entries){assert.equal(entry.outcome,'ENTRY_RESULT');assert.equal(entry.value.reason,'ACCEPTANCE_AUTHORIZATION_CLAIMED');assert.equal(entry.value.exitCode,2);assert.equal(entry.value.authorizationStatus,'CLAIMED');assert.equal(entry.value.attemptExternalActivity,'NOT_STARTED');}
 assert.notEqual(entries[0].value.attemptId,entries[1].value.attemptId);assert.deepEqual(f.snapshot(),afterClaim);
 const attempts=join(f.root,'work/instantly-qa-acceptance-v2/attempts'),reports=readdirSync(attempts).filter(name=>name.endsWith('.result.json'));
 assert.equal(reports.length,2);assert.ok(reports.every(name=>JSON.parse(readFileSync(join(attempts,name))).reason==='ACCEPTANCE_AUTHORIZATION_CLAIMED'));
 assert.equal(existsSync(join(f.root,'work/instantly-qa-acceptance-v2/live-once')),false);
 assert.equal(f.db.prepare("SELECT count(*) AS n FROM records WHERE kind LIKE 'acceptance_instantly_%' AND id LIKE ?").get(id+'%').n,0);
 const result={id,status:'BLOCKED',reason:'OFFLINE_OWNER_CLOSURE',claimInvocationId:winner.invocationId};closeAcceptance(f.db,result,atMs+1);
 assert.equal(getRecord(f.db,'acceptance_authorization',id).status,'CLOSED');assert.deepEqual(getRecord(f.db,'acceptance_result',id),result);
 assert.equal(f.db.prepare("SELECT count(*) AS n FROM journal WHERE subject=? AND event='ACCEPTANCE_LAUNCHED_ONCE'").get(id).n,1);
 assert.equal(f.db.prepare("SELECT count(*) AS n FROM journal WHERE subject=? AND event='ACCEPTANCE_CLOSED'").get(id).n,1);
 assert.deepEqual(controls(f.db),beforeControls);assert.equal(f.network.attempts,0);
});
