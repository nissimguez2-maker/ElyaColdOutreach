import test from 'node:test';import assert from 'node:assert/strict';import {EventEmitter} from 'node:events';
import {createTelegramReviewApi} from '../src/telegram-api.mjs';
import https from 'node:https';
const token='123456:'+ 'q'.repeat(35);
function fakeRequest(mode){return(_options,callback)=>{
 const req=new EventEmitter();req.destroy=()=>{};req.end=()=>queueMicrotask(()=>{
  if(mode==='timeout')return;
  if(mode==='aborted'||mode==='oversize'){const res=new EventEmitter();res.statusCode=200;res.destroy=()=>{};callback(res);if(mode==='aborted')res.emit('aborted');else res.emit('data',Buffer.alloc(524289));return;}
  const error=Error(`https://api.telegram.org/bot${token}/getUpdates`);error.code=mode;req.emit('error',error);
 });return req;
};}
test('native network failures retain only safe operation/category/timing diagnostics',async()=>{
 const original=https.request;https.request=()=>{throw Error('Network forbidden in offline test');};try{
 for(const [mode,category] of [['ECONNRESET','SOCKET_RESET'],['ENOTFOUND','DNS_LOOKUP_FAILED'],['EACCES','LOCAL_ACCESS_DENIED'],['ECANCELED','REQUEST_CANCELLED'],['aborted','RESPONSE_ABORTED'],['oversize','RESPONSE_LIMIT_EXCEEDED'],['timeout','REQUEST_TIMEOUT']]){
  const api=createTelegramReviewApi(token,{request:fakeRequest(mode)});await assert.rejects(api.poll(123,20),error=>{assert.equal(error.message,'TELEGRAM_NETWORK_UNCERTAIN');assert.equal(error.diagnostic.category,category);assert.equal(error.diagnostic.method,'getUpdates');assert.equal(error.diagnostic.requestTimeoutMs,20);assert.ok(Number.isFinite(error.diagnostic.elapsedMs));assert.ok(!JSON.stringify(error).includes(token));assert.ok(!JSON.stringify(error).includes('api.telegram.org'));return true;});
 }
 }finally{https.request=original;}
});
