import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {getRecord,putRecord,openStore,controls,setStopped,setLaunch} from '../src/store.mjs';
import {writingTelegramFixture,callback,at,expires} from './helpers/telegram-writing-fixture.mjs';
import {issueWritingTelegramReview,bindWritingTelegramMessage} from '../src/telegram-writing-decisions.mjs';
import {acquireTelegramConsumer,releaseTelegramConsumer} from '../src/telegram-writing-authority.mjs';
import {blockNetwork} from './helpers/network-block.mjs';
const consumer=await import('../src/telegram-consumer.mjs').catch(()=>null);
const telegram=await import('../src/telegram-api.mjs');
const limits={maxPolls:3,maxUpdates:20,maxRequests:20,totalMs:5000};
function ready(t,path){blockNetwork(t);const f=writingTelegramFixture(path);t.after(()=>f.db.close());putRecord(f.db,'telegram_writing_cursor','primary',{nextOffset:0});const r=issueWritingTelegramReview(f.db,{id:'operational-review',reviewId:f.packet.reviewId,packetHash:f.packet.hash,at,expiresAt:expires,expiryBasis:'EXPLICIT_SYNTHETIC_TEST'});return {...f,review:bindWritingTelegramMessage(f.db,r.id,100,at)};}
function transport(batches,{failAck=false}={}){const calls=[];const api=telegram.createTelegramConsumerFixtureApi(async(method,body)=>{calls.push({method,body});if(method==='answerCallbackQuery'&&failAck)throw Error('uncertain');const result=method==='getMe'?{id:777,is_bot:true}:method==='getWebhookInfo'?{url:''}:method==='getUpdates'?(batches.shift()??[]):method==='sendMessage'?{message_id:101,chat:{id:42,type:'private'},from:{id:777,is_bot:true}}:true;return {status:200,body:JSON.stringify({ok:true,result})};});return {api,calls};}
test('bounded operational consumer is implemented',()=>assert.ok(consumer));
if(consumer){
test('ordinary button order commits once, advances durable cursor, preserves update subscription',async t=>{
 const f=ready(t),first=callback(f.review,'APPROVED',10),{api,calls}=transport([[first,callback(f.review,'DETAILS',11),callback(f.review,'REJECTED',12)],[first],[]]);
 const result=await consumer.runTelegramConsumer({db:f.db,api,ownerId:'run-one',limits,at});
 assert.equal(result.status,'BOUNDED_COMPLETE');assert.deepEqual(result.outcomes.map(x=>x.status),['APPROVED','DETAILS','CONFLICTING_DECISION','DUPLICATE_UPDATE']);
 assert.equal(getRecord(f.db,'telegram_writing_cursor','primary').nextOffset,13);
 assert.deepEqual(calls.filter(c=>c.method==='getUpdates').map(c=>c.body.offset),[0,13,13]);
 assert.ok(calls.filter(c=>c.method==='getUpdates').every(c=>!Object.hasOwn(c.body,'allowed_updates')));
 assert.equal(calls.filter(c=>c.method==='answerCallbackQuery').length,3);assert.equal(f.db.prepare("SELECT count(*) n FROM records WHERE kind='writing_decision'").get().n,1);
 assert.equal(getRecord(f.db,'telegram_consumer_owner','primary').status,'RELEASED');
});
test('entire unknown batch blocks before any decision, receipt or cursor advance',async t=>{
 const f=ready(t),{api}=transport([[callback(f.review,'APPROVED',10),{update_id:11,message:{text:'old diagnostic message'}}]]);
 const result=await consumer.runTelegramConsumer({db:f.db,api,ownerId:'unknown',limits,at});
 assert.equal(result.reason,'UNRELATED_PENDING_UPDATES');assert.equal(getRecord(f.db,'telegram_writing_cursor','primary').nextOffset,0);assert.equal(getRecord(f.db,'telegram_control_receipt','777:10'),null);
});
test('stale buttons get explicit outcome while unauthorized binding stays strict',async t=>{
 const f=ready(t),old=getRecord(f.db,'contact',f.spec.email);putRecord(f.db,'contact',f.spec.email,{...old,changed:true});putRecord(f.db,'contact',f.spec.email,old);
 const {api,calls}=transport([[callback(f.review,'APPROVED',10)],[]]);const result=await consumer.runTelegramConsumer({db:f.db,api,ownerId:'stale',limits,at});assert.equal(result.outcomes[0].status,'STALE_REVIEW');assert.match(calls.find(c=>c.method==='answerCallbackQuery').body.text,/out of date/);assert.equal(getRecord(f.db,'telegram_writing_cursor','primary').nextOffset,11);
 const bad=callback(f.review,'APPROVED',12);bad.callback_query.from.id=43;const second=await consumer.runTelegramConsumer({db:f.db,api:transport([[bad]]).api,ownerId:'unauthorized',limits,at});assert.equal(second.reason,'UNAUTHORIZED_TELEGRAM_UPDATE');assert.equal(getRecord(f.db,'telegram_writing_cursor','primary').nextOffset,11);
});
test('uncertain acknowledgment persists decision and cursor but prevents automatic resend on restart',async t=>{
 const path=join(mkdtempSync(join(tmpdir(),'elya-consumer-')),'db.sqlite'),f=ready(t,path),u=callback(f.review,'APPROVED',10);
 const first=await consumer.runTelegramConsumer({db:f.db,api:transport([[u]],{failAck:true}).api,ownerId:'first',limits,at});assert.equal(first.reason,'TELEGRAM_RESPONSE_RECONCILIATION_REQUIRED');assert.equal(getRecord(f.db,'telegram_writing_cursor','primary').nextOffset,11);
 const restart=openStore(path);t.after(()=>restart.close());const {api,calls}=transport([[u],[]]);const second=await consumer.runTelegramConsumer({db:restart,api,ownerId:'restart',limits,at});assert.equal(second.reason,'TELEGRAM_RESPONSE_RECONCILIATION_REQUIRED');assert.equal(calls.filter(c=>c.method==='answerCallbackQuery').length,0);assert.equal(restart.prepare("SELECT count(*) n FROM records WHERE kind='writing_decision'").get().n,1);
});
test('unresolved acknowledgment is visible and blocks restart even when Telegram no longer returns its update',async t=>{
 const f=ready(t),u=callback(f.review,'APPROVED',10);await consumer.runTelegramConsumer({db:f.db,api:transport([[u]],{failAck:true}).api,ownerId:'uncertain-first',limits,at});
 const {api,calls}=transport([[]]),status=consumer.inspectTelegramConsumerStatus(f.db);assert.equal(status.unresolvedResponses.length,1);
 const next=await consumer.runTelegramConsumer({db:f.db,api,ownerId:'uncertain-second',limits,at});assert.equal(next.reason,'TELEGRAM_RESPONSE_RECONCILIATION_REQUIRED');assert.equal(calls.length,0);
});
test('request budget and elapsed deadline prevent extra requests without stealing ownership',async t=>{
 const f=ready(t),one=transport([[]]);const limited=await consumer.runTelegramConsumer({db:f.db,api:one.api,ownerId:'budget',limits:{...limits,maxRequests:1},at});assert.equal(limited.reason,'TELEGRAM_REQUEST_BUDGET_EXHAUSTED');assert.equal(one.calls.length,1);
 let elapsed=0;const calls=[];const slow=telegram.createTelegramConsumerFixtureApi(async(method)=>{calls.push(method);elapsed=6000;return {status:200,body:JSON.stringify({ok:true,result:{id:777,is_bot:true}})};});
 const deadline=await consumer.runTelegramConsumer({db:f.db,api:slow,ownerId:'deadline',limits,at,clock:()=>elapsed});assert.equal(deadline.reason,'TELEGRAM_SESSION_DEADLINE');assert.deepEqual(calls,['getMe']);assert.equal(getRecord(f.db,'telegram_consumer_owner','primary').status,'RELEASED');
});
test('operational transport requires fresh per-operation authority before each request',async t=>{
 const f=ready(t),{api,calls}=transport([[]]),requests=[];const result=await consumer.runTelegramConsumer({db:f.db,api:{...api,mode:'AUTHORIZED_TELEGRAM_OPERATIONAL',close:async()=>({closed:true,remainingRequests:0})},ownerId:'future-authority',limits,at,authorize:operation=>{requests.push(operation);return operation.method==='identity';}});
 assert.equal(result.reason,'TELEGRAM_OPERATION_NOT_AUTHORIZED');assert.equal(calls.length,1);assert.deepEqual(requests.map(r=>r.method),['identity','checkWebhook']);
});
test('unconfirmed external transport cleanup retains ownership for operator reconciliation',async t=>{
 const f=ready(t),{api}=transport([[]]);const result=await consumer.runTelegramConsumer({db:f.db,api:{...api,mode:'AUTHORIZED_TELEGRAM_OPERATIONAL',close:async()=>({closed:false,remainingRequests:1})},ownerId:'cleanup',limits,at,authorize:()=>true});
 assert.equal(result.reason,'TELEGRAM_TRANSPORT_RECONCILIATION_REQUIRED');assert.equal(getRecord(f.db,'telegram_consumer_owner','primary').status,'RECONCILIATION');
});
test('same update ID with changed payload and old summary-only receipt require reconciliation',async t=>{
 const f=ready(t),u=callback(f.review,'APPROVED',10);await consumer.runTelegramConsumer({db:f.db,api:transport([[u],[]]).api,ownerId:'original',limits,at});
 const altered=structuredClone(u);altered.callback_query.data=f.review.actions.REJECTED;
 const bad=await consumer.runTelegramConsumer({db:f.db,api:transport([[altered]]).api,ownerId:'altered',limits,at});assert.equal(bad.reason,'TELEGRAM_UPDATE_INTEGRITY_MISMATCH');
 putRecord(f.db,'telegram_control_receipt','777:12',{status:'STOPPED',rawUpdateAvailable:false,remoteAcknowledged:false});
 const legacy=await consumer.runTelegramConsumer({db:f.db,api:transport([[callback(f.review,'DETAILS',12)]]).api,ownerId:'legacy',limits,at});assert.equal(legacy.reason,'TELEGRAM_RECEIPT_RECONCILIATION_REQUIRED');assert.equal(getRecord(f.db,'telegram_writing_cursor','primary').nextOffset,11);
});
test('crash after confirmed callback response but before cursor commit resumes from receipt without resend',async t=>{
 const f=ready(t),u=callback(f.review,'APPROVED',10);f.db.exec("CREATE TRIGGER interrupt_cursor BEFORE UPDATE ON records WHEN NEW.kind='telegram_writing_cursor' BEGIN SELECT RAISE(ABORT,'cursor interruption'); END;");
 const first=await consumer.runTelegramConsumer({db:f.db,api:transport([[u]]).api,ownerId:'cursor-crash',limits,at});assert.equal(first.status,'BLOCKED');assert.equal(getRecord(f.db,'telegram_writing_cursor','primary').nextOffset,0);assert.equal(getRecord(f.db,'telegram_control_receipt','777:10').status,'APPROVED');f.db.exec('DROP TRIGGER interrupt_cursor');
 const {api,calls}=transport([[u],[]]);const resumed=await consumer.runTelegramConsumer({db:f.db,api,ownerId:'cursor-resume',limits,at});assert.equal(resumed.status,'BOUNDED_COMPLETE');assert.equal(getRecord(f.db,'telegram_writing_cursor','primary').nextOffset,11);assert.equal(calls.filter(c=>c.method==='answerCallbackQuery').length,0);assert.equal(f.db.prepare("SELECT count(*) n FROM records WHERE kind='writing_decision'").get().n,1);
});
test('future authority may deny a bound content action without committing a decision or advancing cursor',async t=>{
 const f=ready(t),{api}=transport([[callback(f.review,'APPROVED',10)]]),checks=[];
 const result=await consumer.runTelegramConsumer({db:f.db,api:{...api,mode:'AUTHORIZED_TELEGRAM_OPERATIONAL',close:async()=>({closed:true,remainingRequests:0})},ownerId:'content-authority',limits,at,authorize:request=>{checks.push(request);return request.method!=='consumeUpdate';}});
 assert.equal(result.reason,'TELEGRAM_OPERATION_NOT_AUTHORIZED');assert.equal(getRecord(f.db,'telegram_writing_cursor','primary').nextOffset,0);assert.equal(getRecord(f.db,'telegram_control_receipt','777:10'),null);const action=checks.find(r=>r.method==='consumeUpdate');assert.equal(action.action,'APPROVED');assert.equal(action.telegramReviewId,f.review.id);
});
test('existing owner and absent explicit transport authority prevent all requests',async t=>{
 const f=ready(t),{api,calls}=transport([]);acquireTelegramConsumer(f.db,'other',at);
 await assert.rejects(consumer.runTelegramConsumer({db:f.db,api,ownerId:'busy',limits,at}),/CONSUMER_BUSY/);assert.equal(calls.length,0);releaseTelegramConsumer(f.db,'other',at);
 await assert.rejects(consumer.runTelegramConsumer({db:f.db,api:{...api,mode:'LIVE'},ownerId:'live',limits,at}),/TRANSPORT_NOT_AUTHORIZED/);assert.equal(calls.length,0);
});
test('authenticated stop is durable and ends consumption before later queued approval',async t=>{
 const f=ready(t),stop={update_id:10,message:{text:'/stop',message_id:5,date:Math.floor(Date.parse(at)/1000),from:{id:42,is_bot:false},chat:{id:42,type:'private'}}};
 const result=await consumer.runTelegramConsumer({db:f.db,api:transport([[stop,callback(f.review,'APPROVED',11)]]).api,ownerId:'stop',limits,at});assert.equal(result.status,'STOPPED');assert.equal(controls(f.db).stopped,true);assert.equal(getRecord(f.db,'telegram_writing_cursor','primary').nextOffset,11);assert.equal(getRecord(f.db,'telegram_control_receipt','777:11'),null);
});
test('authorized operational control session can observe and stop a separately launched workflow',async t=>{
 const f=ready(t);setStopped(f.db,false,'isolated running fixture');setLaunch(f.db,true,'isolated running fixture');const stop={update_id:10,message:{text:'/stop',message_id:5,date:Math.floor(Date.parse(at)/1000),from:{id:42,is_bot:false},chat:{id:42,type:'private'}}};
 const {api}=transport([[stop]]);const result=await consumer.runTelegramConsumer({db:f.db,api:{...api,mode:'AUTHORIZED_TELEGRAM_OPERATIONAL',close:async()=>({closed:true,remainingRequests:0})},ownerId:'operational-stop',limits,at,authorize:()=>true});assert.equal(result.status,'STOPPED');assert.equal(controls(f.db).stopped,true);assert.equal(controls(f.db).launchAuthorized,true);
});
test('protected operational transport fails closed before network without armed authority',async t=>{
 const blocked=blockNetwork(t);assert.throws(()=>telegram.createTelegramConsumerApi('123456:'+'x'.repeat(35)),/GUARD_REQUIRED/);let body;
 const api=telegram.createTelegramConsumerApi('123456:'+'x'.repeat(35),(method,input)=>{body=input;throw Error('AUTHORIZATION_NOT_ARMED');});
 await assert.rejects(api.poll(10,5000),/AUTHORIZATION_NOT_ARMED/);assert.equal(body.offset,10);assert.equal(Object.hasOwn(body,'allowed_updates'),false);assert.equal(blocked.attempts,0);assert.deepEqual(await api.close(),{closed:true,remainingRequests:0});
});
test('retirement is an exact read-only proposal with explicit approval and no skip/drain execution',t=>{
 const f=ready(t),updates=[{update_id:8,message:{text:'old diagnostic'}}],before=JSON.stringify(f.db.prepare('SELECT * FROM records ORDER BY kind,id').all());
 const plan=consumer.prepareTelegramRetirementPlan(f.db,{id:'retire-old',updates,reason:'Prior closed diagnostic',at});assert.equal(plan.fromOffset,0);assert.equal(plan.nextOffset,9);assert.equal(plan.remoteAcknowledgmentAuthorized,false);
 assert.throws(()=>consumer.validateTelegramRetirementPlan(f.db,plan,{approved:true}),/EXACT_RETIREMENT_APPROVAL_REQUIRED/);
 const approval={approved:true,planHash:plan.hash,botId:777,chatId:42,userId:42,approvedBy:'Daniel Rosen',approvedAt:at,expiresAt:expires,allowLocalRetirement:true,allowRemoteAcknowledgment:true};assert.equal(consumer.validateTelegramRetirementPlan(f.db,plan,approval,at).executable,false);
 assert.equal(JSON.stringify(f.db.prepare('SELECT * FROM records ORDER BY kind,id').all()),before);
});
test('interrupted consumer recovery retains lock until actual process termination is explicitly established',async t=>{
 const f=ready(t);acquireTelegramConsumer(f.db,'interrupted-owner',at);putRecord(f.db,'telegram_consumer_run','interrupted-owner',{ownerId:'interrupted-owner',status:'RUNNING',startedAt:at});const before=controls(f.db);
 const recovered=consumer.recoverTelegramConsumer(f.db,at);assert.equal(recovered.status,'RECONCILIATION');assert.equal(recovered.processStopConfirmationRequired,true);assert.equal(recovered.replayPermitted,false);assert.equal(getRecord(f.db,'telegram_consumer_owner','primary').status,'RECONCILIATION');assert.deepEqual(controls(f.db),before);
 assert.deepEqual(consumer.recoverTelegramConsumer(f.db,at),recovered);const {api,calls}=transport([]);await assert.rejects(consumer.runTelegramConsumer({db:f.db,api,ownerId:'must-not-steal',limits,at}),/CONSUMER_BUSY/);assert.equal(calls.length,0);
});
}
