import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {openStore,getRecord,putRecord,controls} from '../src/store.mjs';
import {digest,canonical} from '../src/values.mjs';
import {createTelegramConsumerFixtureApi} from '../src/telegram-api.mjs';
import {blockNetwork} from './helpers/network-block.mjs';
const runner=await import('../src/acceptance-telegram.mjs').catch(()=>null);
const manifest=JSON.parse(readFileSync('work/acceptance-manifest-v1/manifest.json','utf8'));
const wall=Date.parse('2026-11-17T02:00:00Z'),pair={confirmed:true,userId:8473827686,chatId:8473827686,botId:9077316901};
function fixture(t,options={}){
 const network=blockNetwork(t),db=openStore(':memory:'),syntheticDb=openStore(':memory:'),legacyDb=openStore(':memory:');t.after(()=>{db.close();syntheticDb.close();legacyDb.close();});
 putRecord(db,'telegram_binding','primary',pair);putRecord(db,'telegram_writing_cursor','primary',{nextOffset:64381638});putRecord(db,'contact','held-original',{status:'HELD'});putRecord(db,'draft','original-draft',{status:'UNAPPROVED'});
 putRecord(db,'telegram_control_receipt',`${pair.botId}:64381640`,{status:'STOPPED',updateId:64381640,messageId:14,messageTimestamp:'2026-11-16T21:51:46.000Z',recordedAt:manifest.telegram.knownStop.recordedAt,rawUpdateAvailable:false,provenance:'INSPECTION_SUMMARY_RECONCILIATION'});
 const ref='wr_'+ 'h'.repeat(22),callbackId='historical-details';
 putRecord(legacyDb,'telegram_writing_action',ref,{telegramReviewId:'telegram-details-only-v1',action:'DETAILS'});
 putRecord(legacyDb,'telegram_writing_review','telegram-details-only-v1',{id:'telegram-details-only-v1',messageId:15,packetHash:manifest.telegram.knownDetails.packetHash,actions:{DETAILS:ref},issuedAt:'2026-11-16T22:23:00Z',bindingHash:digest(canonical({userId:pair.userId,chatId:pair.chatId,botId:pair.botId})),syntheticOnly:true});
 putRecord(legacyDb,'telegram_control_receipt',`${pair.botId}:64381641`,{status:'DETAILS',updateId:64381641,packetHash:manifest.telegram.knownDetails.packetHash,telegramReviewId:'telegram-details-only-v1'});
 putRecord(legacyDb,'telegram_callback_receipt',`${pair.botId}-${digest(callbackId)}`,{status:'DETAILS',receiptId:`${pair.botId}:64381641`});
 putRecord(db,'telegram_details_test','telegram-details-only-v1',{status:'COMPLETE',reason:'DETAILS_CALLBACK_CONFIRMED',acknowledgment:{status:'API_CONFIRMED',updateId:64381641},detailsDelivery:{status:'API_CONFIRMED',messageId:16},cleanup:{confirmed:true}});
 const oldStop={update_id:64381640,message:{message_id:14,date:1794865906,text:'/stop',from:{id:pair.userId,is_bot:false},chat:{id:pair.chatId,type:'private'}}};
 const oldDetails={update_id:64381641,callback_query:{id:callbackId,from:{id:pair.userId,is_bot:false},data:ref,message:{message_id:15,date:Math.floor(Date.parse('2026-11-16T22:23:01Z')/1000),from:{id:pair.botId,is_bot:true},chat:{id:pair.chatId,type:'private'}}}};
 const calls=[],events=[],timeline=[],persistedEvents=[];let elapsed=0,polls=0,nextMessage=20,nextUpdate=64381642;let approved=false,finished=false;
 const makeApi=(_token,guard)=>{
  const api=createTelegramConsumerFixtureApi(async(method,body,ms)=>{
   guard(method,body,ms);calls.push({method,body});timeline.push({method});elapsed+=options.tickMs??10;
   if(options.fail===method||(options.failPrefix&&method==='getUpdates'&&body.offset===64381642&&polls===1))throw Error('fixture transport uncertainty');
   let result;
   if(method==='getMe')result={id:pair.botId,is_bot:true,username:'ElyaColdBot'};
   if(method==='getWebhookInfo')result={url:''};
   if(method==='sendMessage')result={message_id:nextMessage++,chat:{id:pair.chatId,type:'private'},from:{id:pair.botId,is_bot:true}};
   if(method==='answerCallbackQuery')result=true;
   if(method==='getUpdates'){
    polls++;
    if(!Object.hasOwn(body,'offset'))result=options.unknown?[oldStop,{update_id:64381638,message:{text:'unknown historical'}}]:[oldStop,oldDetails];
    else if(polls===2)result=[];
    else if(options.empty)result=[];
    else if(options.stop)result=[{...oldStop,update_id:nextUpdate++,message:{...oldStop.message,message_id:99,date:Math.floor((wall+elapsed)/1000)}}];
    else{
     const reviews=syntheticDb.prepare("SELECT data_json FROM records WHERE kind='telegram_writing_review'").all().map(r=>JSON.parse(r.data_json));
     const a1=reviews.find(r=>r.reviewId==='qa-acceptance-A'&&r.version===1),a2=reviews.find(r=>r.reviewId==='qa-acceptance-A'&&r.version===2),b1=reviews.find(r=>r.reviewId==='qa-acceptance-B');
     const update=(r,action)=>({update_id:nextUpdate++,callback_query:{id:`callback-${nextUpdate}`,from:{id:pair.userId,is_bot:false},data:r.actions[action],message:{message_id:r.messageId,date:Math.floor(Date.parse(r.issuedAt)/1000),from:{id:pair.botId,is_bot:true},chat:{id:pair.chatId,type:'private'}}}});
     if(!approved){approved=true;result=options.tooManyExtras?[update(a1,'DETAILS'),update(a1,'DETAILS'),update(a1,'DETAILS'),update(a1,'APPROVED')]:options.wrongButton?[update(a1,'REJECTED'),update(a1,'APPROVED')]:[update(a1,'APPROVED')];if(options.wrongSender)result[0].callback_query.from.id=99;}
     else if(!finished&&a2&&b1){finished=true;result=options.withDetails?[update(a2,'DETAILS'),update(b1,'REJECTED'),update(a2,'REVISION_REQUESTED'),update(a1,'APPROVED')]:[update(b1,'REJECTED'),update(a2,'REVISION_REQUESTED'),update(a1,'APPROVED')];if(options.gap)result[0].update_id+=10;}
     else result=[];
    }
   }
   return {status:200,body:JSON.stringify({ok:true,result})};
  });return {...api,mode:'AUTHORIZED_TELEGRAM_OPERATIONAL',close:async()=>({closed:!options.cleanupFail,remainingRequests:options.cleanupFail?1:0})};
 };
 return {db,syntheticDb,legacyDb,calls,events,timeline,persistedEvents,network,run:()=>runner.runAcceptanceTelegram({db,syntheticDb,legacyDb,manifest,loadToken:async()=> 'FIXTURE',makeApi,assertAuthority:()=>{if(options.unapproved)throw Error('AUTHORIZATION_NOT_ARMED');return true;},startedMono:0,startedWall:options.isoWall?new Date(wall).toISOString():wall,clock:()=>elapsed,sleep:async ms=>{elapsed+=ms;},emit:e=>{events.push(e);timeline.push({event:e.event});if(e.event?.startsWith('OPERATOR_'))persistedEvents.push(getRecord(db,'acceptance_telegram',manifest.id).operatorEvents.at(-1));}})};
}
test('one-use Telegram acceptance runner is implemented',()=>assert.ok(runner));
if(runner){
test('complete sequence uses exact shared pages, unordered independent actions and known-prefix retirement only',async t=>{
 const f=fixture(t),beforeControls=controls(f.db),legacy=JSON.stringify(f.legacyDb.prepare('SELECT * FROM records ORDER BY kind,id').all()),stop=getRecord(f.db,'telegram_control_receipt',`${pair.botId}:64381640`);const r=await f.run();
 assert.equal(r.status,'PASSED',JSON.stringify(r));assert.ok(Object.values(r.scenarios).every(s=>s.status==='PASS'));assert.equal(r.counts.initialMessages,12);assert.equal(r.counts.detailsMessages,0);assert.equal(r.counts.acknowledgments,4);assert.ok(r.attempts.length<=40);
 assert.deepEqual(f.calls.filter(c=>c.method==='getUpdates').slice(0,2).map(c=>c.body),[{timeout:0,limit:100},{offset:64381642,timeout:0,limit:100}]);assert.ok(f.calls.every(c=>!Object.hasOwn(c.body,'allowed_updates')));
 assert.equal(f.calls.filter(c=>c.method==='sendMessage').length,12);assert.match(f.calls.filter(c=>c.method==='sendMessage')[1].body.text,/SYNTHETIC QA — Acceptance v1 — Step 1/);assert.match(f.calls.filter(c=>c.method==='sendMessage')[5].body.text,/Revision 2\./);
 assert.deepEqual(controls(f.db),beforeControls);assert.deepEqual(getRecord(f.db,'telegram_control_receipt',`${pair.botId}:64381640`),stop);assert.equal(JSON.stringify(f.legacyDb.prepare('SELECT * FROM records ORDER BY kind,id').all()),legacy);assert.equal(f.network.attempts,0);
 assert.equal(getRecord(f.db,'telegram_writing_cursor','primary').nextOffset,64381646);assert.equal(r.closure.status,'API_CONFIRMED');assert.equal(r.cleanup.confirmed,true);assert.ok(!JSON.stringify(r).includes('wr_'));
 const count=f.calls.length;assert.notEqual((await f.run()).status,'PASSED');assert.equal(f.calls.length,count);
});
test('any unknown preflight update including historical gaps blocks before cursor retirement or acknowledgment',async t=>{
 const f=fixture(t,{unknown:true}),r=await f.run();assert.equal(r.reason,'UNKNOWN_PREFLIGHT_UPDATE');assert.equal(getRecord(f.db,'telegram_writing_cursor','primary').nextOffset,64381638);assert.equal(f.calls.length,3);assert.equal(f.calls.filter(c=>c.method==='sendMessage').length,0);assert.equal(r.prefixAcknowledgment.status,'NOT_ATTEMPTED');const observation=r.observations.find(o=>o.updateId===64381638);assert.equal(observation.type,'MESSAGE');assert.equal(observation.observedAction,'UNKNOWN');assert.equal(observation.disposition,'LEFT_PENDING');assert.equal(observation.actorMatch,false);assert.ok(!JSON.stringify(r).includes('unknown historical'));assert.ok(!JSON.stringify(r).includes('wr_'));
});
for(const options of [{fail:'sendMessage'},{fail:'answerCallbackQuery'},{failPrefix:true},{stop:true},{empty:true},{unapproved:true},{gap:true}])test(`bounded failure preserves evidence without replay: ${JSON.stringify(options)}`,async t=>{
 const f=fixture(t,options),r=await f.run();assert.notEqual(r.status,'PASSED');assert.ok(r.attempts.length<=40);assert.equal(r.counts.detailsMessages,0);assert.equal(f.network.attempts,0);
 if(options.fail){assert.equal(f.calls.filter(c=>c.method===options.fail).length,1);if(options.fail==='answerCallbackQuery')assert.equal(f.syntheticDb.prepare("SELECT count(*) n FROM records WHERE kind='writing_decision'").get().n,1);}
 if(options.failPrefix){assert.equal(f.calls.length,4);assert.equal(getRecord(f.db,'telegram_writing_cursor','primary').nextOffset,64381642);assert.equal(r.prefixAcknowledgment.status,'UNCERTAIN');}
 if(options.stop){assert.equal(r.reason,'AUTHENTICATED_STOP');assert.equal(f.calls.at(-1).method,'getUpdates');assert.equal(r.stopReceived,true);}
 if(options.empty)assert.ok(r.counts.normalPolls<17);
 if(options.unapproved)assert.equal(f.calls.length,0);
 if(options.gap)assert.equal(r.reason,'SESSION_UPDATE_GAP');
});
test('Details press is acknowledged without any Details page or order failure',async t=>{const f=fixture(t,{withDetails:true}),r=await f.run();assert.equal(r.status,'PASSED',JSON.stringify(r));assert.equal(r.counts.detailsMessages,0);assert.equal(f.calls.filter(c=>c.method==='sendMessage').length,12);assert.equal(r.counts.acknowledgments,5);});
test('bound wrong button is acknowledged without changing content and does not prevent the authorized decision',async t=>{const f=fixture(t,{wrongButton:true,isoWall:true}),r=await f.run();assert.equal(r.status,'PASSED',JSON.stringify(r));assert.equal(r.counts.acknowledgments,5);assert.ok(r.observations.some(x=>x.status==='ACTION_OUTSIDE_ACCEPTANCE_SCOPE'));const decisions=f.syntheticDb.prepare("SELECT data_json FROM records WHERE kind='writing_decision'").all().map(row=>JSON.parse(row.data_json));assert.equal(decisions.length,3);assert.equal(decisions.filter(d=>d.reviewId==='qa-acceptance-A'&&d.decision==='REJECTED').length,0);});
test('deadline never permits further requests after a late response',async t=>{const f=fixture(t,{tickMs:300000}),r=await f.run();assert.equal(r.reason,'TELEGRAM_ACCEPTANCE_API_DEADLINE');assert.equal(f.calls.length,2);assert.equal(getRecord(f.db,'telegram_writing_cursor','primary').nextOffset,64381638);});
test('optional presses cannot consume acknowledgment slots reserved for the four required scenarios',async t=>{const f=fixture(t,{tooManyExtras:true}),r=await f.run();assert.equal(r.reason,'REQUIRED_ACK_SLOTS_RESERVED');assert.equal(r.counts.acknowledgments,2);assert.equal(getRecord(f.db,'telegram_writing_cursor','primary').nextOffset,64381644);assert.equal(f.syntheticDb.prepare("SELECT count(*) n FROM records WHERE kind='writing_decision'").get().n,0);});
test('unpaired callback cannot create a decision or move the session cursor',async t=>{const f=fixture(t,{wrongSender:true}),r=await f.run();assert.equal(r.reason,'UNRELATED_SESSION_UPDATE');assert.equal(r.counts.acknowledgments,0);assert.equal(getRecord(f.db,'telegram_writing_cursor','primary').nextOffset,64381642);});
test('historical Details mismatch stops before retirement and never changes the legacy store',async t=>{const f=fixture(t);const review=getRecord(f.legacyDb,'telegram_writing_review','telegram-details-only-v1');putRecord(f.legacyDb,'telegram_writing_review',review.id,{...review,messageId:999});const before=JSON.stringify(f.legacyDb.prepare('SELECT * FROM records ORDER BY kind,id').all());const r=await f.run();assert.equal(r.reason,'HISTORICAL_DETAILS_MISMATCH');assert.equal(getRecord(f.db,'telegram_writing_cursor','primary').nextOffset,64381638);assert.equal(JSON.stringify(f.legacyDb.prepare('SELECT * FROM records ORDER BY kind,id').all()),before);});
test('cleanup uncertainty preserves first failure and retains ownership for reconciliation',async t=>{const f=fixture(t,{fail:'answerCallbackQuery',cleanupFail:true}),r=await f.run();assert.equal(r.reason,'TELEGRAM_NETWORK_UNCERTAIN');assert.equal(r.cleanup.confirmed,false);assert.equal(getRecord(f.db,'telegram_consumer_owner','primary').status,'RECONCILIATION');});
test('guidance identifies the actual Step 3 button message and persists each single action before emission',async t=>{
 const f=fixture(t),r=await f.run(),prompts=f.events.filter(e=>e.event==='OPERATOR_NEXT_ACTION'),operator=f.events.filter(e=>e.event?.startsWith('OPERATOR_'));
 assert.equal(r.status,'PASSED');assert.ok(prompts.length>=2);assert.equal(prompts[0].messageId,23);assert.equal(prompts[0].location,'Step 3 (button-bearing message)');assert.match(prompts[0].title,/Synthetic Acceptance A • v1$/);assert.equal(prompts[0].buttonLabel,'Approve content');assert.equal(prompts[1].messageId,23);assert.equal(prompts[1].expectedResult,'STALE_REVIEW');
 assert.ok(prompts.every(e=>typeof e.buttonLabel==='string'&&!Array.isArray(e.actions)));assert.deepEqual(f.persistedEvents,operator);assert.deepEqual(r.operatorEvents,operator);assert.ok(!JSON.stringify(operator).includes('wr_'));
 const outcome=f.timeline.findIndex(e=>e.event==='OPERATOR_OUTCOME'),ack=f.timeline.findIndex(e=>e.method==='answerCallbackQuery');assert.ok(outcome>=0&&outcome<ack);
});
test('durable outcome is shown even when the callback acknowledgment is uncertain, without a next prompt',async t=>{
 const f=fixture(t,{fail:'answerCallbackQuery'}),r=await f.run(),outcomes=f.events.filter(e=>e.event==='OPERATOR_OUTCOME'),prompts=f.events.filter(e=>e.event==='OPERATOR_NEXT_ACTION');
 assert.equal(r.status,'UNCERTAIN');assert.equal(outcomes.length,1);assert.equal(outcomes[0].status,'APPROVED');assert.match(outcomes[0].message,/Content approval recorded/);assert.equal(prompts.length,1);assert.equal(f.events.at(-1).event,'OPERATOR_ACK_STATUS');assert.equal(f.events.at(-1).status,'UNCERTAIN');assert.equal(getRecord(f.db,'acceptance_telegram',manifest.id).operatorEvents.at(-1).status,'UNCERTAIN');
});
}
