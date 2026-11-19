import test from 'node:test';
import assert from 'node:assert/strict';
import {writingTelegramFixture} from './helpers/telegram-writing-fixture.mjs';
import {createDraftingPacket} from '../src/drafting-handoff.mjs';
import {setStopped,getRecord,putRecord,controls} from '../src/store.mjs';
import {createBudget,operation,budgetStatus,recoverOperations} from '../src/operations.mjs';
const api=await import('../src/drafting-caller.mjs').catch(e=>{if(e.code==='ERR_MODULE_NOT_FOUND')return {};throw e;});
const at='2026-11-18T20:00:00Z';
const dimensions=['FACTUAL_SUPPORT','ELYA_ROLE','COMMERCIAL_RELEVANCE','RECIPIENT_VALUE','VOICE_CONCISION','CTA','UNSUPPORTED_ASSUMPTIONS','REPETITION'];
function config(overrides={}){return {version:'elya-drafting-caller-v1',enabled:true,interface:'API',provider:'fixture-provider',generation:{model:'fixture-author',settings:{}},review:{model:'fixture-reviewer',settings:{}},timeoutMs:1000,maxInputBytes:500000,maxOutputBytes:100000,maxOutputTokens:4096,maxRevisions:1,chargeContract:{sourceRef:'fixture:reviewed-charge-cap',maximumPerCallUsd:'0.01',coversAllCharges:true},...overrides};}
function setup(t){
 assert.equal(typeof api.createDraftingCaller,'function','Optional provider-neutral caller required');
 const f=writingTelegramFixture();t.after(()=>f.db.close());setStopped(f.db,false,'Synthetic drafting fixture');createBudget(f.db,'draft-budget','1','0','0','Synthetic receipts only');
 const packet=createDraftingPacket(f.db,{spec:f.spec,businessContext:{version:'fixture-business',offer:'Synthetic financing intermediary context'},rubric:{version:'fixture-rubric',dimensions},createdAt:at});
 return {...f,packet,request:{id:'draft-session',packet,authority:{budgetId:'draft-budget',authorizationRef:'fixture:bounded-drafting',notBefore:at,expiresAt:'2026-11-18T21:00:00Z',maximumTotalUsd:'0.04'}}};
}
function response(request,{revise=false}={}){
 const schema=request.outputSchema,p=schema.properties;
 if(request.stage==='REVIEW')return {schemaVersion:'assisted-review-output-v1',packetHash:p.packetHash.const,reviewedDraftHash:p.reviewedDraftHash.const,reviewedResultHash:p.reviewedResultHash.const,verdict:revise?'REVISE':'NEEDS_HUMAN_REVIEW',dimensions:dimensions.map(dimension=>({dimension,judgment:revise?'REVISE':'PASS',reason:'Fixture judgment, no live writing assessment',evidenceRefs:['catering']})),skepticalOwnerObjection:'Why engage?',proposedChanges:revise?['Clarify relevance.']:[],unresolved:['Human exact-content approval required.']};
 return {schemaVersion:'assisted-draft-output-v1',packetHash:p.packetHash.const,contextHash:p.contextHash.const,draftVersion:p.draftVersion.const,disposition:'NEEDS_REVIEW',drafts:[1,2,3].map(step=>({step,subject:'Synthetic proposal '+step,body:`Hi QA team,\n\nSynthetic ${request.stage} content ${step}. No real offer.\n\nDaniel Rosen\nHead of Operations and Underwriting\nElya Partners`,factIds:['catering'],angle:'Synthetic contextual detail',uncertainties:['Fixture only'],skepticalOwnerObjection:'Why engage?',responseToObjection:'No unsupported financing claim.',ctaRationale:'No live action.'})),critique:{method:'AUTHOR_SELF_CRITIQUE',findings:[],unresolved:['Human review required.']}};
}
const receipt=(request,options={})=>({response:response(request,options),provider:request.provider,model:request.model,requestId:'fixture:'+request.operationId,actual:'0.001',chargeEvidenceRef:'fixture:charge:'+request.operationId});
test('caller defaults disabled and rejects consumer chat, implicit models, unknown fields and unbounded charges',async t=>{
 const {db,request}=setup(t);let calls=0;
 const caller=api.createDraftingCaller(undefined,{transport:{generate:async()=>{calls++;}}});
 await assert.rejects(caller.run(db,request),/DRAFTING_CALLER_DISABLED/);assert.equal(calls,0);
 for(const override of [{interface:'CONSUMER_CHAT'},{provider:''},{review:{model:'',settings:{}}},{maxRevisions:2},{fallbackProvider:'other'},{chargeContract:{sourceRef:'fixture',maximumPerCallUsd:'0',coversAllCharges:true}}])assert.throws(()=>api.validateDraftingCallerConfig(config(override)),/DRAFTING_/);
 assert.equal(db.prepare('SELECT count(*) n FROM operations').get().n,0);
});
test('generation and bound review retain actual prompts, source evidence, exact output hashes and no approval',async t=>{
 const {db,packet,request}=setup(t),requests=[];
 const caller=api.createDraftingCaller(config(),{clock:()=>at,assertDispatch:()=>true,transport:{generate:async r=>{requests.push(r);return receipt(r);}}});
 const result=await caller.run(db,request);
 assert.equal(result.status,'UNAPPROVED_NOT_SENDABLE');assert.equal(result.calls.length,2);assert.equal(result.contentApproval,false);assert.equal(result.releaseAuthorized,false);
 assert.match(requests[0].messages[0].content,/UNTRUSTED|untrusted/);assert.match(requests[0].messages[1].content,/offers catering/);assert.match(requests[1].messages[1].content,/Synthetic GENERATE content 1/);
 assert.equal(requests[1].outputSchema.properties.reviewedDraftHash.const,result.reviewBinding.reviewedDraftHash);
 assert.equal(result.envelope.packet.hash,packet.hash);assert.equal(result.proposal.provenance.generation.modelIdentityVerification,'NOT_PERFORMED');assert.equal(result.proposal.provenance.review.independence,'OPERATOR_REPORTED_SEPARATION_UNVERIFIED');
 assert.equal(getRecord(db,'drafting_call','draft-session:0:GENERATE').request.messages[1].content,requests[0].messages[1].content);
 assert.equal(budgetStatus(db,'draft-budget').actual,'0.002');assert.equal(db.prepare("SELECT count(*) n FROM records WHERE kind='draft'").get().n,3);assert.equal(controls(db).launchAuthorized,false);
 assert.deepEqual(await caller.run(db,request),result);assert.equal(requests.length,2);
});
test('one permitted revision gets a new exact review and four-call ceiling without implicit fallback',async t=>{
 const {db,request}=setup(t),requests=[];
 const caller=api.createDraftingCaller(config(),{clock:()=>at,transport:{generate:async r=>{requests.push(r);return receipt(r,{revise:true});}}});
 const result=await caller.run(db,request);assert.equal(requests.length,4);assert.deepEqual(requests.map(r=>r.stage),['GENERATE','REVIEW','REVISE','REVIEW']);
 assert.match(requests[2].messages.at(-1).content,/Clarify relevance/);assert.notEqual(requests[1].outputSchema.properties.reviewedDraftHash.const,requests[3].outputSchema.properties.reviewedDraftHash.const);
 assert.equal(result.review.verdict,'REVISE');assert.equal(result.revisionLimitReached,true);assert.equal(result.contentApproval,false);assert.equal(result.proposal.provenance.materialEdits.length,1);
 assert.deepEqual(new Set(requests.map(r=>r.model)),new Set(['fixture-author','fixture-reviewer']));
});
test('stopped, expired, undersized authority and old accounting schema fail before reservation or transport',async t=>{
 const {db,request}=setup(t);let calls=0;
 const caller=api.createDraftingCaller(config(),{clock:()=>at,transport:{generate:async()=>{calls++;}}});
 setStopped(db,true,'Fixture stop');await assert.rejects(caller.run(db,request),/DRAFTING_SYSTEM_STOPPED/);setStopped(db,false,'Fixture resume');
 await assert.rejects(caller.run(db,{...request,authority:{...request.authority,expiresAt:at}}),/DRAFTING_AUTHORITY/);
 await assert.rejects(caller.run(db,{...request,authority:{...request.authority,maximumTotalUsd:'0.03'}}),/DRAFTING_CHARGE_AUTHORITY/);
 const sql=db.prepare("SELECT sql FROM sqlite_master WHERE name='operations'").get().sql;db.exec('DROP TABLE operations');db.exec(sql.replace(",'DRAFT'",''));
 await assert.rejects(caller.run(db,request),/DRAFT_ACCOUNTING_SCHEMA_UNAVAILABLE/);assert.equal(calls,0);assert.equal(db.prepare('SELECT count(*) n FROM operations').get().n,0);
});
test('malformed output is retained as rejected evidence with known cost and cannot trigger review or a new generation',async t=>{
 const {db,request}=setup(t);let calls=0;
 const caller=api.createDraftingCaller(config(),{clock:()=>at,transport:{generate:async r=>{calls++;const x=receipt(r);x.response.drafts[0].factIds=['invented'];return x;}}});
 const result=await caller.run(db,request);assert.equal(result.status,'INVALID_OUTPUT');assert.equal(operation(db,'draft-session:0:GENERATE').status,'SUCCEEDED');assert.equal(budgetStatus(db,'draft-budget').actual,'0.001');
 assert.equal((await caller.run(db,request)).status,'INVALID_OUTPUT');assert.equal(calls,1);assert.equal(result.contentApproval,false);
});
test('missing charge receipt retains reservation and explicit reconciliation resumes without regenerating',async t=>{
 const {db,request}=setup(t);let calls=0,saved;
 const caller=api.createDraftingCaller(config(),{clock:()=>at,transport:{generate:async r=>{calls++;const x=receipt(r);if(r.stage==='GENERATE'){saved=x;return {...x,actual:null,chargeEvidenceRef:null};}return x;}}});
 assert.equal((await caller.run(db,request)).status,'RECONCILIATION');assert.equal(budgetStatus(db,'draft-budget').reserved,'0.01');
 assert.equal((await caller.run(db,request)).status,'RECONCILIATION');assert.equal(calls,1);
 api.reconcileDraftingCall(db,'draft-session:0:GENERATE',{...saved,evidenceRef:'fixture:explicit-reconciliation'},{at});
 const resumed=await caller.run(db,request);assert.equal(resumed.status,'UNAPPROVED_NOT_SENDABLE');assert.equal(calls,2);assert.equal(budgetStatus(db,'draft-budget').actual,'0.002');
});
test('timeout, cancellation and interrupted dispatch remain uncertain and redact transport errors',async t=>{
 for(const mode of ['timeout','cancel','interrupt']){
  const {db,request}=setup(t);request.id='draft-'+mode;let calls=0;const controller=new AbortController();
  const caller=api.createDraftingCaller(config({timeoutMs:10}),{clock:()=>at,transport:{generate:async r=>{calls++;if(mode==='interrupt'){recoverOperations(db);return receipt(r);}if(mode==='cancel')queueMicrotask(()=>controller.abort());return new Promise(()=>{});}}});
  const result=await caller.run(db,{...request,signal:controller.signal});assert.equal(result.status,'RECONCILIATION');assert.equal(operation(db,request.id+':0:GENERATE').status,'RECONCILIATION');assert.equal(calls,1);
 }
 const {db,request}=setup(t),caller=api.createDraftingCaller(config(),{clock:()=>at,transport:{generate:async()=>{throw Error('Bearer fixture-secret');}}});
 const result=await caller.run(db,request);assert.equal(result.status,'RECONCILIATION');assert.doesNotMatch(JSON.stringify(result),/fixture-secret/);assert.doesNotMatch(getRecord(db,'drafting_call','draft-session:0:GENERATE').error,/fixture-secret/);
});
test('current evidence changes between calls invalidate proposal and prevent review dispatch',async t=>{
 const {db,request,spec}=setup(t);let calls=0;
 const caller=api.createDraftingCaller(config(),{clock:()=>at,transport:{generate:async r=>{calls++;putRecord(db,'contact',spec.email,{...getRecord(db,'contact',spec.email),suppressed:true});return receipt(r);}}});
 const result=await caller.run(db,request);assert.equal(result.status,'INVALID_OUTPUT');assert.equal(calls,1);assert.equal(result.contentApproval,false);
});
test('one bounded authority cannot fund a second caller session under a new local id',async t=>{
 const {db,request}=setup(t);let calls=0;
 const caller=api.createDraftingCaller(config(),{clock:()=>at,transport:{generate:async r=>{calls++;return receipt(r);}}});
 await caller.run(db,request);await assert.rejects(caller.run(db,{...request,id:'different-id'}),/DRAFTING_AUTHORITY_ALREADY_BOUND/);assert.equal(calls,2);
});
test('a transient guard rejection before review can resume the saved generation without paid replay',async t=>{
 const {db,request}=setup(t);let calls=0,deny=false;
 const caller=api.createDraftingCaller(config(),{clock:()=>at,assertDispatch:()=>!deny,transport:{generate:async r=>{calls++;const x=receipt(r);if(r.stage==='GENERATE')deny=true;return x;}}});
 const first=await caller.run(db,request);assert.equal(first.status,'BLOCKED');assert.equal(calls,1);
 deny=false;const resumed=await caller.run(db,request);assert.equal(resumed.status,'UNAPPROVED_NOT_SENDABLE');assert.equal(calls,2);
});
test('receipt request identity cannot be reused across separate drafting stages',async t=>{
 const {db,request}=setup(t),caller=api.createDraftingCaller(config(),{clock:()=>at,transport:{generate:async r=>({...receipt(r),requestId:'same-provider-request'})}});
 const result=await caller.run(db,request);assert.equal(result.status,'RECONCILIATION');assert.equal(operation(db,'draft-session:0:REVIEW').status,'RECONCILIATION');
});
test('configured request and response limits bound the trusted transport and reject oversized output',async t=>{
 const {db,request}=setup(t);let calls=0;
 const tooSmall=api.createDraftingCaller(config({maxInputBytes:1}),{clock:()=>at,transport:{generate:async()=>{calls++;}}});
 assert.equal((await tooSmall.run(db,request)).status,'BLOCKED');assert.equal(calls,0);assert.equal(db.prepare('SELECT count(*) n FROM operations').get().n,0);
 const next={...request,id:'large-output',authority:{...request.authority,authorizationRef:'fixture:other-bounded-authority'}};
 const bounded=api.createDraftingCaller(config({maxOutputBytes:1}),{clock:()=>at,transport:{generate:async r=>{assert.equal(r.maxOutputTokens,4096);assert.equal(r.maxTotalChargeUsd,'0.01');calls++;return receipt(r);}}});
 assert.equal((await bounded.run(db,next)).status,'RECONCILIATION');assert.equal(calls,1);
});
test('known overrun remains recorded when a response violates the output-size bound',async t=>{
 const {db,request}=setup(t),caller=api.createDraftingCaller(config({maxOutputBytes:1}),{clock:()=>at,transport:{generate:async r=>({...receipt(r),actual:'0.02'})}});
 const result=await caller.run(db,request),saved=getRecord(db,'drafting_call','draft-session:0:GENERATE');
 assert.equal(result.status,'RECONCILIATION');assert.equal(saved.actual,'0.02');assert.equal(saved.responseJson,null);assert.equal(saved.requestId,'fixture:draft-session:0:GENERATE');assert.equal(budgetStatus(db,'draft-budget').blocked,true);assert.equal(budgetStatus(db,'draft-budget').reserved,'0.02');
});
