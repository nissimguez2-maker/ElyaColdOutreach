import test from 'node:test';
import assert from 'node:assert/strict';
import { openStore, controls, getRecord, setStopped } from '../src/store.mjs';
const api=await import('../src/telegram-pairing.mjs').catch(()=>null);
test('bounded Telegram pairing implementation exists',()=>assert.ok(api));
const ACK='Pairing test successful. This bot is connected for testing only. The business workflow remains stopped. No campaigns, provider jobs, or outreach have been launched.';
function setup(){const db=openStore(':memory:');let time=1000000;const session=new api.PairingSession(db,()=>time);session.claim();const code=session.startWindow();session.setBot({id:777,is_bot:true,username:'elya_fixture_bot'});return{db,session,code,advance:n=>time+=n};}
function update(code,id=1,user=42,chat=42,type='private'){return{update_id:id,message:{date:1000,text:code,from:{id:user,is_bot:false,first_name:'Daniel'},chat:{id:chat,type}}};}
if(api){
 test('wrong code and group/channel or mismatched sender cannot become pairing candidates',()=>{
  const{db,session,code}=setup();for(const u of [update('wrong'),update(code,2,42,-42,'group'),update(code,3,42,43),{update_id:4,channel_post:update(code).message}])assert.equal(session.consider(u),null);
  assert.equal(getRecord(db,'telegram_binding','primary'),null);db.close();
 });
 test('correct code requires exact local confirmation; code is single-use and updates deduplicated',()=>{
  const{db,session,code}=setup();const candidate=session.consider(update(code));assert.equal(candidate.userId,42);
  assert.equal(session.consider(update(code)),null);assert.equal(session.consider(update(code,2)),null);
  assert.equal(getRecord(db,'telegram_binding','primary'),null);
  assert.throws(()=>session.confirm(43,42),/PAIRING_CONFIRMATION_MISMATCH/);session.confirm(42,42);
  assert.equal(api.isPairedSender(db,update('control').message),true);
  for(const u of [update('x',2,43,42),update('x',3,42,43),update('x',4,42,42,'group')])assert.equal(api.isPairedSender(db,u.message),false);
  assert.equal(controls(db).stopped,true);assert.equal(controls(db).launchAuthorized,false);
  assert.ok(!JSON.stringify(db.prepare('SELECT * FROM records').all()).includes(code));db.close();
 });
 test('five-minute expiry blocks code acceptance and delayed local confirmation',()=>{
  for(const candidateFirst of [false,true]){const{db,session,code,advance}=setup();if(candidateFirst)session.consider(update(code));advance(300000);
   if(candidateFirst)assert.throws(()=>session.confirm(42,42),/PAIRING_EXPIRED/);else assert.equal(session.consider(update(code)),null);
   assert.equal(getRecord(db,'telegram_binding','primary'),null);db.close();}
 });
 test('exact single acknowledgment recorded; repeated send and restart are blocked',async()=>{
  const{db,session,code}=setup();session.consider(update(code));session.confirm(42,42);let calls=0;
  const send=async(chat,text)=>{calls++;assert.equal(chat,42);assert.equal(text,ACK);return{message_id:9,chat:{id:42,type:'private'},from:{id:777,is_bot:true},text:ACK};};
  assert.equal(await session.acknowledge(send),'ACK_CONFIRMED');await assert.rejects(session.acknowledge(send));assert.equal(calls,1);
  assert.throws(()=>new api.PairingSession(db).claim(),/EXISTING_PAIRING_ATTEMPT/);assert.equal(controls(db).launchAuthorized,false);db.close();
 });
 test('lost acknowledgment response or wrong response stays uncertain without resend',async()=>{
  for(const response of [null,{message_id:1,chat:{id:99,type:'private'},text:ACK}]){const{db,session,code}=setup();session.consider(update(code));session.confirm(42,42);let calls=0;
   const send=async()=>{calls++;if(!response)throw Error('https://api.telegram.org/bot123456:secret/sendMessage');return response;};
   assert.equal(await session.acknowledge(send),'ACK_UNCERTAIN');await assert.rejects(session.acknowledge(send));assert.equal(calls,1);
   assert.ok(!JSON.stringify(db.prepare('SELECT * FROM journal').all()).includes('api.telegram'));db.close();}
 });
 test('interruption invalidates session; concurrent/restarted setup cannot repeat external actions',()=>{
  const{db,session,code}=setup();assert.throws(()=>new api.PairingSession(db).claim(),/EXISTING_PAIRING_ATTEMPT/);
  session.stop();assert.equal(session.consider(update(code)),null);assert.throws(()=>session.confirm(42,42));
  assert.throws(()=>new api.PairingSession(db).claim(),/EXISTING_PAIRING_ATTEMPT/);db.close();
 });
 test('pairing requires stopped business state and never unsets stop or launch',async()=>{
  const db=openStore(':memory:');setStopped(db,false,'fixture');assert.throws(()=>new api.PairingSession(db).claim(),/BUSINESS_MUST_REMAIN_STOPPED/);db.close();
  const f=setup();f.session.consider(update(f.code));f.session.confirm(42,42);setStopped(f.db,false,'fixture');let calls=0;
  await assert.rejects(f.session.acknowledge(async()=>{calls++;}),/BUSINESS_MUST_REMAIN_STOPPED/);assert.equal(calls,0);f.db.close();
 });
}
