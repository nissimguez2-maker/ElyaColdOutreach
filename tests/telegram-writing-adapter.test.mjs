import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {blockNetwork} from './helpers/network-block.mjs';
import {writingTelegramFixture,callback,at,expires} from './helpers/telegram-writing-fixture.mjs';
import {issueWritingTelegramReview} from '../src/telegram-writing-decisions.mjs';
import {deliverWritingTelegramFixture,consumeWritingTelegramFixtureUpdate} from '../src/telegram-writing-adapter.mjs';
import {createTelegramWritingFixtureApi} from '../src/telegram-api.mjs';
import {getRecord,openStore,putRecord,controls} from '../src/store.mjs';

function ready(t,path){blockNetwork(t);const f=writingTelegramFixture(path);t.after(()=>f.db.close());const r=issueWritingTelegramReview(f.db,{id:'offline-review',reviewId:f.packet.reviewId,packetHash:f.packet.hash,at,expiresAt:expires,expiryBasis:'EXPLICIT_SYNTHETIC_TEST'});f.review=r;return f;}
function fake(f,{failSend=false,failAck=false,beforeAck=()=>{}}={}){const calls=[];let next=100;const api=createTelegramWritingFixtureApi(async(method,body)=>{calls.push({method,body});if(method==='sendMessage'){if(failSend)throw Error('simulated uncertain send');return {status:200,body:JSON.stringify({ok:true,result:{message_id:next++,chat:{id:42,type:'private'},from:{id:777,is_bot:true}}})};}if(method==='answerCallbackQuery'){beforeAck();if(failAck)throw Error('simulated lost response');return {status:200,body:JSON.stringify({ok:true,result:true})};}throw Error('UNEXPECTED_FIXTURE_OPERATION');});return {api,calls};}
test('packet reaches existing transport parser; exact pages precede content-only durable approval and acknowledgment',async t=>{
 const f=ready(t),{api,calls}=fake(f,{beforeAck:()=>assert.equal(f.db.prepare("SELECT count(*) n FROM records WHERE kind='writing_decision'").get().n,1)});
 const send=await deliverWritingTelegramFixture(f.db,f.review.id,api,5000,at);assert.equal(send.status,'API_CONFIRMED');assert.equal(send.accepted.length,4);
 const review=getRecord(f.db,'telegram_writing_review',f.review.id);assert.equal(review.messageId,103);
 assert.equal(calls.filter(c=>c.method==='sendMessage').length,4);assert.match(calls[0].body.text,/CONTACT HELD/);assert.ok(calls[3].body.reply_markup);assert.equal(calls[3].body.parse_mode,undefined);
 const r=await consumeWritingTelegramFixtureUpdate(f.db,callback(review),api,5000,at);assert.equal(r.outcome.status,'APPROVED');assert.equal(r.response.status,'API_CONFIRMED');assert.equal(controls(f.db).stopped,true);assert.equal(controls(f.db).launchAuthorized,false);assert.equal(f.db.prepare('SELECT count(*) n FROM approvals').get().n,0);
 const duplicate=await consumeWritingTelegramFixtureUpdate(f.db,callback(review),api,5000,at);assert.equal(duplicate.outcome.status,'DUPLICATE_UPDATE');assert.equal(duplicate.response.status,'PREVIOUS_ATTEMPT_NO_RESEND');assert.equal(calls.filter(c=>c.method==='answerCallbackQuery').length,1);
});
test('uncertain send is preserved; repeat delivery blocked without resend',async t=>{
 const f=ready(t),{api,calls}=fake(f,{failSend:true});const r=await deliverWritingTelegramFixture(f.db,f.review.id,api,5000,at);
 assert.equal(r.status,'UNCERTAIN');assert.equal(getRecord(f.db,'telegram_writing_review',f.review.id).messageId,null);
 await assert.rejects(deliverWritingTelegramFixture(f.db,f.review.id,api,5000,at),/ALREADY_ATTEMPTED/);assert.equal(calls.length,1);
});
test('uncertain acknowledgment cannot erase durable decision or automatically resend after restart',async t=>{
 const path=join(mkdtempSync(join(tmpdir(),'elya-tg-adapter-')),'state.sqlite'),f=ready(t,path),first=fake(f,{failAck:true});
 await deliverWritingTelegramFixture(f.db,f.review.id,first.api,5000,at);const review=getRecord(f.db,'telegram_writing_review',f.review.id);
 const r=await consumeWritingTelegramFixtureUpdate(f.db,callback(review),first.api,5000,at);assert.equal(r.outcome.status,'APPROVED');assert.equal(r.response.status,'UNCERTAIN');
 f.db.close();f.db=openStore(path);const second=fake(f);
 const again=await consumeWritingTelegramFixtureUpdate(f.db,callback(review),second.api,5000,at);assert.equal(again.response.status,'PREVIOUS_ATTEMPT_NO_RESEND');assert.equal(second.calls.length,0);assert.equal(f.db.prepare("SELECT count(*) n FROM records WHERE kind='writing_decision'").get().n,1);
});
test('restart with acknowledgment intent requires reconciliation, not a resend',async t=>{
 const f=ready(t),{api,calls}=fake(f);await deliverWritingTelegramFixture(f.db,f.review.id,api,5000,at);
 const {digest}=await import('../src/values.mjs');putRecord(f.db,'telegram_callback_response',digest('1'),{status:'DISPATCH_INTENT'},'confirmed');
 const r=await consumeWritingTelegramFixtureUpdate(f.db,callback(getRecord(f.db,'telegram_writing_review',f.review.id)),api,5000,at);assert.equal(r.response.priorStatus,'DISPATCH_INTENT');assert.equal(calls.length,4);
});
test('details use read-only view; stop reuses existing mechanism and ends consumption',async t=>{
 const f=ready(t),{api,calls}=fake(f);await deliverWritingTelegramFixture(f.db,f.review.id,api,5000,at);
 const d=await consumeWritingTelegramFixtureUpdate(f.db,callback(getRecord(f.db,'telegram_writing_review',f.review.id),'DETAILS'),api,5000,at);assert.equal(d.outcome.status,'DETAILS');assert.equal(d.details.status,'API_CONFIRMED');assert.equal(f.db.prepare("SELECT count(*) n FROM records WHERE kind='writing_decision'").get().n,0);
 const stopped=await consumeWritingTelegramFixtureUpdate(f.db,{update_id:2,message:{text:'/stop',message_id:9,date:Math.floor(Date.parse(at)/1000),from:{id:42,is_bot:false},chat:{id:42,type:'private'}}},api,5000,at);
 assert.equal(stopped.endConsumption,true);assert.equal(stopped.outcome.status,'STOPPED');assert.equal(calls.filter(c=>c.method==='answerCallbackQuery').length,1);assert.equal(controls(f.db).stopped,true);
});
test('no implicit production transport; changed pairing cannot receive the review',async t=>{
 const f=ready(t),{api,calls}=fake(f);
 await assert.rejects(deliverWritingTelegramFixture(f.db,f.review.id,{mode:'LIVE'},5000,at),/NOT_AUTHORIZED/);
 const paired=getRecord(f.db,'telegram_binding','primary');putRecord(f.db,'telegram_binding','primary',{...paired,userId:50,chatId:50},'configuration');
 await assert.rejects(deliverWritingTelegramFixture(f.db,f.review.id,api,5000,at),/PAIRING/);assert.equal(calls.length,0);
});
test('already delivered Details replay never rerenders changed content or sends another page',async t=>{
 const f=ready(t),{api,calls}=fake(f);await deliverWritingTelegramFixture(f.db,f.review.id,api,5000,at);const u=callback(getRecord(f.db,'telegram_writing_review',f.review.id),'DETAILS');
 const first=await consumeWritingTelegramFixtureUpdate(f.db,u,api,5000,at);assert.equal(first.details.status,'API_CONFIRMED');const count=calls.length;
 const contact=getRecord(f.db,'contact',f.spec.email);putRecord(f.db,'contact',f.spec.email,{...contact,changed:true});
 const replay=await consumeWritingTelegramFixtureUpdate(f.db,u,api,5000,at);assert.equal(replay.outcome.status,'DUPLICATE_UPDATE');assert.equal(replay.details.status,'API_CONFIRMED');assert.equal(calls.length,count);
});
