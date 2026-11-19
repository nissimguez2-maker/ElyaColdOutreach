import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {openStore,getRecord,putRecord,controls} from '../src/store.mjs';
import {digest} from '../src/values.mjs';
import {seedAcceptanceFixture,prepareAcceptancePacket} from '../src/acceptance-telegram.mjs';
import {issueWritingTelegramReview,bindWritingTelegramMessage,handleWritingCallback} from '../src/telegram-writing-decisions.mjs';
import {renderTelegramWritingReview,WRITING_BUTTONS} from '../src/telegram-writing-render.mjs';
import {createTelegramConsumerFixtureApi} from '../src/telegram-api.mjs';
import {acceptanceTarget,nextAcceptanceAction,acceptanceOutcome} from '../src/acceptance-guidance.mjs';
import {armAcceptance} from '../src/acceptance-authority.mjs';
import {runAcceptanceSequence} from '../src/acceptance-controller.mjs';
import {instantlyAcceptanceCalls} from '../src/acceptance-instantly.mjs';
import {blockNetwork} from './helpers/network-block.mjs';

const at='2026-11-17T02:00:00.000Z',pair={botId:9012345678,userId:8123456789,chatId:8123456789};
const manifest=JSON.parse(readFileSync('work/acceptance-manifest-v1/manifest.json','utf8'));
const steps=[{key:'stale',target:'fresh-v1',action:'APPROVED',expectedResult:'STALE_REVIEW'},{key:'changes',target:'fresh-v2',action:'REVISION_REQUESTED',expectedResult:'REVISION_REQUESTED'}];

// A prospective fixture only: two fresh messages, no polling, credentials,
// production grant, real provider dispatch or reuse of the closed live session.
function remainingFixture(t,options={}){
 const db=openStore(':memory:');t.after(()=>db.close());seedAcceptanceFixture(db,pair,at);
 const wire=[],events=[],timeline=[],targets={},scenarios={stale:{status:'PENDING'},changes:{status:'PENDING'}};
 let messageId=100,updateId=1,lastOutcome;
 const saveEvent=event=>{events.push(event);putRecord(db,'fixture_operator_events','remaining',{events});timeline.push(event.event);};
 const api=createTelegramConsumerFixtureApi(async(method,body)=>{
  wire.push({method,body:structuredClone(body)});timeline.push(method);
  if(method==='answerCallbackQuery'){
   assert.equal(getRecord(db,'telegram_control_receipt',`${pair.botId}:${updateId-1}`).status,lastOutcome.status);
   assert.equal(getRecord(db,'fixture_operator_events','remaining').events.at(-1).status,lastOutcome.status);
   if(options.uncertainAck===lastOutcome.status)throw Error('fixture uncertain acknowledgment');
  }
  return {status:200,body:JSON.stringify({ok:true,result:method==='sendMessage'?{message_id:++messageId,chat:{id:pair.chatId,type:'private'},from:{id:pair.botId,is_bot:true}}:true})};
 });
 const show=async(packet,id,action)=>{
  const review=issueWritingTelegramReview(db,{id,reviewId:packet.reviewId,packetHash:packet.hash,at,expiresAt:'2026-11-17T02:10:00.000Z',expiryBasis:'EXPLICIT_SYNTHETIC_TEST'});
  const rendered=renderTelegramWritingReview(db,packet,{review,at}),source=rendered.pages.find(page=>page.reply_markup);
  const page={...source,reply_markup:{inline_keyboard:[[source.reply_markup.inline_keyboard.flat().find(button=>button.callback_data===review.actions[action])]]}};
  const sent=await api.sendPage(pair.chatId,page,2000);bindWritingTelegramMessage(db,id,sent.message_id,at);
  targets[id]=acceptanceTarget(page,{version:review.version,messageId:sent.message_id});
  return {...review,messageId:sent.message_id,page};
 };
 const click=async(review,action,key)=>{
  const update={update_id:updateId++,callback_query:{id:`fresh-click-${updateId}`,data:review.actions[action],from:{id:pair.userId,is_bot:false},message:{message_id:review.messageId,date:Date.parse(at)/1000,from:{id:pair.botId,is_bot:true},chat:{id:pair.chatId,type:'private'}}}};
  lastOutcome=handleWritingCallback(db,update,at);saveEvent(acceptanceOutcome(targets[review.id],action,lastOutcome.status,update.update_id));
  await api.answerCallback(lastOutcome.callbackId,lastOutcome.ackText,2000);saveEvent({event:'OPERATOR_ACK_STATUS',status:'API_CONFIRMED'});
  scenarios[key]={status:lastOutcome.status===steps.find(step=>step.key===key).expectedResult?'PASS':'FAILED'};
  putRecord(db,'fixture_scenarios','remaining',scenarios);
 };
 const prompt=()=>saveEvent(nextAcceptanceAction(steps,scenarios,targets));
 return {db,wire,events,timeline,scenarios,run:async()=>{
  try{
   const first=await show(prepareAcceptancePacket(db,'A',1,at),'fresh-v1','APPROVED');
   const revised=prepareAcceptancePacket(db,'A',2,at);
   assert.equal(db.prepare("SELECT count(*) n FROM records WHERE kind='writing_decision'").get().n,0);
   prompt();if(options.omitStale)return {status:'BLOCKED',scenarios,cleanup:{confirmed:true}};
   await click(first,'APPROVED','stale');
   if(scenarios.stale.status!=='PASS'||options.omitChanges)return {status:'BLOCKED',scenarios,cleanup:{confirmed:true}};
   assert.equal(getRecord(db,'fixture_scenarios','remaining').stale.status,'PASS');
   const second=await show(revised,'fresh-v2','REVISION_REQUESTED');prompt();await click(second,'REVISION_REQUESTED','changes');
   return {status:Object.values(scenarios).every(s=>s.status==='PASS')?'PASSED':'BLOCKED',scenarios,cleanup:{confirmed:options.cleanupConfirmed!==false}};
  }catch(error){return {status:'UNCERTAIN',reason:error.message,scenarios,cleanup:{confirmed:true}};}
 }};
}

test('fresh single-action reviews produce stale then changes without an earlier approval or any rejection',async t=>{
 const network=blockNetwork(t),f=remainingFixture(t),before=controls(f.db),result=await f.run();
 assert.equal(result.status,'PASSED',result.reason);assert.deepEqual(result.scenarios,{stale:{status:'PASS'},changes:{status:'PASS'}});
 const sends=f.wire.filter(call=>call.method==='sendMessage');assert.equal(sends.length,2);
 assert.deepEqual(sends.map(call=>call.body.reply_markup.inline_keyboard.flat().map(b=>b.text)),[['Approve content'],['Request changes']]);
 assert.ok(sends.every(call=>call.body.text.includes('## Step 3')&&!call.body.text.includes('Supporting details')));
 const prompts=f.events.filter(event=>event.event==='OPERATOR_NEXT_ACTION');assert.deepEqual(prompts.map(p=>[p.version,p.messageId,p.expectedResult]),[[1,101,'STALE_REVIEW'],[2,102,'REVISION_REQUESTED']]);
 assert.ok(!JSON.stringify(f.events).includes('wr_'));assert.deepEqual(f.events.filter(e=>e.event==='OPERATOR_OUTCOME').map(e=>e.status),['STALE_REVIEW','REVISION_REQUESTED']);
 const decisions=f.db.prepare("SELECT data_json FROM records WHERE kind='writing_decision'").all().map(r=>JSON.parse(r.data_json));assert.deepEqual(decisions.map(d=>d.decision),['REVISION_REQUESTED']);
 const firstAck=f.timeline.indexOf('answerCallbackQuery'),secondSend=f.timeline.lastIndexOf('sendMessage');assert.ok(firstAck<secondSend);assert.equal(f.wire.filter(c=>c.method==='answerCallbackQuery').length,2);
 assert.deepEqual(controls(f.db),before);assert.equal(network.attempts,0);
});

test('uncertain stale acknowledgment keeps its durable outcome and exposes no second message or next action',async t=>{
 const network=blockNetwork(t),f=remainingFixture(t,{uncertainAck:'STALE_REVIEW'}),result=await f.run();
 assert.equal(result.status,'UNCERTAIN');assert.equal(f.wire.filter(c=>c.method==='sendMessage').length,1);
 assert.equal(f.events.filter(e=>e.event==='OPERATOR_NEXT_ACTION').length,1);assert.equal(f.events.at(-1).status,'STALE_REVIEW');
 assert.equal(getRecord(f.db,'telegram_control_receipt',`${pair.botId}:1`).status,'STALE_REVIEW');assert.equal(network.attempts,0);
});

test('single-button wire validation accepts only existing labels and opaque callback references',async t=>{
 const network=blockNetwork(t),wire=[],api=createTelegramConsumerFixtureApi(async(method,body)=>{wire.push({method,body});return {status:200,body:JSON.stringify({ok:true,result:{message_id:1}})};});
 const button=(text,callback_data='wr_'+'a'.repeat(22))=>({text,callback_data});
 const page=buttons=>({text:'Synthetic single-action page',reply_markup:{inline_keyboard:buttons}});
 for(const label of Object.values(WRITING_BUTTONS))await api.sendPage(pair.chatId,page([[button(label)]]),2000);
 assert.equal(wire.length,4);
 for(const rows of [[[button('Unrecognized action')]],[[button('Approve content','not-an-opaque-reference')]],[[{...button('Approve content'),url:'https://example.invalid'}]],[[button('Approve content'),button('Request changes')]],[]])await assert.rejects(api.sendPage(pair.chatId,page(rows),2000),/INVALID_REVIEW_BUTTONS/);
 assert.equal(wire.length,4);assert.equal(network.attempts,0);
});

test('both remaining outcomes and cleanup gate the existing seven-call plan through the shared controller',async t=>{
 const network=blockNetwork(t);
 for(const options of [{},{omitStale:true},{omitChanges:true},{uncertainAck:'STALE_REVIEW'},{cleanupConfirmed:false}]){
  const f=remainingFixture(t,options),db=openStore(':memory:');t.after(()=>db.close());
  const source='src/acceptance-guidance.mjs';armAcceptance(db,manifest,[{path:source,sha256:digest(readFileSync(source))}],1000);
  const dispatched=[];
  const result=await runAcceptanceSequence({db,manifest,root:process.cwd(),now:()=>2000,telegram:()=>f.run(),instantly:async({phase,assertAuthority})=>{
   assertAuthority();for(const call of instantlyAcceptanceCalls(manifest,phase)){assertAuthority();dispatched.push(call);}
   return {status:'PASSED',cleanup:{confirmed:true}};
  }});
  if(!Object.keys(options).length){assert.equal(result.status,'PASS');assert.deepEqual(dispatched.map(call=>call.tool),['instantly_ai.get_campaign','instantly_ai.get_lead','instantly_ai.get_campaign','instantly_ai.get_lead','instantly_ai.update_lead','instantly_ai.get_lead','instantly_ai.get_campaign']);assert.deepEqual(dispatched[4].arguments,manifest.instantly.writeArguments);}
  else{assert.equal(result.status,'BLOCKED');assert.equal(dispatched.length,0);}
  assert.equal(getRecord(db,'acceptance_authorization',manifest.id).status,'CLOSED');
 }
 assert.equal(network.attempts,0);
});
