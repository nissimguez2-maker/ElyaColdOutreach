import https from 'node:https';
import { performance } from 'node:perf_hooks';
import { ACK_TEXT,numericId } from './telegram-pairing.mjs';
import { APPROVED_CHAT_ID,APPROVED_PACKETS } from './telegram-live-contract.mjs';
import { WRITING_BUTTONS } from './telegram-writing-render.mjs';
const allowed=new Set(['getMe','getWebhookInfo','getUpdates','sendMessage','answerCallbackQuery']);
const networkCategories=new Set(['SOCKET_RESET','DNS_LOOKUP_FAILED','DNS_TEMPORARY_FAILURE','LOCAL_ACCESS_DENIED','REQUEST_CANCELLED','RESPONSE_ABORTED','RESPONSE_LIMIT_EXCEEDED','REQUEST_TIMEOUT','SOCKET_TIMEOUT','CONNECTION_REFUSED','NETWORK_UNREACHABLE','TLS_ERROR','RESPONSE_STREAM_ERROR','UNCLASSIFIED_NETWORK_FAILURE']);
function categoryFor(error){return ({ECONNRESET:'SOCKET_RESET',ENOTFOUND:'DNS_LOOKUP_FAILED',EAI_AGAIN:'DNS_TEMPORARY_FAILURE',EACCES:'LOCAL_ACCESS_DENIED',EPERM:'LOCAL_ACCESS_DENIED',ECANCELED:'REQUEST_CANCELLED',ABORT_ERR:'REQUEST_CANCELLED',ETIMEDOUT:'SOCKET_TIMEOUT',ECONNREFUSED:'CONNECTION_REFUSED',ENETUNREACH:'NETWORK_UNREACHABLE',EHOSTUNREACH:'NETWORK_UNREACHABLE',ERR_TLS_CERT_ALTNAME_INVALID:'TLS_ERROR',CERT_HAS_EXPIRED:'TLS_ERROR',UNABLE_TO_VERIFY_LEAF_SIGNATURE:'TLS_ERROR'})[error?.code]??'UNCLASSIFIED_NETWORK_FAILURE';}
export function safeNetworkDiagnostic(value,method){
 return {category:networkCategories.has(value?.category)?value.category:'UNCLASSIFIED_NETWORK_FAILURE',method:allowed.has(method)?method:null,requestTimeoutMs:Number.isSafeInteger(value?.requestTimeoutMs)&&value.requestTimeoutMs>0&&value.requestTimeoutMs<=25000?value.requestTimeoutMs:null,elapsedMs:Number.isSafeInteger(value?.elapsedMs)&&value.elapsedMs>=0&&value.elapsedMs<=300000?value.elapsedMs:null};
}
function networkFailure(category,method,requestTimeoutMs,elapsedMs){const error=Error('TELEGRAM_NETWORK_UNCERTAIN');error.diagnostic=safeNetworkDiagnostic({category,requestTimeoutMs,elapsedMs},method);return error;}
export function validBotToken(value){return typeof value==='string'&&/^\d{6,12}:[A-Za-z0-9_-]{30,80}$/.test(value);}

// Never reject with native errors: they can contain the full credential-bearing URL.
function exchangeHttps(token,method,body,ms,request=https.request){return new Promise((resolve,reject)=>{
 const started=performance.now();let req,timer,done=false;const finish=(category,result)=>{if(done)return;done=true;clearTimeout(timer);category?reject(networkFailure(category,method,ms,Math.round(performance.now()-started))):resolve(result);};
 try{
  const payload=JSON.stringify(body);
  req=request({hostname:'api.telegram.org',port:443,path:`/bot${token}/${method}`,method:'POST',headers:{'Content-Type':'application/json','Content-Length':Buffer.byteLength(payload)},agent:false},res=>{
   const chunks=[];let size=0;res.on('data',chunk=>{size+=chunk.length;if(size>524288){finish('RESPONSE_LIMIT_EXCEEDED');res.destroy();req.destroy();}else chunks.push(chunk);});
   res.on('error',error=>finish(categoryFor(error)==='UNCLASSIFIED_NETWORK_FAILURE'?'RESPONSE_STREAM_ERROR':categoryFor(error)));res.on('aborted',()=>finish('RESPONSE_ABORTED'));res.on('end',()=>finish(null,{status:res.statusCode,body:Buffer.concat(chunks).toString('utf8')}));
  });
  req.on('error',error=>finish(categoryFor(error)));timer=setTimeout(()=>{finish('REQUEST_TIMEOUT');req.destroy();},ms);req.end(payload);
 }catch(error){finish(categoryFor(error));req?.destroy();}
});}

/** Method/argument restriction is deterministic here, not model prompt enforcement. */
function createCaller(token,{request=https.request,exchange=(method,body,ms)=>exchangeHttps(token,method,body,ms,request)}={}){
 if(!validBotToken(token))throw Error('INVALID_TOKEN_FORMAT');
 return checkedCaller(exchange);
}
function checkedCaller(exchange){
 async function call(method,body,ms){
  if(!allowed.has(method)||!Number.isFinite(ms)||ms<=0)throw Error('TELEGRAM_DEADLINE_OR_METHOD');
  const timeout=Math.min(25000,Math.floor(ms)),started=performance.now();
  let response;try{response=await exchange(method,body,timeout);}catch(error){const d=safeNetworkDiagnostic(error?.diagnostic,method);throw networkFailure(d.category==='UNCLASSIFIED_NETWORK_FAILURE'?categoryFor(error):d.category,method,timeout,d.elapsedMs??Math.round(performance.now()-started));}
  let json;try{if(typeof response.body!=='string'||response.body.length>524288)throw Error();json=JSON.parse(response.body);}catch{throw Error('TELEGRAM_INVALID_RESPONSE');}
  if(response.status===409||json.error_code===409)throw Error('TELEGRAM_CONSUMER_CONFLICT');
  if(response.status===401||json.error_code===401)throw Error('TELEGRAM_AUTHENTICATION_FAILED');
  if(response.status!==200||json.ok!==true)throw Error('TELEGRAM_REQUEST_FAILED');return json.result;
 }
 return call;
}
function readMethods(call,allowedUpdates=['message']){return {
  identity:ms=>call('getMe',{},ms),
  async checkWebhook(ms){const r=await call('getWebhookInfo',{},ms);if(typeof r?.url!=='string')throw Error('TELEGRAM_INVALID_RESPONSE');if(r.url!=='')throw Error('TELEGRAM_EXISTING_WEBHOOK');},
  async poll(offset,ms){if(!Number.isSafeInteger(offset)||offset<0)throw Error('INVALID_UPDATE_OFFSET');const r=await call('getUpdates',{offset,timeout:Math.max(0,Math.min(20,Math.floor(ms/1000)-2)),limit:100,...(allowedUpdates===null?{}:{allowed_updates:allowedUpdates})},ms);if(!Array.isArray(r)||r.length>100||r.some(u=>!Number.isSafeInteger(u?.update_id)||u.update_id<0))throw Error('TELEGRAM_INVALID_UPDATES');return r.sort((a,b)=>a.update_id-b.update_id);},
 };}
export function createTelegramApi(token,options){
 const call=createCaller(token,options);
 return Object.freeze({...readMethods(call),acknowledge(chatId,ms){if(!numericId(chatId))return Promise.reject(Error('INVALID_PRIVATE_CHAT'));return call('sendMessage',{chat_id:chatId,text:ACK_TEXT,allow_paid_broadcast:false},ms);}
 });
}
export function createTelegramReviewApi(token,options){
 const call=createCaller(token,options);
 return Object.freeze({...readMethods(call),sendPacket(version,chatId,ms){
  if(![1,2].includes(version)||chatId!==APPROVED_CHAT_ID)return Promise.reject(Error('UNAPPROVED_PACKET_OR_CHAT'));
  return call('sendMessage',{chat_id:APPROVED_CHAT_ID,text:APPROVED_PACKETS[version-1],allow_paid_broadcast:false},ms);
 }
 });
}
export function createTelegramContinuationApi(token,options){
 const call=createCaller(token,options);
 return Object.freeze({...readMethods(call),sendVersion2(ms){return call('sendMessage',{chat_id:APPROVED_CHAT_ID,text:APPROVED_PACKETS[1],allow_paid_broadcast:false},ms);}});
}

/** Offline compatibility seam only. No token, default network exchange or listener.
 * Reuses the existing response parser, timeout handling and update consumption.
 * A bounded live runner/transport must be separately authorized before use.
 */
export function createTelegramWritingFixtureApi(exchange){
 if(typeof exchange!=='function')throw Error('OFFLINE_EXCHANGE_REQUIRED');
 return writingMethods(checkedCaller(exchange),'OFFLINE_FIXTURE');
}
/** The operational consumer preserves the bot's existing update subscription.
 * No token or implicit network implementation. A future live binding must enforce
 * explicit authority for every offset-bearing request (which acknowledges updates). */
export function createTelegramConsumerFixtureApi(exchange){
 if(typeof exchange!=='function')throw Error('OFFLINE_EXCHANGE_REQUIRED');
 return writingMethods(checkedCaller(exchange),'OFFLINE_FIXTURE',null);
}
// A distinct entry point: caller must enforce the one-use claim and shared budget
// before EVERY operation. It cannot turn the old fixture entry point into live mode.
export function createTelegramWritingLiveApi(token,beforeRequest){
 if(typeof beforeRequest!=='function')throw Error('LIVE_SYNTHETIC_GUARD_REQUIRED');
 return guardedWritingApi(token,beforeRequest,'LIVE_SYNTHETIC_WRITING',['message','callback_query']);
}
/** No implicit authorization or credential loading. The runner must supply its
 * armed, exact-operation guard; every protected HTTP request goes through it. */
export function createTelegramConsumerApi(token,beforeRequest){
 if(typeof beforeRequest!=='function')throw Error('OPERATIONAL_TELEGRAM_GUARD_REQUIRED');
 return guardedWritingApi(token,beforeRequest,'AUTHORIZED_TELEGRAM_OPERATIONAL',null);
}
function guardedWritingApi(token,beforeRequest,mode,allowedUpdates){
 const pending=new Set();let closed=false;
 const request=(...args)=>{const req=https.request(...args);pending.add(req);req.once('close',()=>pending.delete(req));return req;};
 const call=createCaller(token,{request});
 const methods=writingMethods((method,body,ms)=>{if(closed)throw Error('TELEGRAM_TRANSPORT_CLOSED');const capped=beforeRequest(method,body,ms);if(!Number.isSafeInteger(capped)||capped<=0||capped>ms)throw Error('LIVE_SYNTHETIC_DEADLINE_REQUIRED');return call(method,body,capped);},mode,allowedUpdates);
 return Object.freeze({...methods,async close(){closed=true;for(const req of pending)req.destroy();const deadline=performance.now()+1000;while(pending.size&&performance.now()<deadline)await new Promise(r=>setTimeout(r,10));return {closed:pending.size===0,remainingRequests:pending.size};}});
}
function writingMethods(call,mode,allowedUpdates=['message','callback_query']){
 return Object.freeze({mode,...readMethods(call,allowedUpdates),
  async inspectPending(ms){
   const r=await call('getUpdates',{timeout:0,limit:100},ms);
   if(!Array.isArray(r)||r.length>100||r.some(u=>!Number.isSafeInteger(u?.update_id)||u.update_id<0))throw Error('TELEGRAM_INVALID_UPDATES');
   return r;
  },
  async sendPage(chatId,page,ms){
   if(!numericId(chatId)||!page||typeof page.text!=='string'||!page.text.length||page.text.length>4096||Object.keys(page).some(k=>!['text','reply_markup'].includes(k)))throw Error('INVALID_REVIEW_PAGE');
   if(page.reply_markup){const rows=page.reply_markup.inline_keyboard;
    const oneAction=Array.isArray(rows)&&rows.length===1&&Array.isArray(rows[0])&&rows[0].length===1&&Object.values(WRITING_BUTTONS).includes(rows[0][0]?.text);
    if(Object.keys(page.reply_markup).length!==1||!Array.isArray(rows)||(!oneAction&&rows.length!==2)||rows.some(r=>!Array.isArray(r)||r.length!==(oneAction?1:2)||r.some(b=>Object.keys(b).sort().join(',')!=='callback_data,text'||typeof b.text!=='string'||b.text.length>40||!/^wr_[A-Za-z0-9_-]{22}$/.test(b.callback_data))))throw Error('INVALID_REVIEW_BUTTONS');
   }
   return call('sendMessage',{chat_id:chatId,...page,allow_paid_broadcast:false,link_preview_options:{is_disabled:true}},ms);
  },
  async answerCallback(id,text,ms){
   if(typeof id!=='string'||id.length<1||id.length>256||/[\r\n\x00-\x1f]/.test(id)||typeof text!=='string'||text.length>200)throw Error('INVALID_CALLBACK_ACK');
   return call('answerCallbackQuery',{callback_query_id:id,text,show_alert:false,cache_time:0},ms);
  }
 });
}
