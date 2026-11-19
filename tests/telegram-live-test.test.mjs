import test from 'node:test';import assert from 'node:assert/strict';
import {openStore,putRecord,getRecord,controls} from '../src/store.mjs';
const runner=await import('../src/telegram-live-test.mjs').catch(()=>null);
const contract=await import('../src/telegram-live-contract.mjs').catch(()=>null);
import {createTelegramReviewApi} from '../src/telegram-api.mjs';
test('bounded approved Telegram live-test runner exists',()=>{assert.ok(runner);assert.ok(contract);});
const ID=8473827686;
function fixture(options={}){
 const db=openStore(':memory:');putRecord(db,'telegram_binding','primary',{confirmed:true,testOnly:true,userId:ID,chatId:ID,botId:777},'configuration');putRecord(db,'telegram_pairing','private-setup-01',{stage:'ACK_CONFIRMED',lastUpdateId:0},'confirmed');
 let time=Date.parse('2026-11-16T18:00:00Z'),poll=0;const calls=[],events=[];
 const commands=['/approve qa-tg-01-v1','/approve qa-tg-01-v1','/reject qa-tg-01-v2','/stop'];
 const update=(text,id,user=ID,chat=ID)=>({update_id:id,message:{message_id:1000+id,date:Math.floor(time/1000),text,from:{id:user,is_bot:false},chat:{id:chat,type:'private'}}});
 const api={identity:async()=>{calls.push('getMe');return{id:options.wrongBot?999:777,is_bot:true};},checkWebhook:async()=>{calls.push('getWebhookInfo');if(options.conflict)throw Error('TELEGRAM_CONSUMER_CONFLICT');},
  sendPacket:async(version,chat)=>{calls.push(`send:${version}`);assert.equal(chat,ID);if(version===2)assert.equal(db.prepare('SELECT decision FROM approvals WHERE version=1').get().decision,'INVALIDATED');if(options.uncertain===version)throw Error('secret-bearing raw URL');return{message_id:100+version,chat:{id:ID,type:'private'},from:{id:777,is_bot:true},text:contract.APPROVED_PACKETS[version-1]};},
  poll:async()=>{time+=1000;calls.push('poll');if(options.deadline){time+=300000;return[];}if(options.earlyStop)return[update('/stop',++poll)];if(options.updates)return options.updates({poll:++poll,update});return[update(commands[poll],++poll)];}};
 return{db,calls,events,deps:{db,loadToken:async()=>{calls.push('readProtected');return'fixture-never-used-in-network';},makeApi:()=>api,clock:()=>time,emit:e=>events.push(e),sleep:async()=>{}}};
}
if(runner&&contract){
 test('review transport cannot send custom text, unapproved versions, acknowledgment or a different chat',async()=>{
  const calls=[];const api=createTelegramReviewApi('123456:'+ 'z'.repeat(35),{exchange:async(method,body)=>{calls.push({method,body});return{status:200,body:JSON.stringify({ok:true,result:{}})};}});
  await assert.rejects(api.sendPacket(3,ID,100));await assert.rejects(api.sendPacket(1,ID+1,100));assert.equal(api.acknowledge,undefined);assert.equal(api.sendMessage,undefined);
  await api.sendPacket(1,ID,100);await api.sendPacket(2,ID,100);assert.equal(calls.length,2);for(const [i,c] of calls.entries()){assert.equal(c.method,'sendMessage');assert.deepEqual(c.body,{chat_id:ID,text:contract.APPROVED_PACKETS[i],allow_paid_broadcast:false});}
 });
 test('both immutable hashes and exact packet text are verified before credentials or sends',async()=>{
  const f=fixture();assert.deepEqual(runner.verifyApprovedProposal(f.db),contract.APPROVED_HASHES);
  putRecord(f.db,'candidate','SYNTHETIC-QA-ONLY',{qualification:'HELD'},'configuration');await assert.rejects(runner.runApprovedTelegramTest(f.deps),/APPROVED_PROPOSAL_MISMATCH/);assert.equal(f.calls.length,0);f.db.close();
 });
 test('complete authorized sequence sends exactly twice; invalidation precedes message 2; stop ends polling',async()=>{
  const f=fixture(),r=await runner.runApprovedTelegramTest(f.deps);assert.equal(r.status,'COMPLETED');assert.deepEqual(r.messages.map(m=>m.status),['API_CONFIRMED','API_CONFIRMED']);assert.deepEqual(r.commands.map(c=>c.outcome),['APPROVED','STALE_REVIEW','REJECTED','STOPPED']);
  assert.equal(r.revisionInvalidationPassed,true);assert.equal(r.staleRejectionPassed,true);assert.equal(r.stopEndedPolling,true);assert.equal(f.calls.filter(x=>x.startsWith('send:')).length,2);assert.equal(controls(f.db).stopped,true);assert.equal(controls(f.db).launchAuthorized,false);
  const count=f.calls.length;await assert.rejects(runner.runApprovedTelegramTest(f.deps),/EXISTING_LIVE_TEST/);assert.equal(f.calls.length,count);f.db.close();
 });
 test('wrong pairing, wrong bot, conflict and deadline never pretend success',async()=>{
  const f=fixture();putRecord(f.db,'telegram_binding','primary',{confirmed:true,userId:1,chatId:1,botId:777},'configuration');await assert.rejects(runner.runApprovedTelegramTest(f.deps),/PAIRING_MISMATCH/);assert.equal(f.calls.length,0);f.db.close();
  for(const options of [{wrongBot:true},{conflict:true},{deadline:true}]){const x=fixture(options);const r=await runner.runApprovedTelegramTest(x.deps);assert.notEqual(r.status,'COMPLETED');assert.equal(r.stopEndedPolling,false);assert.equal(r.staleRejectionPassed,false);assert.ok(!x.calls.includes('send:2'));x.db.close();}
 });
 test('uncertain delivery is terminal without automatic resend or status replies',async()=>{
  for(const version of [1,2]){const f=fixture({uncertain:version}),r=await runner.runApprovedTelegramTest(f.deps);assert.equal(r.status,'DELIVERY_UNCERTAIN');assert.equal(r.messages[version-1].status,'UNCERTAIN');assert.equal(f.calls.filter(x=>x===`send:${version}`).length,1);assert.ok(!JSON.stringify(r).includes('raw URL'));await assert.rejects(runner.runApprovedTelegramTest(f.deps));f.db.close();}
 });
 test('unauthorized and duplicate updates do not advance sequence; out-of-sequence rejection cannot decide v2',async()=>{
  const f=fixture({updates:({poll,update})=>{
   if(poll===1)return[update('/approve qa-tg-01-v1',1,999),update('/approve qa-tg-01-v1',2,ID,999)];
   if(poll===2)return[update('/approve qa-tg-01-v1',3)];
   if(poll===3)return[update('/approve qa-tg-01-v1',3),update('/reject qa-tg-01-v2',4)];
   if(poll===4)return[update('/approve qa-tg-01-v1',5)];
   if(poll===5)return[update('/reject qa-tg-01-v2',6)];return[update('/stop',7)];
  }});const r=await runner.runApprovedTelegramTest(f.deps);assert.equal(r.status,'COMPLETED');assert.ok(r.commands.some(c=>c.outcome==='UNAUTHORIZED'));assert.ok(r.commands.some(c=>c.outcome==='DUPLICATE_UPDATE'));assert.ok(r.commands.some(c=>c.outcome==='OUT_OF_SEQUENCE'));assert.equal(f.db.prepare('SELECT count(*) n FROM approvals').get().n,2);f.db.close();
 });
 test('early stop persists stop, ends polling, and reports remaining steps incomplete',async()=>{
  const f=fixture({earlyStop:true}),r=await runner.runApprovedTelegramTest(f.deps);assert.equal(r.status,'STOPPED_INCOMPLETE');assert.equal(r.stopEndedPolling,true);assert.equal(r.messages[1].status,'NOT_SENT');assert.equal(f.calls.filter(x=>x==='poll').length,1);f.db.close();
 });
 test('commands queued before either packet cannot count as responses to that packet',async()=>{
  const f=fixture({updates:({poll,update})=>{
   if(poll===1){const u=update('/approve qa-tg-01-v1',1);u.message.message_id=100;return[u];}
   if(poll===2)return[update('/approve qa-tg-01-v1',2)];
   if(poll===3){const u=update('/approve qa-tg-01-v1',3);u.message.message_id=101;return[u];}
   if(poll===4)return[update('/approve qa-tg-01-v1',4)];
   if(poll===5)return[update('/reject qa-tg-01-v2',5)];return[update('/stop',6)];
  }});const r=await runner.runApprovedTelegramTest(f.deps);assert.equal(r.commands[0].outcome,'OUT_OF_SEQUENCE');assert.equal(r.commands[2].outcome,'OUT_OF_SEQUENCE');assert.deepEqual(r.commands.map(c=>c.outcome),['OUT_OF_SEQUENCE','APPROVED','OUT_OF_SEQUENCE','STALE_REVIEW','REJECTED','STOPPED']);assert.equal(r.status,'COMPLETED');f.db.close();
 });
 test('authenticated stop already in a poll batch prevents message 2 after approval 1',async()=>{
  const f=fixture({updates:({update})=>[update('/approve qa-tg-01-v1',1),update('/stop',2)]});
  const r=await runner.runApprovedTelegramTest(f.deps);assert.ok(!f.calls.includes('send:2'));assert.equal(r.messages[1].status,'NOT_SENT');assert.equal(r.status,'STOPPED_INCOMPLETE');assert.equal(r.stopEndedPolling,true);f.db.close();
 });
 test('credential failure before external execution does not consume the live test or expose diagnostics',async()=>{
  const f=fixture();f.deps.loadToken=async()=>{throw Error('WINDOWS_PROTECTION_FAILED');};await assert.rejects(runner.runApprovedTelegramTest(f.deps),/LOCAL_CREDENTIAL_UNAVAILABLE/);assert.equal(getRecord(f.db,'telegram_live_test','synthetic-live-01'),null);assert.equal(f.calls.length,0);f.db.close();
 });
 test('explicit manual normal-user handoff is allowed once only after pre-send network failure',async()=>{
  const f=fixture();const api=f.deps.makeApi();let identityCalls=0;const old=api.identity;api.identity=async()=>{if(++identityCalls===1)throw Error('TELEGRAM_NETWORK_UNCERTAIN');return old();};
  const first=await runner.runApprovedTelegramTest(f.deps);assert.equal(first.phase,'CHECKS');assert.ok(first.messages.every(m=>m.status==='NOT_SENT'));
  await assert.rejects(runner.runApprovedTelegramTest(f.deps),/EXISTING_LIVE_TEST/);
  const result=await runner.runApprovedTelegramTest({...f.deps,manualNormalUserHandoff:true});assert.equal(result.status,'COMPLETED');assert.equal(result.normalUserHandoffUsed,true);assert.equal(f.calls.filter(c=>c.startsWith('send:')).length,2);
  await assert.rejects(runner.runApprovedTelegramTest({...f.deps,manualNormalUserHandoff:true}),/HANDOFF_NOT_ALLOWED/);f.db.close();
 });
 test('manual handoff refuses uncertain sends, conflicts and any created synthetic state',async()=>{
  for(const options of [{uncertain:1},{conflict:true},{deadline:true}]){const f=fixture(options);await runner.runApprovedTelegramTest(f.deps);const before=f.calls.length;await assert.rejects(runner.runApprovedTelegramTest({...f.deps,manualNormalUserHandoff:true}),/HANDOFF_NOT_ALLOWED/);assert.equal(f.calls.length,before);f.db.close();}
 });
 test('poll failure reports the failing operation, remaining allowance and unexercised checks without losing accepted sends',async()=>{
  const f=fixture(),api=f.deps.makeApi();let polls=0;api.poll=async()=>{if(++polls===1)return[];const e=Error('TELEGRAM_NETWORK_UNCERTAIN');e.diagnostic={category:'SOCKET_RESET',method:'getUpdates',requestTimeoutMs:25000,elapsedMs:1200};throw e;};
  const r=await runner.runApprovedTelegramTest(f.deps);assert.equal(r.terminalReason.code,'TELEGRAM_NETWORK_UNCERTAIN');assert.equal(r.terminalReason.operation,'getUpdates');assert.equal(r.terminalReason.diagnostic.category,'SOCKET_RESET');assert.ok(r.terminalReason.remainingMs>0);
  assert.equal(r.polling.attempts,2);assert.equal(r.polling.completed,1);assert.equal(r.polling.emptyResponses,1);assert.equal(r.polling.last.offset,1);
  assert.equal(r.messages[0].status,'API_CONFIRMED');assert.equal(r.messages[1].status,'NOT_SENT');assert.equal(r.checkOutcomes.revisionInvalidation,'NOT_EXERCISED');assert.equal(r.checkOutcomes.staleRejection,'NOT_EXERCISED');assert.equal(r.checkOutcomes.stopEndedPolling,'NOT_EXERCISED');assert.ok(f.events.at(-1).terminalReason);f.db.close();
 });
 test('long manual waiting interval does not reduce execution allowance and stopped state permits synthetic polling',async()=>{
  const f=fixture(),api=f.deps.makeApi();let time=Date.parse('2026-11-16T18:00:00Z'),first=true;f.deps.clock=()=>time;const old=api.identity;api.identity=async()=>{if(first){first=false;time+=1627;throw Error('TELEGRAM_NETWORK_UNCERTAIN');}return old();};
  await runner.runApprovedTelegramTest(f.deps);time+=3600000;api.poll=async()=>{throw Error('TELEGRAM_NETWORK_UNCERTAIN');};const r=await runner.runApprovedTelegramTest({...f.deps,manualNormalUserHandoff:true});
  assert.equal(Date.parse(r.deadline)-Date.parse(r.startedAt),298373);assert.equal(r.terminalReason.operation,'getUpdates');assert.equal(r.polling.attempts,1);assert.equal(r.finalControls.stopped,true);f.db.close();
 });
}
