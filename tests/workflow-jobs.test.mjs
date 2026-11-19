import test from 'node:test';
import assert from 'node:assert/strict';
import {openStore,getRecord,putRecord,setStopped,setLaunch} from '../src/store.mjs';
import {createBatch,decideApproval} from '../src/batches.mjs';
import {createBudget,reserveOperation} from '../src/operations.mjs';
import {scheduleWorkflowJob,claimWorkflowJob,runWorkflowJob,retryWorkflowJob,recoverWorkflowJobs,workflowJobStatus} from '../src/workflow-jobs.mjs';
const at='2026-11-16T17:00:00Z',night='2026-11-17T03:00:00Z';
const job=(extra={})=>({id:'job-1',kind:'PREPARE',runAt:at,timeoutMs:1000,maxAttempts:2,operationId:null,payload:{candidateId:'synthetic-candidate'},...extra});
function fixture(t){const db=openStore(':memory:');t.after(()=>db.close());return db;}
function importFixture(db){
 setStopped(db,false,'fixture');setLaunch(db,true,'fixture');createBudget(db,'fixture','1','0','0');
 putRecord(db,'candidate','candidate',{qualification:'QUALIFIED'});putRecord(db,'contact','qa@example.invalid',{candidateId:'candidate',attribution:'fixture',verification:'PASSED',suppressed:false});
 const b=createBatch(db,'batch',{campaignId:'fixture-campaign',recipients:[{candidateId:'candidate',email:'qa@example.invalid',messages:[{subject:'Fixture',body:'Fixture'}]}],sequence:{},settings:{}});
 const a=decideApproval(db,'batch',b.version,b.hash,'APPROVED','fixture','2026-11-18T00:00:00Z',at);
 reserveOperation(db,{id:'import',kind:'RELEASE',budgetId:'fixture',reservation:'0',authorizationRef:'fixture',payload:{batchId:'batch',approvalId:a.id}});
 scheduleWorkflowJob(db,job({kind:'IMPORT',operationId:'import',payload:{}}));return a;
}
test('local preparation runs while stopped and outside the New York send window',async t=>{
 const db=fixture(t);scheduleWorkflowJob(db,job());
 const result=await runWorkflowJob(db,'job-1',{mode:'offline',async execute(){return {status:'SUCCEEDED',evidenceRef:'fixture:prepared'};}},{ownerId:'operator',at:night});
 assert.equal(result.status,'SUCCEEDED');assert.equal(workflowJobStatus(db)[0].attempts,1);
});
test('duplicate job identity and concurrent durable claims cannot cause duplicate work',t=>{
 const db=fixture(t);scheduleWorkflowJob(db,job());assert.equal(scheduleWorkflowJob(db,job()).id,'job-1');
 assert.throws(()=>scheduleWorkflowJob(db,job({id:'job-2'})),/DUPLICATE/);
 assert.throws(()=>scheduleWorkflowJob(db,job({payload:{changed:true}})),/IMMUTABLE/);
 claimWorkflowJob(db,'job-1',{ownerId:'owner-1',at});assert.throws(()=>claimWorkflowJob(db,'job-1',{ownerId:'owner-2',at}),/RUNNING|CLAIM/);
 assert.equal(getRecord(db,'workflow_job','job-1').ownerId,'owner-1');
});
test('interrupted running job becomes reconciliation and cannot be retried automatically',t=>{
 const db=fixture(t);scheduleWorkflowJob(db,job());claimWorkflowJob(db,'job-1',{ownerId:'owner',at});
 assert.equal(recoverWorkflowJobs(db,at).length,1);assert.equal(getRecord(db,'workflow_job','job-1').status,'RECONCILIATION');
 assert.throws(()=>retryWorkflowJob(db,'job-1',at),/RECONCILIATION/);
});
test('definitive predispatched failure permits explicit retry only up to its bound',async t=>{
 const db=fixture(t);scheduleWorkflowJob(db,job());const handler={mode:'offline',async execute(){return {status:'NOT_DISPATCHED',evidenceRef:'fixture:failure'};}};
 assert.equal((await runWorkflowJob(db,'job-1',handler,{ownerId:'owner',at})).status,'RETRYABLE');retryWorkflowJob(db,'job-1',at);
 assert.equal((await runWorkflowJob(db,'job-1',handler,{ownerId:'owner',at})).status,'FAILED');assert.throws(()=>retryWorkflowJob(db,'job-1',at),/ATTEMPTS|RETRY/);
});
test('future jobs, live transports and missing authorization operations never execute',async t=>{
 const db=fixture(t);scheduleWorkflowJob(db,job({runAt:'2026-11-20T00:00:00Z'}));let calls=0;
 const handler={mode:'offline',async execute(){calls++;return {status:'SUCCEEDED',evidenceRef:'fixture'};}};
 await assert.rejects(runWorkflowJob(db,'job-1',handler,{ownerId:'owner',at}),/NOT_DUE/);
 await assert.rejects(runWorkflowJob(db,'job-1',{...handler,mode:'live'},{ownerId:'owner',at}),/OFFLINE/);
 assert.throws(()=>scheduleWorkflowJob(db,job({id:'bad-import',kind:'IMPORT'})),/OPERATION/);assert.equal(calls,0);
});
test('import rechecks stop, budget, current approval, suppression and send window before claiming',t=>{
 const db=fixture(t),approval=importFixture(db);
 setStopped(db,true,'fixture');assert.throws(()=>claimWorkflowJob(db,'job-1',{ownerId:'owner',at}),/stopped/);setStopped(db,false,'fixture');
 assert.throws(()=>claimWorkflowJob(db,'job-1',{ownerId:'owner',at:night}),/window/);
 db.prepare("UPDATE budgets SET blocked=1 WHERE id='fixture'").run();assert.throws(()=>claimWorkflowJob(db,'job-1',{ownerId:'owner',at}),/BUDGET/);db.prepare("UPDATE budgets SET blocked=0 WHERE id='fixture'").run();
 putRecord(db,'contact','qa@example.invalid',{candidateId:'candidate',attribution:'fixture',verification:'PASSED',suppressed:true});assert.throws(()=>claimWorkflowJob(db,'job-1',{ownerId:'owner',at}),/Contact held/);
 db.prepare("UPDATE approvals SET decision='REVOKED' WHERE id=?").run(approval.id);assert.throws(()=>claimWorkflowJob(db,'job-1',{ownerId:'owner',at}),/approval/);
 assert.equal(getRecord(db,'workflow_job','job-1').status,'SCHEDULED');
});
test('timeout and thrown failures preserve uncertain status; late completion cannot overwrite it',async t=>{
 const db=fixture(t);scheduleWorkflowJob(db,job({timeoutMs:10}));let finish;
 const p=runWorkflowJob(db,'job-1',{mode:'offline',execute:()=>new Promise(resolve=>{finish=resolve;})},{ownerId:'owner',at});
 assert.equal((await p).status,'RECONCILIATION');finish({status:'SUCCEEDED',evidenceRef:'fixture:late'});await new Promise(resolve=>setImmediate(resolve));
 assert.equal(getRecord(db,'workflow_job','job-1').status,'RECONCILIATION');
});
