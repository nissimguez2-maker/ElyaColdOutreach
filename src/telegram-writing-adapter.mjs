import {getRecord,putRecord,transaction,journal,now} from './store.mjs';
import {digest,canonical} from './values.mjs';
import {numericId,requireStopped} from './telegram-pairing.mjs';
import {handleSyntheticControl} from './telegram-decisions.mjs';
import {handleWritingCallback,bindWritingTelegramMessage} from './telegram-writing-decisions.mjs';
import {renderTelegramWritingReview} from './telegram-writing-render.mjs';

function offline(api){if(api?.mode!=='OFFLINE_FIXTURE')throw Error('WRITING_LIVE_TRANSPORT_NOT_AUTHORIZED');}
function packetFor(db,id){const review=getRecord(db,'telegram_writing_review',id);if(!review)throw Error('WRITING_TELEGRAM_REVIEW_MISSING');const packet=getRecord(db,'writing_packet',review.packetHash);if(!packet||packet.synthetic!==review.syntheticOnly)throw Error('WRITING_PACKET_BINDING_MISMATCH');return {review,packet};}
function checkPairing(db,review){const b=getRecord(db,'telegram_binding','primary');if(!b?.confirmed||review.bindingHash!==digest(canonical({userId:b.userId,chatId:b.chatId,botId:b.botId})))throw Error('REVIEW_PAIRING_CHANGED');}
function evidence(db,kind,id,data,event){transaction(db,()=>{putRecord(db,kind,id,data,'confirmed');journal(db,event,id,data);});}

// Single-attempt page send journal; an interrupted intent is unresolved on restart.
// It never assumes API acceptance proves delivery, and never resends a prior intent.
async function pagesOnce(db,id,pages,api,ms,at,guard=()=>{},permit=null,timestampNow=null){
 const startedMono=performance.now();
 const completedAt=timestampNow??(()=>new Date(Date.parse(at)+Math.floor(performance.now()-startedMono)).toISOString());
 const check=()=>{if(permit)permit();else{offline(api);requireStopped(db);}};check();
 if(!Number.isSafeInteger(ms)||ms<=0||ms>300000)throw Error('FIXTURE_DEADLINE_REQUIRED');
 guard();
 const paired=getRecord(db,'telegram_binding','primary');
 if(!paired?.confirmed||!numericId(paired.chatId)||!numericId(paired.botId))throw Error('CONFIRMED_PAIRING_REQUIRED');
 let state={status:'INTENT',pageCount:pages.length,accepted:[],startedAt:at,pagesHash:digest(canonical(pages))};
 transaction(db,()=>{if(getRecord(db,'telegram_writing_delivery',id))throw Error('DELIVERY_ALREADY_ATTEMPTED_RECONCILE');putRecord(db,'telegram_writing_delivery',id,state,'confirmed');journal(db,'WRITING_TELEGRAM_SEND_INTENT',id,{pagesHash:state.pagesHash,pageCount:pages.length});});
 const deadline=performance.now()+ms;
 for(const [index,page]of pages.entries()){
  check();guard();
  const remaining=Math.floor(deadline-performance.now());if(remaining<=0){state={...state,status:'INCOMPLETE_DEADLINE'};evidence(db,'telegram_writing_delivery',id,state,'WRITING_TELEGRAM_SEND_INCOMPLETE');return state;}
  state={...state,status:'DISPATCH_INTENT',activePage:index};evidence(db,'telegram_writing_delivery',id,state,'WRITING_TELEGRAM_PAGE_INTENT');
  try{
   const result=await api.sendPage(paired.chatId,page,remaining);
   if(!numericId(result?.message_id)||result.chat?.id!==paired.chatId||result.chat?.type!=='private'||result.from?.id!==paired.botId||result.from?.is_bot!==true)throw Error('UNMATCHED_MESSAGE_RESULT');
   state={...state,status:'PAGE_API_CONFIRMED',accepted:[...state.accepted,{page:index,messageId:result.message_id}]};evidence(db,'telegram_writing_delivery',id,state,'WRITING_TELEGRAM_PAGE_CONFIRMED');
  }catch{state={...state,status:'UNCERTAIN',mustNotResend:true};evidence(db,'telegram_writing_delivery',id,state,'WRITING_TELEGRAM_DELIVERY_UNCERTAIN');return state;}
 }
 state={...state,status:'API_CONFIRMED',finishedAt:completedAt()};evidence(db,'telegram_writing_delivery',id,state,'WRITING_TELEGRAM_DELIVERY_CONFIRMED');return state;
}
async function deliverWritingTelegram(db,id,api,ms,at=now(),permit=null,timestampNow=null){
 permit?permit():offline(api);const {review,packet}=packetFor(db,id);
 checkPairing(db,review);
 const rendered=renderTelegramWritingReview(db,packet,{review,at});
 const result=await pagesOnce(db,`review:${id}`,rendered.pages,api,ms,at,()=>checkPairing(db,review),permit,timestampNow);
 if(result.status==='API_CONFIRMED')bindWritingTelegramMessage(db,id,result.accepted.at(-1).messageId,result.finishedAt);
 return result;
}

/** One update handed off by the existing consumer; this function never polls.
 * Receipt and content decision commit before any protocol acknowledgment.
 * The shared telegram_control_receipt identity also covers existing /stop.
 */
async function consumeWritingTelegramUpdate(db,update,api,ms,at=now(),permit=null,controlDb=db,timestampNow=null){
 permit?permit():offline(api);
 const outcome=update?.callback_query?handleWritingCallback(db,update,at):handleSyntheticControl(controlDb,update,at);
 let response={status:'NOT_APPLICABLE'},details=null;
 if(typeof outcome.callbackId==='string'){
  const id=digest(outcome.callbackId),prior=getRecord(db,'telegram_callback_response',id);
  if(prior)response={status:'PREVIOUS_ATTEMPT_NO_RESEND',priorStatus:prior.status};
  else{
   const text=outcome.ackText;
   const intent={status:'DISPATCH_INTENT',outcome:outcome.status,at};
   evidence(db,'telegram_callback_response',id,intent,'TELEGRAM_CALLBACK_ACK_INTENT');
   try{const accepted=await api.answerCallback(outcome.callbackId,text,ms);if(accepted!==true)throw Error('UNMATCHED_ACK');response={...intent,status:'API_CONFIRMED'};}
   catch{response={...intent,status:'UNCERTAIN',mustNotResend:true};}
   evidence(db,'telegram_callback_response',id,response,'TELEGRAM_CALLBACK_ACK_OUTCOME');
  }
  // Details is read-only and explicitly requested. No extra page after uncertain ACK.
  if(outcome.detailsRequested&&(response.status==='API_CONFIRMED'||response.priorStatus==='API_CONFIRMED')){
   details=getRecord(db,'telegram_writing_delivery',`details:${id}`);
   if(!details){const {review,packet}=packetFor(db,outcome.telegramReviewId);
    const rendered=renderTelegramWritingReview(db,packet,{review,at});
    details=await pagesOnce(db,`details:${id}`,rendered.details.map(text=>({text})),api,ms,at,()=>checkPairing(db,review),permit,timestampNow);
   }
  }
 }
 // The existing per-bot receipt is authoritative. Cursor advances only after it
 // exists; a crash before this write is safely deduplicated from the receipt.
 const paired=getRecord(db,'telegram_binding','primary');
 if(!permit&&paired&&Number.isSafeInteger(update?.update_id)&&getRecord(db,'telegram_control_receipt',`${paired.botId}:${update.update_id}`)){
  const old=getRecord(db,'telegram_writing_cursor','primary');putRecord(db,'telegram_writing_cursor','primary',{nextOffset:Math.max(old?.nextOffset??0,update.update_id+1)},'confirmed');
 }
 return {outcome,response,details,endConsumption:outcome.status==='STOPPED'};
}
export const deliverWritingTelegramFixture=(db,id,api,ms,at=now())=>deliverWritingTelegram(db,id,api,ms,at);
export const consumeWritingTelegramFixtureUpdate=(db,update,api,ms,at=now())=>consumeWritingTelegramUpdate(db,update,api,ms,at);

/** Shared operational adapter, with no poller, credential loader or authority
 * issuance. The caller owns the cursor and lock. An external transport is accepted
 * only with a per-operation authority checker supplied by an approved runner. */
export function bindOperationalWritingAdapter({db,api,assertAuthority,timestampNow=now}){
 if(!['OFFLINE_FIXTURE','AUTHORIZED_TELEGRAM_OPERATIONAL'].includes(api?.mode)||typeof assertAuthority!=='function')throw Error('TELEGRAM_TRANSPORT_NOT_AUTHORIZED');
 const permit=()=>{if(assertAuthority()!==true)throw Error('TELEGRAM_OPERATION_NOT_AUTHORIZED');if(api.mode==='OFFLINE_FIXTURE')requireStopped(db);};permit();
 return Object.freeze({deliver:(id,ms,at)=>deliverWritingTelegram(db,id,api,ms,at,permit,timestampNow),consume:(update,ms,at)=>consumeWritingTelegramUpdate(db,update,api,ms,at,permit,db,timestampNow)});
}

// No polling and no auth issuance here. Only the future one-use live runner calls
// this binding with its real-store claim checker and budgeted Telegram-only API.
export function bindLiveSyntheticWritingAdapter({db,syntheticDb,api,assertAuthority,timestampNow=now}){
 if(db===syntheticDb||db.location()&&db.location()===syntheticDb.location()||api?.mode!=='LIVE_SYNTHETIC_WRITING'||typeof assertAuthority!=='function')throw Error('LIVE_SYNTHETIC_BINDING_REQUIRED');
 const permit=()=>{assertAuthority();requireStopped(db);requireStopped(syntheticDb);};permit();
 const syntheticPermit=()=>{permit();const packets=syntheticDb.prepare("SELECT data_json FROM records WHERE kind='writing_packet'").all();if(packets.some(row=>JSON.parse(row.data_json).synthetic!==true))throw Error('SYNTHETIC_FIXTURE_REQUIRED');};
 return Object.freeze({deliver:(id,ms,at)=>deliverWritingTelegram(syntheticDb,id,api,ms,at,syntheticPermit,timestampNow),consume:(update,ms,at)=>consumeWritingTelegramUpdate(syntheticDb,update,api,ms,at,syntheticPermit,db,timestampNow)});
}
