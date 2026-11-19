import test from 'node:test';import assert from 'node:assert/strict';import { PassThrough } from 'node:stream';
import { mkdtempSync,readFileSync } from 'node:fs';import { tmpdir } from 'node:os';import { join } from 'node:path';
import { openStore,getRecord,controls } from '../src/store.mjs';
const ui=await import('../src/telegram-local.mjs').catch(()=>null);
const runner=await import('../src/telegram-setup-flow.mjs').catch(()=>null);
const storage=await import('../src/windows-protected-storage.mjs').catch(()=>null);
test('local secure setup components exist',()=>{assert.ok(ui);assert.ok(runner);assert.ok(storage);});
if(ui)test('masked terminal input never echoes secret and restores raw mode; deadline and non-TTY fail closed',async()=>{
 const input=new PassThrough(),output=new PassThrough();input.isTTY=true;output.isTTY=true;input.isRaw=false;input.setRawMode=value=>input.isRaw=value;let shown='';output.on('data',x=>shown+=x);
 const ask=ui.createLocalPrompt(input,output);const read=ask('Token:',{masked:true,ms:1000});input.write('private-value\r');assert.equal(await read,'private-value');assert.ok(!shown.includes('private-value'));assert.equal(input.isRaw,false);
 await assert.rejects(ask('Confirm:',{ms:5}),/LOCAL_INPUT_TIMEOUT/);assert.equal(input.listenerCount('data'),0);
 assert.throws(()=>ui.createLocalPrompt(new PassThrough(),output),/LOCAL_TERMINAL_REQUIRED/);
});
if(storage)test('Windows DPAPI round trip protects a synthetic value and refuses overwrite',{skip:process.platform!=='win32'},async()=>{
 const dir=mkdtempSync(join(tmpdir(),'elya-dpapi-')),file=join(dir,'synthetic.dpapi'),value='synthetic-no-credential-123';
 await storage.storeProtected(file,value,5000);assert.ok(!readFileSync(file,'utf8').includes(value));assert.equal(await storage.readProtected(file,5000),value);
 await assert.rejects(storage.storeProtected(file,'replacement',5000));
});
if(runner){
 function setup(options={}){const db=openStore(':memory:');let clock=1000000,code='',calls=[],reads=0;const fake={
  identity:async()=>{calls.push('getMe');return{id:777,is_bot:true,username:'elya_fixture_bot'};},
  checkWebhook:async()=>{calls.push('getWebhookInfo');if(options.webhook)throw Error('TELEGRAM_EXISTING_WEBHOOK');},
  poll:async()=>{calls.push('getUpdates');if(options.conflict)throw Error('TELEGRAM_CONSUMER_CONFLICT');if(options.expire){clock+=300000;return[];}return[{update_id:1,message:{date:1000,text:code,from:{id:42,is_bot:false,first_name:'Daniel'},chat:{id:42,type:'private'}}}];},
  acknowledge:async(chat,ms)=>{calls.push('sendMessage');assert.ok(ms<=300000);if(options.uncertain)throw Error('token-bearing-url');return{message_id:8,chat:{id:chat,type:'private'},from:{id:777,is_bot:true},text:'Pairing test successful. This bot is connected for testing only. The business workflow remains stopped. No campaigns, provider jobs, or outreach have been launched.'};}
 };return{db,calls,deps:{db,clock:()=>clock,ask:async(prompt,{masked})=>{reads++;if(reads===1){assert.equal(masked,true);return'123456:'+ 'x'.repeat(35);}return options.reject?'NO':'PAIR 42 42';},display:(kind,value)=>{if(kind==='code')code=value;},storeToken:async()=>{calls.push('protected-store');},makeApi:()=>fake}};}
 test('complete offline setup verifies identity and webhook, confirms exact IDs then sends one acknowledgment',async()=>{
  const f=setup();assert.equal((await runner.runTelegramSetup(f.deps)).stage,'ACK_CONFIRMED');assert.deepEqual(f.calls,['getMe','getWebhookInfo','protected-store','getUpdates','sendMessage']);assert.equal(controls(f.db).stopped,true);assert.equal(controls(f.db).launchAuthorized,false);
  const before=f.calls.length;await assert.rejects(runner.runTelegramSetup(f.deps),/EXISTING_PAIRING_ATTEMPT/);assert.equal(f.calls.length,before);f.db.close();
 });
 test('webhook, consumer conflict, expiry, and local rejection never send',async()=>{
  for(const options of [{webhook:true},{conflict:true},{expire:true},{reject:true}]){const f=setup(options);const r=await runner.runTelegramSetup(f.deps);assert.equal(r.stage,'STOPPED');assert.ok(!f.calls.includes('sendMessage'));assert.equal(getRecord(f.db,'telegram_binding','primary'),null);f.db.close();}
 });
 test('uncertain acknowledgment stops and is not retried by another invocation',async()=>{
  const f=setup({uncertain:true});assert.equal((await runner.runTelegramSetup(f.deps)).stage,'ACK_UNCERTAIN');await assert.rejects(runner.runTelegramSetup(f.deps));assert.equal(f.calls.filter(x=>x==='sendMessage').length,1);f.db.close();
 });
}
