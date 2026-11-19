import test from 'node:test';
import assert from 'node:assert/strict';
import https from 'node:https';
import {EventEmitter} from 'node:events';
import {createTelegramWritingFixtureApi,createTelegramWritingLiveApi} from '../src/telegram-api.mjs';
import {blockNetwork} from './helpers/network-block.mjs';
import {openStore,putRecord,getRecord,controls} from '../src/store.mjs';

async function fixture(t,options={}){
 blockNetwork(t);const module=await import('../src/telegram-pending-inspection.mjs');
 const db=openStore(':memory:'),syntheticDb=openStore(':memory:');t.after(()=>{db.close();syntheticDb.close();});
 const pairing={confirmed:true,userId:42,chatId:42,botId:777};
 putRecord(db,'telegram_binding','primary',pairing,'configuration');
 putRecord(db,'telegram_writing_authorization','telegram-writing-live-v1',{status:'CLOSED'},'configuration');
 putRecord(db,'telegram_writing_cursor','primary',{nextOffset:100},'confirmed');
 putRecord(db,'contact','held',{status:'HELD'});putRecord(db,'draft','unapproved',{status:'UNAPPROVED'});
 const ref='wr_abcdefghijklmnopqrstuv';
 const review={id:'telegram-writing-live-v1',version:1,packetHash:'a'.repeat(64),messageId:13,actions:{DETAILS:ref}};
 putRecord(syntheticDb,'telegram_writing_review',review.id,review,'configuration');
 putRecord(syntheticDb,'telegram_writing_action',ref,{telegramReviewId:review.id,action:'DETAILS'},'configuration');
 const approved={pairing,protectedHash:module.protectedInspectionHash(db),reviewHash:module.inspectionReviewHash(syntheticDb)};
 const updates=[{update_id:100,callback_query:{id:'sensitive-callback-id',from:{id:42},data:ref,message:{message_id:13,date:1794865718,chat:{id:42,type:'private'},from:{id:777,is_bot:true}}}},{update_id:101,message:{message_id:14,date:1794865790,text:'/stop',from:{id:42},chat:{id:42,type:'private'}}},{update_id:102,message:{message_id:15,text:'UNRELATED_SECRET_TEXT',from:{id:99},chat:{id:99,type:'private'}}}];
 let tick=0,loads=0;const calls=[];
 const makeApi=(_token,guard)=>{
  const api=createTelegramWritingFixtureApi(async(method,body,ms)=>{
   guard(options.guardAttack?.method??method,options.guardAttack?.body??body,ms);calls.push({method,body});tick+=options.tick??1;
   if(options.fail===method)throw Error('https://token-bearing-example.invalid/SECRET');
   const result=method==='getMe'?{id:options.identity??777,is_bot:true}:method==='getWebhookInfo'?{url:options.webhook?'https://private.example/webhook':''}:options.updates??updates;
   return {status:200,body:JSON.stringify({ok:true,result})};
  });return {...api,close:async()=>{if(options.changeOwnerOnClose)putRecord(db,'telegram_consumer_owner','primary',{ownerId:'other',status:'ACTIVE'});return {closed:true,remainingRequests:0};}};
 };
 return {db,syntheticDb,approved,calls,ref,module,get loads(){return loads;},run:()=>module.runPendingInspection({db,syntheticDb,approved,loadToken:async()=>{loads++;return 'FIXTURE';},makeApi,clock:()=>tick,wallClock:()=>1794866400000})};
}

test('one-use inspection preserves cursor/receipts/decisions/business state and saves sanitized inventory only',async t=>{
 const f=await fixture(t),before=f.module.protectedInspectionHash(f.db),s=f.syntheticDb.prepare('SELECT * FROM records ORDER BY kind,id').all();
 const r=await f.run();assert.equal(r.reason,'INSPECTION_COMPLETE');assert.equal(r.authorizationStatus,'CLOSED');
 assert.deepEqual(f.calls.map(c=>c.method),['getMe','getWebhookInfo','getUpdates']);assert.deepEqual(f.calls[2].body,{timeout:0,limit:100});
 assert.equal(f.module.protectedInspectionHash(f.db),before);assert.deepEqual(f.syntheticDb.prepare('SELECT * FROM records ORDER BY kind,id').all(),s);
 assert.equal(r.inventory[0].decodedAction,'DETAILS');assert.equal(r.inventory[0].mapsToClosedPacket,true);assert.equal(r.inventory[0].actionTimestamp,'UNKNOWN');
 assert.equal(r.inventory[1].isStop,true);assert.equal(r.inventory[2].classification,'UNRELATED');
 const saved=JSON.stringify(r)+JSON.stringify(f.db.prepare('SELECT * FROM records').all());
 for(const forbidden of [f.ref,'sensitive-callback-id','UNRELATED_SECRET_TEXT'])assert.equal(saved.includes(forbidden),false);
 assert.equal(controls(f.db).stopped,true);assert.equal(controls(f.db).launchAuthorized,false);assert.equal(getRecord(f.db,'telegram_consumer_owner','primary').status,'RELEASED');
 const again=await f.run();assert.equal(again.reason,'INSPECTION_ALREADY_ATTEMPTED');assert.equal(f.calls.length,3);assert.equal(f.loads,1);
});
for(const [label,options,reason,count]of [['webhook',{webhook:true},'TELEGRAM_EXISTING_WEBHOOK',2],['identity',{identity:888},'BOT_IDENTITY_MISMATCH',1],['failure',{fail:'getUpdates'},'TELEGRAM_NETWORK_UNCERTAIN',3],['deadline',{tick:26000},'INSPECTION_API_DEADLINE',1]])test(`inspection stops on ${label} without retry`,async t=>{
 const f=await fixture(t,options);const r=await f.run();assert.equal(r.reason,reason);assert.equal(f.calls.length,count);assert.equal(r.authorizationStatus,'CLOSED');assert.equal(r.cleanup.confirmed,true);assert.equal(getRecord(f.db,'telegram_writing_cursor','primary').nextOffset,100);
});
test('existing owner is not stolen and credential is not accessed',async t=>{
 const f=await fixture(t);putRecord(f.db,'telegram_consumer_owner','primary',{ownerId:'other',status:'ACTIVE'});const r=await f.run();
 assert.equal(r.reason,'TELEGRAM_CONSUMER_BUSY');assert.equal(f.loads,0);assert.equal(f.calls.length,0);assert.equal(getRecord(f.db,'telegram_consumer_owner','primary').ownerId,'other');assert.equal(r.authorizationStatus,'CLOSED');
});
test('100 returned updates is a truncation warning, never a second request',async t=>{
 const f=await fixture(t,{updates:Array.from({length:100},(_,i)=>({update_id:i+100}))});const r=await f.run();assert.equal(r.additionalUpdatesMayExist,true);assert.equal(r.inventory.length,100);assert.equal(f.calls.length,3);
});
test('ownership change at cleanup closes authorization with uncertainty without touching the other owner',async t=>{
 const f=await fixture(t,{changeOwnerOnClose:true});const r=await f.run();
 assert.equal(r.authorizationStatus,'CLOSED');assert.equal(r.reason,'INSPECTION_CLEANUP_UNCONFIRMED');assert.equal(r.cleanup.confirmed,false);assert.equal(r.cleanup.ownershipReleased,false);
 assert.equal(getRecord(f.db,'telegram_consumer_owner','primary').ownerId,'other');assert.equal(f.calls.length,3);
});
for(const attack of [{method:'sendMessage',body:{chat_id:42,text:'NOT_ALLOWED'}},{method:'getUpdates',body:{offset:0,timeout:0,limit:100}},{method:'getMe',body:{allowed_updates:[]}}])test(`request guard rejects unauthorized ${attack.method}/${Object.keys(attack.body).join(',')} before dispatch`,async t=>{
 const f=await fixture(t,{guardAttack:attack});const r=await f.run();assert.equal(f.calls.length,0);assert.equal(r.apiAttemptCount,0);assert.equal(r.authorizationStatus,'CLOSED');assert.equal(getRecord(f.db,'telegram_writing_cursor','primary').nextOffset,100);
});

test('inspection serializes exactly timeout0/limit100, without offset or subscription fields',async t=>{
 blockNetwork(t);const requests=[];
 const api=createTelegramWritingFixtureApi(async(method,body)=>{requests.push({method,body:JSON.parse(JSON.stringify(body))});return {status:200,body:JSON.stringify({ok:true,result:[]})};});
 assert.equal(typeof api.inspectPending,'function');
 assert.deepEqual(await api.inspectPending(1000),[]);
 assert.deepEqual(requests,[{method:'getUpdates',body:{timeout:0,limit:100}}]);
});
test('inspection failure makes one attempt with no retry or follow-on poll',async t=>{
 blockNetwork(t);let attempts=0;
 const api=createTelegramWritingFixtureApi(async()=>{attempts++;throw Error('fixture failure');});
 assert.equal(typeof api.inspectPending,'function');
 await assert.rejects(api.inspectPending(1000),/TELEGRAM_NETWORK_UNCERTAIN/);
 assert.equal(attempts,1);
});

test('existing live transport serializes the exact inspection body at the HTTPS boundary',async t=>{
 const network=blockNetwork(t);const bodies=[];
 t.mock.method(https,'request',(_options,onResponse)=>{
  const req=new EventEmitter();req.destroy=()=>req.emit('close');
  req.end=body=>{bodies.push(JSON.parse(body));queueMicrotask(()=>{const res=new EventEmitter();res.statusCode=200;onResponse(res);res.emit('data',Buffer.from('{"ok":true,"result":[]}'));res.emit('end');req.emit('close');});};return req;
 });
 const api=createTelegramWritingLiveApi('123456:'+ 'x'.repeat(32),(_method,_body,ms)=>ms);
 assert.deepEqual(await api.inspectPending(1000),[]);assert.deepEqual(bodies,[{timeout:0,limit:100}]);
 assert.deepEqual(await api.close(),{closed:true,remainingRequests:0});assert.equal(network.attempts,0);
});
