import test from 'node:test';import assert from 'node:assert/strict';
const transport=await import('../src/telegram-api.mjs').catch(()=>null);
test('Telegram restricted transport exists',()=>assert.ok(transport));
if(transport){
 test('transport drops secret-bearing diagnostics and never retries',async()=>{
  let calls=0;const token='123456:'+ 'a'.repeat(35);const api=transport.createTelegramApi(token,{exchange:async()=>{calls++;throw Error(`failure https://api.telegram.org/bot${token}/getMe`);}});
  await assert.rejects(api.identity(100),e=>e.message==='TELEGRAM_NETWORK_UNCERTAIN'&&!JSON.stringify(e).includes(token));assert.equal(calls,1);
 });
 test('webhook or conflicting consumer stops without replacement',async()=>{
  for(const body of [{ok:true,result:{url:'https://private.invalid/secret'}},{ok:false,error_code:409,description:'conflict'}]){
   const api=transport.createTelegramApi('123456:'+ 'b'.repeat(35),{exchange:async()=>({status:body.ok?200:409,body:JSON.stringify(body)})});
   await assert.rejects(api.checkWebhook(100),/EXISTING_WEBHOOK|CONSUMER_CONFLICT/);
  }
 });
 test('transport only exposes fixed setup operations and exact acknowledgment',async()=>{
  const seen=[];const api=transport.createTelegramApi('123456:'+ 'c'.repeat(35),{exchange:async(method,body)=>{seen.push({method,body});return{status:200,body:JSON.stringify({ok:true,result:[]})};}});
  await api.poll(0,1200);assert.deepEqual(seen[0],{method:'getUpdates',body:{offset:0,timeout:0,limit:100,allowed_updates:['message']}});
  assert.equal(api.call,undefined);await assert.rejects(api.acknowledge(-1,100));assert.equal(seen.length,1);
 });
}
