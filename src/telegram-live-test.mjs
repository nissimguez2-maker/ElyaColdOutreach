import { putRecord,getRecord,controls,transaction,journal } from './store.mjs';
import { latestBatch } from './batches.mjs';
import { createSyntheticBatch,issueSyntheticReview,handleSyntheticControl,controlMessageRejection } from './telegram-decisions.mjs';
import { isPairedSender,numericId } from './telegram-pairing.mjs';
import { APPROVED_CHAT_ID,APPROVED_BATCH_ID,APPROVED_PACKETS } from './telegram-live-contract.mjs';
import { safeNetworkDiagnostic } from './telegram-api.mjs';
import {pinnedBinding,exactPacket,verifyApprovedProposal} from './telegram-review-checks.mjs';
import {CONTINUATION_ID,CONTINUATION_REVIEW_ID,validateContinuation,claimContinuation,advanceContinuationRevision} from './telegram-continuation.mjs';
import {assertNoActiveTelegramConsumer} from './telegram-writing-authority.mjs';
export {verifyApprovedProposal} from './telegram-review-checks.mjs';

export const LIVE_TEST_ID='synthetic-live-01';
const safeCodes=new Set(['TELEGRAM_CONSUMER_CONFLICT','TELEGRAM_EXISTING_WEBHOOK','TELEGRAM_AUTHENTICATION_FAILED','TELEGRAM_NETWORK_UNCERTAIN','TELEGRAM_INVALID_RESPONSE','TELEGRAM_INVALID_UPDATES','TELEGRAM_REQUEST_FAILED','TELEGRAM_DEADLINE_OR_METHOD','PAIRING_MISMATCH','BOT_IDENTITY_MISMATCH','BUSINESS_MUST_REMAIN_STOPPED','DEADLINE','APPROVED_PROPOSAL_MISMATCH','REVISION_INVALIDATION_FAILED','DELIVERY_UNCERTAIN','LOCAL_CREDENTIAL_UNAVAILABLE_USE_NORMAL_USER_TERMINAL']);
function unused(db){if(getRecord(db,'telegram_live_test',LIVE_TEST_ID))throw Error('EXISTING_LIVE_TEST_NO_AUTOMATIC_RETRY');if(latestBatch(db,APPROVED_BATCH_ID)||getRecord(db,'telegram_review','qa-tg-01-v1')||getRecord(db,'telegram_review','qa-tg-01-v2'))throw Error('EXISTING_SYNTHETIC_STATE_REQUIRES_REVIEW');}
function preSendHandoff(db){
 const s=getRecord(db,'telegram_live_test',LIVE_TEST_ID),elapsed=s?Date.parse(s.finishedAt)-Date.parse(s.startedAt):NaN;
 if(!s||s.status!=='STOPPED_INCOMPLETE'||s.phase!=='CHECKS'||s.errorCode!=='TELEGRAM_NETWORK_UNCERTAIN'||s.normalUserHandoffUsed||s.pollingEnded!==true||s.messages?.length!==2||!s.messages.every(m=>m.status==='NOT_SENT')||s.commands?.length!==0||!Number.isFinite(elapsed)||elapsed<0||elapsed>=300000||latestBatch(db,APPROVED_BATCH_ID)||getRecord(db,'telegram_review','qa-tg-01-v1')||getRecord(db,'telegram_review','qa-tg-01-v2')||db.prepare("SELECT id FROM journal WHERE subject=? AND event='SYNTHETIC_PACKET_SEND_INTENT' LIMIT 1").get(LIVE_TEST_ID))throw Error('HANDOFF_NOT_ALLOWED');
 return {elapsed,previousStartedAt:s.startedAt,previousFinishedAt:s.finishedAt,errorCode:s.errorCode};
}
export const runApprovedTelegramTest=deps=>runSyntheticSession(deps,false);
export const runApprovedTelegramContinuation=deps=>runSyntheticSession(deps,true);
async function runSyntheticSession({db,loadToken,makeApi,clock=Date.now,emit=()=>{},sleep=ms=>new Promise(r=>setTimeout(r,ms)),manualNormalUserHandoff=false},continuation){
 const source=continuation?validateContinuation(db,new Date(clock()).toISOString()):null;
 const handoff=continuation?null:manualNormalUserHandoff===true?preSendHandoff(db):(unused(db),null);
 const sessionId=continuation?CONTINUATION_ID:LIVE_TEST_ID,reviewId1=continuation?CONTINUATION_REVIEW_ID:'qa-tg-01-v1';
 const recognized=new Set([`/approve ${reviewId1}`,`/reject ${reviewId1}`,'/approve qa-tg-01-v1','/approve qa-tg-01-v2','/reject qa-tg-01-v1','/reject qa-tg-01-v2','/stop']);
 verifyApprovedProposal(db);const paired=pinnedBinding(db),started=clock(),deadline=started+(continuation?180000:300000)-(handoff?.elapsed??0);let token;
 if(!continuation){try{token=await loadToken(Math.min(5000,deadline-clock()));}catch{throw Error('LOCAL_CREDENTIAL_UNAVAILABLE_USE_NORMAL_USER_TERMINAL');}}
 let state={status:'RUNNING',phase:'CHECKS',startedAt:new Date(started).toISOString(),deadline:new Date(deadline).toISOString(),allowanceAtStartMs:deadline-started,normalUserHandoffUsed:!!handoff,priorContextFailure:handoff,messages:[{version:1,status:'NOT_SENT'},{version:2,status:'NOT_SENT'}],commands:[],revisionInvalidationPassed:false,staleRejectionPassed:false,version1Approved:false,version2Rejected:false,stopEndedPolling:false,offset:Math.max(0,(getRecord(db,'telegram_pairing','private-setup-01')?.lastUpdateId??-1)+1),phaseFloor:-1,polling:{attempts:0,completed:0,emptyResponses:0,last:null}};
 if(continuation){state.sourceId=source.sourceId;state.sourceSnapshotHash=source.sourceSnapshotHash;state.sourceReviewHash=source.sourceReviewHash;state.messages[0]={version:1,status:'API_CONFIRMED',messageId:4,inherited:true,mustNotResend:true};state.offset=source.offset;}
 const save=event=>transaction(db,()=>{putRecord(db,'telegram_live_test',sessionId,state,'configuration');journal(db,event,sessionId,{status:state.status,phase:state.phase});});
 if(continuation)claimContinuation(db,state,new Date(clock()).toISOString());
  else transaction(db,()=>{if(handoff)preSendHandoff(db);else unused(db);assertNoActiveTelegramConsumer(db);pinnedBinding(db);putRecord(db,'telegram_live_test',sessionId,state,'configuration');journal(db,handoff?'SYNTHETIC_NORMAL_USER_HANDOFF':'SYNTHETIC_LIVE_CLAIMED',sessionId,{deadline:state.deadline});});
 const remaining=()=>{const current=pinnedBinding(db);if(current.botId!==paired.botId)throw Error('PAIRING_MISMATCH');const ms=deadline-clock();if(ms<=0)throw Error('DEADLINE');return ms;};
 let approvalId;
 const operation=async(method,invoke)=>{
  const began=clock();state.lastOperation={method,status:'ATTEMPTED',startedAt:new Date(began).toISOString(),remainingAtStartMs:Math.max(0,deadline-began)};
  if(method==='getUpdates'){state.polling.attempts++;state.polling.last={offset:state.offset,...state.lastOperation};}
  save('SYNTHETIC_IO_ATTEMPT');
  try{const value=await invoke();state.lastOperation={...state.lastOperation,status:'COMPLETED',finishedAt:new Date(clock()).toISOString()};
   if(method==='getUpdates'){state.polling.completed++;if(Array.isArray(value)&&value.length===0)state.polling.emptyResponses++;state.polling.last={offset:state.offset,...state.lastOperation,updateCount:Array.isArray(value)?value.length:null};}
   save('SYNTHETIC_IO_COMPLETED');return value;
  }catch(error){state.lastOperation={...state.lastOperation,status:'FAILED',finishedAt:new Date(clock()).toISOString(),errorCode:safeCodes.has(error?.message)?error.message:'UNRESOLVED_LOCAL_OR_SERVICE_FAILURE',diagnostic:error?.message==='TELEGRAM_NETWORK_UNCERTAIN'?safeNetworkDiagnostic(error.diagnostic,method):null};if(method==='getUpdates')state.polling.last={offset:state.offset,...state.lastOperation};save('SYNTHETIC_IO_FAILED');throw error;}
 };
 try{
  // Claim the once-only continuation before credential access; failure is terminal too.
  if(continuation)token=await operation('readProtected',async()=>{const ms=Math.min(5000,remaining());try{return await loadToken(ms);}catch{throw Error('LOCAL_CREDENTIAL_UNAVAILABLE_USE_NORMAL_USER_TERMINAL');}});
  const api=makeApi(token);token=null;
  const identity=await operation('getMe',()=>api.identity(remaining()));if(identity?.id!==paired.botId||identity.is_bot!==true)throw Error('BOT_IDENTITY_MISMATCH');await operation('getWebhookInfo',()=>api.checkWebhook(remaining()));
  const issue=version=>{remaining();if(continuation){if(version!==2)throw Error('CONTINUATION_VERSION1_FORBIDDEN');advanceContinuationRevision(db);}else createSyntheticBatch(db,APPROVED_BATCH_ID,version);issueSyntheticReview(db,`qa-tg-01-v${version}`,APPROVED_BATCH_ID,state.deadline,new Date(clock()).toISOString());exactPacket(db,version);};
  const send=async version=>{
   remaining();if(continuation&&version!==2)throw Error('CONTINUATION_VERSION1_FORBIDDEN');exactPacket(db,version);if(state.messages[version-1].status!=='NOT_SENT')throw Error('DELIVERY_UNCERTAIN');
   state.messages[version-1]={version,status:'SEND_INTENT'};save('SYNTHETIC_PACKET_SEND_INTENT');
   try{
    const r=await operation('sendMessage',()=>continuation?api.sendVersion2(remaining()):api.sendPacket(version,APPROVED_CHAT_ID,remaining()));
    if(!numericId(r?.message_id)||r.chat?.id!==APPROVED_CHAT_ID||r.chat.type!=='private'||r.from?.id!==paired.botId||r.from.is_bot!==true||r.text!==APPROVED_PACKETS[version-1])throw Error();
    state.messages[version-1]={version,status:'API_CONFIRMED',messageId:r.message_id};save('SYNTHETIC_PACKET_CONFIRMED');emit({event:'message',version,outcome:'API_CONFIRMED'});
   }catch{state.messages[version-1]={version,status:'UNCERTAIN'};save('SYNTHETIC_PACKET_UNCERTAIN');throw Error('DELIVERY_UNCERTAIN');}
  };
  if(!continuation){issue(1);await send(1);}state.phase='WAIT_APPROVE_V1';save('SYNTHETIC_LIVE_PHASE');
  emit({event:'ready',command:`/approve ${reviewId1}`,remainingMs:remaining(),sourceMessageId:continuation?4:state.messages[0].messageId});
  while(state.status==='RUNNING'){
   const updates=await operation('getUpdates',()=>api.poll(state.offset,remaining()));remaining();
   if(!Array.isArray(updates)||updates.length>100||updates.some(u=>!Number.isSafeInteger(u?.update_id)||u.update_id<0))throw Error('TELEGRAM_INVALID_UPDATES');
   const floor=Math.max(state.phaseFloor,...updates.map(u=>u.update_id));
   const pendingStop=updates.some(u=>u.message?.text==='/stop'&&!getRecord(db,'telegram_control_receipt',`${paired.botId}:${u.update_id}`)&&controlMessageRejection(db,u,new Date(clock()).toISOString())===null);
   for(const update of updates){
    remaining();if(state.commands.length>=500)throw Error('UPDATE_LIMIT');const m=update.message;
    const receiptId=`${paired.botId}:${update.update_id}`,existing=getRecord(db,'telegram_control_receipt',receiptId);
    let result;
    if(existing||!isPairedSender(db,m)||m?.text==='/stop')result=handleSyntheticControl(db,update,new Date(clock()).toISOString());
    else {
     const expected={WAIT_APPROVE_V1:`/approve ${reviewId1}`,WAIT_STALE_V1:`/approve ${reviewId1}`,WAIT_REJECT_V2:'/reject qa-tg-01-v2',WAIT_STOP:'/stop'}[state.phase];
     const precedingPacket=state.messages[state.phase==='WAIT_APPROVE_V1'?0:1];
     if(update.update_id<=state.phaseFloor||!numericId(m?.message_id)||m.message_id<=precedingPacket.messageId||m?.text!==expected||!Number.isSafeInteger(m?.date)||m.date<Math.floor(started/1000)){
      result={status:'OUT_OF_SEQUENCE'};putRecord(db,'telegram_control_receipt',receiptId,{status:result.status,updateId:update.update_id,recordedAt:new Date(clock()).toISOString(),syntheticOnly:true},'confirmed');
     }else result=handleSyntheticControl(db,update,new Date(clock()).toISOString());
    }
    state.commands.push({updateId:update.update_id,command:recognized.has(m?.text)?m.text:'UNRECOGNIZED_OR_NONCONTROL',outcome:result.status});state.offset=Math.max(state.offset,update.update_id+1);save('SYNTHETIC_LIVE_COMMAND');emit({event:'command',...state.commands.at(-1)});
    if(result.status==='STOPPED'){state.stopEndedPolling=true;state.status=state.version1Approved&&state.revisionInvalidationPassed&&state.staleRejectionPassed&&state.version2Rejected?'COMPLETED':'STOPPED_INCOMPLETE';break;}
    if(state.phase==='WAIT_APPROVE_V1'&&result.status==='APPROVED'){
     state.version1Approved=true;approvalId=result.approvalId;
     if(pendingStop){state.phase='WAIT_STOP';save('SYNTHETIC_PENDING_STOP_SUPPRESSED_SEND');continue;}
     issue(2); // insertBatch commits v2 and invalidation of v1 in the same transaction.
     if(db.prepare('SELECT decision FROM approvals WHERE id=?').get(approvalId)?.decision!=='INVALIDATED')throw Error('REVISION_INVALIDATION_FAILED');
     state.revisionInvalidationPassed=true;state.phaseFloor=floor;save('SYNTHETIC_REVISION_INVALIDATED');await send(2);state.phase='WAIT_STALE_V1';save('SYNTHETIC_LIVE_PHASE');
    }else if(state.phase==='WAIT_STALE_V1'&&result.status==='STALE_REVIEW'){state.staleRejectionPassed=true;state.phase='WAIT_REJECT_V2';save('SYNTHETIC_LIVE_PHASE');}
    else if(state.phase==='WAIT_REJECT_V2'&&result.status==='REJECTED'){state.version2Rejected=true;state.phase='WAIT_STOP';save('SYNTHETIC_LIVE_PHASE');}
   }
   if(state.status==='RUNNING')await sleep(Math.min(250,remaining()));
  }
 }catch(error){state.status=error?.message==='DELIVERY_UNCERTAIN'?'DELIVERY_UNCERTAIN':clock()>=deadline?'DEADLINE_INCOMPLETE':'STOPPED_INCOMPLETE';state.errorCode=safeCodes.has(error?.message)?error.message:'UNRESOLVED_LOCAL_OR_SERVICE_FAILURE';state.terminalReason={code:state.errorCode,operation:state.lastOperation?.status==='FAILED'?state.lastOperation.method:'LOCAL_CONTROL',diagnostic:state.lastOperation?.status==='FAILED'?state.lastOperation.diagnostic:null,remainingMs:Math.max(0,deadline-clock())};}
 finally{token=null;state.finishedAt=new Date(clock()).toISOString();state.pollingEnded=true;state.finalControls=controls(db);
  state.terminalReason??={code:state.status==='COMPLETED'?'REQUIRED_SEQUENCE_COMPLETED':'AUTHENTICATED_STOP_BEFORE_SEQUENCE_COMPLETE',operation:'control_message',diagnostic:null,remainingMs:Math.max(0,deadline-clock())};
  state.checkOutcomes={revisionInvalidation:state.revisionInvalidationPassed?'PASSED':state.version1Approved?'INCOMPLETE':'NOT_EXERCISED',staleRejection:state.staleRejectionPassed?'PASSED':'NOT_EXERCISED',version2Rejection:state.version2Rejected?'PASSED':'NOT_EXERCISED',stopEndedPolling:state.stopEndedPolling?'PASSED':'NOT_EXERCISED'};
  save('SYNTHETIC_LIVE_FINISHED');}
 emit({event:'finished',status:state.status,terminalReason:state.terminalReason,checkOutcomes:state.checkOutcomes,polling:state.polling,controls:state.finalControls});return state;
}
