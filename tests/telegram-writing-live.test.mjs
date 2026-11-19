import test from 'node:test';import assert from 'node:assert/strict';
import {blockNetwork} from './helpers/network-block.mjs';
import {openStore,putRecord,getRecord,controls} from '../src/store.mjs';
import {seedSyntheticWritingCard,makeWritingTestContract,TEST_ID,ACTIONS} from '../src/telegram-writing-live-card.mjs';
import {armWritingTest} from '../src/telegram-writing-authority.mjs';
import {runWritingLiveTest} from '../src/telegram-writing-live.mjs';
import {createTelegramWritingFixtureApi} from '../src/telegram-api.mjs';
const base=Date.parse('2026-11-16T22:00:00Z');
function fixture(t,options={}){
 const network=blockNetwork(t),db=openStore(':memory:'),syntheticDb=openStore(':memory:');t.after(()=>{db.close();syntheticDb.close();});
 const pairing={confirmed:true,userId:42,chatId:42,botId:777};putRecord(db,'telegram_binding','primary',pairing,'configuration');
 putRecord(db,'telegram_writing_cursor','primary',{nextOffset:100},'confirmed');
 putRecord(db,'draft','real-draft',{status:'UNAPPROVED',body:'Preserve real draft'},'confirmed');putRecord(db,'contact','held@example.invalid',{verification:'HELD'},'confirmed');
 const packet=seedSyntheticWritingCard(syntheticDb,pairing,new Date(base).toISOString()),contract=makeWritingTestContract(packet,pairing);
 if(options.arm!==false)armWritingTest(db,contract,new Date(base).toISOString());
 let clock=0,nextMessage=1,nextUpdate=100,actionIndex=0,tokenLoads=0,closed=0;const calls=[];
 const makeUpdate=(action)=>{
  const review=getRecord(syntheticDb,'telegram_writing_review',TEST_ID);
  if(action==='STOP'||action==='/stop')return {update_id:nextUpdate++,message:{message_id:90,date:Math.floor((base+clock)/1000),text:'/stop',from:{id:42,is_bot:false},chat:{id:42,type:'private'}}};
  // Label-click regressions take the opaque reference from the actual outbound
  // renderer payload, not from a second handcrafted label/action dictionary.
  const button=options.clickLabels?calls.find(c=>c.method==='sendMessage'&&c.body.reply_markup)?.body.reply_markup.inline_keyboard.flat().find(b=>b.text===action):null;
  if(options.clickLabels)assert.ok(button,'Requested button must exist in the actual rendered keyboard');
  const id=nextUpdate++;return {update_id:id,callback_query:{id:String(id),from:{id:42,is_bot:false},data:button?.callback_data??review.actions[action],message:{message_id:review.messageId,date:Math.floor(base/1000),from:{id:777,is_bot:true},chat:{id:42,type:'private'}}}};
 };
 const makeApi=(_token,guard)=>{
  const inner=createTelegramWritingFixtureApi(async(method,body,ms)=>{
   const boundedMs=guard(method,body,ms);assert.ok(boundedMs>0&&boundedMs<=ms);calls.push({method,body,ms:boundedMs});clock+=options.tickMs??1;
   if(options.onCall)await options.onCall({method,body,ms,calls,db,syntheticDb,setClock:v=>{clock=v;}});
   let result;
   if(method==='getMe')result={id:777,is_bot:true};
   if(method==='getWebhookInfo')result={url:options.webhook?'https://existing.invalid/webhook':''};
   if(method==='sendMessage'){if(options.failSend)throw Error('simulated uncertainty');result={message_id:nextMessage++,chat:{id:42,type:'private'},from:{id:777,is_bot:true},text:body.text};}
   if(method==='answerCallbackQuery'){if(options.failAck)throw Error('simulated uncertainty');result=true;}
   if(method==='getUpdates'){
    result=options.emptyPolls?[]:[makeUpdate((options.clickLabels??options.actions??ACTIONS)[actionIndex++]??'STOP')];
    if(options.unrelated)result.push({update_id:10000,message:{message_id:91,text:'Unrelated pending update',date:Math.floor(base/1000),from:{id:42,is_bot:false},chat:{id:42,type:'private'}}});
    if(options.pollResult)result=options.pollResult(result,{calls,makeUpdate,db,syntheticDb});
   }
   return {status:200,body:JSON.stringify({ok:true,result})};
  });return {...inner,mode:'LIVE_SYNTHETIC_WRITING',close:async()=>{closed++;return options.cleanupUnconfirmed?{closed:false,remainingRequests:1}:{closed:true,remainingRequests:0};}};
 };
 return {db,syntheticDb,contract,calls,network,get tokenLoads(){return tokenLoads;},get closed(){return closed;},setClock:v=>{clock=v;},
  run:()=>runWritingLiveTest({db,syntheticDb,contract,clock:()=>clock,wallClock:()=>base,loadToken:async()=>{tokenLoads++;if(options.credentialUnconfirmed)throw Error('WINDOWS_PROTECTION_CLEANUP_UNCONFIRMED');return 'FIXTURE_NO_CREDENTIAL';},makeApi})};
}
test('one exact card completes through existing adapter; no real approval, no forked synthetic cursor',async t=>{
 const f=fixture(t);const before=f.db.prepare("SELECT data_json FROM records WHERE kind IN ('draft','contact') ORDER BY kind").all();
 const r=await f.run();assert.equal(r.status,'COMPLETED',JSON.stringify(r));assert.equal(r.terminalReason,'REQUIRED_SEQUENCE_COMPLETED');assert.equal(r.authorizationStatus,'CLOSED');assert.equal(r.budget.attempts,18);assert.equal(f.closed,1);
 assert.deepEqual(r.commands.map(c=>c.outcome),['DETAILS','APPROVED','ALREADY_DECIDED','CONFLICTING_DECISION','CONFLICTING_DECISION','STOPPED']);
 assert.deepEqual(f.db.prepare("SELECT data_json FROM records WHERE kind IN ('draft','contact') ORDER BY kind").all(),before);assert.equal(f.db.prepare("SELECT count(*) n FROM records WHERE kind='writing_decision'").get().n,0);
 assert.equal(f.syntheticDb.prepare("SELECT count(*) n FROM records WHERE kind='writing_decision'").get().n,1);assert.equal(getRecord(f.syntheticDb,'telegram_writing_cursor','primary'),null);
 assert.equal(getRecord(f.db,'telegram_writing_cursor','primary').nextOffset,106);assert.equal(controls(f.db).stopped,true);assert.equal(controls(f.db).launchAuthorized,false);assert.equal(f.network.attempts,0);
 const count=f.calls.length;const repeated=await f.run();assert.equal(repeated.terminalReason,'AUTHORIZATION_NOT_ARMED');assert.equal(f.calls.length,count);
});
test('missing authorization prevents token access or transport initialization',async t=>{const f=fixture(t,{arm:false});const r=await f.run();assert.equal(r.terminalReason,'AUTHORIZATION_ABSENT');assert.equal(f.tokenLoads,0);assert.equal(f.calls.length,0);});
test('changed contract is terminal without initialization',async t=>{const f=fixture(t);f.contract.cardHash='0'.repeat(64);const r=await f.run();assert.equal(r.terminalReason,'AUTHORIZATION_MISMATCH');assert.equal(r.authorizationStatus,'CLOSED');assert.equal(f.tokenLoads,0);});
test('exclusive-owner failure closes this grant before initialization',async t=>{const f=fixture(t);putRecord(f.db,'telegram_consumer_owner','primary',{ownerId:'another',status:'ACTIVE'},'configuration');const r=await f.run();assert.equal(r.terminalReason,'TELEGRAM_CONSUMER_BUSY');assert.equal(r.authorizationStatus,'CLOSED');assert.equal(f.tokenLoads,0);assert.equal(getRecord(f.db,'telegram_consumer_owner','primary').ownerId,'another');});
test('existing webhook stops before messages or polling and is never changed',async t=>{const f=fixture(t,{webhook:true});const r=await f.run();assert.equal(r.terminalReason,'TELEGRAM_EXISTING_WEBHOOK');assert.deepEqual(f.calls.map(x=>x.method),['getMe','getWebhookInfo']);assert.equal(r.authorizationStatus,'CLOSED');});
test('entire batch checked first; unrelated update prevents decisions and cursor advance',async t=>{const f=fixture(t,{unrelated:true});const r=await f.run();assert.equal(r.terminalReason,'UNRELATED_PENDING_UPDATES');assert.equal(getRecord(f.db,'telegram_writing_cursor','primary').nextOffset,100);assert.equal(f.syntheticDb.prepare("SELECT count(*) n FROM records WHERE kind='writing_decision'").get().n,0);assert.equal(f.calls.filter(c=>c.method==='answerCallbackQuery').length,0);});
test('poll exhaustion cannot borrow ACK/details slots or the reserved stop poll',async t=>{const f=fixture(t,{emptyPolls:true});const r=await f.run();assert.equal(r.terminalReason,'STOP_POLL_RESERVED');assert.equal(r.budget.counts.polls,11);assert.equal(r.budget.counts.acknowledgments,0);assert.equal(r.budget.attempts,17);assert.equal(r.authorizationStatus,'CLOSED');});
for(const method of ['getUpdates','sendMessage'])test(`deadline during ${method} stops and closes without another request`,async t=>{
 let hit=false;const f=fixture(t,{onCall:({method:m,setClock})=>{if(m===method&&!hit){hit=true;setClock(170001);}}});const r=await f.run();assert.equal(r.status,'STOPPED_INCOMPLETE');assert.ok(r.requestEvidence.some(e=>e.error==='API_DEADLINE'));assert.equal(f.calls.at(-1).method,method);assert.equal(r.authorizationStatus,'CLOSED');assert.equal(f.closed,1);
});
test('uncertain send is recorded once, no polling or retry',async t=>{const f=fixture(t,{failSend:true});const r=await f.run();assert.equal(r.terminalReason,'DELIVERY_UNCERTAIN');assert.equal(f.calls.filter(c=>c.method==='sendMessage').length,1);assert.equal(f.calls.filter(c=>c.method==='getUpdates').length,0);assert.equal(r.authorizationStatus,'CLOSED');});
test('uncertain acknowledgment retains decision/outcome and cannot resume',async t=>{const f=fixture(t,{failAck:true});const r=await f.run();assert.equal(r.terminalReason,'CALLBACK_RESPONSE_UNCERTAIN');assert.equal(f.calls.filter(c=>c.method==='answerCallbackQuery').length,1);assert.equal(getRecord(f.db,'telegram_writing_cursor','primary').nextOffset,100);assert.equal(r.authorizationStatus,'CLOSED');});
test('early /stop uses actual global handler and makes no post-stop calls',async t=>{const f=fixture(t,{actions:['STOP']});const r=await f.run();assert.equal(r.terminalReason,'AUTHENTICATED_STOP_BEFORE_SEQUENCE_COMPLETE');assert.equal(f.calls.at(-1).method,'getUpdates');assert.equal(f.calls.filter(c=>c.method==='answerCallbackQuery').length,0);assert.match(controls(f.db).reason,/Authenticated synthetic Telegram stop/);assert.equal(r.authorizationStatus,'CLOSED');});
test('unexpected action does not create a decision or advance consumption',async t=>{const f=fixture(t,{actions:['REJECTED']});const r=await f.run();assert.equal(r.terminalReason,'UNEXPECTED_TEST_ACTION');assert.equal(getRecord(f.db,'telegram_writing_cursor','primary').nextOffset,100);assert.equal(f.syntheticDb.prepare("SELECT count(*) n FROM records WHERE kind='writing_decision'").get().n,0);});
test('insufficient time for details is detected before recording that action',async t=>{const f=fixture(t,{onCall:({method,setClock})=>{if(method==='getUpdates')setClock(161000);}});const r=await f.run();assert.equal(r.terminalReason,'INSUFFICIENT_ACTION_TIME');assert.equal(f.calls.filter(c=>c.method==='answerCallbackQuery').length,0);assert.equal(getRecord(f.db,'telegram_writing_cursor','primary').nextOffset,100);});
test('unconfirmed transport cleanup closes authorization but retains ownership in reconciliation',async t=>{
 const f=fixture(t,{actions:['STOP'],cleanupUnconfirmed:true});const r=await f.run();assert.equal(r.authorizationStatus,'CLOSED');assert.equal(r.terminalReason,'TRANSPORT_CLEANUP_UNCONFIRMED');assert.equal(getRecord(f.db,'telegram_consumer_owner','primary').status,'RECONCILIATION');assert.equal(r.cleanup.confirmed,false);
});
test('unconfirmed credential helper cleanup prevents all API calls and retains reconciliation ownership',async t=>{
 const f=fixture(t,{credentialUnconfirmed:true});const r=await f.run();assert.equal(r.authorizationStatus,'CLOSED');assert.equal(r.terminalReason,'CREDENTIAL_CLEANUP_UNCONFIRMED');assert.equal(f.calls.length,0);assert.equal(getRecord(f.db,'telegram_consumer_owner','primary').status,'RECONCILIATION');assert.equal(r.cleanup.confirmed,false);
});
test('actual rendered Details label traverses opaque decoder, sequence gate and handler successfully',async t=>{
 const f=fixture(t,{clickLabels:['Details','Approve content','Approve content','Request changes','Reject content','/stop']});
 const r=await f.run();assert.equal(r.status,'COMPLETED');assert.deepEqual(r.commands.map(x=>x.outcome),['DETAILS','APPROVED','ALREADY_DECIDED','CONFLICTING_DECISION','CONFLICTING_DECISION','STOPPED']);
 assert.equal(r.budget.counts.detailsMessages,1);assert.equal(r.budget.counts.acknowledgments,5);assert.equal(f.network.attempts,0);
});
test('unexpected actual rendered button records redacted pre-handler diagnostics without consuming it',async t=>{
 const f=fixture(t,{clickLabels:['Approve content']});const r=await f.run();
 assert.equal(r.terminalReason,'UNEXPECTED_TEST_ACTION');assert.deepEqual(r.unexpectedAction,{updateId:100,updateType:'CALLBACK_QUERY',observedAction:'APPROVED',expectedAction:'DETAILS',sequenceIndex:0,phase:'INTERACTIONS',classification:'BOUND_TEST_CALLBACK',actorChatCheck:'MATCHED',botCheck:'MATCHED',boundMessageId:4,receivedMessageId:4,packetVersion:1,packetVersionMatch:true,currentPacketCheck:'PASSED',handlerValidation:'NOT_RUN',handlerDispatched:false,observationPersisted:true,receiptCreatedForThisUpdate:false,decisionCommittedForThisUpdate:false,contentDecisionStatus:'PENDING',offsetBefore:100,offsetAfter:100,consumed:false,remoteQueueStatus:'UNOBSERVED_MAY_REMAIN_PENDING'});
 assert.equal(getRecord(f.db,'telegram_writing_cursor','primary').nextOffset,100);assert.equal(getRecord(f.syntheticDb,'telegram_writing_review',TEST_ID).status,'PENDING');
 const all=JSON.stringify(r)+JSON.stringify(f.db.prepare("SELECT details_json FROM journal WHERE event='WRITING_LIVE_UNEXPECTED_ACTION'").all());
 for(const ref of Object.values(getRecord(f.syntheticDb,'telegram_writing_review',TEST_ID).actions))assert.equal(all.includes(ref),false);
 assert.equal(f.syntheticDb.prepare("SELECT count(*) n FROM records WHERE kind IN ('telegram_control_receipt','writing_decision')").get().n,0);assert.equal(f.calls.filter(c=>c.method==='answerCallbackQuery').length,0);
});
test('delivery completion uses completion time after sends, not the start timestamp',async t=>{
 const f=fixture(t,{tickMs:1000,clickLabels:['/stop']});const r=await f.run();
 const lastSend=r.requestEvidence.filter(e=>e.kind==='initialMessages').at(-1);
 assert.ok(Date.parse(r.delivery.finishedAt)>Date.parse(r.delivery.startedAt));assert.ok(Date.parse(r.delivery.finishedAt)>=Date.parse(lastSend.finishedAt));
});
