import test from 'node:test';
import assert from 'node:assert/strict';
import {openStore,getRecord} from '../src/store.mjs';
import {scheduleWorkflowJob,runWorkflowJob,recoverWorkflowOwnership,acquireWorkflowOwnership} from '../src/workflow-jobs.mjs';
import {putRecord,journal} from '../src/store.mjs';
import {createBudget,reserveOperation} from '../src/operations.mjs';
import {mkdtempSync,rmSync} from 'node:fs';import {tmpdir} from 'node:os';import {join} from 'node:path';
import {spawn,spawnSync} from 'node:child_process';import {once} from 'node:events';import {pathToFileURL} from 'node:url';

const at='2026-11-19T15:00:00.000Z';
function fixture(t){const db=openStore(':memory:');t.after(()=>db.close());return db;}
function schedule(db,id){return scheduleWorkflowJob(db,{id,kind:'PREPARE',runAt:at,timeoutMs:1000,maxAttempts:1,operationId:null,payload:{id}});}

// Removing the entry abort check would claim/execute cancelled work.
test('a cancelled foreground invocation never claims its job',async t=>{
 const db=fixture(t);schedule(db,'cancelled');const controller=new AbortController();controller.abort();
 await assert.rejects(runWorkflowJob(db,'cancelled',{mode:'offline',execute:async()=>({status:'SUCCEEDED',evidenceRef:'fixture'})},{ownerId:'operator',at,signal:controller.signal}),/CANCELLED/);
 assert.equal(getRecord(db,'workflow_job','cancelled').attempts,0);
});

// Losing the singleton lease permits different jobs to run concurrently.
test('different jobs cannot overlap and normal completion releases ownership',async t=>{
 const db=fixture(t);schedule(db,'first');schedule(db,'second');let finish;
 const first=runWorkflowJob(db,'first',{mode:'offline',execute:()=>new Promise(resolve=>{finish=resolve;})},{ownerId:'owner-a',at});
 await new Promise(resolve=>setImmediate(resolve));
 try{await assert.rejects(runWorkflowJob(db,'second',{mode:'offline',execute:async()=>({status:'SUCCEEDED',evidenceRef:'fixture:second'})},{ownerId:'owner-b',at}),/RUNTIME_ALREADY_OWNED/);
 assert.equal(getRecord(db,'workflow_job','second').attempts,0);}
 finally{finish({status:'SUCCEEDED',evidenceRef:'fixture:first'});await first;}
 assert.equal(getRecord(db,'workflow_job','first').status,'SUCCEEDED');
 assert.equal((await runWorkflowJob(db,'second',{mode:'offline',execute:async()=>({status:'SUCCEEDED',evidenceRef:'fixture:second'})},{ownerId:'owner-b',at})).status,'SUCCEEDED');
});

// Losing parent abort propagation lets a stop become a successful dispatch.
test('operator cancellation aborts the component and retains uncertainty without replay',async t=>{
 const db=fixture(t);schedule(db,'running');const controller=new AbortController();let seenSignal,finish;
 const result=runWorkflowJob(db,'running',{mode:'offline',execute:context=>{seenSignal=context.signal;return new Promise(resolve=>{finish=resolve;});}},{ownerId:'operator',at,signal:controller.signal});
 await new Promise(resolve=>setImmediate(resolve));controller.abort();
 try{assert.equal(seenSignal.aborted,true);}
 finally{finish({status:'SUCCEEDED',evidenceRef:'late'});}
 assert.equal((await result).status,'RECONCILIATION');
 finish({status:'SUCCEEDED',evidenceRef:'late'});await new Promise(resolve=>setImmediate(resolve));
 assert.equal(getRecord(db,'workflow_job','running').status,'RECONCILIATION');
});

// A race result is not evidence that the handler stopped; ownership must outlive it.
for(const mode of ['cancellation','timeout'])test(`${mode} retains ownership while the handler is pending and requires explicit recovery`,async t=>{
 const db=fixture(t);schedule(db,'next');
 scheduleWorkflowJob(db,{id:'pending',kind:'PREPARE',runAt:at,timeoutMs:20,maxAttempts:1,operationId:null,payload:{id:'pending'}});
 const controller=new AbortController();let finish;
 const first=runWorkflowJob(db,'pending',{mode:'offline',execute:()=>new Promise(resolve=>{finish=resolve;})},{ownerId:'pending-owner',at,signal:controller.signal});
 await new Promise(resolve=>setImmediate(resolve));if(mode==='cancellation')controller.abort();
 try{
  assert.equal((await first).status,'RECONCILIATION');
  await assert.rejects(runWorkflowJob(db,'next',{mode:'offline',execute:async()=>({status:'SUCCEEDED',evidenceRef:'fixture:next'})},{ownerId:'next-owner',at}),/RUNTIME_ALREADY_OWNED/);
  assert.equal(getRecord(db,'workflow_job','next').attempts,0);
 }finally{finish({status:'SUCCEEDED',evidenceRef:'fixture:late'});await new Promise(resolve=>setImmediate(resolve));}
 const claim=getRecord(db,'workflow_runtime_owner','foreground');
 assert.equal(claim.status,'ACTIVE');assert.equal(getRecord(db,'workflow_job','pending').status,'RECONCILIATION');
 assert.throws(()=>recoverWorkflowOwnership(db,claim.claimId,at),/NOT_CONFIRMED_DEAD/);
 assert.throws(()=>acquireWorkflowOwnership(db,'after-late-result',at),/ALREADY_OWNED/);
});

test('recovery refuses to rewrite work while another foreground owner remains active',async t=>{
 const db=fixture(t),runtime=await import('../src/workflow-runtime.mjs');schedule(db,'running');acquireWorkflowOwnership(db,'active',at);
 assert.throws(()=>runtime.recoverWorkflowRuntime(db,at),/ALREADY_OWNED/);
 assert.equal(getRecord(db,'workflow_job','running').status,'SCHEDULED');
});

// A fixture, future date, missing real-start attestation, or rerecording must not start/reset the week.
test('observation starts only from an explicit real-operation attestation and remains immutable',async t=>{
 const db=fixture(t),api=await import('../src/workflow-observation.mjs').catch(()=>null);
 assert.ok(api,'explicit operational observation capability is available');
 const input={id:'week-1',startedAt:at,approvedBy:'Daniel Rosen',approvalRef:'fixture:approved-cadence',cadence:'Weekdays at 09:00 America/New_York; manual first touch only',startEvidenceRef:'fixture:first-real-run',realOperationConfirmed:true};
 assert.throws(()=>api.startOperationalObservation(db,{...input,realOperationConfirmed:false},at),/REAL_OPERATION/);
 assert.throws(()=>api.startOperationalObservation(db,{...input,startedAt:'2026-11-20T15:00:00Z'},at),/FUTURE/);
 assert.equal(api.operationalObservationReport(db,'week-1',at).status,'NOT_STARTED');
 const saved=api.startOperationalObservation(db,input,at);assert.equal(saved.startedAt,at);assert.equal(saved.evidenceBasis,'user_reported');
 assert.throws(()=>api.startOperationalObservation(db,{...input,startedAt:'2026-11-19T14:00:00Z'},at),/IMMUTABLE/);
 assert.equal(api.operationalObservationReport(db,'week-1','2026-11-26T15:00:00Z').status,'PERIOD_ELAPSED_REVIEW_EVIDENCE');
});

// Dropping journal/state/cost categories or treating unknown usage as zero hides operational gaps.
test('observation reads existing evidence, preserving unknown costs and explicit manual gaps',async t=>{
 const db=fixture(t),api=await import('../src/workflow-observation.mjs').catch(()=>null);
 assert.ok(api,'explicit operational observation capability is available');
 const startedAt=new Date(Date.now()-1000).toISOString(),endAt=new Date(Date.now()+1000).toISOString();
 api.startOperationalObservation(db,{id:'week',startedAt,approvedBy:'Daniel Rosen',approvalRef:'fixture:approval',cadence:'Manual approved first touch',startEvidenceRef:'fixture:start',realOperationConfirmed:true},endAt);
 journal(db,'WORKFLOW_JOB_OUTCOME','fixture:run',{status:'SUCCEEDED',evidenceRef:'fixture:success'});
 journal(db,'WORKFLOW_JOB_RECOVERY_REQUIRED','fixture:interrupted',{});
 putRecord(db,'provider_event','fixture:reply',{event:{type:'REPLIED'},ingestedAt:startedAt});
 putRecord(db,'manual_response_event','fixture:refusal',{event:{type:'REFUSAL'},recordedAt:startedAt},'user_reported');
 putRecord(db,'contact','fixture:contact',{verification:'HELD'});
 createBudget(db,'fixture','1','0','0');reserveOperation(db,{id:'unknown-cost',kind:'READ',budgetId:'fixture',reservation:'0',authorizationRef:'fixture',payload:{fixture:true}});
 api.recordOperationalIntervention(db,{id:'gap',observationId:'week',occurredAt:startedAt,actor:'Daniel Rosen',category:'MISSING_SIGNAL',evidenceRef:'fixture:no-provider-cost'},endAt);
 const before=db.prepare('SELECT count(*) AS n FROM journal').get().n;
 const report=api.operationalObservationReport(db,'week',endAt);
 assert.equal(report.runs.SUCCEEDED,1);assert.equal(report.recoveryEvents,1);assert.equal(report.replies,1);assert.equal(report.refusals,1);
 assert.equal(report.manualInterventions.length,1);assert.equal(report.stateTransitions.some(row=>row.kind==='contact'),true);
 assert.equal(report.costs.knownActualUsd,'0');assert.equal(report.costs.coverage,'RECORDED_OPERATIONS_ONLY_NOT_TOTAL_PROVIDER_BILLING');
 assert.equal(report.costs.unknownActualOperations,1);assert.equal(report.costs.operations[0].actual_usd,null);
 assert.equal(db.prepare('SELECT count(*) AS n FROM journal').get().n,before);
});

test('a separate process cannot overlap and its interrupted owner requires explicit dead-process recovery',async t=>{
 const directory=mkdtempSync(join(tmpdir(),'elya-runtime-'));
 const dbPath=join(directory,'fixture.sqlite'),db=openStore(dbPath);t.after(()=>{db.close();assert.ok(directory.startsWith(join(tmpdir(),'elya-runtime-')));rmSync(directory,{recursive:true,force:true});});schedule(db,'held');schedule(db,'next');
 const storeUrl=pathToFileURL(join(process.cwd(),'src/store.mjs')).href,jobsUrl=pathToFileURL(join(process.cwd(),'src/workflow-jobs.mjs')).href;
 const child=spawn(process.execPath,['--input-type=module','-e',`import {openStore} from ${JSON.stringify(storeUrl)};import {acquireWorkflowOwnership,claimWorkflowJob} from ${JSON.stringify(jobsUrl)};const db=openStore(process.argv[1]);acquireWorkflowOwnership(db,'isolated-child',${JSON.stringify(at)});claimWorkflowJob(db,'held',{ownerId:'isolated-child',at:${JSON.stringify(at)}});console.log('OWNED');setInterval(()=>{},1000);`,dbPath],{windowsHide:true,stdio:['ignore','pipe','pipe']});
 t.after(()=>{if(child.exitCode===null)child.kill();});
 await Promise.race([once(child.stdout,'data'),once(child,'error').then(([error])=>{throw error;})]);
 assert.throws(()=>acquireWorkflowOwnership(db,'second',at),/ALREADY_OWNED/);
 const claim=getRecord(db,'workflow_runtime_owner','foreground');assert.throws(()=>recoverWorkflowOwnership(db,claim.claimId,at),/NOT_CONFIRMED_DEAD/);
 const closed=once(child,'close');child.kill();await closed;
 assert.throws(()=>acquireWorkflowOwnership(db,'second',at),/ALREADY_OWNED/);
 assert.equal(recoverWorkflowOwnership(db,claim.claimId,at).status,'INTERRUPTED');
 const runtime=await import('../src/workflow-runtime.mjs');assert.equal(runtime.recoverWorkflowRuntime(db,at).jobs[0].status,'RECONCILIATION');
 assert.equal((await runWorkflowJob(db,'next',{mode:'offline',execute:async()=>({status:'SUCCEEDED',evidenceRef:'fixture:next'})},{ownerId:'second',at})).status,'SUCCEEDED');
 assert.equal(getRecord(db,'workflow_job','held').attempts,1);
});

test('foreground CLI can inspect an isolated database without starting observation or enabling dispatch',t=>{
 const directory=mkdtempSync(join(tmpdir(),'elya-runtime-cli-')),dbPath=join(directory,'fixture.sqlite'),db=openStore(dbPath);db.close();
 t.after(()=>{assert.ok(directory.startsWith(join(tmpdir(),'elya-runtime-cli-')));rmSync(directory,{recursive:true,force:true});});
 const result=spawnSync(process.execPath,['src/workflow-runner-cli.mjs','--database',dbPath,'observation-status','week'],{windowsHide:true,encoding:'utf8'});
 assert.equal(result.status,0,result.stderr);assert.equal(JSON.parse(result.stdout).status,'NOT_STARTED');
 const check=openStore(dbPath);try{assert.equal(getRecord(check,'settings','workflow-runtime'),null);assert.equal(getRecord(check,'operational_observation','week'),null);}finally{check.close();}
});
