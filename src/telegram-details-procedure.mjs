import {performance} from 'node:perf_hooks';
import {getRecord,putRecord,transaction,journal,controls} from './store.mjs';
import {canonical,digest} from './values.mjs';
import {requireStopped,isPairedSender} from './telegram-pairing.mjs';
import {controlMessageRejection,applySyntheticStopSemantics,handleSyntheticControl} from './telegram-decisions.mjs';
import {acquireTelegramConsumer,releaseTelegramConsumer} from './telegram-writing-authority.mjs';
import {WritingRequestBudget} from './telegram-writing-budget.mjs';
import {seedSyntheticWritingCard} from './telegram-writing-live-card.mjs';
import {issueWritingTelegramReview,bindWritingTelegramMessage,handleWritingCallback} from './telegram-writing-decisions.mjs';
import {DETAILS_ID,TEST_MESSAGE,DETAILS_RESPONSE,DETAILS_LIMITS,detailsCardHash,renderDetailsProbe} from './telegram-details-card.mjs';
export {DETAILS_ID,TEST_MESSAGE,DETAILS_RESPONSE,detailsCardHash};
const evidenceId='telegram-pending-inspection-v1',stopId=64381640;
const hash=v=>digest(canonical(v));
const safe=e=>/^[A-Z][A-Z0-9_]{0,99}$/.test(e?.message??'')?e.message:'UNRESOLVED_LOCAL_FAILURE';
function evidenceStop(db,evidence,priorApproval){
 const grant=getRecord(db,'telegram_details_authorization',DETAILS_ID),pair=getRecord(db,'telegram_binding','primary');
 if(!grant||!['APPROVED','CLAIMED'].includes(grant.status)||grant.approved.cardHash!==detailsCardHash())throw Error('DETAILS_AUTHORIZATION_NOT_APPROVED');
 if(hash(evidence)!==grant.approved.evidenceHash||hash(priorApproval)!==grant.approved.priorApprovalHash||canonical(pair)!==canonical(grant.approved.pairing)||canonical(pair)!==canonical(priorApproval.pairing)||evidence.approvalBindingHash!==hash(priorApproval))throw Error('INSPECTION_EVIDENCE_BINDING_MISMATCH');
 if(canonical(evidence)!==canonical(getRecord(db,'telegram_pending_inspection',evidenceId))||evidence.id!==evidenceId||evidence.reason!=='INSPECTION_COMPLETE'||evidence.authorizationStatus!=='CLOSED'||evidence.cleanup?.confirmed!==true||evidence.protectedStateUnchanged!==true||evidence.inventory?.length!==1||evidence.additionalUpdatesMayExist!==false)throw Error('INSPECTION_EVIDENCE_NOT_COMPLETE');
 const e=evidence.inventory[0];
 if(e.updateId!==stopId||e.type!=='MESSAGE'||e.messageId!==14||e.actorMatch!==true||e.chatMatch!==true||e.isStop!==true||e.classification!=='PAIRED_STOP_NOT_EXECUTED'||e.actionTimestamp!=='2026-11-16T21:51:46.000Z')throw Error('EXPECTED_STOP_EVIDENCE_MISSING');
 return {pair,e};
}
export function reconcileKnownStop(db,evidence,priorApproval,at){
 requireStopped(db);const {pair,e}=evidenceStop(db,evidence,priorApproval);
 return transaction(db,()=>{
  const id=`${pair.botId}:${stopId}`;if(getRecord(db,'telegram_control_receipt',id))throw Error('STOP_ALREADY_RECONCILED');
  applySyntheticStopSemantics(db,at);
  const receipt={status:'STOPPED',updateId:stopId,messageId:e.messageId,messageTimestamp:e.actionTimestamp,recordedAt:at,syntheticOnly:true,provenance:'INSPECTION_SUMMARY_RECONCILIATION',rawUpdateAvailable:false,inspectionId:evidenceId,inspectionHash:hash(evidence),pairingHash:hash(pair),remoteAcknowledged:false,cursorChanged:false};
  putRecord(db,'telegram_control_receipt',id,receipt,'confirmed');journal(db,'INSPECTED_STOP_RECONCILED',id,receipt);return receipt;
 });
}
function knownStopMatches(db,u,pair,at,evidence,requireReceipt){
 if(u.update_id!==stopId)return false;
 if(controlMessageRejection(db,u,at)!==null||u.message.text!=='/stop'||u.message.message_id!==14||u.message.date!==1794865906||u.callback_query)throw Error('KNOWN_STOP_PAYLOAD_MISMATCH');
 const receipt=getRecord(db,'telegram_control_receipt',`${pair.botId}:${stopId}`);
 if(requireReceipt&&!receipt)throw Error('KNOWN_STOP_RECEIPT_MISSING');
 if(receipt&&(receipt.provenance!=='INSPECTION_SUMMARY_RECONCILIATION'||receipt.inspectionHash!==hash(evidence)||receipt.pairingHash!==hash(pair)))throw Error('KNOWN_STOP_RECEIPT_MISMATCH');
 return true;
}

/** One approved local reconciliation plus a single isolated Details test.
 * Offset-free polls leave remote queue confirmation out of this procedure. */
export async function runDetailsProcedure({db,syntheticDb,evidence,priorApproval,loadToken,makeApi,clock=()=>performance.now(),wallClock=Date.now,startedMono=clock(),startedWall=wallClock(),sleep=ms=>new Promise(r=>setTimeout(r,ms)),emit=()=>{}}){
 const start=startedMono,wall=startedWall,iso=()=>new Date(wall+Math.floor(clock()-start)).toISOString();
 let claimed=false,owned=false,api=null,credentialCleanup=true,stopped=false,permit=null,review=null;
 const result={id:DETAILS_ID,startedAt:iso(),status:'STOPPED',reason:null,attempts:[],receivedActions:[],stopReceived:false,authorizationStatus:'NOT_CLAIMED',localCursorChanged:false,remoteOffsetSubmitted:false,underlyingTransportRetries:'UNOBSERVED'};
 const save=()=>putRecord(db,'telegram_details_test',DETAILS_ID,result,'confirmed');
 const budget=new WritingRequestBudget({clock,startedAt:start,record:snapshot=>{result.budget=snapshot;}});
 const remaining=()=>{const ms=Math.floor(DETAILS_LIMITS.apiMs-(clock()-start));if(stopped||ms<=0)throw Error(stopped?'TEST_COMMUNICATION_STOPPED':'DETAILS_API_DEADLINE');return ms;};
 const pair=getRecord(db,'telegram_binding','primary'),cursorBefore=canonical(getRecord(db,'telegram_writing_cursor','primary'));
 const active=()=>{requireStopped(db);remaining();if(canonical(getRecord(db,'telegram_binding','primary'))!==canonical(pair)||getRecord(db,'telegram_consumer_owner','primary')?.ownerId!==DETAILS_ID||getRecord(db,'telegram_consumer_owner','primary')?.status!=='ACTIVE'||getRecord(db,'telegram_details_authorization',DETAILS_ID)?.status!=='CLAIMED')throw Error('DETAILS_AUTHORITY_CHANGED');};
 const guard=(method,body,ms)=>{
  active();if(!permit||permit.method!==method||canonical(body)!==canonical(permit.body)||result.attempts.length>=DETAILS_LIMITS.requests)throw Error('DETAILS_WIRE_REQUEST_DENIED');
  const capped=Math.min(ms,remaining());permit=null;result.attempts.push({method,status:'ATTEMPTED',at:iso()});save();return capped;
 };
 const call=async(kind,method,body,fn)=>{
  active();const ms=Math.min(budget.take(kind),remaining(),5000);permit={method,body};
  try{const data=await fn(ms);permit=null;const a=result.attempts.at(-1);a.status='API_RETURNED';a.finishedAt=iso();save();return data;}
  catch(e){permit=null;const a=result.attempts.at(-1);if(a?.status==='ATTEMPTED')a.status='FAILED_OR_UNCERTAIN';save();throw e;}
 };
 const send=async(page,kind)=>{
  const data=await call(kind,'sendMessage',{chat_id:pair.chatId,...page,allow_paid_broadcast:false,link_preview_options:{is_disabled:true}},ms=>api.sendPage(pair.chatId,page,ms));
  if(!Number.isSafeInteger(data?.message_id)||data.message_id<=0||data.chat?.id!==pair.chatId||data.chat.type!=='private'||data.from?.id!==pair.botId||data.from.is_bot!==true)throw Error('MESSAGE_ACCEPTANCE_UNCERTAIN');
  return {status:'API_CONFIRMED',messageId:data.message_id,confirmedAt:iso()};
 };
 const poll=()=>call('polls','getUpdates',{timeout:0,limit:100},ms=>api.inspectPending(ms));
 const classify=(updates,preflight=false)=>{
  if(updates.length===100)throw Error('QUEUE_MAY_BE_TRUNCATED');
  const seen=new Set(),entries=[];
  for(const u of [...updates].sort((a,b)=>a.update_id-b.update_id)){
   if(seen.has(u.update_id))throw Error('DUPLICATE_UPDATE_IN_RESPONSE');seen.add(u.update_id);
   if(knownStopMatches(db,u,pair,iso(),evidence,!preflight))continue;
   const q=u.callback_query,m=q?.message??u.message;
   const action=q&&review?Object.entries(review.actions).find(([,ref])=>ref===q.data)?.[0]??'UNKNOWN':u.message?.text==='/stop'?'STOP':'UNKNOWN';
   const observation={updateId:u.update_id,type:q?'CALLBACK_QUERY':u.message?'MESSAGE':'UNKNOWN',observedAction:action,expectedAction:'DETAILS',phase:preflight?'PREFLIGHT':'WAIT_DETAILS',actorChatMatch:isPairedSender(db,{from:q?.from??m?.from,chat:m?.chat}),messageId:Number.isSafeInteger(m?.message_id)?m.message_id:null,messageBindingMatch:!!q&&m?.message_id===review?.messageId,handler:'NOT_RUN',disposition:'LEFT_PENDING'};
   result.receivedActions.push(observation);save();
   if(u.message?.text==='/stop'&&controlMessageRejection(db,u,iso())===null){entries.push({u,action:'STOP',observation});continue;}
   if(preflight)throw Error('UNRELATED_PENDING_UPDATE');
   if(!q||!observation.actorChatMatch||m?.from?.id!==pair.botId||m?.from?.is_bot!==true)throw Error('CALLBACK_AUTHORIZATION_OR_TYPE_FAILURE');
   if(!observation.messageBindingMatch)throw Error('CALLBACK_MESSAGE_BINDING_FAILURE');
   if(action!=='DETAILS')throw Error('UNEXPECTED_OR_UNKNOWN_ACTION');
   entries.push({u,action,observation});
  }
  return entries;
 };
 const stopIfPresent=entries=>{
  const entry=entries.find(e=>e.action==='STOP');if(!entry)return false;
  const outcome=handleSyntheticControl(db,entry.u,iso());entry.observation.handler=outcome.status;
  if(outcome.status!=='STOPPED')throw Error('STOP_OUTCOME_UNEXPECTED');
  stopped=true;budget.stop();result.stopReceived=true;result.reason='AUTHENTICATED_STOP';entry.observation.disposition='LOCAL_STOP_RECORDED_REMOTE_PENDING';save();return true;
 };
 try{
  evidenceStop(db,evidence,priorApproval);
  transaction(db,()=>{const grant=getRecord(db,'telegram_details_authorization',DETAILS_ID);if(grant.status!=='APPROVED'||getRecord(db,'telegram_details_test',DETAILS_ID))throw Error('DETAILS_AUTHORIZATION_NOT_APPROVED');putRecord(db,'telegram_details_authorization',DETAILS_ID,{...grant,status:'CLAIMED',startedAt:iso()},'configuration');});claimed=true;
  requireStopped(db);if(db===syntheticDb||db.location()&&db.location()===syntheticDb.location())throw Error('ISOLATED_SYNTHETIC_DATABASE_REQUIRED');
  acquireTelegramConsumer(db,DETAILS_ID,iso());owned=true;save();
  let token;try{token=await loadToken(Math.min(5000,remaining()));}catch(e){credentialCleanup=['PROTECTED_STORAGE_UNAVAILABLE','WINDOWS_PROTECTION_UNAVAILABLE','WINDOWS_PROTECTION_FAILED'].includes(e?.message);throw Error(credentialCleanup?'LOCAL_CREDENTIAL_UNAVAILABLE':'CREDENTIAL_CLEANUP_UNCONFIRMED');}
  api=makeApi(token,guard);token=null;
  const bot=await call('getMe','getMe',{},ms=>api.identity(ms));if(bot?.id!==pair.botId||bot.is_bot!==true)throw Error('BOT_IDENTITY_MISMATCH');
  await call('getWebhookInfo','getWebhookInfo',{},ms=>api.checkWebhook(ms));
  // One offset-free preflight prevents sending into unrelated pending updates.
  const before=classify(await poll(),true);if(stopIfPresent(before))return result;
  result.reconciliation=reconcileKnownStop(db,evidence,priorApproval,iso());save();
  const packet=seedSyntheticWritingCard(syntheticDb,pair,iso());
  review=issueWritingTelegramReview(syntheticDb,{id:DETAILS_ID,reviewId:packet.reviewId,packetHash:packet.hash,at:iso(),expiresAt:new Date(wall+DETAILS_LIMITS.apiMs).toISOString(),expiryBasis:'EXPLICIT_SYNTHETIC_TEST'});
  result.packetBinding={packetHash:packet.hash,packetVersion:packet.version,cardHash:detailsCardHash()};save();
  result.initialDelivery=await send(renderDetailsProbe(review),'initialMessages');save();active();
  review=bindWritingTelegramMessage(syntheticDb,DETAILS_ID,result.initialDelivery.messageId,iso());
  emit({event:'READY_FOR_DETAILS',messageId:review.messageId});
  for(let i=0;i<10;i++){
   if(remaining()<15000)throw Error('INSUFFICIENT_TIME_FOR_DETAILS');
   const entries=classify(await poll());if(stopIfPresent(entries))return result;
   const entry=entries.find(e=>e.action==='DETAILS');
   if(entry){
    if(remaining()<10000)throw Error('INSUFFICIENT_TIME_FOR_DETAILS');budget.requireAction('DETAILS');
    const outcome=handleWritingCallback(syntheticDb,entry.u,iso());entry.observation.handler=outcome.status;save();
    if(outcome.status!=='DETAILS')throw Error('CALLBACK_HANDLER_REJECTED');
    const ack=await call('acknowledgments','answerCallbackQuery',{callback_query_id:outcome.callbackId,text:outcome.ackText,show_alert:false,cache_time:0},ms=>api.answerCallback(outcome.callbackId,outcome.ackText,ms));
    if(ack!==true)throw Error('CALLBACK_ACK_UNCERTAIN');result.acknowledgment={status:'API_CONFIRMED',updateId:entry.u.update_id};save();
    result.detailsDelivery=await send({text:DETAILS_RESPONSE},'detailsMessages');entry.observation.disposition='DETAILS_RECORDED_REMOTE_PENDING';save();
    active();result.status='COMPLETE';result.reason='DETAILS_CALLBACK_CONFIRMED';return result;
   }
   if(i<9){if(remaining()<20000)throw Error('INSUFFICIENT_TIME_FOR_DETAILS');await sleep(DETAILS_LIMITS.pollGapMs);}
  }
  throw Error('NO_DETAILS_WITHIN_POLL_BUDGET');
 }catch(e){result.reason=safe(e);return result;}
 finally{
  stopped=true;budget.stop();let transport={closed:true,remainingRequests:0};try{if(api)transport=await api.close();}catch{transport={closed:false,remainingRequests:null};}
  if(claimed){
   let released=!owned,error=null;
   try{if(owned){if(transport.closed&&transport.remainingRequests===0&&credentialCleanup){releaseTelegramConsumer(db,DETAILS_ID,iso());released=true;}else{const owner=getRecord(db,'telegram_consumer_owner','primary');if(owner?.ownerId!==DETAILS_ID)throw Error('CONSUMER_OWNER_MISMATCH');putRecord(db,'telegram_consumer_owner','primary',{...owner,status:'RECONCILIATION'},'configuration');}}}catch(e){error=safe(e);}
   result.cleanup={confirmed:transport.closed===true&&transport.remainingRequests===0&&credentialCleanup&&released,transport,credentialCleanup,ownershipReleased:owned&&released,error};
   if(!result.cleanup.confirmed){result.status='STOPPED';result.reason='DETAILS_CLEANUP_UNCONFIRMED';}
   result.localCursorChanged=canonical(getRecord(db,'telegram_writing_cursor','primary'))!==cursorBefore;
   if(result.localCursorChanged){result.status='STOPPED';result.reason='UNEXPECTED_CURSOR_CHANGE';}
   result.elapsedMs=Math.floor(clock()-start);if(result.elapsedMs>DETAILS_LIMITS.totalMs){result.status='STOPPED';result.reason='TOTAL_DEADLINE_EXCEEDED';}
   result.authorizationStatus='CLOSED';result.finishedAt=iso();result.budget=budget.snapshot();result.finalControls=controls(db);
   transaction(db,()=>{const grant=getRecord(db,'telegram_details_authorization',DETAILS_ID);putRecord(db,'telegram_details_authorization',DETAILS_ID,{...grant,status:'CLOSED',reason:result.reason,finishedAt:result.finishedAt},'configuration');save();journal(db,'DETAILS_TEST_CLOSED',DETAILS_ID,{reason:result.reason});});
  }
 }
}
