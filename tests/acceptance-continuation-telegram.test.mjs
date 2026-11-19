import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {openStore,getRecord,putRecord,controls} from '../src/store.mjs';
import {createTelegramConsumerFixtureApi} from '../src/telegram-api.mjs';
import {blockNetwork} from './helpers/network-block.mjs';
import {digest} from '../src/values.mjs';
import {armAcceptance} from '../src/acceptance-authority.mjs';
import {runAcceptanceSequence} from '../src/acceptance-controller.mjs';
import {instantlyAcceptanceCalls} from '../src/acceptance-instantly.mjs';

const runner=await import('../src/acceptance-continuation-telegram.mjs').catch(()=>null);
test('the fresh continuation has a separately bounded Telegram entry point',()=>assert.equal(typeof runner?.runAcceptanceContinuationTelegram,'function'));

const manifest=JSON.parse(readFileSync('work/acceptance-continuation-v1/manifest.json','utf8'));
const wall=Date.parse(manifest.telegram.snapshotAt)+1000,pair={confirmed:true,userId:8473827686,chatId:8473827686,botId:9077316901};
function fixture(t,options={}){
 const network=blockNetwork(t),db=openStore(':memory:'),syntheticDb=openStore(':memory:');t.after(()=>{db.close();syntheticDb.close();});
 putRecord(db,'telegram_binding','primary',pair);putRecord(db,'telegram_writing_cursor','primary',{nextOffset:64381646});putRecord(db,'contact','real-held',{status:'HELD'});putRecord(db,'draft','real-unapproved',{status:'UNAPPROVED'});
 const wire=[],events=[],timeline=[];let elapsed=0,messageId=100,nextUpdate=64381646,clicks=0,firstUpdate;
 const stop=()=>({update_id:nextUpdate++,message:{message_id:990,date:Math.floor((wall+elapsed)/1000),text:'/stop',from:{id:pair.userId,is_bot:false},chat:{id:pair.chatId,type:'private'}}});
 const makeApi=(_token,guard)=>{
  const api=createTelegramConsumerFixtureApi(async(method,body,ms)=>{
   guard(method,body,ms);wire.push({method,body,ms});timeline.push({method});elapsed+=options.tickMs??10;
   if(options.fail===method)throw Error('fixture transport failure');
   let result;
   if(method==='getMe')result={id:options.identityMismatch?1:pair.botId,username:'ElyaColdBot',is_bot:true};
   if(method==='getWebhookInfo')result={url:options.webhook?'https://example.invalid/hook':''};
   if(method==='sendMessage'){result={message_id:++messageId,chat:{id:pair.chatId,type:'private'},from:{id:pair.botId,is_bot:true}};if(options.lateSend)elapsed+=230000;}
   if(method==='answerCallbackQuery'){
    const persisted=getRecord(db,'acceptance_telegram',manifest.id);assert.equal(persisted.operatorEvents.at(-1).event,'OPERATOR_OUTCOME');
    if(options.nearDeadlineAfterStale&&clicks===1)elapsed=195000;
    result=true;
   }
   if(method==='getUpdates'){
    if(!Object.hasOwn(body,'offset'))result=options.preflightStop?[stop()]:options.preflightUnknown?[{update_id:64381646,message:{text:'PRIVATE_UNRELATED_TEXT'}}]:options.fullQueue?Array.from({length:100},(_,i)=>({update_id:64381646+i})):[];
    else if(options.stop)result=[stop()];
    else if(options.empty){result=[];elapsed+=options.pollMs??0;}
    else if(clicks<2){
     const version=clicks===0?1:2,review=syntheticDb.prepare("SELECT data_json FROM records WHERE kind='telegram_writing_review' AND json_extract(data_json,'$.version')=?").get(version);
     assert.ok(review,'No second callback before the second review exists');const r=JSON.parse(review.data_json),action=version===1?'APPROVED':'REVISION_REQUESTED';
     if(version===1){assert.equal(getRecord(syntheticDb,'writing_current',r.reviewId).version,2);assert.equal(syntheticDb.prepare("SELECT count(*) n FROM records WHERE kind='writing_decision'").get().n,0);}
     const u={update_id:nextUpdate++,callback_query:{id:`callback-${nextUpdate}`,data:r.actions[action],from:{id:pair.userId,is_bot:false},message:{message_id:r.messageId,date:Math.floor(Date.parse(r.issuedAt)/1000),from:{id:pair.botId,is_bot:true},chat:{id:pair.chatId,type:'private'}}}};
     clicks++;
     if(options.wrongSender)u.callback_query.from.id=1;
     if(options.wrongMessage)u.callback_query.message.message_id=999;
     if(options.hiddenAction)u.callback_query.data=r.actions.REJECTED;
     if(options.gap)u.update_id+=1;
     if(options.unknownReference)u.callback_query.data='wr_'+'x'.repeat(22);
     if(options.tamperCurrent)putRecord(syntheticDb,'writing_current',r.reviewId,{version:3,packetHash:'unapproved-packet'});
     if(options.duplicate&&firstUpdate)result=[firstUpdate,u];else result=[u];
     firstUpdate??=u;
    }else result=options.closureUnknown?[{update_id:nextUpdate,message:{text:'PRIVATE_CLOSURE_TEXT'}}]:[];
   }
   return {status:200,body:JSON.stringify({ok:true,result})};
  });return {...api,mode:'AUTHORIZED_TELEGRAM_OPERATIONAL',close:async()=>({closed:!options.cleanupFail,remainingRequests:options.cleanupFail?1:0})};
 };
 return {db,syntheticDb,wire,events,timeline,network,now:()=>wall+elapsed,run:(overrides={})=>runner.runAcceptanceContinuationTelegram({db,syntheticDb,manifest,loadToken:async()=> 'OFFLINE_FIXTURE',makeApi,assertAuthority:()=>{if(options.unapproved)throw Error('AUTHORIZATION_REQUIRED');return true;},startedMono:0,startedWall:wall,clock:()=>elapsed,emit:event=>{assert.deepEqual(getRecord(db,'acceptance_telegram',manifest.id).operatorEvents.at(-1),event);events.push(event);timeline.push({event:event.event,status:event.status});},...overrides})};
}
if(runner){
test('shared stale-check then shared request-changes use two exact single-button messages with durable console progression',async t=>{
 const f=fixture(t),before=controls(f.db),result=await f.run();assert.equal(result.status,'PASSED',JSON.stringify(result));assert.deepEqual(Object.values(result.scenarios).map(s=>s.status),['PASS','PASS']);
 assert.equal(result.scenarios.staleVersion.sharedHandler,true);assert.equal(result.preparedPackets.priorApprovalCreated,false);
 const sends=f.wire.filter(x=>x.method==='sendMessage');assert.equal(sends.length,2);assert.deepEqual(sends.map(x=>x.body.reply_markup.inline_keyboard.flat().map(b=>b.text)),[['Approve content'],['Request changes']]);
 assert.deepEqual(sends.map(x=>x.body.text),manifest.telegram.approvedPages.map(p=>p.text));assert.ok(f.wire.every(x=>!Object.hasOwn(x.body,'allowed_updates')));
 const polls=f.wire.filter(x=>x.method==='getUpdates');assert.deepEqual(polls[0].body,{timeout:0,limit:100});assert.equal(polls[1].body.offset,64381646);assert.equal(polls.at(-1).body.timeout,0);assert.equal(result.remoteAcknowledgment.lastApiConfirmedOffset,64381648);
 const decisions=f.syntheticDb.prepare("SELECT data_json FROM records WHERE kind='writing_decision'").all().map(r=>JSON.parse(r.data_json));assert.deepEqual(decisions.map(x=>x.decision),['REVISION_REQUESTED']);
 assert.deepEqual(f.events.filter(e=>e.event==='OPERATOR_NEXT_ACTION').map(e=>[e.version,e.messageId,e.buttonLabel]),[[1,101,'Approve content'],[2,102,'Request changes']]);
 assert.deepEqual(f.events.filter(e=>e.event==='OPERATOR_OUTCOME').map(e=>e.status),['STALE_REVIEW','REVISION_REQUESTED']);const firstOutcome=f.timeline.findIndex(e=>e.event==='OPERATOR_OUTCOME'),firstAck=f.timeline.findIndex(e=>e.method==='answerCallbackQuery'),secondSend=f.timeline.findLastIndex(e=>e.method==='sendMessage');assert.ok(firstOutcome<firstAck&&firstAck<secondSend);
 assert.equal(result.attempts.length,10);assert.equal(result.cleanup.confirmed,true);assert.equal(result.finalCursor,64381648);assert.deepEqual(controls(f.db),before);assert.equal(getRecord(f.db,'contact','real-held').status,'HELD');assert.equal(getRecord(f.db,'draft','real-unapproved').status,'UNAPPROVED');assert.equal(f.network.attempts,0);assert.ok(!JSON.stringify(result).includes('wr_'));
 const count=f.wire.length;assert.notEqual((await f.run()).status,'PASSED');assert.equal(f.wire.length,count);
});
for(const options of [{preflightUnknown:true},{fullQueue:true},{webhook:true},{identityMismatch:true},{wrongSender:true},{wrongMessage:true},{unknownReference:true},{hiddenAction:true},{gap:true},{unapproved:true}])test(`strict preconditions stop without unknown acknowledgment: ${JSON.stringify(options)}`,async t=>{
 const f=fixture(t,options),r=await f.run();assert.equal(r.status,'BLOCKED',JSON.stringify(r));assert.equal(r.counts.acknowledgments,0);assert.equal(r.finalCursor,64381646);assert.equal(r.scenarios.requestChanges.status,'PENDING');assert.equal(f.network.attempts,0);assert.ok(!JSON.stringify(r).includes('PRIVATE_'));
 if(options.preflightUnknown){assert.equal(f.wire.length,3);assert.equal(r.observations[0].disposition,'LEFT_PENDING');assert.equal(r.observations[0].observedAction,'UNKNOWN');}
 if(options.unapproved)assert.equal(f.wire.length,0);
});
test('exact duplicate receipt is not executed or acknowledged again',async t=>{const f=fixture(t,{duplicate:true}),r=await f.run();assert.equal(r.status,'PASSED',JSON.stringify(r));assert.equal(r.counts.acknowledgments,2);assert.ok(r.observations.some(o=>o.disposition==='EXACT_DUPLICATE_NO_REPLAY'));});
for(const fail of ['sendMessage','answerCallbackQuery'])test(`uncertain ${fail} is never retried`,async t=>{
 const f=fixture(t,{fail}),r=await f.run();assert.equal(r.status,'UNCERTAIN');assert.equal(f.wire.filter(x=>x.method===fail).length,1);assert.equal(r.counts.initialMessages,1);assert.equal(r.scenarios.requestChanges.status,'PENDING');
 if(fail==='answerCallbackQuery'){assert.equal(r.finalCursor,64381647);assert.equal(f.events.at(-1).status,'UNCERTAIN');assert.equal(getRecord(f.db,'telegram_control_receipt',`${pair.botId}:64381646`).status,'STALE_REVIEW');}
});
for(const options of [{stop:true},{preflightStop:true}])test(`a valid new stop ends all communication: ${JSON.stringify(options)}`,async t=>{const f=fixture(t,options),r=await f.run();assert.equal(r.status,'BLOCKED');assert.equal(r.reason,'AUTHENTICATED_STOP');assert.equal(r.stopReceived,true);assert.equal(f.wire.at(-1).method,'getUpdates');assert.equal(r.counts.acknowledgments,0);assert.equal(r.finalCursor,64381646);assert.equal(controls(f.db).stopped,true);assert.equal(controls(f.db).launchAuthorized,false);});
test('closure unknown update stays pending and blocks acceptance',async t=>{const f=fixture(t,{closureUnknown:true}),r=await f.run();assert.equal(r.status,'BLOCKED');assert.equal(r.reason,'CLOSURE_UPDATES_LEFT_PENDING');assert.equal(r.finalCursor,64381648);assert.equal(r.remoteAcknowledgment.lastApiConfirmedOffset,64381648);assert.equal(getRecord(f.db,'telegram_control_receipt',`${pair.botId}:64381648`),null);assert.ok(!JSON.stringify(r).includes('PRIVATE_CLOSURE_TEXT'));});
test('working polls cannot consume the closure slot or remaining required action budget',async t=>{const f=fixture(t,{empty:true}),r=await f.run();assert.equal(r.reason,'CONTINUATION_POLL_BUDGET_EXHAUSTED');assert.equal(r.counts.normalPolls,11);assert.ok(r.attempts.length<20);assert.equal(r.closure.status,'NOT_ATTEMPTED');assert.equal(r.counts.acknowledgments,0);});
test('time reserves end waiting before it consumes required sends and acknowledgments',async t=>{const f=fixture(t,{empty:true,pollMs:20000}),r=await f.run();assert.equal(r.reason,'INSUFFICIENT_TIME_FOR_REQUIRED_ACTIONS');assert.ok(r.elapsedMs<230000);assert.ok(r.counts.normalPolls<12);assert.equal(r.counts.initialMessages,1);});
test('late delivery reports uncertain execution and cannot trigger another request',async t=>{const f=fixture(t,{lateSend:true}),r=await f.run();assert.equal(r.status,'UNCERTAIN');assert.equal(r.reason,'TELEGRAM_CONTINUATION_API_DEADLINE');assert.equal(f.wire.at(-1).method,'sendMessage');assert.equal(r.counts.initialMessages,1);assert.equal(r.counts.acknowledgments,0);assert.equal(r.attempts.at(-1).returnedMessageId,101);});
test('cleanup uncertainty retains exclusive ownership for reconciliation',async t=>{const f=fixture(t,{fail:'answerCallbackQuery',cleanupFail:true}),r=await f.run();assert.equal(r.status,'BLOCKED');assert.equal(r.cleanup.confirmed,false);assert.equal(getRecord(f.db,'telegram_consumer_owner','primary').status,'RECONCILIATION');});
test('existing owner conflict is not stolen and no credential or transport operation begins',async t=>{const f=fixture(t);putRecord(f.db,'telegram_consumer_owner','primary',{ownerId:'other',status:'ACTIVE'});const r=await f.run();assert.equal(r.reason,'TELEGRAM_CONSUMER_BUSY');assert.equal(f.wire.length,0);assert.equal(getRecord(f.db,'telegram_consumer_owner','primary').ownerId,'other');});
test('unexpected current packet mutation cannot masquerade as the intended stale-version success',async t=>{const f=fixture(t,{tamperCurrent:true}),r=await f.run();assert.equal(r.scenarios.staleVersion.status,'PENDING');assert.equal(r.reason,'REVISED_PACKET_INTEGRITY_CHANGED');assert.equal(r.counts.acknowledgments,0);assert.equal(r.finalCursor,64381646);});
test('insufficient time after stale acknowledgment sends no unusable second prompt or message',async t=>{const f=fixture(t,{nearDeadlineAfterStale:true}),r=await f.run();assert.equal(r.reason,'INSUFFICIENT_TIME_FOR_REQUIRED_ACTIONS');assert.equal(r.scenarios.staleVersion.status,'PASS');assert.equal(r.counts.initialMessages,1);assert.equal(f.events.filter(e=>e.event==='OPERATOR_NEXT_ACTION').length,1);assert.equal(r.cleanup.confirmed,true);});
test('real continuation runner composes with one-use authority and controller before the exact seven-call plan',async t=>{
 const f=fixture(t),oldId='elya-acceptance-manifest-v1';
 putRecord(f.db,'acceptance_authorization',oldId,{status:'CLOSED',reason:'TELEGRAM_SEGMENT_NOT_PASSED'});
 putRecord(f.db,'acceptance_telegram',oldId,{status:'BLOCKED',finalCursor:64381646,remoteAcknowledgment:{lastApiConfirmedOffset:64381646},cleanup:{confirmed:true}});
 const before={oldGrant:getRecord(f.db,'acceptance_authorization',oldId),oldRun:getRecord(f.db,'acceptance_telegram',oldId),controls:controls(f.db)};
 const path='src/acceptance-continuation-contract.mjs';armAcceptance(f.db,manifest,[{path,sha256:digest(readFileSync(path))}],wall-1000);
 const calls=[],result=await runAcceptanceSequence({db:f.db,manifest,root:process.cwd(),now:f.now,startedAtMs:wall,startedMono:0,telegram:({assertAuthority})=>f.run({assertAuthority}),instantly:async({phase,assertAuthority})=>{assertAuthority();calls.push(...instantlyAcceptanceCalls(manifest,phase));return {status:'PASSED',cleanup:{confirmed:true}};}});
 assert.equal(result.status,'PASS',JSON.stringify(result));assert.equal(result.authorizationStatus,'CLOSED');assert.equal(calls.length,7);assert.deepEqual(calls[4].arguments,manifest.instantly.writeArguments);
 assert.equal(getRecord(f.db,'acceptance_authorization',manifest.id).status,'CLOSED');assert.deepEqual(getRecord(f.db,'acceptance_authorization',oldId),before.oldGrant);assert.deepEqual(getRecord(f.db,'acceptance_telegram',oldId),before.oldRun);assert.deepEqual(controls(f.db),before.controls);assert.equal(f.network.attempts,0);
});
}
