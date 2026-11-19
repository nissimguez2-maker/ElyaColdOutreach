import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {getRecord,putRecord,controls,openStore,setStopped,setLaunch} from '../src/store.mjs';
import {prepareWritingReview,decideWritingReview,evaluateWritingReview,evaluateWritingBatch} from '../src/writing.mjs';
import {handleSyntheticControl} from '../src/telegram-decisions.mjs';
import {writingTelegramFixture,callback,at,expires} from './helpers/telegram-writing-fixture.mjs';
import {blockNetwork} from './helpers/network-block.mjs';
const api=await import('../src/telegram-writing-decisions.mjs').catch(()=>null);
test.beforeEach(t=>blockNetwork(t));
test('writing Telegram callback bridge is implemented',()=>assert.ok(api));
function ready(path){const f=writingTelegramFixture(path);const r=api.issueWritingTelegramReview(f.db,{id:'qa-writing-message',reviewId:f.packet.reviewId,packetHash:f.packet.hash,at,expiresAt:expires,expiryBasis:'EXPLICIT_SYNTHETIC_TEST'});return {...f,review:api.bindWritingTelegramMessage(f.db,r.id,100,at)};}
const decisions=db=>db.prepare("SELECT count(*) n FROM records WHERE kind='writing_decision'").get().n;
// Reserved example.org address, in memory only: exercise the real-policy branch
// without importing a real business or invoking any transport/provider adapter.
function policyPacket(f,approvalExpiry){
 const {db,spec}=f,candidateId='policy-contract-example',email='review@example.org',campaignId='policy-contract-example';
 for(const [kind,id,oldId,changes]of [['candidate',candidateId,spec.candidateId,{synthetic:false}],['contact',email,spec.email,{candidateId,email}],['campaign',campaignId,spec.campaignId,{purpose:'policy_contract_test'}],['refinement_current',candidateId,spec.candidateId,{}],['refinement_assessment',candidateId+':assessment-v1',spec.candidateId+':assessment-v1',{}],['writing_policy',campaignId,spec.campaignId,{synthetic:false,approvalExpiry}]])putRecord(db,kind,id,{...getRecord(db,kind,oldId),...changes});
 const draftIds=spec.draftIds.map((id,i)=>{const next=`policy-contract-example:step${i+1}`;putRecord(db,'draft',next,{...getRecord(db,'draft',id),candidateId,email});return next;});
 return prepareWritingReview(db,{...spec,reviewId:'policy-contract-review',candidateId,email,campaignId,draftIds,synthetic:false,steps:spec.steps.map((s,i)=>({...s,draftId:draftIds[i]}))});
}
if(api){
 test('explicit approved campaign expiry permits real content review without clearing contact holds',()=>{
  const f=writingTelegramFixture(),p=policyPacket(f,{approved:true,approvedBy:'Daniel Rosen',approvedAt:at,revision:'approved-fixture-policy',maxAgeMs:300000});
  const input={id:'real-policy-test',reviewId:p.reviewId,packetHash:p.hash,at,expiresAt:expires,expiryBasis:'APPROVED_CONTENT_POLICY'};
  assert.throws(()=>api.issueWritingTelegramReview(f.db,{...input,expiresAt:'2026-11-17T22:00:00Z'}),/EXPIRY/);
  const issued=api.issueWritingTelegramReview(f.db,input),r=api.bindWritingTelegramMessage(f.db,issued.id,100,at);
  assert.equal(r.syntheticOnly,false);assert.equal(api.handleWritingCallback(f.db,callback(r),at).status,'APPROVED');
  assert.equal(getRecord(f.db,'contact',f.spec.email).verification,'CATCH_ALL');assert.equal(controls(f.db).stopped,true);f.db.close();
 });
 test('real review cannot adopt an unapproved expiry, wrong approver or future policy',()=>{
  for(const expiry of [{approved:false},{approved:true,approvedBy:'Other',approvedAt:at,revision:'v1',maxAgeMs:300000},{approved:true,approvedBy:'Daniel Rosen',approvedAt:expires,revision:'v1',maxAgeMs:300000}]){
   const f=writingTelegramFixture(),p=policyPacket(f,expiry);
   assert.throws(()=>api.issueWritingTelegramReview(f.db,{id:'blocked-real',reviewId:p.reviewId,packetHash:p.hash,at,expiresAt:expires,expiryBasis:'APPROVED_CONTENT_POLICY'}),/EXPIRY/);f.db.close();
  }
 });
 test('real content-only review is compatible with separately authorized running controls',()=>{
  const f=writingTelegramFixture(),p=policyPacket(f,{approved:true,approvedBy:'Daniel Rosen',approvedAt:at,revision:'running-policy-fixture',maxAgeMs:300000});setStopped(f.db,false,'isolated policy fixture');setLaunch(f.db,true,'isolated policy fixture');const before=controls(f.db);
  const r=api.issueWritingTelegramReview(f.db,{id:'running-content',reviewId:p.reviewId,packetHash:p.hash,at,expiresAt:expires,expiryBasis:'APPROVED_CONTENT_POLICY'});api.bindWritingTelegramMessage(f.db,r.id,100,at);
  assert.equal(api.handleWritingCallback(f.db,callback(r),at).status,'APPROVED');assert.deepEqual(controls(f.db),before);assert.equal(f.db.prepare('SELECT count(*) n FROM approvals').get().n,0);f.db.close();
 });
 for(const action of ['APPROVED','REJECTED','REVISION_REQUESTED'])test(`authorized ${action} is durable, version-bound and content only`,()=>{
  const {db,packet,review}=ready(),before=controls(db),contact=getRecord(db,'contact',packet.email),result=api.handleWritingCallback(db,callback(review,action),at);
  assert.equal(result.status,action);const d=getRecord(db,'writing_decision',result.decisionId);assert.equal(d.packetHash,packet.hash);assert.equal(d.actor,'Daniel Rosen');assert.equal(d.decision,action);assert.deepEqual(d.acknowledgedFindings,['FIXTURE_CAUTION']);assert.equal(decisions(db),1);
  assert.equal(db.prepare('SELECT count(*) n FROM approvals').get().n,0);assert.equal(db.prepare('SELECT count(*) n FROM operations').get().n,0);assert.deepEqual(controls(db),before);assert.deepEqual(getRecord(db,'contact',packet.email),contact);
  const gate=evaluateWritingReview(db,packet.reviewId,d.id,at);assert.equal(gate.contentApproved,action==='APPROVED');assert.equal(gate.contactEligible,false);assert.equal(gate.campaignEligible,false);
  const content={campaignId:packet.campaignId,recipients:[{candidateId:packet.candidateId,email:packet.email,messages:packet.messages,writing:{reviewId:packet.reviewId,packetHash:packet.hash,decisionId:d.id}}],sequence:packet.policy.sequence};assert.equal(evaluateWritingBatch(db,content,at).allowed,false);db.close();
 });
 test('issuance requires explicit fixture-only expiry, exact packet, and unique durable references',()=>{
  const f=writingTelegramFixture();const input={id:'test',reviewId:f.packet.reviewId,packetHash:f.packet.hash,at,expiresAt:expires,expiryBasis:'EXPLICIT_SYNTHETIC_TEST'};
  assert.throws(()=>api.issueWritingTelegramReview(f.db,{...input,expiresAt:null}),/timestamp|EXPIRY/);assert.throws(()=>api.issueWritingTelegramReview(f.db,{...input,expiryBasis:null}),/EXPIRY/);assert.throws(()=>api.issueWritingTelegramReview(f.db,{...input,packetHash:'0'.repeat(64)}),/STALE/);
  const r=api.issueWritingTelegramReview(f.db,input);assert.equal(new Set(Object.values(r.actions)).size,4);for(const ref of Object.values(r.actions)){assert.match(ref,/^wr_[A-Za-z0-9_-]{22}$/);assert.ok(Buffer.byteLength(ref)<=64);assert.ok(!ref.includes(f.packet.email));}assert.throws(()=>api.issueWritingTelegramReview(f.db,input),/ALREADY/);
  assert.equal(api.handleWritingCallback(f.db,callback(r),at).status,'MESSAGE_NOT_BOUND');f.db.close();
 });
 test('unpaired, wrong sender/chat/group/bot/message and malformed callbacks never decide',()=>{
  const variants=[u=>u.callback_query.from.id=43,u=>u.callback_query.message.chat.id=43,u=>u.callback_query.message.chat.type='group',u=>u.callback_query.from.is_bot=true,u=>u.callback_query.message.from.id=778,u=>u.callback_query.message.from.is_bot=false,u=>u.callback_query.message.message_id=999,u=>u.callback_query.inline_message_id='foreign',u=>u.callback_query.data='wr_'+ 'a'.repeat(22),u=>u.callback_query.data='APPROVED',u=>u.callback_query.data=['bad'],u=>u.callback_query.message.forward_origin={type:'user'}];
  for(const change of variants){const {db,review}=ready(),u=callback(review);change(u);assert.notEqual(api.handleWritingCallback(db,u,at).status,'APPROVED');assert.equal(decisions(db),0);db.close();}
 });
 test('duplicate update, callback delivery, repeated press and conflicting decision cannot decide twice',()=>{
  const {db,review}=ready(),u=callback(review);assert.equal(api.handleWritingCallback(db,u,at).status,'APPROVED');assert.equal(api.handleWritingCallback(db,u,at).status,'DUPLICATE_UPDATE');assert.equal(api.handleWritingCallback(db,{...u,update_id:2},at).status,'DUPLICATE_CALLBACK');assert.equal(api.handleWritingCallback(db,callback(review,'APPROVED',3),at).status,'ALREADY_DECIDED');assert.equal(api.handleWritingCallback(db,callback(review,'REJECTED',4),at).status,'CONFLICTING_DECISION');assert.equal(decisions(db),1);db.close();
 });
 test('expired and pre-issue callbacks fail; exact pairing change fails',()=>{
  for(const scenario of ['expired','before','binding']){const {db,review}=ready();let time=scenario==='expired'?expires:scenario==='before'?'2026-11-16T21:59:59Z':at;if(scenario==='binding')putRecord(db,'telegram_binding','primary',{confirmed:true,userId:42,chatId:42,botId:778});assert.notEqual(api.handleWritingCallback(db,callback(review),time).status,'APPROVED');assert.equal(decisions(db),0);db.close();}
 });
 for(const target of ['contact','campaign','evidence','draft','assessment'])test(`${target} change and restore cannot revive callback`,()=>{
  const {db,spec,review}=ready();const [kind,id]=target==='contact'?['contact',spec.email]:target==='campaign'?['campaign',spec.campaignId]:target==='evidence'?['writing_evidence','fact-source']:target==='assessment'?['refinement_assessment',spec.candidateId+':assessment-v1']:['draft',spec.draftIds[0]];
  const old=getRecord(db,kind,id);if(kind==='draft'){const newid=id+'-new';putRecord(db,'draft',newid,{...old,version:2});db.prepare("DELETE FROM records WHERE kind='draft' AND id=?").run(newid);}else{putRecord(db,kind,id,{...old,changed:true});putRecord(db,kind,id,old);}
  assert.equal(api.handleWritingCallback(db,callback(review),at).status,'STALE_REVIEW');assert.equal(decisions(db),0);db.close();
 });
 test('new packet and revoked/superseded decisions cannot be revived by old buttons',()=>{
  const {db,spec,packet,review}=ready();const accepted=api.handleWritingCallback(db,callback(review),at);decideWritingReview(db,{actionId:'revoke',reviewId:packet.reviewId,packetHash:packet.hash,decision:'REVOKED',actor:'Daniel Rosen',expiresAt:expires,at,acknowledgedFindings:[]});assert.equal(api.handleWritingCallback(db,callback(review,'APPROVED',2),at).status,'REVOKED_OR_SUPERSEDED');assert.equal(evaluateWritingReview(db,packet.reviewId,accepted.decisionId,at).contentApproved,false);spec.unknowns.push('Changed');prepareWritingReview(db,spec);assert.equal(api.handleWritingCallback(db,callback(review,'REJECTED',3),at).status,'STALE_REVIEW');db.close();
 });
 test('details has no decision; stop reuses existing handler and no forbidden release follows',()=>{
  const {db,review}=ready();const r=api.handleWritingCallback(db,callback(review,'DETAILS'),at);assert.equal(r.status,'DETAILS');assert.equal(r.detailsRequested,true);assert.equal(decisions(db),0);
  setStopped(db,false,'fixture-only');assert.equal(api.handleWritingCallback(db,callback(review,'APPROVED',2),at).status,'BUSINESS_CONTROL_MISMATCH');const s=handleSyntheticControl(db,{update_id:3,message:{message_id:3,date:Math.floor(Date.parse(at)/1000),from:{id:42,is_bot:false},chat:{id:42,type:'private'},text:'/stop'}},at);assert.equal(s.status,'STOPPED');assert.equal(controls(db).stopped,true);assert.equal(controls(db).launchAuthorized,false);assert.equal(db.prepare('SELECT count(*) n FROM operations').get().n,0);db.close();
 });
 test('decision and shared receipt commit atomically; restart cannot replay',()=>{
  const path=join(mkdtempSync(join(tmpdir(),'elya-tg-writing-')),'db.sqlite'),{db,review}=ready(path),u=callback(review),before=db.prepare('SELECT count(*) n FROM journal').get().n;
  db.exec("CREATE TRIGGER fail_tg_receipt BEFORE INSERT ON records WHEN NEW.kind='telegram_control_receipt' BEGIN SELECT RAISE(ABORT,'fixture interruption'); END;");assert.throws(()=>api.handleWritingCallback(db,u,at),/interruption/);assert.equal(decisions(db),0);assert.equal(db.prepare('SELECT count(*) n FROM journal').get().n,before);assert.equal(getRecord(db,'telegram_writing_review',review.id).status,'PENDING');db.exec('DROP TRIGGER fail_tg_receipt');db.close();
  const restart=openStore(path);assert.equal(api.handleWritingCallback(restart,u,at).status,'APPROVED');restart.close();const again=openStore(path);assert.equal(api.handleWritingCallback(again,u,at).status,'DUPLICATE_UPDATE');assert.equal(decisions(again),1);again.close();
 });
 test('message binding cannot be replaced and unknown values are not logged',()=>{
  const {db,review}=ready();assert.throws(()=>api.bindWritingTelegramMessage(db,review.id,101,at),/MESSAGE_ALREADY_BOUND/);const u=callback(review);u.callback_query.data='Bearer do-not-log';assert.equal(api.handleWritingCallback(db,u,at).status,'INVALID_CALLBACK');const dump=db.prepare('SELECT data_json FROM records').all().map(r=>r.data_json).join('\n');assert.ok(!dump.includes('do-not-log'));assert.equal(decisions(db),0);db.close();
 });
 test('credential-like callback IDs are neither retained nor returned for acknowledgment',()=>{
  const {db,review}=ready(),u=callback(review);u.callback_query.id='apify_api_fixtureNotARealCredential';const result=api.handleWritingCallback(db,u,at);assert.equal(result.status,'INVALID_CALLBACK');assert.equal(result.callbackId,null);assert.ok(!JSON.stringify(db.prepare('SELECT data_json FROM records').all()).includes('fixtureNotARealCredential'));db.close();
 });
 test('relative-year content cannot be approved after its applicability year',()=>{
  const {db,spec}=writingTelegramFixture();const old=getRecord(db,'draft',spec.draftIds[0]),next='synthetic-writing:relative:v2';putRecord(db,'draft',next,{...old,version:2,body:old.body+'\nThis year is the fixture year.'});spec.draftIds[0]=next;spec.steps[0].draftId=next;const packet=prepareWritingReview(db,spec);
  const review=api.issueWritingTelegramReview(db,{id:'year-test',reviewId:packet.reviewId,packetHash:packet.hash,at,expiresAt:'2027-01-02T00:00:00Z',expiryBasis:'EXPLICIT_SYNTHETIC_TEST'});api.bindWritingTelegramMessage(db,review.id,100,at);assert.equal(api.handleWritingCallback(db,callback(review),'2027-01-01T00:00:00Z').status,'STALE_REVIEW');assert.equal(decisions(db),0);db.close();
 });
}
