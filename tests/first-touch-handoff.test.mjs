import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {buildSavedInstantlyContract,buildHandoffAuthorization,prepareHandoff,executeHandoff,reconcileHandoff,createIsolatedHandoffAdapter} from '../src/handoff.mjs';
import {writingTelegramFixture} from './helpers/telegram-writing-fixture.mjs';
import {getRecord,putRecord,setLaunch,setStopped} from '../src/store.mjs';
import {prepareWritingReview,decideWritingReview,evaluateWritingReview} from '../src/writing.mjs';
import {createBatch,decideApproval} from '../src/batches.mjs';
import {createBudget,operation} from '../src/operations.mjs';

const at='2026-11-16T22:00:00Z',expires='2026-11-16T22:05:00Z';
const source=JSON.parse(readFileSync(new URL('./fixtures/instantly-handoff-schema-captured.json',import.meta.url),'utf8'));
function input(){
 const snapshot=structuredClone(source);
 snapshot.snapshot={campaign:{value:{structuredContent:{id:'qa-first-touch',status:0,sequences:[{steps:[{type:'email',variants:[{subject:'{{pilot_subject_1}}',body:'{{pilot_body_1}}',v_disabled:false}]}]}]}}}};
 return {id:'first-touch-contract',campaignId:'qa-first-touch',snapshot,sourceRef:'isolated first-touch fixture',approvedBy:'Daniel Rosen',approvedAt:at,expiresAt:expires,fixtureOnly:true,writingContractVersion:'first-touch-only-v1',readbackRequired:true,observedAt:at,campaignStatusRule:{approvedStatuses:[0],evidenceRef:'isolated inactive fixture'}};
}
test('explicit first-touch contract seals only its two variable names and mode',()=>{
 const contract=buildSavedInstantlyContract(input());
 assert.deepEqual(contract.variableNames,['pilot_subject_1','pilot_body_1']);
 assert.equal(contract.writingContractVersion,'first-touch-only-v1');
 assert.equal(contract.version,'captured-first-touch-create-update-v1');
 assert.equal(contract.readbackRequired,true);
 assert.equal(contract.activationAllowed,false);
});
test('first-touch remote mapping rejects followups, variants, disabled variants, wrong variables and missing readback',()=>{
 for(const alteration of ['followup','variant','disabled','wrongSubject','wrongBody','absentEnabled','readback']){
  const i=input(),steps=i.snapshot.snapshot.campaign.value.structuredContent.sequences[0].steps,v=steps[0].variants[0];
  if(alteration==='followup')steps.push(structuredClone(steps[0]));
  if(alteration==='variant')steps[0].variants.push(structuredClone(v));
  if(alteration==='disabled')v.v_disabled=true;
  if(alteration==='wrongSubject')v.subject='{{pilot_subject_2}}';
  if(alteration==='wrongBody')v.body='{{pilot_body_2}}';
  if(alteration==='absentEnabled')delete v.v_disabled;
  if(alteration==='readback')i.readbackRequired=false;
  assert.throws(()=>buildSavedInstantlyContract(i),/mapping|readback/i,alteration);
 }
});
test('unknown writing contract versions are not silently treated as legacy',()=>{
 assert.throws(()=>buildSavedInstantlyContract({...input(),writingContractVersion:'first-touch-v999'}),/contract|mode|version/i);
});
test('first-touch mapping requires an explicit email step rather than missing or alternate channel type',()=>{
 for(const type of [undefined,'sms']){
  const i=input(),step=i.snapshot.snapshot.campaign.value.structuredContent.sequences[0].steps[0];
  if(type===undefined)delete step.type;else step.type=type;
  assert.throws(()=>buildSavedInstantlyContract(i),/mapping/);
 }
});
test('first-touch mapping rejects array-like sequences and variants',()=>{
 for(const field of ['sequences','variants']){
  const i=input(),campaign=i.snapshot.snapshot.campaign.value.structuredContent;
  if(field==='sequences')campaign.sequences={length:1,0:campaign.sequences[0]};
  else campaign.sequences[0].steps[0].variants={length:1,0:campaign.sequences[0].steps[0].variants[0]};
  assert.throws(()=>buildSavedInstantlyContract(i),/mapping/);
 }
});

function setup(){
 const {db,spec:legacy}=writingTelegramFixture();
 const spec={...legacy,contractVersion:'first-touch-only-v1',draftIds:legacy.draftIds.slice(0,1),steps:legacy.steps.slice(0,1)};
 putRecord(db,'settings','handoff-fixture-isolation',{isolated:true,fixtureId:'first-touch-handoff-test'});
 putRecord(db,'contact',spec.email,{...getRecord(db,'contact',spec.email),verification:'PASSED',suppressed:false});
 putRecord(db,'campaign',spec.campaignId,{purpose:'synthetic_qa',mustRemainInactive:false});
 putRecord(db,'writing_policy',spec.campaignId,{...getRecord(db,'writing_policy',spec.campaignId),sequence:{steps:1,endpoint:'END_AFTER_FIRST_TOUCH',endpointApproved:true},physicalAddressApproved:true,physicalAddress:'Synthetic fixture address only',optOutApproved:true,optOut:{approved:true,mode:'REPLY_STOP',text:'Synthetic opt-out'},approvalExpiry:{approved:true,approvedBy:'Daniel Rosen',approvedAt:at,revision:'fixture-only-seven-calendar-days',maxCalendarDays:7,timeZone:'America/New_York'}});
 const packet=prepareWritingReview(db,spec);
 const decision=decideWritingReview(db,{actionId:'first-touch-content',reviewId:packet.reviewId,packetHash:packet.hash,decision:'APPROVED',actor:'Daniel Rosen',at,expiresAt:expires,acknowledgedFindings:['FIXTURE_CAUTION']});
 const batch=createBatch(db,'first-touch-batch',{campaignId:spec.campaignId,recipients:[{candidateId:spec.candidateId,email:spec.email,messages:packet.messages,writing:{reviewId:packet.reviewId,packetHash:packet.hash,decisionId:decision.id}}],sequence:packet.policy.sequence,settings:{syntheticOnly:true}});
 const batchId='first-touch-batch',approval=decideApproval(db,batchId,batch.version,batch.hash,'APPROVED','Daniel Rosen',expires,at);
 createBudget(db,'fixture-budget','0','0','0');setStopped(db,false,'isolated fixture');setLaunch(db,true,'isolated fixture');
 const contractInput=input();contractInput.campaignId=spec.campaignId;contractInput.snapshot.snapshot.campaign.value.structuredContent.id=spec.campaignId;
 const contract=buildSavedInstantlyContract(contractInput);putRecord(db,'instantly_handoff_contract',contract.id,contract);
 const authority=buildHandoffAuthorization(db,{id:'first-touch-authority',batchId,approvalId:approval.id,contractId:contract.id,budgetId:'fixture-budget',notBefore:at,expiresAt:expires,approvedBy:'Daniel Rosen',fixtureOnly:true,maxRequests:3,reservation:'0'});
 putRecord(db,'handoff_authorization',authority.id,authority);
 const request={id:'first-touch-import',batchId,approvalId:approval.id,contractId:contract.id,authorizationId:authority.id,budgetId:'fixture-budget',reservation:'0',at};
 return {db,spec,packet,batch,approval,contract,authority,request};
}
function transport({loseOtherVariable=false,changedReadback=false}={}){
 const calls=[],extras={pilot_subject_2:'untouched subject 2',pilot_body_2:'untouched body 2',pilot_subject_3:'untouched subject 3',pilot_body_3:'untouched body 3',unrelated:'preserve exactly'};
 let lead;
 return {calls,extras,execute:async call=>{
  calls.push(structuredClone(call));
  if(call.tool.endsWith('create_lead')){lead={id:'first-touch-lead',campaign:call.arguments.campaign,email:call.arguments.email,custom_variables:{...extras}};return {content:[],structuredContent:structuredClone(lead)};}
  if(call.tool.endsWith('update_lead')){lead.custom_variables={...lead.custom_variables,...call.arguments.custom_variables};if(loseOtherVariable)delete lead.custom_variables.unrelated;return {content:[],structuredContent:{success:true}};}
  if(call.tool.endsWith('get_lead')){if(changedReadback)lead.custom_variables.pilot_body_1='wrong';return {content:[],structuredContent:structuredClone(lead)};}
  throw Error('Unexpected fixture provider call');
 }};
}
test('one-message handoff creates, writes two keys, and independently reads back preserving observed unrelated variables',async()=>{
 const f=setup(),t=transport(),adapter=createIsolatedHandoffAdapter(f.db,t);
 try{
  const prepared=prepareHandoff(f.db,f.request,{fixtureAdapter:adapter});assert.equal(prepared.recipients.length,1);
  assert.equal((await executeHandoff(f.db,f.request.id,adapter,at)).status,'SUCCEEDED');
  assert.deepEqual(t.calls.map(c=>c.tool.split('_ai_')[1]),['create_lead','update_lead','get_lead']);
  assert.deepEqual(Object.keys(t.calls[1].arguments.custom_variables).sort(),['pilot_body_1','pilot_subject_1']);
  assert.equal(getRecord(f.db,'handoff',f.request.id).requestCount,3);
  assert.deepEqual(getRecord(f.db,'handoff_variable_snapshot',f.request.id+':0').unrelatedVariables,t.extras);
  await assert.rejects(()=>executeHandoff(f.db,f.request.id,adapter,at),/state|replay|terminal/i);
  assert.equal(t.calls.length,3);
 }finally{f.db.close();}
});
test('first-touch readback mismatch or lost unrelated variables requires reconciliation without replay',async()=>{
 for(const option of ['loseOtherVariable','changedReadback']){
  const f=setup(),t=transport({[option]:true}),adapter=createIsolatedHandoffAdapter(f.db,t);
  try{
   prepareHandoff(f.db,f.request,{fixtureAdapter:adapter});
   assert.equal((await executeHandoff(f.db,f.request.id,adapter,at)).status,'RECONCILIATION');
   assert.equal(operation(f.db,f.request.id).actual_usd,null);
   await assert.rejects(()=>executeHandoff(f.db,f.request.id,adapter,at),/state|replay|reconciliation/i);
   assert.equal(t.calls.length,3);
  }finally{f.db.close();}
 }
});
test('first-touch handoff cannot reuse a legacy contract or bypass held, suppression, stop, launch, or approval gates',()=>{
 for(const state of ['legacy','held','suppressed','stop','launch','approval']){
  const f=setup(),t=transport(),adapter=createIsolatedHandoffAdapter(f.db,t);
  try{
   if(state==='legacy'){
    const c=buildSavedInstantlyContract({...input(),writingContractVersion:undefined,campaignId:f.spec.campaignId,id:f.contract.id});putRecord(f.db,'instantly_handoff_contract',c.id,c);
    const a=buildHandoffAuthorization(f.db,{...f.authority,contractId:c.id});putRecord(f.db,'handoff_authorization',a.id,a);
   }
   if(state==='held')putRecord(f.db,'contact',f.spec.email,{...getRecord(f.db,'contact',f.spec.email),verification:'CATCH_ALL'});
   if(state==='suppressed')putRecord(f.db,'contact',f.spec.email,{...getRecord(f.db,'contact',f.spec.email),suppressed:true});
   if(state==='stop')setStopped(f.db,true,'fixture stop');
   if(state==='launch')setLaunch(f.db,false,'fixture no launch');
   if(state==='approval')putRecord(f.db,'writing_decision','first-touch-content',{...getRecord(f.db,'writing_decision','first-touch-content'),decision:'REVOKED'});
   assert.throws(()=>prepareHandoff(f.db,f.request,{fixtureAdapter:adapter}),state==='legacy'?/writing contract mode mismatch/:undefined,state);
   assert.equal(t.calls.length,0);assert.equal(f.db.prepare('SELECT count(*) n FROM operations').get().n,0);
  }finally{f.db.close();}
 }
});
test('first-touch reconciliation requires preservation evidence as well as exact selected variables',async()=>{
 const f=setup(),t=transport({changedReadback:true}),adapter=createIsolatedHandoffAdapter(f.db,t);
 try{
  prepareHandoff(f.db,f.request,{fixtureAdapter:adapter});
  assert.equal((await executeHandoff(f.db,f.request.id,adapter,at)).status,'RECONCILIATION');
  const evidence={evidenceRef:'fixture separately inspected state',actual:'0',recipients:[{campaignId:f.spec.campaignId,email:f.spec.email,leadId:'first-touch-lead',custom_variables:{...t.calls[1].arguments.custom_variables}}]};
  assert.throws(()=>reconcileHandoff(f.db,f.request.id,evidence,at),/preservation|unrelated/i);
  evidence.recipients[0].custom_variables={...t.extras,...evidence.recipients[0].custom_variables};
  assert.equal(reconcileHandoff(f.db,f.request.id,evidence,at).status,'SUCCEEDED');
  assert.equal(t.calls.length,3);
 }finally{f.db.close();}
});

test('uncertain first-touch create or rejected update preserves partial state and cannot be retried',async()=>{
 for(const failedStage of ['create_lead','update_lead']){
  const f=setup(),t=transport(),seen=[],adapter=createIsolatedHandoffAdapter(f.db,{execute:async call=>{
   seen.push(call.tool);if(call.tool.endsWith(failedStage))throw Error('Synthetic unavailable service');return t.execute(call);
  }});
  try{
   prepareHandoff(f.db,f.request,{fixtureAdapter:adapter});
   assert.equal((await executeHandoff(f.db,f.request.id,adapter,at)).status,'RECONCILIATION');
   const h=getRecord(f.db,'handoff',f.request.id);
   assert.equal(h.recipients[0].leadId,failedStage==='create_lead'?null:'first-touch-lead');
   assert.equal(h.recipients[0].status,failedStage==='create_lead'?'CREATING':'UPDATING');
   await assert.rejects(()=>executeHandoff(f.db,f.request.id,adapter,at),/state|reconciliation|terminal/i);
   assert.throws(()=>prepareHandoff(f.db,{...f.request,id:'another-attempt'},{fixtureAdapter:adapter}),/Duplicate|reconciliation/i);
   assert.equal(seen.length,failedStage==='create_lead'?1:2);
  }finally{f.db.close();}
 }
});
test('material content revision after creation invalidates approval and blocks the variable update',async()=>{
 let revisionError;const f=setup(),t=transport(),adapter=createIsolatedHandoffAdapter(f.db,{execute:async call=>{
  const result=await t.execute(call);
  if(call.tool.endsWith('create_lead')){
   const old=getRecord(f.db,'draft',f.spec.draftIds[0]),id=`${f.spec.candidateId}:v2:step1`;
   putRecord(f.db,'draft',id,{...old,version:2,subject:'A different synthetic subject'});
   try{prepareWritingReview(f.db,{...f.spec,draftIds:[id],steps:[{...f.spec.steps[0],draftId:id}]});}catch(error){revisionError=error;throw error;}
  }
  return result;
 }});
 try{
  prepareHandoff(f.db,f.request,{fixtureAdapter:adapter});
  assert.equal((await executeHandoff(f.db,f.request.id,adapter,at)).status,'RECONCILIATION');
  assert.equal(revisionError,undefined);
  assert.equal(t.calls.length,1);assert.equal(t.calls[0].tool.endsWith('create_lead'),true);
  assert.equal(evaluateWritingReview(f.db,f.packet.reviewId,'first-touch-content',at).contentApproved,false);
  assert.equal(getRecord(f.db,'handoff',f.request.id).recipients[0].leadId,'first-touch-lead');
 }finally{f.db.close();}
});
test('concurrent first-touch invocation and new-ID replay cannot create the recipient twice',async()=>{
 const f=setup(),t=transport();let release;const waiting=new Promise(resolve=>{release=resolve;});
 const adapter=createIsolatedHandoffAdapter(f.db,{execute:async call=>{if(call.tool.endsWith('create_lead'))await waiting;return t.execute(call);}});
 try{
  prepareHandoff(f.db,f.request,{fixtureAdapter:adapter});
  const first=executeHandoff(f.db,f.request.id,adapter,at);
  await assert.rejects(()=>executeHandoff(f.db,f.request.id,adapter,at),/state|reconciliation|terminal/i);
  release();assert.equal((await first).status,'SUCCEEDED');
  assert.throws(()=>prepareHandoff(f.db,{...f.request,id:'new-id-same-recipient'},{fixtureAdapter:adapter}),/Duplicate/);
  assert.equal(t.calls.filter(c=>c.tool.endsWith('create_lead')).length,1);assert.equal(t.calls.length,3);
 }finally{release();f.db.close();}
});
