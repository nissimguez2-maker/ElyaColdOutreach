import test from 'node:test';
import assert from 'node:assert/strict';
import {getRecord,putRecord,controls} from '../src/store.mjs';
import {prepareWritingReview,evaluateWritingReview} from '../src/writing.mjs';
import {renderTelegramWritingReview} from '../src/telegram-writing-render.mjs';
import {issueWritingTelegramReview,bindWritingTelegramMessage,handleWritingCallback} from '../src/telegram-writing-decisions.mjs';
import {writingTelegramFixture,callback,at,expires} from './helpers/telegram-writing-fixture.mjs';
import {blockNetwork} from './helpers/network-block.mjs';

function firstTouch(t){
 const f=writingTelegramFixture();t.after(()=>f.db.close());
 const policy=getRecord(f.db,'writing_policy',f.spec.campaignId);
 putRecord(f.db,'writing_policy',f.spec.campaignId,{...policy,sequence:{steps:1,endpoint:'END_AFTER_FIRST_TOUCH',endpointApproved:true},approvalExpiry:{approved:true,approvedBy:policy.approver,approvedAt:at,revision:'fixture-calendar-v1',maxCalendarDays:7,timeZone:'America/New_York'}});
 const spec={...f.spec,contractVersion:'first-touch-only-v1',draftIds:f.spec.draftIds.slice(0,1),steps:f.spec.steps.slice(0,1)};
 return {...f,spec,packet:prepareWritingReview(f.db,spec)};
}

test('single first-touch review attaches existing buttons to its sole message without a cadence gate',t=>{
 const network=blockNetwork(t),{db,packet}=firstTouch(t);
 const review=issueWritingTelegramReview(db,{id:'single-render',reviewId:packet.reviewId,packetHash:packet.hash,at,expiresAt:expires,expiryBasis:'EXPLICIT_SYNTHETIC_TEST'});
 const rendered=renderTelegramWritingReview(db,packet,{review,at});
 assert.equal(rendered.pages.length,2);assert.equal(rendered.steps.length,1);
 assert.equal(rendered.pages[0].reply_markup,undefined);
 const buttons=rendered.pages[1].reply_markup.inline_keyboard.flat();
 assert.deepEqual(buttons.map(b=>b.text),['Approve content','Reject content','Request changes','Details']);
 assert.deepEqual(buttons.map(b=>b.callback_data),[review.actions.APPROVED,review.actions.REJECTED,review.actions.REVISION_REQUESTED,review.actions.DETAILS]);
 assert.match(rendered.summary,/one first.touch|one message/i);assert.match(rendered.summary,/no follow.up/i);
 assert.doesNotMatch(rendered.summary,/cadence and endpoint/);
 assert.match(rendered.summary,/physical-address footer/);assert.match(rendered.summary,/operative opt-out/);
 assert.equal(rendered.state.handoffPermitted,false);assert.equal(network.attempts,0);
});

test('single-message rendered opaque callback follows shared identity, message and exact-content decision checks',t=>{
 const network=blockNetwork(t),{db,packet}=firstTouch(t),before=controls(db),contact=getRecord(db,'contact',packet.email);
 let review=issueWritingTelegramReview(db,{id:'single-callback',reviewId:packet.reviewId,packetHash:packet.hash,at,expiresAt:expires,expiryBasis:'EXPLICIT_SYNTHETIC_TEST'});
 const rendered=renderTelegramWritingReview(db,packet,{review,at}),button=rendered.pages[1].reply_markup.inline_keyboard[0][0];
 review=bindWritingTelegramMessage(db,review.id,100,at);
 const wrong=callback(review,'APPROVED',10);wrong.callback_query.data=button.callback_data;wrong.callback_query.message.message_id=101;
 assert.equal(handleWritingCallback(db,wrong,at).status,'MESSAGE_MISMATCH');
 const unauthorized=callback(review,'APPROVED',11);unauthorized.callback_query.data=button.callback_data;unauthorized.callback_query.from.id=43;
 assert.equal(handleWritingCallback(db,unauthorized,at).status,'UNAUTHORIZED');
 assert.equal(db.prepare("SELECT count(*) n FROM records WHERE kind='writing_decision'").get().n,0);
 const accepted=callback(review,'APPROVED',12);accepted.callback_query.data=button.callback_data;
 const outcome=handleWritingCallback(db,accepted,at);assert.equal(outcome.status,'APPROVED');
 const decision=getRecord(db,'writing_decision',outcome.decisionId);assert.equal(decision.packetHash,packet.hash);
 const gate=evaluateWritingReview(db,packet.reviewId,outcome.decisionId,at);
 assert.equal(gate.contentApproved,true);assert.equal(gate.contactEligible,false);assert.equal(gate.campaignEligible,false);
 assert.equal(handleWritingCallback(db,accepted,at).status,'DUPLICATE_UPDATE');
 assert.deepEqual(controls(db),before);assert.deepEqual(getRecord(db,'contact',packet.email),contact);
 assert.equal(db.prepare('SELECT count(*) n FROM approvals').get().n,0);assert.equal(db.prepare('SELECT count(*) n FROM operations').get().n,0);
 assert.equal(network.attempts,0);
});

test('legacy three-message review still puts its keyboard on step three and retains cadence requirements',t=>{
 const network=blockNetwork(t),{db,packet}=writingTelegramFixture();t.after(()=>db.close());
 const review=issueWritingTelegramReview(db,{id:'legacy-render',reviewId:packet.reviewId,packetHash:packet.hash,at,expiresAt:expires,expiryBasis:'EXPLICIT_SYNTHETIC_TEST'});
 const rendered=renderTelegramWritingReview(db,packet,{review,at});
 assert.equal(rendered.pages.length,4);assert.ok(rendered.pages.slice(0,3).every(p=>p.reply_markup===undefined));assert.ok(rendered.pages[3].reply_markup);
 assert.match(rendered.summary,/cadence and endpoint/);assert.equal(network.attempts,0);
});

test('first-touch Telegram review rejects over-seven-day expiry even for isolated synthetic packets',t=>{
 blockNetwork(t);const {db,packet}=firstTouch(t);
 assert.throws(()=>issueWritingTelegramReview(db,{id:'overlong-single',reviewId:packet.reviewId,packetHash:packet.hash,at,expiresAt:'2026-11-24T22:00:00Z',expiryBasis:'EXPLICIT_SYNTHETIC_TEST'}),/POLICY_EXPIRY_UNRESOLVED/);
 assert.equal(db.prepare("SELECT count(*) n FROM records WHERE kind='telegram_writing_review'").get().n,0);
});

test('non-synthetic first-touch review uses approved calendar policy and exact rendered button without releasing held contact',t=>{
 blockNetwork(t);const f=firstTouch(t),{db,spec}=f;
 // Reserved example.org identities exercise the real-policy branch in memory.
 const candidateId='first-touch-policy-example',campaignId='first-touch-policy-example',email='review@example.org';
 for(const [kind,id,oldId,changes] of [
  ['candidate',candidateId,spec.candidateId,{synthetic:false}],
  ['contact',email,spec.email,{candidateId,email}],
  ['campaign',campaignId,spec.campaignId,{purpose:'policy_contract_test'}],
  ['refinement_current',candidateId,spec.candidateId,{}],
  ['refinement_assessment',candidateId+':assessment-v1',spec.candidateId+':assessment-v1',{}],
  ['writing_policy',campaignId,spec.campaignId,{synthetic:false}]
 ])putRecord(db,kind,id,{...getRecord(db,kind,oldId),...changes});
 const draftId='first-touch-policy-example:step1';
 putRecord(db,'draft',draftId,{...getRecord(db,'draft',spec.draftIds[0]),candidateId,email});
 const packet=prepareWritingReview(db,{...spec,reviewId:'first-touch-policy-review',candidateId,campaignId,email,synthetic:false,draftIds:[draftId],steps:[{...spec.steps[0],draftId}]});
 assert.equal(packet.synthetic,false);
 const issued=issueWritingTelegramReview(db,{id:'policy-single',reviewId:packet.reviewId,packetHash:packet.hash,at,expiresAt:expires,expiryBasis:'APPROVED_CONTENT_POLICY'});
 const review=bindWritingTelegramMessage(db,issued.id,100,at);
 const rendered=renderTelegramWritingReview(db,packet,{review,at});
 const u=callback(review);u.callback_query.data=rendered.pages[1].reply_markup.inline_keyboard[0][0].callback_data;
 const outcome=handleWritingCallback(db,u,at);assert.equal(outcome.status,'APPROVED');
 assert.equal(getRecord(db,'writing_decision',outcome.decisionId).packetHash,packet.hash);
 assert.equal(getRecord(db,'contact',email).verification,'CATCH_ALL');
 assert.equal(controls(db).stopped,true);assert.equal(controls(db).launchAuthorized,false);
 assert.equal(db.prepare('SELECT count(*) n FROM approvals').get().n,0);
 assert.equal(db.prepare('SELECT count(*) n FROM operations').get().n,0);
});
