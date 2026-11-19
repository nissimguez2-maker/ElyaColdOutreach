import './helpers/deny-network-preload.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {firstTouchFixture,at} from './helpers/first-touch-fixture.mjs';
import {writingTelegramFixture} from './helpers/telegram-writing-fixture.mjs';
import {getRecord,putRecord,controls} from '../src/store.mjs';
import {prepareWritingReview,decideWritingReview,evaluateWritingReview,evaluateWritingBatch,reviewVariables,previewDraftingContext,renderWritingStep,writingApprovalExpiryAllowed} from '../src/writing.mjs';
const approve=(f,extra={})=>decideWritingReview(f.db,{actionId:'first-touch-content',reviewId:f.packet.reviewId,packetHash:f.packet.hash,decision:'APPROVED',actor:'Daniel Rosen',at,expiresAt:'2026-11-23T22:00:00Z',acknowledgedFindings:['FIXTURE_CAUTION'],...extra});

test('explicit first-touch review selects one exact message and two variables without approving follow-ups',t=>{
 const f=firstTouchFixture();t.after(()=>f.db.close());
 assert.equal(f.packet.contractVersion,'first-touch-only-v1');assert.equal(f.packet.messages.length,1);
 assert.deepEqual(Object.keys(reviewVariables(f.packet)),['pilot_subject_1','pilot_body_1']);
 assert.deepEqual(f.packet.policy.sequence,{steps:1,endpoint:'END_AFTER_FIRST_TOUCH',endpointApproved:true});
 const decision=approve(f),gate=evaluateWritingReview(f.db,f.packet.reviewId,decision.id,at);
 assert.equal(gate.contentApproved,true);assert.equal(gate.contactEligible,false);assert.equal(gate.campaignEligible,false);
 assert.equal(controls(f.db).stopped,true);assert.equal(controls(f.db).launchAuthorized,false);
 assert.equal(f.db.prepare('SELECT count(*) n FROM operations').get().n,0);
 assert.equal(f.db.prepare("SELECT count(*) n FROM records WHERE kind='writing_decision'").get().n,1);
 assert.throws(()=>renderWritingStep(f.packet,1),/WRITING_STEP_INDEX/);
});

test('new mode rejects extra drafts, mixed sequence settings, unknown modes and absent opt-in',t=>{
 for(const mutate of [f=>{f.spec.contractVersion='unknown';},f=>{delete f.spec.contractVersion;},f=>{f.spec.draftIds.push('extra');},f=>{f.spec.steps.push(f.spec.steps[0]);}]){
  const f=firstTouchFixture();try{mutate(f);assert.throws(()=>prepareWritingReview(f.db,f.spec));}finally{f.db.close();}
 }
 for(const patch of [{cadenceApproved:true},{delaysDays:[0]},{followUpCount:0},{endpoint:'FOLLOW_UP'},{steps:3},{endpointApproved:'true'}]){
  const f=firstTouchFixture();try{const p=getRecord(f.db,'writing_policy',f.spec.campaignId);putRecord(f.db,'writing_policy',f.spec.campaignId,{...p,sequence:{...p.sequence,...patch}});assert.throws(()=>prepareWritingReview(f.db,f.spec),/WRITING_SEQUENCE_REQUIRED/);}finally{f.db.close();}
 }
});

test('seven-calendar-day policy refuses overlong approval and preserves expiry as a policy not approval',t=>{
 const f=firstTouchFixture();t.after(()=>f.db.close());assert.equal(f.db.prepare("SELECT count(*) n FROM records WHERE kind='writing_decision'").get().n,0);
 assert.throws(()=>approve(f,{expiresAt:'2026-11-23T22:00:00.001Z'}),/EXPIRY/);
 const d=approve(f);assert.equal(evaluateWritingReview(f.db,f.packet.reviewId,d.id,'2026-11-23T22:00:00Z').contentApproved,false);
});

test('calendar expiry uses New York dates across spring and fall DST boundaries',t=>{
 const f=firstTouchFixture();t.after(()=>f.db.close());const policy={...f.packet.policy,approvalExpiry:{...f.packet.policy.approvalExpiry,approvedAt:'2026-01-01T00:00:00Z'}};
 for(const [start,end]of [['2026-03-01T17:00:00Z','2026-03-08T16:00:00Z'],['2026-10-25T16:00:00Z','2026-11-01T17:00:00Z'],['2026-12-28T17:00:00Z','2027-01-04T17:00:00Z']]){
  assert.equal(writingApprovalExpiryAllowed(policy,start,end,'first-touch-only-v1'),true);
  assert.equal(writingApprovalExpiryAllowed(policy,start,new Date(Date.parse(end)+1).toISOString(),'first-touch-only-v1'),false);
 }
 for(const patch of [{maxCalendarDays:8},{timeZone:'UTC'},{maxAgeMs:604800000},{approved:false}])assert.equal(writingApprovalExpiryAllowed({...policy,approvalExpiry:{...policy.approvalExpiry,...patch}},at,'2026-11-17T22:00:00Z','first-touch-only-v1'),false);
});

test('calendar expiry chooses the earlier fall overlap and never extends through a nonexistent spring clock time',t=>{
 const f=firstTouchFixture();t.after(()=>f.db.close());const policy={...f.packet.policy,approvalExpiry:{...f.packet.policy.approvalExpiry,approvedAt:'2026-01-01T00:00:00Z'}};
 assert.equal(writingApprovalExpiryAllowed(policy,'2026-10-25T05:30:00Z','2026-11-01T05:30:00Z','first-touch-only-v1'),true);
 assert.equal(writingApprovalExpiryAllowed(policy,'2026-10-25T05:30:00Z','2026-11-01T06:30:00Z','first-touch-only-v1'),false);
 assert.equal(writingApprovalExpiryAllowed(policy,'2026-03-01T07:30:00Z','2026-03-08T06:30:00Z','first-touch-only-v1'),true);
 assert.equal(writingApprovalExpiryAllowed(policy,'2026-03-01T07:30:00Z','2026-03-08T07:30:00Z','first-touch-only-v1'),false);
});

test('missing calendar policy cannot approve even synthetic first-touch content',t=>{
 const f=firstTouchFixture();t.after(()=>f.db.close());const policy=getRecord(f.db,'writing_policy',f.spec.campaignId);delete policy.approvalExpiry;
 putRecord(f.db,'writing_policy',f.spec.campaignId,policy);f.packet=prepareWritingReview(f.db,f.spec);
 assert.throws(()=>approve(f),/WRITING_APPROVAL_EXPIRY_POLICY_REQUIRED/);
 assert.equal(f.db.prepare("SELECT count(*) n FROM records WHERE kind='writing_decision'").get().n,0);
});

test('approved endpoint permits synthetic campaign eligibility without inventing cadence, while one exact recipient remains required',t=>{
 const f=firstTouchFixture();t.after(()=>f.db.close());const policy=getRecord(f.db,'writing_policy',f.spec.campaignId);
 putRecord(f.db,'writing_policy',f.spec.campaignId,{...policy,physicalAddressApproved:true,optOutApproved:true});
 putRecord(f.db,'campaign',f.spec.campaignId,{purpose:'synthetic_qa',mustRemainInactive:false});f.packet=prepareWritingReview(f.db,f.spec);
 const d=approve(f);assert.equal(evaluateWritingReview(f.db,f.packet.reviewId,d.id,at).campaignEligible,true);
 const recipient={candidateId:f.spec.candidateId,email:f.spec.email,messages:f.packet.messages,writing:{reviewId:f.packet.reviewId,packetHash:f.packet.hash,decisionId:d.id}};
 const check=evaluateWritingBatch(f.db,{campaignId:f.spec.campaignId,sequence:f.packet.policy.sequence,settings:{},recipients:[recipient,structuredClone(recipient)]},at);
 assert.equal(check.allowed,false);assert.ok(check.reasons.includes('First-touch-only requires one exact recipient'));
});

test('material first-touch revision invalidates the old exact-content approval',t=>{
 const f=firstTouchFixture();t.after(()=>f.db.close());const d=approve(f),old=f.packet;
 const id=f.spec.draftIds[0],draft=getRecord(f.db,'draft',id),newId=id+'-revision';
 putRecord(f.db,'draft',newId,{...draft,version:2,subject:'New exact first-touch subject'});f.spec.draftIds=[newId];f.spec.steps=[{...f.spec.steps[0],draftId:newId}];
 const revised=prepareWritingReview(f.db,f.spec);assert.notEqual(revised.hash,old.hash);assert.equal(getRecord(f.db,'writing_decision',d.id).decision,'INVALIDATED');
 assert.equal(evaluateWritingReview(f.db,old.reviewId,d.id,at).contentApproved,false);assert.throws(()=>approve(f,{actionId:'stale'}),/STALE/);
});

test('one-message context requests no follow-ups and no new policy choices',t=>{
 const f=firstTouchFixture();t.after(()=>f.db.close());const context=previewDraftingContext(f.db,f.spec);
 assert.equal(context.outputContract.draftCount,1);assert.deepEqual(context.outputContract.steps,[1]);
 assert.match(context.messages[0].content,/END_AFTER_FIRST_TOUCH/);assert.doesNotMatch(context.messages[0].content,/two complete proposed follow-ups/);
 assert.equal(context.trustedBusinessPolicy.physicalAddressApproved,false);assert.equal(context.trustedBusinessPolicy.optOutApproved,false);
});

test('legacy three-message contract and existing review remain unchanged by opt-in support',t=>{
 const f=writingTelegramFixture();t.after(()=>f.db.close());const again=prepareWritingReview(f.db,f.spec);
 assert.deepEqual(again,f.packet);assert.equal(again.hash,'7a1d8e69e19c9f3ab53445da8224fa238a6685b9db4fadef7754ef63c024a5ed');assert.equal(again.contractVersion,'offline-writing-v1');assert.equal(again.messages.length,3);
 assert.equal(Object.keys(reviewVariables(again)).length,6);
});
