import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync,backup} from 'node:sqlite';
import {mkdtempSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {blockNetwork} from './helpers/network-block.mjs';
import {getRecord,openStore,putRecord,controls} from '../src/store.mjs';
import {renderWritingReview,renderWritingStep,prepareWritingReview,evaluateWritingReview,evaluateWritingBatch} from '../src/writing.mjs';
import {renderTelegramWritingReview,CONTENT_DISCLAIMER} from '../src/telegram-writing-render.mjs';

async function copy(){const path=join(mkdtempSync(join(tmpdir(),'elya-tg-writing-held-')),'state.sqlite');const original=new DatabaseSync('data/elya.sqlite',{readOnly:true});try{await backup(original,path);}finally{original.close();}return openStore(path);}
test('historical quality-stale packets are rejected and current isolated held packets render exact copy without actions',async t=>{
 const guard=blockNetwork(t),db=await copy();t.after(()=>db.close());
 const protectedRows=()=>JSON.stringify(db.prepare("SELECT * FROM records WHERE kind IN ('draft','contact','campaign','writing_policy') ORDER BY kind,id").all());
 const before=protectedRows();
 for(const id of ['PHL-12-writing-v2','PHL-13-writing-v2']){
  const historical=getRecord(db,'writing_packet',getRecord(db,'writing_current',id).packetHash);
  assert.throws(()=>renderTelegramWritingReview(db,historical),/TELEGRAM_STALE_WRITING_PACKET/);
  // Prepare only in this disposable copy. Never rewrite or reapprove the old packet.
  const p=prepareWritingReview(db,{...historical.spec,reviewId:`current-render-${id}`}),r=renderTelegramWritingReview(db,p);
  assert.deepEqual(p.messages,historical.messages);
  const {issueWritingTelegramReview}=await import('../src/telegram-writing-decisions.mjs');
  assert.throws(()=>issueWritingTelegramReview(db,{id:`blocked-${id}`,reviewId:p.reviewId,packetHash:p.hash,at:p.spec.asOf,expiresAt:'2026-11-17T00:00:00Z',expiryBasis:'EXPLICIT_SYNTHETIC_TEST'}),/POLICY_EXPIRY_UNRESOLVED/);
  assert.equal(r.pages.length,4);assert.equal(r.actionable,false);assert.ok(r.pages.every(p=>p.text.length<=4096&&!p.reply_markup));
  assert.equal(r.state.contactHeld,true);assert.equal(r.state.contentApproved,false);assert.equal(r.state.handoffPermitted,false);
  assert.match(r.summary,/CONTACT HELD/);assert.match(r.summary,/approval-expiry policy/);assert.ok(r.summary.includes(CONTENT_DISCLAIMER));
  for(const f of p.findings.filter(f=>f.severity!=='NOTE'))assert.ok(r.summary.includes(f.detail));
  for(let i=0;i<3;i++){assert.ok(r.steps[i].includes(p.messages[i].subject));assert.ok(r.steps[i].includes(p.messages[i].body));assert.ok(renderWritingReview(p).includes(renderWritingStep(p,i)));}
 }
 assert.equal(protectedRows(),before);assert.equal(guard.attempts,0);
});
test('saved content approval is displayed accurately and expiry/revocation cannot appear approved',async t=>{
 blockNetwork(t);const {writingTelegramFixture,callback,at,expires}=await import('./helpers/telegram-writing-fixture.mjs');
 const {issueWritingTelegramReview,bindWritingTelegramMessage,handleWritingCallback}=await import('../src/telegram-writing-decisions.mjs');
 const {db,packet}=writingTelegramFixture();t.after(()=>db.close());
 let review=issueWritingTelegramReview(db,{id:'render-decision',reviewId:packet.reviewId,packetHash:packet.hash,at,expiresAt:expires,expiryBasis:'EXPLICIT_SYNTHETIC_TEST'});
 review=bindWritingTelegramMessage(db,review.id,100,at);handleWritingCallback(db,callback(review),at);review=getRecord(db,'telegram_writing_review',review.id);
 const approved=renderTelegramWritingReview(db,packet,{review,at});assert.equal(approved.state.contentApproved,true);assert.match(approved.summary,/Content: APPROVED \(content only\)/);assert.equal(approved.state.handoffPermitted,false);
 assert.equal(renderTelegramWritingReview(db,packet,{review,at:expires}).state.contentApproved,false);
 const d=getRecord(db,'writing_decision',review.decisionId);putRecord(db,'writing_decision',d.id,{...d,decision:'REVOKED'},'assessment');
 assert.equal(renderTelegramWritingReview(db,packet,{review,at}).state.contentApproved,false);
});
test('actual held data in isolated synthetic review fixture can approve content but cannot hand off',async t=>{
 const guard=blockNetwork(t),db=await copy();t.after(()=>db.close());
 const {issueWritingTelegramReview,bindWritingTelegramMessage,handleWritingCallback}=await import('../src/telegram-writing-decisions.mjs');
 const at='2026-11-16T22:00:00Z',expiresAt='2026-11-16T22:03:00Z';
 const protectedBefore=JSON.stringify(db.prepare("SELECT * FROM records WHERE kind IN ('draft','contact','campaign','writing_policy') ORDER BY kind,id").all());
 const binding=getRecord(db,'telegram_binding','primary');
 for(const [i,id]of ['PHL-12-writing-v2','PHL-13-writing-v2'].entries()){
  const old=getRecord(db,'writing_packet',getRecord(db,'writing_current',id).packetHash);
  const p=prepareWritingReview(db,{...old.spec,reviewId:`isolated-${id}`,synthetic:true});
  const r=issueWritingTelegramReview(db,{id:`held-fixture-${i}`,reviewId:p.reviewId,packetHash:p.hash,at,expiresAt,expiryBasis:'EXPLICIT_SYNTHETIC_TEST'});
  bindWritingTelegramMessage(db,r.id,800+i,at);
  const result=handleWritingCallback(db,{update_id:9000+i,callback_query:{id:`held-${i}`,from:{id:binding.userId,is_bot:false},data:r.actions.APPROVED,message:{message_id:800+i,date:Math.floor(Date.parse(at)/1000),from:{id:binding.botId,is_bot:true},chat:{id:binding.chatId,type:'private'}}}},at);
  assert.equal(result.status,'APPROVED');const g=evaluateWritingReview(db,p.reviewId,result.decisionId,at);
  assert.equal(g.contentApproved,true);assert.equal(g.contactEligible,false);assert.equal(g.campaignEligible,false);
  const batch={campaignId:p.campaignId,recipients:[{candidateId:p.candidateId,email:p.email,messages:p.messages,writing:{reviewId:p.reviewId,packetHash:p.hash,decisionId:result.decisionId}}],sequence:p.policy.sequence};
  assert.equal(evaluateWritingBatch(db,batch,at).allowed,false);
 }
 assert.equal(JSON.stringify(db.prepare("SELECT * FROM records WHERE kind IN ('draft','contact','campaign','writing_policy') ORDER BY kind,id").all()),protectedBefore);
 assert.equal(controls(db).stopped,true);assert.equal(controls(db).launchAuthorized,false);assert.equal(guard.attempts,0);
});
test('fixture Telegram API requires injected exchange; callback acknowledgment is a separate API action',async t=>{
 const guard=blockNetwork(t);const {createTelegramWritingFixtureApi}=await import('../src/telegram-api.mjs');
 assert.throws(()=>createTelegramWritingFixtureApi(),/EXCHANGE/);
 const calls=[];const api=createTelegramWritingFixtureApi(async(method,body)=>{calls.push({method,body});return {status:200,body:JSON.stringify({ok:true,result:method==='getUpdates'?[]:true})};});
 await api.poll(8,5000);await api.answerCallback('callback-1','Content decision recorded.',5000);
 assert.deepEqual(calls[0].body.allowed_updates,['message','callback_query']);assert.equal(calls[1].method,'answerCallbackQuery');assert.equal(calls[1].body.cache_time,0);assert.equal(guard.attempts,0);
});
test('review summary reflects configured policy instead of always declaring every policy unresolved',async t=>{
 blockNetwork(t);const {writingTelegramFixture,at}=await import('./helpers/telegram-writing-fixture.mjs');const f=writingTelegramFixture();t.after(()=>f.db.close());const p=getRecord(f.db,'writing_policy',f.spec.campaignId);
 putRecord(f.db,'writing_policy',f.spec.campaignId,{...p,sequence:{...p.sequence,cadenceApproved:true,endpointApproved:true},physicalAddressApproved:true,physicalAddress:'Example address for offline policy display only',optOutApproved:true,optOut:{approved:true,mode:'REPLY_STOP',text:'Reply stop'},approvalExpiry:{approved:true,approvedBy:p.approver,approvedAt:at,revision:'fixture-display',maxAgeMs:300000}});
 const packet=prepareWritingReview(f.db,f.spec),rendered=renderTelegramWritingReview(f.db,packet,{at});
 assert.doesNotMatch(rendered.summary,/Unresolved release requirements: cadence/);assert.match(rendered.summary,/Content approval remains separate from release authorization/);assert.equal(rendered.state.handoffPermitted,false);
});
