// Contract probes only. Reserved synthetic recipient, in-memory SQLite, no transport.
import './helpers/deny-network-preload.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {writingTelegramFixture,at,expires} from './helpers/telegram-writing-fixture.mjs';
import {getRecord,putRecord,controls} from '../src/store.mjs';
import {prepareWritingReview,evaluateWritingBatch,reviewVariables} from '../src/writing.mjs';
import {hashBatch} from '../src/batches.mjs';
import {buildSavedInstantlyContract,HANDOFF_VARIABLES} from '../src/handoff.mjs';

function fixture(t){
 const f=writingTelegramFixture();
 t.after(()=>{
  assert.equal(f.db.prepare('PRAGMA database_list').all().find(r=>r.name==='main').file,'');
  for(const table of ['operations','approvals','batches'])assert.equal(f.db.prepare(`SELECT count(*) n FROM ${table}`).get().n,0);
  assert.equal(f.db.prepare("SELECT count(*) n FROM records WHERE kind IN ('writing_decision','handoff_authorization','handoff','handoff_import')").get().n,0);
  assert.equal(controls(f.db).stopped,true);
  assert.equal(controls(f.db).launchAuthorized,false);
  f.db.close();
 });
 return f;
}
function content(f,messages=f.packet.messages,sequence=f.packet.policy.sequence){
 return {campaignId:f.spec.campaignId,sequence,settings:{syntheticOnly:true},recipients:[{candidateId:f.spec.candidateId,email:f.spec.email,messages,writing:{reviewId:f.packet.reviewId,packetHash:f.packet.hash,decisionId:null}}]};
}
function providerInput(steps){
 const saved=JSON.parse(readFileSync(new URL('../work/instantly-capability-inspection.json',import.meta.url),'utf8'));
 return {id:'single-message-contract-probe',campaignId:'qa-single-message',snapshot:{schemas:saved.schemas,snapshot:{campaign:{value:{structuredContent:{id:'qa-single-message',status:1,sequences:[{steps}]}}}}},sourceRef:'fixture:locally-saved-schema-only',approvedBy:'fixture-operator',approvedAt:at,expiresAt:expires,observedAt:at,campaignStatusRule:{approvedStatuses:[1],evidenceRef:'fixture:status-rule'},fixtureOnly:false};
}
const providerStep=step=>({type:'email',variants:[{subject:`{{pilot_subject_${step}}}`,body:`{{pilot_body_${step}}}`} ]});

test('one first-touch draft and one descriptor are rejected by the current writing shape',t=>{
 const f=fixture(t),single={...f.spec,draftIds:f.spec.draftIds.slice(0,1),steps:f.spec.steps.slice(0,1)};
 assert.throws(()=>prepareWritingReview(f.db,single),/WRITING_SPEC_SHAPE/);
 assert.equal(getRecord(f.db,'writing_current',f.spec.reviewId).packetHash,f.packet.hash);
});

test('declaring a one-step policy cannot convert the retained three-slot review',t=>{
 const f=fixture(t),policy=getRecord(f.db,'writing_policy',f.spec.campaignId);
 putRecord(f.db,'writing_policy',f.spec.campaignId,{...policy,sequence:{steps:1,cadenceApproved:false,endpointApproved:false}});
 assert.throws(()=>prepareWritingReview(f.db,f.spec),/WRITING_SEQUENCE_REQUIRED/);
});

test('empty follow-up drafts cannot stand in for absent follow-ups',t=>{
 const f=fixture(t),id=f.spec.draftIds[1],replacement=id+'-empty';
 putRecord(f.db,'draft',replacement,{...getRecord(f.db,'draft',id),version:2,subject:'',body:''});
 f.spec.draftIds[1]=replacement;f.spec.steps[1].draftId=replacement;
 assert.throws(()=>prepareWritingReview(f.db,f.spec),/^Error: value required$/);
});

test('invented enabled/disabled metadata is retained but does not select executable slots',t=>{
 const f=fixture(t),policy=getRecord(f.db,'writing_policy',f.spec.campaignId);
 putRecord(f.db,'writing_policy',f.spec.campaignId,{...policy,sequence:{...policy.sequence,enabledSteps:[1],followUpCount:0}});
 f.spec.steps=f.spec.steps.map((step,i)=>({...step,enabled:i===0}));
 const packet=prepareWritingReview(f.db,f.spec);
 assert.deepEqual(packet.spec.steps.map(s=>s.enabled),[true,false,false]);
 assert.deepEqual(packet.policy.sequence.enabledSteps,[1]);
 assert.equal(packet.messages.length,3);
 const variables=reviewVariables(packet);
 assert.deepEqual(Object.keys(variables),HANDOFF_VARIABLES);
 assert.ok(variables.pilot_body_2.length>0&&variables.pilot_body_3.length>0);
});

test('a structurally valid one-message batch fails the writing packet binding',t=>{
 const f=fixture(t),single=content(f,f.packet.messages.slice(0,1),{steps:1,cadenceApproved:false,endpointApproved:false});
 assert.match(hashBatch(single),/^[a-f0-9]{64}$/);
 const result=evaluateWritingBatch(f.db,single,at);
 assert.equal(result.allowed,false);
 assert.ok(result.reasons.includes('Writing packet, recipient, messages or sequence mismatch'));
});

test('a one-step campaign snapshot is rejected by the nonfixture provider mapping validator',()=>{
 assert.throws(()=>buildSavedInstantlyContract(providerInput([providerStep(1)])),/Handoff current approved campaign variable mapping required/);
});

test('three remote step objects with invented disabled flags still bind all six variables',()=>{
 const input=providerInput([1,2,3].map(i=>({...providerStep(i),enabled:i===1})));
 const result=buildSavedInstantlyContract(input);
 assert.deepEqual(result.variableNames,HANDOFF_VARIABLES);
 assert.equal(result.variableNames.length,6);
 assert.equal(result.activationAllowed,false);
 // Pure returned object only: it is never stored, authorized or dispatched.
});
