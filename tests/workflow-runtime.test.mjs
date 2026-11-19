import test from 'node:test';import assert from 'node:assert/strict';
import {openStore,putRecord,getRecord,setStopped} from '../src/store.mjs';
import {registerWorkflowTask,runWorkflowTask,runtimeStatus,defineWorkflowSchedule,materializeWorkflowSchedules,recoverWorkflowRuntime,runScheduledReportsOnce} from '../src/workflow-runtime.mjs';
import {productionFixture,productionTransport} from './helpers/handoff-production-fixture.mjs';
import {prepareHandoff} from '../src/handoff.mjs';
import {createProductionHandoffAdapter} from '../src/handoff-production.mjs';
import {at as handoffAt} from './helpers/telegram-writing-fixture.mjs';
const at='2026-11-16T15:00:00.000Z';
function fixture(t){const db=openStore(':memory:');t.after(()=>db.close());return db;}
const task=(more={})=>({id:'report',action:'PREPARE_REPORT',arguments:{campaignId:'fixture',includeSynthetic:true},runAt:at,timeoutMs:1000,...more});
function enable(db){putRecord(db,'settings','workflow-runtime',{enabled:true,generalDispatchEnabled:true,approvedBy:'fixture',approvedAt:'2026-01-01T00:00:00Z',revision:'fixture-only',timeZone:'America/New_York'});}
test('default disabled runtime refuses before claim or service invocation',async t=>{
 const db=fixture(t);registerWorkflowTask(db,task());let invoked=0;
 await assert.rejects(runWorkflowTask(db,'report',{services:{},ownerId:'fixture',clock:()=>at}),/RUNTIME_DISABLED/);
 assert.equal(getRecord(db,'workflow_job','task:report').attempts,0);assert.equal(runtimeStatus(db).enabled,false);assert.equal(invoked,0);
});
test('registered local report task runs stopped, persists result, rejects duplicate execution and survives restart recovery',async t=>{
 const db=fixture(t);enable(db);registerWorkflowTask(db,task());
 const result=await runWorkflowTask(db,'report',{ownerId:'fixture',clock:()=>at});
 assert.equal(result.status,'SUCCEEDED');assert.equal(getRecord(db,'workflow_task_result','report').result.campaignId,'fixture');
 await assert.rejects(runWorkflowTask(db,'report',{ownerId:'fixture',clock:()=>at}),/CLAIM_REJECTED/);
 assert.equal(recoverWorkflowRuntime(db,at).jobs.length,0);
});
test('immutable typed tasks reject unknown fields, arbitrary action and altered stored arguments',async t=>{
 const db=fixture(t);enable(db);
 assert.throws(()=>registerWorkflowTask(db,task({action:'EXECUTE_SCRIPT'})),/ACTION/);
 assert.throws(()=>registerWorkflowTask(db,task({arguments:{campaignId:'fixture',includeSynthetic:true,script:'arbitrary'}})),/ARGUMENT/);
 registerWorkflowTask(db,task());const stored=getRecord(db,'workflow_task','report');
 putRecord(db,'workflow_task','report',{...stored,arguments:{campaignId:'changed',includeSynthetic:true}});
 await assert.rejects(runWorkflowTask(db,'report',{ownerId:'fixture',clock:()=>at}),/HASH|IMMUTABLE/);
});
test('stopped, disabled general dispatch and unresolved operations block external work without claiming',async t=>{
 const db=fixture(t);enable(db);registerWorkflowTask(db,task({action:'HANDOFF',arguments:{importId:'not-imported'}}));
 await assert.rejects(runWorkflowTask(db,'report',{ownerId:'fixture',clock:()=>at}),/STOPPED/);
 setStopped(db,false,'fixture only');putRecord(db,'settings','workflow-runtime',{...getRecord(db,'settings','workflow-runtime'),generalDispatchEnabled:false});
 await assert.rejects(runWorkflowTask(db,'report',{ownerId:'fixture',clock:()=>at}),/DISPATCH_DISABLED/);
 assert.equal(getRecord(db,'workflow_job','task:report').attempts,0);
});
test('controlled NY recurrence materializes once per date, handles DST, never registers a schedule',t=>{
 const db=fixture(t);enable(db);
 defineWorkflowSchedule(db,{id:'daily',action:'PREPARE_REPORT',arguments:{campaignId:'fixture',includeSynthetic:true},localTime:'09:00',weekdays:[1,2,3,4,5],timeoutMs:1000});
 assert.equal(materializeWorkflowSchedules(db,'2026-03-06T14:00:00Z').length,0);
 const plan=getRecord(db,'workflow_schedule','daily');putRecord(db,'workflow_schedule','daily',{...plan,enabled:true,approval:{by:'fixture',at:'2026-01-01T00:00:00Z',revision:'synthetic'}});
 assert.equal(materializeWorkflowSchedules(db,'2026-03-06T13:59:00Z').length,0);
 assert.equal(materializeWorkflowSchedules(db,'2026-03-06T14:00:00Z').length,1);
 assert.equal(materializeWorkflowSchedules(db,'2026-03-06T18:00:00Z').length,0);
 assert.equal(materializeWorkflowSchedules(db,'2026-03-09T12:59:00Z').length,0);
 assert.equal(materializeWorkflowSchedules(db,'2026-03-09T13:00:00Z').length,1);
 assert.equal(materializeWorkflowSchedules(db,'2026-11-02T14:00:00Z').length,1);
 assert.equal(materializeWorkflowSchedules(db,'2026-11-07T14:00:00Z').length,0);
 assert.equal(db.prepare("SELECT count(*) AS n FROM records WHERE kind='workflow_task'").get().n,3);
});
test('recurrence cannot mint repeat provider authorizations or backfill missed occurrences',t=>{
 const db=fixture(t);enable(db);
 assert.throws(()=>defineWorkflowSchedule(db,{id:'unsafe',action:'HANDOFF',arguments:{importId:'repeated'},localTime:'09:00',weekdays:[1],timeoutMs:1000}),/LOCAL_REPORT/);
 defineWorkflowSchedule(db,{id:'daily',action:'PREPARE_REPORT',arguments:{campaignId:'fixture',includeSynthetic:true},localTime:'09:00',weekdays:[1,2,3,4,5],timeoutMs:1000});
 const plan=getRecord(db,'workflow_schedule','daily');putRecord(db,'workflow_schedule','daily',{...plan,enabled:true,approval:{by:'fixture',at,revision:'synthetic'}});
 const jobs=materializeWorkflowSchedules(db,'2026-11-18T17:00:00Z');assert.equal(jobs.length,1);assert.match(jobs[0].id,/2026-11-18/);
});
test('scheduler tick resumes a durably materialized but never claimed occurrence after interruption',async t=>{
 const db=fixture(t);enable(db);defineWorkflowSchedule(db,{id:'daily',action:'PREPARE_REPORT',arguments:{campaignId:'fixture',includeSynthetic:true},localTime:'09:00',weekdays:[1,2,3,4,5],timeoutMs:1000});
 putRecord(db,'workflow_schedule','daily',{...getRecord(db,'workflow_schedule','daily'),enabled:true,approval:{by:'fixture',at,revision:'fixture'}});
 const [task]=materializeWorkflowSchedules(db,at);assert.equal(getRecord(db,'workflow_job','task:'+task.id).status,'SCHEDULED');
 recoverWorkflowRuntime(db,at);
 const result=await runScheduledReportsOnce(db,{ownerId:'restart',clock:()=>at});assert.equal(result.results.length,1);assert.equal(result.results[0].status,'SUCCEEDED');
 assert.equal((await runScheduledReportsOnce(db,{ownerId:'next-tick',clock:()=>at})).results.length,0);
});
test('integrated runtime revocation after create blocks the next exact provider call',async t=>{
 const f=productionFixture();t.after(()=>f.db.close());enable(f.db);
 const tx=productionTransport(f,{afterCall:async(_call,count)=>{if(count===1)putRecord(f.db,'settings','workflow-runtime',{...getRecord(f.db,'settings','workflow-runtime'),generalDispatchEnabled:false});}});
 prepareHandoff(f.db,f.input,{productionAdapter:tx.adapter});registerWorkflowTask(f.db,task({id:'import',action:'HANDOFF',arguments:{importId:f.input.id},runAt:handoffAt}));
 const result=await runWorkflowTask(f.db,'import',{services:{handoffAdapter:tx.adapter},ownerId:'fixture',clock:()=>handoffAt});
 assert.equal(result.status,'RECONCILIATION');assert.deepEqual(tx.calls.map(c=>c.tool),['instantly_ai.create_lead']);
 await assert.rejects(runWorkflowTask(f.db,'import',{services:{handoffAdapter:tx.adapter},ownerId:'repeat',clock:()=>handoffAt}),/DISPATCH_DISABLED/);
});
test('disabled materialized schedule is reported without starving another authorized local report',async t=>{
 const db=fixture(t);enable(db);
 for(const id of ['a','b']){defineWorkflowSchedule(db,{id,action:'PREPARE_REPORT',arguments:{campaignId:'fixture',includeSynthetic:true},localTime:'09:00',weekdays:[1,2,3,4,5],timeoutMs:1000});putRecord(db,'workflow_schedule',id,{...getRecord(db,'workflow_schedule',id),enabled:true,approval:{by:'fixture',at,revision:'fixture'}});}
 materializeWorkflowSchedules(db,at);putRecord(db,'workflow_schedule','a',{...getRecord(db,'workflow_schedule','a'),enabled:false});
 const r=await runScheduledReportsOnce(db,{ownerId:'fixture',clock:()=>at});assert.equal(r.results.length,1);assert.match(r.results[0].id,/schedule:b:/);assert.equal(r.skipped[0].reason,'SCHEDULE_DISABLED');assert.equal(getRecord(db,'workflow_job','task:schedule:a:2026-11-16').attempts,0);
});
test('outer job timeout aborts dispatch capability, retains uncertainty and cannot replay on restart',async t=>{
 const f=productionFixture();t.after(()=>f.db.close());enable(f.db);const base=productionTransport(f);let calls=0,late,seenSignal;
 const adapter=createProductionHandoffAdapter(f.db,{fixtureAdapter:base.fixtureAdapter,clock:()=>handoffAt,timeoutMs:1000,transport:{mode:'offline',async execute(call,{permit,signal}){permit(call);calls++;seenSignal=signal;return new Promise(resolve=>{late=resolve;});}}});
 prepareHandoff(f.db,f.input,{productionAdapter:adapter});registerWorkflowTask(f.db,task({id:'timed',action:'HANDOFF',arguments:{importId:f.input.id},runAt:handoffAt,timeoutMs:80}));
 const result=await runWorkflowTask(f.db,'timed',{services:{handoffAdapter:adapter},ownerId:'fixture',clock:()=>handoffAt});
 assert.equal(result.status,'RECONCILIATION');assert.equal(calls,1);assert.equal(seenSignal.aborted,true);
 late({content:[],structuredContent:{id:'late',email:f.spec.email,campaign:f.spec.campaignId},isError:false});await new Promise(resolve=>setTimeout(resolve,20));
 assert.throws(()=>recoverWorkflowRuntime(f.db,handoffAt),/WORKFLOW_RUNTIME_ALREADY_OWNED/);assert.equal(getRecord(f.db,'workflow_job','task:timed').status,'RECONCILIATION');assert.equal(calls,1);
 await assert.rejects(runWorkflowTask(f.db,'timed',{services:{handoffAdapter:adapter},ownerId:'restart',clock:()=>handoffAt}),/RECONCILIATION/);
});
