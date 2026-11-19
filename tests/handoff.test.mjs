import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync,mkdtempSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {writingTelegramFixture,at,expires} from './helpers/telegram-writing-fixture.mjs';
import {getRecord,putRecord,setLaunch,setStopped,openStore} from '../src/store.mjs';
import {prepareWritingReview,decideWritingReview,reviewVariables,evaluateWritingReview} from '../src/writing.mjs';
import {createBatch,decideApproval,evaluateRelease} from '../src/batches.mjs';
import {createBudget,operation,recoverOperations} from '../src/operations.mjs';
const api=await import('../src/handoff.mjs').catch(()=>null);
const HANDOFF_KEYS=[1,2,3].flatMap(i=>[`pilot_subject_${i}`,`pilot_body_${i}`]);
const snapshot=JSON.parse(readFileSync(new URL('./fixtures/instantly-handoff-schema-captured.json',import.meta.url),'utf8'));

test('handoff contract and fixture execution boundary exist',()=>assert.ok(api));
function setup({path=':memory:',patchPolicy={},held=false}={}){
 const {db,spec}=writingTelegramFixture(path);
 putRecord(db,'settings','handoff-fixture-isolation',{isolated:true,fixtureId:'handoff-test'});
 putRecord(db,'contact',spec.email,{...getRecord(db,'contact',spec.email),verification:held?'CATCH_ALL':'PASSED',suppressed:false});
 putRecord(db,'campaign',spec.campaignId,{purpose:'synthetic_qa',mustRemainInactive:false});
 putRecord(db,'writing_policy',spec.campaignId,{...getRecord(db,'writing_policy',spec.campaignId),sequence:{steps:3,cadenceApproved:true,endpointApproved:true},physicalAddressApproved:true,physicalAddress:'Synthetic fixture address only',optOutApproved:true,optOut:{approved:true,mode:'REPLY_STOP',text:'Synthetic opt-out'},approvalExpiry:{approved:true,approvedBy:'Daniel Rosen',approvedAt:at,revision:'fixture-v1',maxAgeMs:300000},...patchPolicy});
 const packet=prepareWritingReview(db,spec),decision=decideWritingReview(db,{actionId:'content-approval',reviewId:packet.reviewId,packetHash:packet.hash,decision:'APPROVED',actor:'Daniel Rosen',at,expiresAt:expires,acknowledgedFindings:['FIXTURE_CAUTION']});
 const b=createBatch(db,'fixture-batch',{campaignId:spec.campaignId,recipients:[{candidateId:spec.candidateId,email:spec.email,messages:packet.messages,writing:{reviewId:packet.reviewId,packetHash:packet.hash,decisionId:decision.id}}],sequence:packet.policy.sequence,settings:{syntheticOnly:true}});
 const approval=decideApproval(db,'fixture-batch',b.version,b.hash,'APPROVED','Daniel Rosen',expires,at);
 createBudget(db,'fixture-budget','0','0','0');setStopped(db,false,'isolated fixture');setLaunch(db,true,'isolated fixture');
 const contract=api.buildSavedInstantlyContract({id:'fixture-contract',campaignId:spec.campaignId,snapshot,sourceRef:'work/instantly-capability-inspection.json',approvedBy:'Daniel Rosen',approvedAt:at,expiresAt:expires,fixtureOnly:true});
 putRecord(db,'instantly_handoff_contract',contract.id,contract);
 const authority=api.buildHandoffAuthorization(db,{id:'fixture-authority',batchId:'fixture-batch',approvalId:approval.id,contractId:contract.id,budgetId:'fixture-budget',notBefore:at,expiresAt:expires,approvedBy:'Daniel Rosen',fixtureOnly:true,maxRequests:2,reservation:'0'});
 putRecord(db,'handoff_authorization',authority.id,authority);
 const input={id:'fixture-import',batchId:'fixture-batch',approvalId:approval.id,contractId:contract.id,authorizationId:authority.id,budgetId:'fixture-budget',reservation:'0',at};
 return {db,spec,packet,approval,input,contract,authority};
}
function transport(){
 const calls=[],leads=new Map();
 return {calls,leads,execute:async call=>{
  calls.push(structuredClone(call));
  if(call.tool==='mcp__codex_apps__instantly_ai_create_lead'){
   const lead={id:'fixture-lead-1',campaign:call.arguments.campaign,email:call.arguments.email,custom_variables:{}};leads.set(lead.id,lead);return {content:[],structuredContent:lead,isError:false};
  }
  if(call.tool==='mcp__codex_apps__instantly_ai_update_lead'){
   const lead={...leads.get(call.arguments.id),custom_variables:call.arguments.custom_variables};leads.set(lead.id,lead);return {content:[],structuredContent:lead,isError:false};
  }
  throw Error('Unknown fixture operation');
 }};
}
if(api){
test('saved actual schemas serialize create then scalar update, with durable import mapping and no activation',async()=>{
 const f=setup(),t=transport(),adapter=api.createIsolatedHandoffAdapter(f.db,t);
 assert.equal(evaluateRelease(f.db,f.input.batchId,f.approval.id,at).allowed,false);
 const prepared=api.prepareHandoff(f.db,f.input,{fixtureAdapter:adapter});assert.equal(prepared.mode,'ISOLATED_FIXTURE');
 const result=await api.executeHandoff(f.db,f.input.id,adapter,at);assert.equal(result.status,'SUCCEEDED');
 assert.deepEqual(t.calls.map(c=>c.tool),['mcp__codex_apps__instantly_ai_create_lead','mcp__codex_apps__instantly_ai_update_lead']);
 assert.deepEqual(t.calls[0].arguments,{campaign:f.spec.campaignId,email:f.spec.email});
 assert.deepEqual(Object.keys(t.calls[1].arguments).sort(),['custom_variables','id']);
 assert.equal(t.calls[1].arguments.id,'fixture-lead-1');
 assert.deepEqual(Object.keys(t.calls[1].arguments.custom_variables).sort(),['pilot_body_1','pilot_body_2','pilot_body_3','pilot_subject_1','pilot_subject_2','pilot_subject_3']);
 assert.match(t.calls[1].arguments.custom_variables.pilot_body_1,/equipment &amp; catering/);
 const imports=f.db.prepare("SELECT data_json FROM records WHERE kind='handoff_import'").all().map(r=>JSON.parse(r.data_json));
 assert.equal(imports.length,1);assert.equal(imports[0].leadId,'fixture-lead-1');assert.equal(imports[0].importOperationId,f.input.id);assert.equal(imports[0].status,'IMPORTED');
 assert.equal(operation(f.db,f.input.id).kind,'RELEASE');
 await assert.rejects(()=>api.executeHandoff(f.db,f.input.id,adapter,at),/terminal|reconciliation|replay|state/i);assert.equal(t.calls.length,2);f.db.close();
});
test('synthetic serialization and arbitrary transport are blocked outside exact fixture capability',async()=>{
 const f=setup(),t=transport(),adapter=api.createIsolatedHandoffAdapter(f.db,t);
 assert.throws(()=>api.prepareHandoff(f.db,f.input),/Synthetic|synthetic|fixture/i);
 api.prepareHandoff(f.db,f.input,{fixtureAdapter:adapter});
 await assert.rejects(()=>api.executeHandoff(f.db,f.input.id,{mode:'offline',execute:t.execute},at),/adapter|isolation|fixture/i);assert.equal(t.calls.length,0);f.db.close();
});
test('fixture capability refuses real-record contamination, wrong database and nonfixture file path',()=>{
 const f=setup(),t=transport(),adapter=api.createIsolatedHandoffAdapter(f.db,t);
 putRecord(f.db,'candidate','real',{qualification:'HOLD'});
 assert.throws(()=>api.prepareHandoff(f.db,f.input,{fixtureAdapter:adapter}),/isolation|synthetic/i);f.db.close();
 const other=setup();assert.throws(()=>api.prepareHandoff(other.db,other.input,{fixtureAdapter:adapter}),/isolation|adapter/i);other.db.close();
 const file=join(mkdtempSync(join(tmpdir(),'unrelated-db-')),'state.sqlite'),bad=setup({path:file});assert.throws(()=>api.createIsolatedHandoffAdapter(bad.db,t),/isolation|path/i);bad.db.close();
});
test('held, suppressed, stopped, unapproved policy and stale content gates stay active in fixtures',()=>{
 for(const state of ['held','suppressed','stopped','policy','content']){
  const f=setup(state==='held'?{held:true}:state==='policy'?{patchPolicy:{optOutApproved:false}}:{}),adapter=api.createIsolatedHandoffAdapter(f.db,transport());
  if(state==='suppressed')putRecord(f.db,'contact',f.spec.email,{...getRecord(f.db,'contact',f.spec.email),suppressed:true});
  if(state==='stopped')setStopped(f.db,true,'fixture stop');
  if(state==='content')putRecord(f.db,'writing_decision','content-approval',{...getRecord(f.db,'writing_decision','content-approval'),decision:'REVOKED'});
  assert.throws(()=>api.prepareHandoff(f.db,f.input,{fixtureAdapter:adapter}));assert.equal(f.db.prepare('SELECT count(*) n FROM operations').get().n,0);f.db.close();
 }
});
test('missing or altered provider contract and mismatched authority fail before reservation',()=>{
 for(const state of ['missing','contract','authority']){
  const f=setup(),adapter=api.createIsolatedHandoffAdapter(f.db,transport());
  if(state==='missing')f.db.prepare("DELETE FROM records WHERE kind='instantly_handoff_contract'").run();
  if(state==='contract')putRecord(f.db,'instantly_handoff_contract',f.contract.id,{...f.contract,variableNames:['not-approved']});
  if(state==='authority')putRecord(f.db,'handoff_authorization',f.authority.id,{...f.authority,campaignId:'another-campaign'});
  assert.throws(()=>api.prepareHandoff(f.db,f.input,{fixtureAdapter:adapter}),/contract|authority/i);assert.equal(f.db.prepare('SELECT count(*) n FROM operations').get().n,0);f.db.close();
 }
 const f=setup(),changed=structuredClone(snapshot);changed.schemas.find(x=>x.name.endsWith('create_lead')).schema+=' changed';assert.throws(()=>api.buildSavedInstantlyContract({...f.contract,snapshot:changed}),/contract|schema/i);f.db.close();
});
test('dispatch rechecks authority, stop and bindings after local preparation',async()=>{
 for(const state of ['authority','stop','content']){
  const f=setup(),t=transport(),adapter=api.createIsolatedHandoffAdapter(f.db,t);api.prepareHandoff(f.db,f.input,{fixtureAdapter:adapter});
  if(state==='authority')putRecord(f.db,'handoff_authorization',f.authority.id,{...f.authority,status:'CLOSED'});
  if(state==='stop')setStopped(f.db,true,'stop after prepare');
  if(state==='content')putRecord(f.db,'writing_decision','content-approval',{...getRecord(f.db,'writing_decision','content-approval'),decision:'REVOKED'});
  await assert.rejects(()=>api.executeHandoff(f.db,f.input.id,adapter,at));assert.equal(t.calls.length,0);assert.equal(operation(f.db,f.input.id).status,'PREPARED');f.db.close();
 }
});
test('ambiguous update survives restart, blocks duplicate job and reconciles exact imported content without replay',async()=>{
 const path=join(mkdtempSync(join(tmpdir(),'elya-handoff-')),'state.sqlite'),f=setup({path}),t=transport();
 const adapter=api.createIsolatedHandoffAdapter(f.db,{execute:async call=>{const response=await t.execute(call);if(call.tool.endsWith('update_lead'))throw Error('lost response');return response;}});
 api.prepareHandoff(f.db,f.input,{fixtureAdapter:adapter});assert.equal((await api.executeHandoff(f.db,f.input.id,adapter,at)).status,'RECONCILIATION');assert.equal(t.calls.length,2);
 f.db.close();const db=openStore(path);recoverOperations(db);const restarted=api.createIsolatedHandoffAdapter(db,t);
 await assert.rejects(()=>api.executeHandoff(db,f.input.id,restarted,at),/reconciliation|state|replay/i);
 assert.throws(()=>api.prepareHandoff(db,{...f.input,id:'duplicate'},{fixtureAdapter:restarted}),/Duplicate|reconciliation|already/i);
 const evidence={evidenceRef:'fixture provider state after restart',actual:'0',recipients:[{campaignId:f.spec.campaignId,email:f.spec.email,leadId:'fixture-lead-1',custom_variables:reviewVariables(f.packet)}]};
 const wrong=structuredClone(evidence);wrong.recipients[0].custom_variables.pilot_subject_1='changed';assert.throws(()=>api.reconcileHandoff(db,f.input.id,wrong,at),/mismatch/i);assert.equal(operation(db,f.input.id).status,'RECONCILIATION');
 assert.equal(api.reconcileHandoff(db,f.input.id,evidence,at).status,'SUCCEEDED');assert.equal(t.calls.length,2);db.close();
});
test('malformed provider output becomes uncertain, preserving reservation and preventing the next write',async()=>{
 const f=setup(),calls=[],adapter=api.createIsolatedHandoffAdapter(f.db,{execute:async call=>{calls.push(call);return {content:[],structuredContent:{id:'wrong-lead',email:'other@example.invalid',campaign:f.spec.campaignId}};}});
 api.prepareHandoff(f.db,f.input,{fixtureAdapter:adapter});assert.equal((await api.executeHandoff(f.db,f.input.id,adapter,at)).status,'RECONCILIATION');assert.equal(calls.length,1);assert.equal(operation(f.db,f.input.id).actual_usd,null);f.db.close();
});
test('a stalled fixture transport times out uncertain instead of hanging or sending the next request',async()=>{
 const f=setup(),adapter=api.createIsolatedHandoffAdapter(f.db,{timeoutMs:5,execute:async()=>new Promise(()=>{})});
 api.prepareHandoff(f.db,f.input,{fixtureAdapter:adapter});assert.equal((await api.executeHandoff(f.db,f.input.id,adapter,at)).status,'RECONCILIATION');assert.equal(getRecord(f.db,'handoff',f.input.id).requestCount,1);f.db.close();
});
test('stop after create prevents variable update and preserves the created remote identity for reconciliation',async()=>{
 const f=setup(),t=transport(),adapter=api.createIsolatedHandoffAdapter(f.db,{execute:async call=>{const r=await t.execute(call);setStopped(f.db,true,'stop while provider returns');return r;}});
 api.prepareHandoff(f.db,f.input,{fixtureAdapter:adapter});assert.equal((await api.executeHandoff(f.db,f.input.id,adapter,at)).status,'RECONCILIATION');assert.equal(t.calls.length,1);assert.equal(getRecord(f.db,'handoff',f.input.id).recipients[0].leadId,'fixture-lead-1');f.db.close();
});
test('saved QA payload result path is accepted without recursive extraction',async()=>{
 const saved=JSON.parse(readFileSync(new URL('../work/synthetic-qa-created-record.json',import.meta.url),'utf8')).readbacks.lead.value.structuredContent;
 assert.equal(Object.hasOwn(saved,'custom_variables'),false);assert.ok(HANDOFF_KEYS.every(k=>typeof saved.payload[k]==='string'));
 const f=setup(),t=transport(),adapter=api.createIsolatedHandoffAdapter(f.db,{execute:async call=>{
  const result=await t.execute(call);if(call.tool.endsWith('update_lead')){const lead=result.structuredContent;result.structuredContent={id:lead.id,campaign:lead.campaign,email:lead.email,payload:{email:lead.email,campaign:lead.campaign,...lead.custom_variables}};}return result;
 }});
 api.prepareHandoff(f.db,f.input,{fixtureAdapter:adapter});assert.equal((await api.executeHandoff(f.db,f.input.id,adapter,at)).status,'SUCCEEDED');assert.equal(t.calls.length,2);f.db.close();
});
test('payload variables reject wrong types, missing values, changed values and conflicting representations',async()=>{
 for(const variant of ['null','array','missing','changed','conflict','nested']){
  const f=setup(),t=transport(),adapter=api.createIsolatedHandoffAdapter(f.db,{execute:async call=>{
   const result=await t.execute(call);if(call.tool.endsWith('update_lead')){
    const lead=result.structuredContent,vars=lead.custom_variables;delete lead.custom_variables;lead.payload={...vars};
    if(variant==='null')lead.payload=null;
    if(variant==='array')lead.payload=[vars];
    if(variant==='missing')delete lead.payload.pilot_body_1;
    if(variant==='changed')lead.payload.pilot_body_1='changed';
    if(variant==='conflict'){lead.custom_variables={...vars};lead.payload.pilot_body_1='different';}
    if(variant==='nested')lead.payload={nested:vars};
   }return result;
  }});
  api.prepareHandoff(f.db,f.input,{fixtureAdapter:adapter});assert.equal((await api.executeHandoff(f.db,f.input.id,adapter,at)).status,'RECONCILIATION');assert.equal(t.calls.length,2);f.db.close();
 }
});
test('a provider lead identifier already bound to a different recipient cannot be reused',async()=>{
 const f=setup(),t=transport(),adapter=api.createIsolatedHandoffAdapter(f.db,t);
 putRecord(f.db,'handoff_import','prior-fixture-import',{status:'IMPORTED',campaignId:f.spec.campaignId,email:'another@example.invalid',candidateId:f.spec.candidateId,leadId:'fixture-lead-1',importOperationId:'old-fixture-operation'});
 api.prepareHandoff(f.db,f.input,{fixtureAdapter:adapter});assert.equal((await api.executeHandoff(f.db,f.input.id,adapter,at)).status,'RECONCILIATION');assert.equal(t.calls.length,1);f.db.close();
});
}

function realReview(){
 const {db,spec}=writingTelegramFixture(),candidateId='fixture-business',email='office@example.com';
 putRecord(db,'candidate',candidateId,{name:'Offline fixture',qualification:'QUALIFIED',operatingStatusCheckedAt:at});
 putRecord(db,'contact',email,{candidateId,email,attribution:'Fixture group inbox',attributionClass:'GROUP_SHARED',verification:'PASSED',verifiedAt:at,attributionCorroboratedAt:at,suppressed:false});
 putRecord(db,'refinement_current',candidateId,{semanticHash:'assessment-v1',disposition:'QUALIFIED_FOR_REVIEW'});
 putRecord(db,'refinement_assessment',candidateId+':assessment-v1',{businessFit:{state:'PASS'},contacts:[]});
 putRecord(db,'campaign',spec.campaignId,{purpose:'prospect',mustRemainInactive:false});
 putRecord(db,'writing_policy',spec.campaignId,{...getRecord(db,'writing_policy',spec.campaignId),synthetic:false,sequence:{steps:3,cadenceApproved:true,endpointApproved:true},physicalAddressApproved:true,physicalAddress:'123 Fixture Street',optOutApproved:true,optOut:{approved:true,mode:'REPLY_STOP',text:'Reply stop to end follow-up.'},approvalExpiry:{approved:true,approvedBy:'Daniel Rosen',approvedAt:at,revision:'fixture-only',maxAgeMs:300000}});
 const draftIds=spec.draftIds.map((id,i)=>{const next='real-boundary-step-'+i;putRecord(db,'draft',next,{...getRecord(db,'draft',id),candidateId,email});return next;});
 return {db,spec:{...spec,candidateId,email,synthetic:false,draftIds,steps:spec.steps.map((s,i)=>({...s,draftId:draftIds[i]}))}};
}
test('real content cannot be approved without including the configured address and opt-out text',()=>{
 const {db,spec}=realReview(),p=prepareWritingReview(db,spec);assert.equal(p.synthetic,false);
 assert.throws(()=>decideWritingReview(db,{actionId:'missing-footer',reviewId:p.reviewId,packetHash:p.hash,decision:'APPROVED',actor:'Daniel Rosen',at,expiresAt:expires,acknowledgedFindings:['FIXTURE_CAUTION']}),/BLOCK/);db.close();
});
test('real review decisions enforce the approved expiry and actual footer text can clear that content gate',()=>{
 const {db,spec}=realReview();
 for(const [i,id]of spec.draftIds.entries()){const next=id+'-footer',old=getRecord(db,'draft',id);putRecord(db,'draft',next,{...old,version:2,body:old.body+'\n123 Fixture Street\nReply stop to end follow-up.'});spec.draftIds[i]=next;spec.steps[i].draftId=next;}
 const p=prepareWritingReview(db,spec),input={actionId:'real-expiry',reviewId:p.reviewId,packetHash:p.hash,decision:'APPROVED',actor:'Daniel Rosen',at,expiresAt:expires,acknowledgedFindings:['FIXTURE_CAUTION']};
 assert.throws(()=>decideWritingReview(db,{...input,expiresAt:'2026-11-17T22:00:00Z'}),/EXPIRY/);
 assert.throws(()=>decideWritingReview(db,input),/ACKNOWLEDGMENT_REQUIRED/);
 const expectedReviewCodes=['FIXTURE_CAUTION','SEMANTIC_REVIEW_REQUIRED','SPARSE_EVIDENCE'];
 assert.deepEqual([...new Set(p.findings.filter(f=>f.severity==='REVIEW').map(f=>f.code))].sort(),expectedReviewCodes);
 input.acknowledgedFindings=expectedReviewCodes;
 const d=decideWritingReview(db,input);assert.equal(evaluateWritingReview(db,p.reviewId,d.id,at).contentApproved,true);db.close();
});
