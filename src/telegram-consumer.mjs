// One bounded operational consumer. Existing synthetic demonstrations stay separate
// historical evidence; they share this module's owner record and may not overlap it.
// No credential loading, scheduler, default network transport or queue draining.
import {performance} from 'node:perf_hooks';
import {canonical,digest,timestamp,required} from './values.mjs';
import {getRecord,putRecord,transaction,journal,controls,now} from './store.mjs';
import {numericId,isPairedSender,requireStopped} from './telegram-pairing.mjs';
import {controlMessageRejection} from './telegram-decisions.mjs';
import {acquireTelegramConsumer,releaseTelegramConsumer} from './telegram-writing-authority.mjs';
import {bindOperationalWritingAdapter} from './telegram-writing-adapter.mjs';

const hash=value=>digest(canonical(value));
const safeReason=error=>/^[A-Z][A-Z0-9_]{0,99}$/.test(error?.message??'')?error.message:'TELEGRAM_LOCAL_FAILURE';
function pairing(db){const b=getRecord(db,'telegram_binding','primary');if(b?.confirmed!==true||!numericId(b.userId)||!numericId(b.chatId)||!numericId(b.botId))throw Error('CONFIRMED_PAIRING_REQUIRED');return {userId:b.userId,chatId:b.chatId,botId:b.botId};}
function cursor(db){const c=getRecord(db,'telegram_writing_cursor','primary');if(!Number.isSafeInteger(c?.nextOffset)||c.nextOffset<0)throw Error('TELEGRAM_CURSOR_RECONCILIATION_REQUIRED');return c;}
function validateLimits(value){
 if(!value||Object.keys(value).sort().join(',')!=='maxPolls,maxRequests,maxUpdates,totalMs'||!Number.isSafeInteger(value.maxPolls)||value.maxPolls<1||value.maxPolls>100||!Number.isSafeInteger(value.maxUpdates)||value.maxUpdates<1||value.maxUpdates>1000||!Number.isSafeInteger(value.maxRequests)||value.maxRequests<1||value.maxRequests>1000||!Number.isSafeInteger(value.totalMs)||value.totalMs<1||value.totalMs>300000)throw Error('BOUNDED_TELEGRAM_LIMITS_REQUIRED');
}
/** Classify the complete response before acting. Exact durable receipts are replay
 * evidence. A historic summary without a raw-update fingerprint is not evidence
 * that a currently pending update is safe to acknowledge remotely. */
export function classifyTelegramUpdates(db,updates,at=now()){
 if(!Array.isArray(updates)||updates.length>100)throw Error('TELEGRAM_INVALID_UPDATES');
 const b=pairing(db),c=cursor(db),seen=new Set();
 return updates.map(update=>{
  const id=update?.update_id;if(!Number.isSafeInteger(id)||id<0||seen.has(id))throw Error('TELEGRAM_INVALID_UPDATES');seen.add(id);
  let updateHash;try{updateHash=hash(update);}catch{throw Error('TELEGRAM_UPDATE_INTEGRITY_MISMATCH');}
  const receipt=getRecord(db,'telegram_control_receipt',`${b.botId}:${id}`);
  if(receipt){if(!receipt.updateHash)throw Error('TELEGRAM_RECEIPT_RECONCILIATION_REQUIRED');if(receipt.updateHash!==updateHash)throw Error('TELEGRAM_UPDATE_INTEGRITY_MISMATCH');const ref=typeof update.callback_query?.data==='string'?getRecord(db,'telegram_writing_action',update.callback_query.data):null;return {update,updateHash,duplicate:true,action:receipt.status==='STOPPED'?'STOP':ref?.action??'CALLBACK',telegramReviewId:ref?.telegramReviewId??null};}
  if(id<c.nextOffset)throw Error('TELEGRAM_CURSOR_RECONCILIATION_REQUIRED');
  if(update.message?.text==='/stop'){
   if(controlMessageRejection(db,update,at))throw Error('UNAUTHORIZED_TELEGRAM_UPDATE');
   return {update,updateHash,action:'STOP'};
  }
  const q=update.callback_query,ref=typeof q?.data==='string'&&getRecord(db,'telegram_writing_action',q.data),review=ref&&getRecord(db,'telegram_writing_review',ref.telegramReviewId);
  if(!review||!['APPROVED','REJECTED','REVISION_REQUESTED','DETAILS'].includes(ref.action)||review.actions[ref.action]!==q.data)throw Error('UNRELATED_PENDING_UPDATES');
  if(!isPairedSender(db,{from:q.from,chat:q.message?.chat})||q.message?.from?.id!==b.botId||q.message.from.is_bot!==true)throw Error('UNAUTHORIZED_TELEGRAM_UPDATE');
  // The actual callback handler owns message binding, expiry and version checks;
  // a recognized stale button must get a useful result, not a poller error.
  return {update,updateHash,action:ref.action,telegramReviewId:review.id};
 }).sort((a,b)=>a.update.update_id-b.update.update_id);
}
function stop(db,entry,at){
 return transaction(db,()=>{
  const b=pairing(db),id=`${b.botId}:${entry.update.update_id}`,prior=getRecord(db,'telegram_control_receipt',id);
  if(prior)return {status:'DUPLICATE_UPDATE'};
  if(controlMessageRejection(db,entry.update,at))throw Error('UNAUTHORIZED_TELEGRAM_UPDATE');
  db.prepare("UPDATE controls SET stopped=1,reason='Authenticated Telegram stop',updated_at=? WHERE singleton=1").run(at);
  const outcome={status:'STOPPED',updateId:entry.update.update_id,updateHash:entry.updateHash,recordedAt:at};
  putRecord(db,'telegram_control_receipt',id,outcome,'confirmed');journal(db,'TELEGRAM_STOP','system',{receiptId:id});return outcome;
 });
}
function commitCursor(db,b,entry,at){
 transaction(db,()=>{
  const receipt=getRecord(db,'telegram_control_receipt',`${b.botId}:${entry.update.update_id}`);
  if(!receipt||receipt.updateHash!==entry.updateHash)throw Error('TELEGRAM_RECEIPT_RECONCILIATION_REQUIRED');
  const old=cursor(db);putRecord(db,'telegram_writing_cursor','primary',{...old,nextOffset:Math.max(old.nextOffset,entry.update.update_id+1),recordedAt:at},'confirmed');
 });
}
function responseUncertain(result){
 const status=result.response?.priorStatus??result.response?.status;
 return ['UNCERTAIN','DISPATCH_INTENT'].includes(status)||(result.details&&result.details.status!=='API_CONFIRMED');
}

/** Executes a single bounded session, never a perpetual poller. OFFLINE_FIXTURE is
 * the default test transport. An approved caller may provide the separate
 * AUTHORIZED_TELEGRAM_OPERATIONAL transport AND authorize(operation) => true.
 * That callback is checked before every request and must enforce exact targets,
 * credential lifetime and explicit offset/remote-ack authority. This module never
 * creates that authority. No negative offsets or allowed_updates changes occur.
 */
export async function runTelegramConsumer({db,api,ownerId,limits,at=now(),clock=()=>performance.now(),timestampNow,authorize}){
 validateLimits(limits);required(ownerId);timestamp(at);
 if(api?.mode!=='OFFLINE_FIXTURE'&&(api?.mode!=='AUTHORIZED_TELEGRAM_OPERATIONAL'||typeof authorize!=='function'))throw Error('TELEGRAM_TRANSPORT_NOT_AUTHORIZED');
 if(api.mode==='AUTHORIZED_TELEGRAM_OPERATIONAL'&&typeof api.close!=='function')throw Error('TELEGRAM_TRANSPORT_CLEANUP_REQUIRED');
 if(['poll','sendPage','answerCallback','identity','checkWebhook'].some(name=>typeof api[name]!=='function'))throw Error('TELEGRAM_TRANSPORT_CONTRACT_REQUIRED');
 const b=pairing(db),started=clock(),iso=timestampNow??(()=>new Date(timestamp(at)+Math.floor(clock()-started)).toISOString());
 const initial=cursor(db);if(api.mode==='OFFLINE_FIXTURE')requireStopped(db);
 const state={ownerId,status:'RUNNING',startedAt:at,pairing:b,initialOffset:initial.nextOffset,nextOffset:initial.nextOffset,requests:0,polls:0,processed:0,outcomes:[],reason:null,mode:api.mode};
 transaction(db,()=>{if(getRecord(db,'telegram_consumer_run',ownerId))throw Error('TELEGRAM_RUN_ALREADY_EXISTS');acquireTelegramConsumer(db,ownerId,at);putRecord(db,'telegram_consumer_run',ownerId,state,'confirmed');});
 const save=()=>putRecord(db,'telegram_consumer_run',ownerId,state,'confirmed');
 const active=()=>{
  const owner=getRecord(db,'telegram_consumer_owner','primary');if(owner?.ownerId!==ownerId||owner.status!=='ACTIVE')throw Error('CONSUMER_OWNER_MISMATCH');
  if(canonical(pairing(db))!==canonical(b))throw Error('PAIRING_CHANGED');if(api.mode==='OFFLINE_FIXTURE')requireStopped(db);
  if(clock()-started>=limits.totalMs)throw Error('TELEGRAM_SESSION_DEADLINE');return true;
 };
 const remaining=()=>{active();return Math.max(1,Math.floor(limits.totalMs-(clock()-started)));};
 const call=async(method,args)=>{
  active();if(state.requests>=limits.maxRequests)throw Error('TELEGRAM_REQUEST_BUDGET_EXHAUSTED');
  const operation={method,pairing:b,ownerId,...(method==='poll'?{offset:args[0]}:{}),...(method==='sendPage'?{chatId:args[0],pageHash:hash(args[1])}:{}),...(method==='answerCallback'?{callbackHash:hash(args[0]),text:args[1]}:{})};
  if(api.mode!=='OFFLINE_FIXTURE'&&authorize(operation)!==true)throw Error('TELEGRAM_OPERATION_NOT_AUTHORIZED');
  state.requests++;state.lastRequest={method,status:'INTENT',at:iso(),...(method==='poll'?{offset:args[0]}:{})};save();
  try{const result=await api[method](...args,remaining());state.lastRequest={...state.lastRequest,status:'API_RETURNED'};save();active();return result;}
  catch(error){state.lastRequest={...state.lastRequest,status:'UNCERTAIN_OR_FAILED',reason:safeReason(error)};save();throw error;}
 };
 const bound={mode:api.mode,sendPage:(chat,page)=>call('sendPage',[chat,page]),answerCallback:(id,text)=>call('answerCallback',[id,text])};
 try{
  if(inspectTelegramConsumerStatus(db).unresolvedResponses.length||db.prepare("SELECT id FROM records WHERE kind='telegram_writing_delivery' AND json_extract(data_json,'$.status')<>'API_CONFIRMED' LIMIT 1").get())throw Error('TELEGRAM_RESPONSE_RECONCILIATION_REQUIRED');
  const adapter=bindOperationalWritingAdapter({db,api:bound,assertAuthority:active,timestampNow:iso});
  const identity=await call('identity',[]);if(identity?.id!==b.botId||identity.is_bot!==true)throw Error('BOT_IDENTITY_MISMATCH');await call('checkWebhook',[]);
  while(state.polls<limits.maxPolls&&state.processed<limits.maxUpdates){
   const offset=cursor(db).nextOffset;state.polls++;
   const entries=classifyTelegramUpdates(db,await call('poll',[offset]),iso());
   if(!entries.length)break;
   for(const entry of entries){
    active();if(state.processed>=limits.maxUpdates)break;
    if(api.mode!=='OFFLINE_FIXTURE'&&authorize({method:'consumeUpdate',pairing:b,ownerId,updateId:entry.update.update_id,updateHash:entry.updateHash,action:entry.action,telegramReviewId:entry.telegramReviewId??null})!==true)throw Error('TELEGRAM_OPERATION_NOT_AUTHORIZED');
    let result;
    if(entry.action==='STOP')result={outcome:stop(db,entry,iso()),endConsumption:true};
    else result=await adapter.consume(entry.update,remaining(),iso());
    commitCursor(db,b,entry,iso());state.nextOffset=cursor(db).nextOffset;state.processed++;state.outcomes.push({updateId:entry.update.update_id,status:result.outcome.status});save();
    if(result.endConsumption){state.status='STOPPED';state.reason='AUTHENTICATED_STOP';return state;}
    if(responseUncertain(result))throw Error('TELEGRAM_RESPONSE_RECONCILIATION_REQUIRED');
   }
  }
  state.status='BOUNDED_COMPLETE';return state;
 }catch(error){state.status='BLOCKED';state.reason=safeReason(error);return state;}
 finally{
  let clean=true;if(api.mode==='AUTHORIZED_TELEGRAM_OPERATIONAL')try{const closed=await api.close();clean=closed?.closed===true&&closed.remainingRequests===0;}catch{clean=false;}
  state.finishedAt=iso();state.elapsedMs=Math.floor(clock()-started);state.nextOffset=cursor(db).nextOffset;
  if(clean)releaseTelegramConsumer(db,ownerId,iso());
  else{state.status='BLOCKED';state.reason='TELEGRAM_TRANSPORT_RECONCILIATION_REQUIRED';transaction(db,()=>{const owner=getRecord(db,'telegram_consumer_owner','primary');if(owner?.ownerId===ownerId)putRecord(db,'telegram_consumer_owner','primary',{...owner,status:'RECONCILIATION',observedAt:iso()},'configuration');});}
  save();
 }
}

/** Read-only exact proposal. Applying local retirement and sending the subsequent
 * offset-bearing request are deliberately absent: both need separate approval. */
export function prepareTelegramRetirementPlan(db,{id,updates,reason,at=now()}){
 required(id);required(reason);timestamp(at);const b=pairing(db),c=cursor(db),seen=new Set();
 if(!Array.isArray(updates)||!updates.length||updates.length>100)throw Error('RETIREMENT_OBSERVED_UPDATES_REQUIRED');
 const entries=updates.map(update=>{const updateId=update?.update_id;if(!Number.isSafeInteger(updateId)||updateId<c.nextOffset||seen.has(updateId))throw Error('RETIREMENT_UPDATE_ID_INVALID');seen.add(updateId);const receipt=getRecord(db,'telegram_control_receipt',`${b.botId}:${updateId}`);return {updateId,updateHash:hash(update),receiptHash:receipt?hash(receipt):null};}).sort((a,b)=>a.updateId-b.updateId);
 const body={id,pairing:b,fromOffset:c.nextOffset,nextOffset:entries.at(-1).updateId+1,entries,reason,preparedAt:at,remoteAcknowledgmentAuthorized:false,executionImplemented:false};return {...body,hash:hash(body)};
}
export function validateTelegramRetirementPlan(db,plan,approval,at=now()){
 timestamp(at);const {hash:planHash,...body}=plan??{};
 if(hash(body)!==planHash||canonical(pairing(db))!==canonical(body.pairing)||cursor(db).nextOffset!==body.fromOffset)throw Error('RETIREMENT_PLAN_CHANGED');
 for(const e of body.entries){const r=getRecord(db,'telegram_control_receipt',`${body.pairing.botId}:${e.updateId}`);if((r?hash(r):null)!==e.receiptHash)throw Error('RETIREMENT_PLAN_CHANGED');}
 let approved=false;try{approved=approval?.approved===true&&approval.planHash===planHash&&['botId','chatId','userId'].every(k=>approval[k]===body.pairing[k])&&approval.approvedBy==='Daniel Rosen'&&approval.allowLocalRetirement===true&&approval.allowRemoteAcknowledgment===true&&timestamp(approval.approvedAt)<=timestamp(at)&&timestamp(approval.expiresAt)>timestamp(at);}catch{/* Unresolved approval is denied. */}
 if(!approved)throw Error('EXACT_RETIREMENT_APPROVAL_REQUIRED');return {validated:true,executable:false,planHash,requires:'SEPARATELY_AUTHORIZED_RETIREMENT_RUNNER'};
}
export function inspectTelegramConsumerStatus(db){return {controls:controls(db),owner:getRecord(db,'telegram_consumer_owner','primary'),cursor:getRecord(db,'telegram_writing_cursor','primary'),runs:db.prepare("SELECT data_json FROM records WHERE kind='telegram_consumer_run' ORDER BY updated_at DESC LIMIT 10").all().map(r=>JSON.parse(r.data_json)),unresolvedResponses:db.prepare("SELECT id,data_json FROM records WHERE kind='telegram_callback_response' AND json_extract(data_json,'$.status') IN ('DISPATCH_INTENT','UNCERTAIN')").all().map(r=>({id:r.id,...JSON.parse(r.data_json)}))};}

/** A restart is not evidence the previous poller stopped. Retain ownership and
 * outbox intents; an operator must establish process termination before a separate
 * explicit lock reconciliation. No PID guessing, process killing or send replay. */
export function recoverTelegramConsumer(db,at=now()){
 timestamp(at);return transaction(db,()=>{
  const owner=getRecord(db,'telegram_consumer_owner','primary'),run=owner&&getRecord(db,'telegram_consumer_run',owner.ownerId);
  if(!run||!['ACTIVE','RECONCILIATION'].includes(owner.status))return {status:'NOT_APPLICABLE'};
  const result={status:'RECONCILIATION',ownerId:owner.ownerId,processStopConfirmationRequired:true,replayPermitted:false};
  if(owner.status==='ACTIVE'){
   putRecord(db,'telegram_consumer_owner','primary',{...owner,status:'RECONCILIATION',observedAt:at},'configuration');
   putRecord(db,'telegram_consumer_run',owner.ownerId,{...run,status:'RECONCILIATION',reason:'INTERRUPTED_PROCESS_STOP_UNCONFIRMED',recoveredAt:at},'confirmed');
   journal(db,'TELEGRAM_CONSUMER_INTERRUPTED',owner.ownerId,result);
  }
  return result;
 });
}
