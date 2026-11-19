import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {at} from './helpers/telegram-writing-fixture.mjs';
import {getRecord,putRecord,setLaunch,setStopped,openStore} from '../src/store.mjs';
import {reviewVariables} from '../src/writing.mjs';
import {operation,recoverOperations,budgetStatus} from '../src/operations.mjs';
import * as handoff from '../src/handoff.mjs';
import {productionFixture,productionTransport} from './helpers/handoff-production-fixture.mjs';
import {registerWorkflowTask} from '../src/workflow-runtime.mjs';
const production=await import('../src/handoff-production.mjs').catch(()=>null);

test('general production handoff boundary is available without enabling dispatch',()=>assert.equal(typeof production?.createProductionHandoffAdapter,'function'));

if(production){
test('production sequence accepts arbitrary-object update ACK only after exact get_lead readback',async()=>{
 const f=productionFixture(),t=productionTransport(f,{ack:{accepted:true,elapsed:0.25}});
 const prepared=handoff.prepareHandoff(f.db,f.input,{productionAdapter:t.adapter});assert.equal(prepared.mode,'PRODUCTION_BOUNDARY_FIXTURE');
 assert.equal((await handoff.executeHandoff(f.db,f.input.id,t.adapter,at)).status,'SUCCEEDED');
 assert.deepEqual(t.calls.map(x=>[x.server,x.tool]),[['codex_apps','instantly_ai.create_lead'],['codex_apps','instantly_ai.update_lead'],['codex_apps','instantly_ai.get_lead']]);
 assert.deepEqual(t.calls[0].arguments,{campaign:'qa-tg-writing',email:'qa@example.invalid'});
 assert.deepEqual(t.calls[1].arguments,{id:'fixture-created-1',custom_variables:reviewVariables(f.packet)});
 assert.deepEqual(t.calls[2].arguments,{id:'fixture-created-1'});
 assert.equal(getRecord(f.db,'handoff',f.input.id).recipients[0].status,'IMPORTED');
 assert.equal(f.db.prepare("SELECT count(*) n FROM records WHERE kind='handoff_call'").get().n,3);
 await assert.rejects(()=>handoff.executeHandoff(f.db,f.input.id,t.adapter,at),/state|replay|terminal/i);assert.equal(t.calls.length,3);f.db.close();
});
test('production dispatch defaults disabled and rejects arbitrary uncontained transports before reservations',()=>{
 const f=productionFixture({enabled:false}),t=productionTransport(f);
 assert.throws(()=>handoff.prepareHandoff(f.db,f.input,{productionAdapter:t.adapter}),/DISABLED/);
 assert.throws(()=>production.createProductionHandoffAdapter(f.db,{transport:{mode:'contained-app-server',execute:async()=>{}}}),/CONTAINED/);
 assert.equal(f.db.prepare('SELECT count(*) n FROM operations').get().n,0);f.db.close();
});
test('production preparation preserves stopped, held, stale-content, suppression, window, launch and budget gates',()=>{
 for(const state of ['stopped','held','stale','suppressed','window','launch','budget','general']){
  const f=productionFixture(state==='budget'?{reservation:'2',limit:'1'}:{}),t=productionTransport(f);
  if(state==='stopped')setStopped(f.db,true,'test stop');
  if(state==='launch')setLaunch(f.db,false,'test disarm');
  if(state==='held'||state==='suppressed')putRecord(f.db,'contact',f.spec.email,{...getRecord(f.db,'contact',f.spec.email),...(state==='held'?{verification:'CATCH_ALL'}:{suppressed:true})});
  if(state==='stale')putRecord(f.db,'writing_decision','production-content',{...getRecord(f.db,'writing_decision','production-content'),decision:'REVOKED'});
  if(state==='window')f.input.at='2026-11-17T04:00:00Z';
  if(state==='general')putRecord(f.db,'settings','handoff-production',{enabled:true,generalDispatchEnabled:false});
  assert.throws(()=>handoff.prepareHandoff(f.db,f.input,{productionAdapter:t.adapter}),undefined,state);
  assert.equal(f.db.prepare('SELECT count(*) n FROM operations').get().n,0);f.db.close();
 }
});
test('stop and disabled dispatch are rechecked before every production request',async()=>{
 for(const state of ['stopped','disabled']){
  const f=productionFixture(),t=productionTransport(f,{afterCall:()=>state==='stopped'?setStopped(f.db,true,'during create'):putRecord(f.db,'settings','handoff-production',{enabled:false,generalDispatchEnabled:true})});
  handoff.prepareHandoff(f.db,f.input,{productionAdapter:t.adapter});assert.equal((await handoff.executeHandoff(f.db,f.input.id,t.adapter,at)).status,'RECONCILIATION');assert.equal(t.calls.length,1);f.db.close();
 }
});
test('newly blocked budget prevents the next provider write after creation',async()=>{
 const f=productionFixture(),t=productionTransport(f,{afterCall:()=>f.db.prepare("UPDATE budgets SET blocked=1 WHERE id='production-budget'").run()});
 handoff.prepareHandoff(f.db,f.input,{productionAdapter:t.adapter});assert.equal((await handoff.executeHandoff(f.db,f.input.id,t.adapter,at)).status,'RECONCILIATION');assert.equal(t.calls.length,1);f.db.close();
});
test('job cancellation reaches the active transport and prevents subsequent writes',async()=>{
 const f=productionFixture(),cancel=new AbortController(),t=productionTransport(f,{afterCall:()=>cancel.abort()});
 handoff.prepareHandoff(f.db,f.input,{productionAdapter:t.adapter});
 assert.equal((await handoff.executeHandoff(f.db,f.input.id,t.adapter,at,{signal:cancel.signal})).status,'RECONCILIATION');assert.equal(t.calls.length,1);f.db.close();
});
test('job dispatch recheck stops a later provider call when the global integration is disabled',async()=>{
 let enabled=true;const f=productionFixture(),t=productionTransport(f,{afterCall:()=>{enabled=false;}});
 handoff.prepareHandoff(f.db,f.input,{productionAdapter:t.adapter});
 assert.equal((await handoff.executeHandoff(f.db,f.input.id,t.adapter,at,{assertDispatch:()=>enabled})).status,'RECONCILIATION');assert.equal(t.calls.length,1);f.db.close();
});
function workflowBinding(f){
 putRecord(f.db,'settings','workflow-runtime',{enabled:true,generalDispatchEnabled:true,timeZone:'America/New_York',approvedBy:'Daniel Rosen',approvedAt:at,revision:'fixture-runtime-v1'});
 const task=registerWorkflowTask(f.db,{id:'bound-handoff',action:'HANDOFF',arguments:{importId:f.input.id},runAt:at,timeoutMs:60000}),jobId='task:'+task.id;
 putRecord(f.db,'workflow_job',jobId,{...getRecord(f.db,'workflow_job',jobId),status:'RUNNING',deadlineAt:'2026-11-16T22:01:00Z'});
 return {taskId:task.id,taskHash:task.specHash,jobId};
}
test('persisted workflow binding blocks parent requests when runtime policy changes without a closure',async()=>{
 const f=productionFixture(),binding=workflowBinding(f),t=productionTransport(f,{afterCall:()=>putRecord(f.db,'settings','workflow-runtime',{...getRecord(f.db,'settings','workflow-runtime'),generalDispatchEnabled:false})});
 handoff.prepareHandoff(f.db,f.input,{productionAdapter:t.adapter});
 assert.equal((await handoff.executeHandoff(f.db,f.input.id,t.adapter,at,{workflowBinding:binding})).status,'RECONCILIATION');assert.equal(t.calls.length,1);
 assert.deepEqual(getRecord(f.db,'handoff_call',f.input.id+':1').workflowBinding,binding);f.db.close();
});
test('durable provider permit independently enforces workflow binding after a child handoff',async()=>{
 const f=productionFixture(),binding=workflowBinding(f),fixtureAdapter=handoff.createIsolatedHandoffAdapter(f.db,{execute:async()=>{}});let permitted=false,adapter;
 adapter=production.createProductionHandoffAdapter(f.db,{fixtureAdapter,clock:()=>at,transport:{mode:'offline',async execute(call,{context}){
  putRecord(f.db,'settings','workflow-runtime',{...getRecord(f.db,'settings','workflow-runtime'),generalDispatchEnabled:false});
  handoff.permitHandoffProviderCall(f.db,context.operationId,context.requestCount,call,at,adapter);permitted=true;
  return {content:[],structuredContent:{id:'fixture-created-1',campaign:f.spec.campaignId,email:f.spec.email}};
 }}});
 handoff.prepareHandoff(f.db,f.input,{productionAdapter:adapter});
 assert.equal((await handoff.executeHandoff(f.db,f.input.id,adapter,at,{workflowBinding:binding})).status,'RECONCILIATION');assert.equal(permitted,false);f.db.close();
});
test('one-use final permit rejects changed arguments and late held contacts',async()=>{
 for(const mode of ['changed','held','twice']){
  const f=productionFixture(),fixtureAdapter=handoff.createIsolatedHandoffAdapter(f.db,{execute:async()=>{throw Error('Unexpected');}});let allowed=0;
  const adapter=production.createProductionHandoffAdapter(f.db,{fixtureAdapter,clock:()=>at,transport:{mode:'offline',async execute(call,{permit}){
   if(mode==='held')putRecord(f.db,'contact',f.spec.email,{...getRecord(f.db,'contact',f.spec.email),verification:'CATCH_ALL'});
   permit(mode==='changed'?{...call,arguments:{...call.arguments,email:'wrong@example.invalid'}}:call);allowed++;
   if(mode==='twice')permit(call);
   return {content:[],structuredContent:{id:'fixture-created-1',campaign:f.spec.campaignId,email:f.spec.email}};
  }}});
  handoff.prepareHandoff(f.db,f.input,{productionAdapter:adapter});assert.equal((await handoff.executeHandoff(f.db,f.input.id,adapter,at)).status,'RECONCILIATION');assert.equal(allowed,mode==='twice'?1:0);f.db.close();
 }
});
test('uncertain update preserves reservation and lead identity across restart without automatic replay',async()=>{
 const path=join(mkdtempSync(join(tmpdir(),'elya-handoff-production-')),'state.sqlite'),f=productionFixture({path,reservation:'0.2'}),t=productionTransport(f,{afterCall:(_,n)=>{if(n===2)throw Error('Lost response');}});
 handoff.prepareHandoff(f.db,f.input,{productionAdapter:t.adapter});assert.equal((await handoff.executeHandoff(f.db,f.input.id,t.adapter,at)).status,'RECONCILIATION');assert.equal(t.calls.length,2);assert.equal(budgetStatus(f.db,'production-budget').reserved,'0.2');f.db.close();
 const db=openStore(path);recoverOperations(db);const again=productionTransport({...f,db});
 await assert.rejects(()=>handoff.executeHandoff(db,f.input.id,again.adapter,at),/state|replay|reconciliation/i);
 assert.equal(getRecord(db,'handoff',f.input.id).recipients[0].leadId,'fixture-created-1');assert.equal(again.calls.length,0);
 assert.equal(handoff.reconcileHandoff(db,f.input.id,{evidenceRef:'fixture exact readback after restart',actual:'0',recipients:[{campaignId:f.spec.campaignId,email:f.spec.email,leadId:'fixture-created-1',custom_variables:reviewVariables(f.packet)}]},at).status,'SUCCEEDED');db.close();
});
test('missing permit, malformed acknowledgement and conflicting readback remain uncertain',async()=>{
 for(const variant of ['permit','ack','readback','payload-identity']){
  const f=productionFixture(),t=productionTransport(f,{skipPermit:variant==='permit',ack:variant==='ack'?null:{anything:'accepted'},readbackPatch:lead=>variant==='readback'?{...lead,email:'wrong@example.invalid'}:variant==='payload-identity'?{...lead,payload:{...lead.payload,email:'wrong@example.invalid'}}:lead});
  handoff.prepareHandoff(f.db,f.input,{productionAdapter:t.adapter});assert.equal((await handoff.executeHandoff(f.db,f.input.id,t.adapter,at)).status,'RECONCILIATION',variant);assert.equal(operation(f.db,f.input.id).actual_usd,null);f.db.close();
 }
});
}
