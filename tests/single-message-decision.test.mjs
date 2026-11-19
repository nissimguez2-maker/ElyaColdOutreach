import test from 'node:test';
import assert from 'node:assert/strict';
import {writingTelegramFixture,at} from './helpers/telegram-writing-fixture.mjs';
import {getRecord,putRecord} from '../src/store.mjs';
import {createDraftingPacket,createDraftProvenanceTemplate,createCriticalReviewPacket} from '../src/drafting-handoff.mjs';
import {createBatch,decideApproval} from '../src/batches.mjs';
import {canonical} from '../src/values.mjs';
import {blockNetwork} from './helpers/network-block.mjs';
const dimensions=['FACTUAL_SUPPORT','ELYA_ROLE','COMMERCIAL_RELEVANCE','RECIPIENT_VALUE','VOICE_CONCISION','CTA','UNSUPPORTED_ASSUMPTIONS','REPETITION'];
function fixture(t){
 blockNetwork(t);const f=writingTelegramFixture();t.after(()=>f.db.close());
 const packet=createDraftingPacket(f.db,{spec:f.spec,businessContext:{version:'fixture-business-v1',offer:'Funding intermediary'},rubric:{version:'fixture-rubric-v1',dimensions},createdAt:at});
 const result={schemaVersion:'assisted-draft-output-v1',packetHash:packet.hash,contextHash:packet.context.hash,draftVersion:packet.draftVersion,disposition:'NEEDS_REVIEW',drafts:[1,2,3].map(step=>({step,subject:`Fixture subject ${step}`,body:`Hi QA team,\n\nOur fixture offers catering. Who handles financing conversations?\n\nDaniel Rosen\nHead of Operations and Underwriting\nElya Partners`,factIds:['catering'],angle:'Fixture only',uncertainties:['No release'],skepticalOwnerObjection:'Why another contact?',responseToObjection:'Unresolved.',ctaRationale:'Routing.'})),critique:{method:'AUTHOR_SELF_CRITIQUE',findings:[],unresolved:['No approval']}};
 const provenance=createDraftProvenanceTemplate(result),reviewBinding=createCriticalReviewPacket(packet,result);
 const review={schemaVersion:'assisted-review-output-v1',packetHash:packet.hash,reviewedDraftHash:reviewBinding.reviewedDraftHash,reviewedResultHash:reviewBinding.reviewedResultHash,verdict:'NEEDS_HUMAN_REVIEW',dimensions:dimensions.map(dimension=>({dimension,judgment:'PASS',reason:'Synthetic fixture judgment, not live evidence.',evidenceRefs:['catering']})),skepticalOwnerObjection:'Why?',proposedChanges:[],unresolved:['Human approval required']};
 return {...f,input:{packet,result,provenance,reviewBinding,review,reviewedSteps:[1],at,plan:{}}};
}
const snapshot=db=>canonical({records:db.prepare('SELECT * FROM records ORDER BY kind,id').all().map(r=>({...r})),operations:db.prepare('SELECT * FROM operations').all().map(r=>({...r})),approvals:db.prepare('SELECT * FROM approvals').all().map(r=>({...r})),batches:db.prepare('SELECT * FROM batches').all().map(r=>({...r})),budgets:db.prepare('SELECT * FROM budgets').all().map(r=>({...r})),controls:db.prepare('SELECT * FROM controls').all().map(r=>({...r}))});
async function api(){const m=await import('../src/single-message-decision.mjs').catch(()=>({}));assert.equal(typeof m.prepareSingleMessageDecision,'function');return m;}
test('one-message preview preserves exact first touch and cannot include hypothetical follow-ups or reserve work',async t=>{
 const f=fixture(t),m=await api(),before=snapshot(f.db),out=m.prepareSingleMessageDecision(f.db,f.input);
 assert.deepEqual(out.messages,[{subject:'Fixture subject 1',body:f.input.result.drafts[0].body}]);assert.equal(out.followUpCount,0);assert.equal(out.releaseAllowed,false);assert.equal(out.executable,false);assert.equal(out.window,null);assert.equal(snapshot(f.db),before);
 assert.match(m.renderSingleMessageDecision(out),/PREVIEW.*NOT RELEASED/);assert.doesNotMatch(m.renderSingleMessageDecision(out),/Fixture subject 2|Fixture subject 3/);
});
test('held and unknown-suppression contacts remain blocked despite eight editorial passes',async t=>{
 const f=fixture(t),m=await api(),out=m.prepareSingleMessageDecision(f.db,f.input);
 for(const r of ['CONTACT_VERIFICATION_HELD','SUPPRESSION_NOT_CLEARED','EXACT_CONTENT_AND_BATCH_APPROVAL_MISSING','PHYSICAL_FOOTER_UNAPPROVED','OPT_OUT_UNAPPROVED','MONITORING_COVERAGE_UNDECIDED','COST_EXPOSURE_OR_PERMISSION_UNRESOLVED'])assert.ok(out.blockers.includes(r),r);
 assert.equal(out.editorial.verdict,'NEEDS_HUMAN_REVIEW');assert.equal(out.editorial.contentApproval,false);assert.equal(out.status,'BLOCKED');
});
test('unapproved caller flags, extra recipients, and schedule cannot grant a single-message preview authority',async t=>{
 const f=fixture(t),m=await api();
 for(const plan of [{approved:true},{recipients:['another@example.invalid']},{window:'tomorrow'},{activate:true}])assert.throws(()=>m.prepareSingleMessageDecision(f.db,{...f.input,plan}),/PLAN_UNKNOWN_FIELD/);
});
test('changed copy cannot reuse a previous exact-text review',async t=>{
 const f=fixture(t),m=await api(),result=structuredClone(f.input.result);result.drafts[0].subject='Changed';
 assert.throws(()=>m.prepareSingleMessageDecision(f.db,{...f.input,result}),/REVIEW_COPY_BINDING_MISMATCH/);
});
test('an empty or mismatched review cannot become content approval',async t=>{
 const f=fixture(t),m=await api();assert.throws(()=>m.prepareSingleMessageDecision(f.db,{...f.input,review:{}}),/REVIEW_RESULT_SCHEMA/);
});
test('expired actual batch approval is rejected and batch first-touch mismatch is explicit',async t=>{
 const f=fixture(t),m=await api(),b=createBatch(f.db,'fixture-decision',{campaignId:f.spec.campaignId,sequence:{steps:1},settings:{},recipients:[{candidateId:f.spec.candidateId,email:f.spec.email,messages:[{subject:'Different message',body:'Fixture body'}]}]});
 const a=decideApproval(f.db,'fixture-decision',b.version,b.hash,'APPROVED','Daniel Rosen','2026-11-16T21:59:00Z','2026-11-16T21:00:00Z');
 const out=m.prepareSingleMessageDecision(f.db,{...f.input,plan:{batchId:'fixture-decision',approvalId:a.id}});
 assert.ok(out.blockers.includes('EXACT_FIRST_TOUCH_BATCH_MISMATCH'));assert.ok(out.blockers.some(r=>/expired/.test(r)));assert.equal(out.releaseAllowed,false);
});
test('missing actual approval remains blocked when operator supplies a plausible approval identifier',async t=>{
 const f=fixture(t),m=await api(),out=m.prepareSingleMessageDecision(f.db,{...f.input,plan:{batchId:'missing',approvalId:'looks-approved'}});
 assert.ok(out.blockers.includes('EXACT_CONTENT_AND_BATCH_APPROVAL_MISSING'));assert.equal(out.executable,false);
});
test('freshness is checked against meaningful record timestamps without renewing them',async t=>{
 const f=fixture(t);const contact=getRecord(f.db,'contact',f.spec.email);putRecord(f.db,'contact',f.spec.email,{...contact,verifiedAt:'2020-01-01T00:00:00Z'});
 const m=await api();assert.throws(()=>m.prepareSingleMessageDecision(f.db,f.input),/DRAFTING_STALE_CONTEXT/);
});
test('costs require exact decimal strings and unknown values cannot be silently treated as zero',async t=>{
 const f=fixture(t),m=await api();assert.throws(()=>m.prepareSingleMessageDecision(f.db,{...f.input,plan:{cost:{maximumUsd:0.15,basis:'estimate',permissionRef:null}}}),/exact|decimal|string/i);
 const out=m.prepareSingleMessageDecision(f.db,f.input);assert.equal(out.cost.maximumUsd,null);assert.equal(out.cost.basis,'UNKNOWN');assert.equal(out.cost.reservationCreated,false);
});
test('absence of a review or human decisions does not rewrite policy, create approval, or clear global stop',async t=>{
 const f=fixture(t),m=await api(),before=snapshot(f.db),out=m.prepareSingleMessageDecision(f.db,f.input);
 assert.equal(out.controls.stopped,true);assert.equal(out.controls.launchAuthorized,false);assert.equal(out.generalDispatchEnabled,false);assert.equal(snapshot(f.db),before);
 assert.ok(out.blockers.includes('APPROVAL_EXPIRY_POLICY_UNAPPROVED'));assert.ok(out.blockers.includes('SINGLE_MESSAGE_POLICY_NOT_APPROVED'));
});
test('a contact-driven refinement hold does not relabel a qualified business as disqualified',async t=>{
 const f=fixture(t),m=await api();
 putRecord(f.db,'refinement_current',f.spec.candidateId,{semanticHash:'assessment-v1',disposition:'HOLD'});
 const packet=createDraftingPacket(f.db,{spec:f.spec,businessContext:f.input.packet.businessContext,rubric:f.input.packet.rubric,createdAt:at});
 const result={...f.input.result,packetHash:packet.hash,contextHash:packet.context.hash},reviewBinding=createCriticalReviewPacket(packet,result);
 const review={...f.input.review,packetHash:packet.hash,reviewedDraftHash:reviewBinding.reviewedDraftHash,reviewedResultHash:reviewBinding.reviewedResultHash};
 const out=m.prepareSingleMessageDecision(f.db,{...f.input,packet,result,reviewBinding,review});
 assert.ok(out.blockers.includes('REFINEMENT_DISPOSITION_HELD'));assert.equal(out.blockers.includes('BUSINESS_QUALIFICATION_HELD'),false);
});
test('blocked or revise editorial verdict remains visible even when all dimension labels pass',async t=>{
 const f=fixture(t),m=await api();
 for(const verdict of ['BLOCKED','REVISE']){
  const review={...f.input.review,verdict,unresolved:['Synthetic unresolved factual concern'],proposedChanges:['Synthetic correction requested']};
  const out=m.prepareSingleMessageDecision(f.db,{...f.input,review}),readable=m.renderSingleMessageDecision(out);
  assert.ok(out.blockers.includes('EDITORIAL_VERDICT_'+verdict));assert.deepEqual(out.editorial.unresolved,review.unresolved);
  assert.match(readable,new RegExp('Editorial verdict: '+verdict));assert.match(readable,/Synthetic unresolved factual concern/);assert.match(readable,/Synthetic correction requested/);assert.equal(out.releaseAllowed,false);
 }
});
test('review note arrays are not mechanically converted into required copy changes',async t=>{
 const f=fixture(t),m=await api(),review={...f.input.review,proposedChanges:['Necessary first-touch corrections: none. Optional preference only.'],unresolved:['Follow-up slots were not reviewed; contact remains held.']};
 const out=m.prepareSingleMessageDecision(f.db,{...f.input,review});
 assert.equal(out.blockers.some(r=>r.startsWith('EDITORIAL_')),false);
 assert.match(m.renderSingleMessageDecision(out),/Necessary first-touch corrections: none/);
 assert.ok(out.blockers.includes('EXACT_CONTENT_AND_BATCH_APPROVAL_MISSING'));assert.equal(out.releaseAllowed,false);
});
test('missing or follow-up-only editorial scope cannot become a first-touch assessment',async t=>{
 const f=fixture(t),m=await api();
 for(const reviewedSteps of [null,[2]]){
  const input={...f.input,reviewedSteps};if(reviewedSteps===null)delete input.reviewedSteps;
  const out=m.prepareSingleMessageDecision(f.db,input);
  assert.ok(out.blockers.includes('FIRST_TOUCH_EDITORIAL_SCOPE_UNESTABLISHED'));assert.equal(out.editorial.scope,'FIRST_TOUCH_NOT_ESTABLISHED');assert.equal(out.releaseAllowed,false);
 }
 assert.throws(()=>m.prepareSingleMessageDecision(f.db,{...f.input,reviewedSteps:[1,1]}),/REVIEWED_STEPS/);
});
