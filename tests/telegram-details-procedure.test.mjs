import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {openStore,putRecord,getRecord,controls} from '../src/store.mjs';
import {canonical,digest} from '../src/values.mjs';
import {blockNetwork} from './helpers/network-block.mjs';
import {createTelegramWritingFixtureApi} from '../src/telegram-api.mjs';

const at='2026-11-16T23:00:00.000Z';
async function fixture(t,options={}){
 blockNetwork(t);const m=await import('../src/telegram-details-procedure.mjs');
 const db=openStore(':memory:'),s=openStore(':memory:');t.after(()=>{db.close();s.close();});
 const pairing={confirmed:true,userId:42,chatId:42,botId:777};putRecord(db,'telegram_binding','primary',pairing,'configuration');
 putRecord(db,'telegram_writing_cursor','primary',{nextOffset:64381638});
 putRecord(db,'contact','real-held',{status:'HELD'});putRecord(db,'draft','real-unapproved',{status:'UNAPPROVED'});
 const evidence=JSON.parse(readFileSync('work/telegram-pending-inspection-v1/result.json','utf8'));
 const priorApproval={pairing};evidence.approvalBindingHash=digest(canonical(priorApproval));
 putRecord(db,'telegram_pending_inspection',evidence.id,evidence,'confirmed');
 const approved={id:m.DETAILS_ID,pairing,evidenceHash:digest(canonical(evidence)),priorApprovalHash:digest(canonical(priorApproval)),cardHash:m.detailsCardHash()};
 if(!options.unapproved)putRecord(db,'telegram_details_authorization',m.DETAILS_ID,{status:'APPROVED',approved},'configuration');
 let clock=0,closed=0,polls=0;const calls=[];
 const stop={update_id:64381640,message:{message_id:14,date:1794865906,text:'/stop',from:{id:42,is_bot:false},chat:{id:42,type:'private'}}};
 const makeApi=(_token,guard)=>{
  const api=createTelegramWritingFixtureApi(async(method,body,ms)=>{
   guard(method,body,ms);calls.push({method,body});clock+=options.tickMs??20;
   if(options.fail===method)throw Error('fixture failure');
   let result;
   if(method==='getMe')result={id:777,is_bot:true};
   if(method==='getWebhookInfo')result={url:options.webhook?'https://exists.invalid':''};
   if(method==='sendMessage')result={message_id:body.reply_markup?30:31,chat:{id:42,type:'private'},from:{id:777,is_bot:true}};
   if(method==='answerCallbackQuery')result=true;
   if(method==='getUpdates'){
    polls++;
    if(polls===1)result=options.unknown?[stop,{update_id:64381641,message:{message_id:20,text:'unrelated',from:{id:42,is_bot:false},chat:{id:42,type:'private'},date:1794865907}}]:[stop];
    else if(options.empty)result=[stop];
    else if(options.stop)result=[stop,{update_id:64381642,message:{...stop.message,message_id:32,date:Math.floor((Date.parse(at)+clock)/1000)}}];
    else{
     const page=calls.find(x=>x.method==='sendMessage').body;
     const q={update_id:64381642,callback_query:{id:'fixture-callback',from:{id:options.unauthorized?99:42,is_bot:false},message:{message_id:options.wrongMessage?99:30,date:Math.floor(Date.parse(at)/1000),from:{id:777,is_bot:true},chat:{id:42,type:'private'}},data:page.reply_markup.inline_keyboard[0][0].callback_data}};
     if(options.expired)q.callback_query.message.date=1;
     if(options.unknownAction)q.callback_query.data='wr_'+ 'z'.repeat(22);
     result=[stop,q];
    }
   }
   return {status:200,body:JSON.stringify({ok:true,result})};
  });return {...api,close:async()=>{closed++;return {closed:true,remainingRequests:0};}};
 };
 return {m,db,s,evidence,priorApproval,approved,calls,stop,get closed(){return closed;},run:()=>m.runDetailsProcedure({db,syntheticDb:s,evidence,priorApproval,loadToken:async()=> 'FIXTURE',makeApi,clock:()=>clock,wallClock:()=>Date.parse(at),sleep:async ms=>{clock+=ms;}})};
}
test('known stop gets an evidence-based receipt with unchanged cursor and preserved stopped controls',async t=>{
 const f=await fixture(t);f.m.reconcileKnownStop(f.db,f.evidence,f.priorApproval,at);
 const r=getRecord(f.db,'telegram_control_receipt','777:64381640');assert.equal(r.status,'STOPPED');assert.equal(r.provenance,'INSPECTION_SUMMARY_RECONCILIATION');assert.equal(r.rawUpdateAvailable,false);
 assert.equal(getRecord(f.db,'telegram_writing_cursor','primary').nextOffset,64381638);assert.equal(controls(f.db).stopped,true);assert.equal(controls(f.db).launchAuthorized,false);
 const timestamp=controls(f.db).updatedAt;assert.throws(()=>f.m.reconcileKnownStop(f.db,f.evidence,f.priorApproval,at),/ALREADY_RECONCILED/);assert.equal(controls(f.db).updatedAt,timestamp);
});
test('changed inspection summary is rejected before stop mutation',async t=>{
 const f=await fixture(t);f.evidence.inventory[0].updateId++;const before=controls(f.db);assert.throws(()=>f.m.reconcileKnownStop(f.db,f.evidence,f.priorApproval,at));assert.deepEqual(controls(f.db),before);
});
test('combined procedure uses real one-button payload and handler, no offset, no decisions, no stop required for success',async t=>{
 const f=await fixture(t);const r=await f.run();assert.equal(r.reason,'DETAILS_CALLBACK_CONFIRMED',JSON.stringify(r));assert.equal(r.authorizationStatus,'CLOSED');assert.equal(r.cleanup.confirmed,true);
 const sends=f.calls.filter(x=>x.method==='sendMessage');assert.equal(sends.length,2);assert.equal(sends[0].body.text,f.m.TEST_MESSAGE);assert.deepEqual(sends[0].body.reply_markup.inline_keyboard.map(row=>row.map(b=>b.text)),[['Details']]);assert.equal(sends[1].body.text,f.m.DETAILS_RESPONSE);
 assert.equal(f.calls.filter(x=>x.method==='answerCallbackQuery').length,1);for(const c of f.calls.filter(x=>x.method==='getUpdates'))assert.deepEqual(c.body,{timeout:0,limit:100});
 assert.equal(getRecord(f.db,'telegram_writing_cursor','primary').nextOffset,64381638);assert.equal(f.s.prepare("SELECT count(*) n FROM records WHERE kind='writing_decision'").get().n,0);
 assert.deepEqual(getRecord(f.db,'contact','real-held'),{status:'HELD'});assert.deepEqual(getRecord(f.db,'draft','real-unapproved'),{status:'UNAPPROVED'});assert.equal(f.db.prepare('SELECT count(*) n FROM approvals').get().n,0);
 assert.equal(r.stopReceived,false);assert.equal(r.detailsDelivery.status,'API_CONFIRMED');assert.equal(f.closed,1);
 const count=f.calls.length;const again=await f.run();assert.equal(again.reason,'DETAILS_AUTHORIZATION_NOT_APPROVED');assert.equal(f.calls.length,count);
});
for(const options of [{unapproved:true},{unknown:true},{unauthorized:true},{wrongMessage:true},{webhook:true},{fail:'sendMessage'},{stop:true},{empty:true},{expired:true},{unknownAction:true}])test(`bounded stop: ${JSON.stringify(options)}`,async t=>{
 const f=await fixture(t,options);const r=await f.run();assert.notEqual(r.reason,'DETAILS_CALLBACK_CONFIRMED');assert.equal(getRecord(f.db,'telegram_writing_cursor','primary').nextOffset,64381638);assert.equal(f.calls.filter(x=>x.method==='answerCallbackQuery').length,0);
 if(options.unapproved){assert.equal(f.calls.length,0);assert.equal(getRecord(f.db,'telegram_control_receipt','777:64381640'),null);}
 if(options.unknown){assert.equal(f.calls.filter(x=>x.method==='sendMessage').length,0);assert.equal(getRecord(f.db,'telegram_control_receipt','777:64381640'),null);}
 if(options.unauthorized||options.wrongMessage)assert.ok(r.receivedActions.length);
 if(options.fail)assert.equal(f.calls.filter(x=>x.method==='sendMessage').length,1);
 if(options.stop){assert.equal(r.reason,'AUTHENTICATED_STOP');assert.equal(r.stopReceived,true);assert.equal(f.calls.at(-1).method,'getUpdates');}
 if(options.empty)assert.ok(f.calls.length<=16);
});
test('uncertain acknowledgment retains synthetic receipt, sends no details and never retries',async t=>{
 const f=await fixture(t,{fail:'answerCallbackQuery'});const r=await f.run();assert.notEqual(r.reason,'DETAILS_CALLBACK_CONFIRMED');assert.equal(f.calls.filter(c=>c.method==='answerCallbackQuery').length,1);assert.equal(f.calls.filter(c=>c.method==='sendMessage').length,1);assert.equal(r.authorizationStatus,'CLOSED');assert.equal(f.s.prepare("SELECT count(*) n FROM records WHERE kind='telegram_control_receipt'").get().n,1);
});
