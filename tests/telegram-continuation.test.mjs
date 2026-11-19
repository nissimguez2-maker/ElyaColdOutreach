import test from 'node:test';import assert from 'node:assert/strict';
import {openStore,putRecord,getRecord,controls} from '../src/store.mjs';
import {createSyntheticBatch,issueSyntheticReview} from '../src/telegram-decisions.mjs';
import {APPROVED_PACKETS,APPROVED_HASHES} from '../src/telegram-live-contract.mjs';
import * as runner from '../src/telegram-live-test.mjs';import * as transport from '../src/telegram-api.mjs';
const continuation=await import('../src/telegram-continuation.mjs').catch(()=>null);
test('approved continuation is implemented without a version-1 send route',()=>{assert.ok(continuation);assert.equal(typeof runner.runApprovedTelegramContinuation,'function');assert.equal(typeof transport.createTelegramContinuationApi,'function');});
const ID=8473827686,OLD='synthetic-live-01',NEW='synthetic-live-01-cont1',REVIEW='qa-tg-01-v1-cont1';
function fixture(options={}){
 const db=openStore(':memory:');putRecord(db,'telegram_binding','primary',{confirmed:true,userId:ID,chatId:ID,botId:777},'configuration');
 createSyntheticBatch(db,'QA-TG-01',1);issueSyntheticReview(db,'qa-tg-01-v1','QA-TG-01','2026-11-16T16:05:28.924Z','2026-11-16T16:00:33.594Z');
 putRecord(db,'telegram_live_test',OLD,{status:'STOPPED_INCOMPLETE',phase:'WAIT_APPROVE_V1',errorCode:'TELEGRAM_NETWORK_UNCERTAIN',pollingEnded:true,messages:[{version:1,status:'API_CONFIRMED',messageId:4},{version:2,status:'NOT_SENT'}],commands:[],offset:64381634},'confirmed');
 putRecord(db,'telegram_send_evidence',`${OLD}-v1`,{messageId:4,version:1,apiAcceptance:'API_CONFIRMED',packetHash:APPROVED_HASHES[0],mustNotResend:true},'confirmed');
 putRecord(db,'telegram_delivery_observation',`${OLD}-v1`,{messageId:4,userReportedExactPacketReceived:true},'user_reported');
 let time=Date.parse('2026-11-16T18:00:00Z'),poll=0;const calls=[],events=[];
 const commands=[`/approve ${REVIEW}`,`/approve ${REVIEW}`,'/reject qa-tg-01-v2','/stop'];
 const update=(text,id,user=ID)=>({update_id:64381634+id,message:{message_id:10+id,date:Math.floor(time/1000),text,from:{id:user,is_bot:false},chat:{id:ID,type:'private'}}});
 const api={identity:async()=>{calls.push('getMe');return{id:options.wrongBot?999:777,is_bot:true};},checkWebhook:async()=>{calls.push('getWebhookInfo');if(options.conflict)throw Error('TELEGRAM_CONSUMER_CONFLICT');},sendVersion2:async()=>{calls.push('sendVersion2');assert.equal(db.prepare('SELECT decision FROM approvals WHERE version=1').get().decision,'INVALIDATED');if(options.uncertain)throw Error('TELEGRAM_NETWORK_UNCERTAIN');return{message_id:5,chat:{id:ID,type:'private'},from:{id:777,is_bot:true},text:APPROVED_PACKETS[1]};},poll:async(offset)=>{calls.push('getUpdates');assert.ok(events.some(e=>e.event==='ready'));time+=1000;if(options.deadline){time+=180000;return[];}if(options.pollError)throw Error('TELEGRAM_NETWORK_UNCERTAIN');if(options.stop)return[update('/stop',++poll)];if(options.updates)return options.updates({poll:++poll,update});return[update(commands[poll],++poll)];}};
 return{db,calls,events,deps:{db,clock:()=>time,loadToken:async()=>{calls.push('readProtected');return'synthetic-token-not-used';},makeApi:()=>api,emit:e=>events.push(e),sleep:async()=>{}}};
}
if(continuation&&runner.runApprovedTelegramContinuation){
 test('continuation preflight verifies actual delivered state and hashes without changing source records',()=>{
  const f=fixture(),old=getRecord(f.db,'telegram_live_test',OLD);const p=continuation.validateContinuation(f.db,'2026-11-16T18:00:00Z');assert.equal(p.sourceMessageId,4);assert.deepEqual(p.approvedHashes,APPROVED_HASHES);assert.deepEqual(getRecord(f.db,'telegram_live_test',OLD),old);assert.equal(getRecord(f.db,'telegram_live_test',NEW),null);assert.equal(getRecord(f.db,'telegram_review',REVIEW),null);assert.equal(f.calls.length,0);f.db.close();
 });
 test('complete continuation sends only version2, preserves old run/review, and invalidates fresh approval',async()=>{
  const f=fixture(),old=getRecord(f.db,'telegram_live_test',OLD),review=getRecord(f.db,'telegram_review','qa-tg-01-v1');
  const r=await runner.runApprovedTelegramContinuation(f.deps);assert.equal(r.status,'COMPLETED');assert.equal(r.allowanceAtStartMs,180000);assert.deepEqual(r.commands.map(c=>c.outcome),['APPROVED','STALE_REVIEW','REJECTED','STOPPED']);assert.equal(f.calls.filter(c=>c==='sendVersion2').length,1);assert.equal(r.messages[0].messageId,4);assert.equal(r.messages[0].status,'API_CONFIRMED');assert.ok(r.messages[0].inherited);
  assert.deepEqual(getRecord(f.db,'telegram_live_test',OLD),old);assert.deepEqual(getRecord(f.db,'telegram_review','qa-tg-01-v1'),review);assert.equal(controls(f.db).stopped,true);assert.equal(controls(f.db).launchAuthorized,false);assert.equal(f.events.find(e=>e.event==='ready').command,`/approve ${REVIEW}`);
  const count=f.calls.length;await assert.rejects(runner.runApprovedTelegramContinuation(f.deps));assert.equal(f.calls.length,count);f.db.close();
 });
 test('unproven delivery, changed content, an active old review, or a previous continuation block before credentials',async()=>{
  for(const change of [f=>{const s=getRecord(f.db,'telegram_live_test',OLD);s.messages[0].status='UNCERTAIN';putRecord(f.db,'telegram_live_test',OLD,s);},f=>putRecord(f.db,'candidate','SYNTHETIC-QA-ONLY',{qualification:'HELD'}),f=>{const r=getRecord(f.db,'telegram_review','qa-tg-01-v1');r.expiresAt='2026-11-17T00:00:00Z';putRecord(f.db,'telegram_review',r.id,r);},f=>putRecord(f.db,'telegram_live_test',NEW,{status:'RUNNING'})]){const f=fixture();change(f);await assert.rejects(runner.runApprovedTelegramContinuation(f.deps));assert.equal(f.calls.length,0);f.db.close();}
 });
 test('old queued approvals and unauthorized commands cannot approve the fresh review',async()=>{
  const f=fixture({updates:({poll,update})=>{if(poll===1)return[update('/approve qa-tg-01-v1',1),update(`/approve ${REVIEW}`,2,999)];if(poll===2)return[update(`/approve ${REVIEW}`,3)];if(poll===3)return[update(`/approve ${REVIEW}`,4)];if(poll===4)return[update('/reject qa-tg-01-v2',5)];return[update('/stop',6)];}});
  const r=await runner.runApprovedTelegramContinuation(f.deps);assert.equal(r.status,'COMPLETED');assert.deepEqual(r.commands.slice(0,2).map(c=>c.outcome),['OUT_OF_SEQUENCE','UNAUTHORIZED']);f.db.close();
 });
 test('deadline, polling failure, early stop and uncertain version2 send remain terminal without resend',async()=>{
  for(const options of [{deadline:true},{pollError:true},{stop:true},{uncertain:true},{wrongBot:true},{conflict:true}]){const f=fixture(options);const r=await runner.runApprovedTelegramContinuation(f.deps);assert.notEqual(r.status,'COMPLETED');assert.equal(r.messages[0].status,'API_CONFIRMED');assert.ok(f.calls.filter(c=>c==='sendVersion2').length<=1);const n=f.calls.length;await assert.rejects(runner.runApprovedTelegramContinuation(f.deps));assert.equal(f.calls.length,n);f.db.close();}
 });
 test('continuation transport exposes no version1 or arbitrary message method',async()=>{
  let sent;const api=transport.createTelegramContinuationApi('123456:'+ 'w'.repeat(35),{exchange:async(method,body)=>{sent={method,body};return{status:200,body:'{"ok":true,"result":{}}'};}});assert.equal(api.sendPacket,undefined);assert.equal(api.acknowledge,undefined);await api.sendVersion2(100);assert.deepEqual(sent,{method:'sendMessage',body:{chat_id:ID,text:APPROVED_PACKETS[1],allow_paid_broadcast:false}});
 });
 test('credential failure is terminal and the continuation cannot acquire credentials again',async()=>{
  const f=fixture(),source=getRecord(f.db,'telegram_live_test',OLD);let attempts=0;
  f.deps.loadToken=async()=>{attempts++;throw Error('private native error must never be logged');};
  const r=await runner.runApprovedTelegramContinuation(f.deps);
  assert.equal(r.status,'STOPPED_INCOMPLETE');assert.equal(r.terminalReason.code,'LOCAL_CREDENTIAL_UNAVAILABLE_USE_NORMAL_USER_TERMINAL');assert.equal(r.terminalReason.operation,'readProtected');
  assert.equal(r.messages[0].messageId,4);assert.equal(r.messages[1].status,'NOT_SENT');assert.equal(r.polling.attempts,0);assert.equal(r.pollingEnded,true);
  assert.equal(getRecord(f.db,'telegram_live_test',NEW).status,'STOPPED_INCOMPLETE');assert.ok(!JSON.stringify(r).includes('private native error'));
  await assert.rejects(runner.runApprovedTelegramContinuation(f.deps),/CONTINUATION_ALREADY_CLAIMED/);assert.equal(attempts,1);assert.equal(f.calls.length,0);assert.deepEqual(getRecord(f.db,'telegram_live_test',OLD),source);f.db.close();
 });
}
