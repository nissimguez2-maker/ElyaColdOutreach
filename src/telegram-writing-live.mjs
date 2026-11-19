import {performance} from 'node:perf_hooks';
import {getRecord,putRecord,journal,transaction,controls} from './store.mjs';
import {canonical,digest} from './values.mjs';
import {isPairedSender,requireStopped} from './telegram-pairing.mjs';
import {controlMessageRejection} from './telegram-decisions.mjs';
import {evaluateWritingReview} from './writing.mjs';
import {issueWritingTelegramReview} from './telegram-writing-decisions.mjs';
import {bindLiveSyntheticWritingAdapter} from './telegram-writing-adapter.mjs';
import {makeWritingTestContract,ACTIONS,TEST_ID} from './telegram-writing-live-card.mjs';
import {claimWritingTest,assertWritingTest,closeWritingTest,commitConsumedUpdate} from './telegram-writing-authority.mjs';
import {WritingRequestBudget} from './telegram-writing-budget.mjs';

const expectedOutcomes=['DETAILS','APPROVED','ALREADY_DECIDED','CONFLICTING_DECISION','CONFLICTING_DECISION'];
const safeError=e=>/^[A-Z][A-Z0-9_]{0,99}$/.test(e?.message??'')?e.message:'UNRESOLVED_LOCAL_FAILURE';
const numeric=value=>Number.isSafeInteger(value)&&value>=0;

// Never classify arbitrary old commands as this test. Full returned batch is
// inspected before ANY decision or cursor mutation, including /stop precedence.
export function classifyWritingUpdates(db,syntheticDb,review,updates,at){
 if(!Array.isArray(updates)||updates.length>100||updates.some(u=>!numeric(u?.update_id)))throw Error('INVALID_UPDATES');
 const paired=getRecord(db,'telegram_binding','primary'),cursor=getRecord(db,'telegram_writing_cursor','primary');
 const ids=new Set();
 return updates.map(update=>{
  if(ids.has(update.update_id))throw Error('DUPLICATE_UPDATE_IN_RESPONSE');ids.add(update.update_id);
  const updateHash=digest(canonical(update)),key=`${paired.botId}:${update.update_id}`;
  const prior=getRecord(db,'telegram_writing_consumed',key);
  if(prior){if(prior.updateHash!==updateHash||prior.testId!==TEST_ID)throw Error('CONSUMED_UPDATE_MISMATCH');return {update,updateHash,duplicate:true};}
  if(update.update_id<cursor.nextOffset||getRecord(db,'telegram_control_receipt',key))throw Error('UNRELATED_PENDING_UPDATES');
  if(update.message?.text==='/stop'&&controlMessageRejection(db,update,at)===null)return {update,updateHash,action:'STOP'};
  const q=update.callback_query,m=q?.message;
  if(!q||!isPairedSender(db,{from:q.from,chat:m?.chat})||typeof q.id!=='string'||m.from?.id!==paired.botId||m.from?.is_bot!==true||m.message_id!==review.messageId||!Object.values(review.actions).includes(q.data))throw Error('UNRELATED_PENDING_UPDATES');
  // The existing handler performs all remaining message and packet validation.
  const action=Object.entries(review.actions).find(([,ref])=>ref===q.data)[0];
  return {update,updateHash,action};
 }).sort((a,b)=>a.update.update_id-b.update.update_id);
}

/** Bounded one-use orchestration. makeApi is the ONLY injected transport; live CLI
 * supplies the existing Telegram client. Offline tests supply a network-blocked fake.
 * This entry never loads a provider connector or uses a model-driven operation.
 */
export async function runWritingLiveTest({db,syntheticDb,contract,loadToken,makeApi,clock=()=>performance.now(),wallClock=Date.now,emit=()=>{},cancelled=()=>false}){
 const startedMono=clock(),startedWall=wallClock(),iso=()=>new Date(startedWall+Math.floor(clock()-startedMono)).toISOString();
 let claim=null,api=null,token=null,stopped=false,review=null,credentialCleanupConfirmed=true;
 let state={id:TEST_ID,status:'STARTING',startedAt:iso(),phase:'CHECKS',commands:[],messages:[],requestEvidence:[],terminalReason:null,networkRequestsBelowTransport:'UNOBSERVED',cleanup:null};
 const save=(event,details={})=>transaction(db,()=>{putRecord(db,'telegram_writing_live_test',TEST_ID,state,'confirmed');journal(db,event,TEST_ID,{status:state.status,phase:state.phase,...details});});
 const budget=new WritingRequestBudget({clock,startedAt:startedMono,record:(snapshot,kind)=>{state.budget=snapshot;state.requestEvidence.push({kind,status:'ATTEMPTED',at:iso()});save('WRITING_LIVE_REQUEST_INTENT');}});
 const assertActive=()=>{
  if(cancelled())throw Error('LOCAL_CANCELLED');if(stopped)throw Error('TEST_COMMUNICATION_STOPPED');
  assertWritingTest(db,claim,iso());requireStopped(syntheticDb);budget.check();
  const gate=evaluateWritingReview(syntheticDb,'qa-writing-review',null,iso());
  if(gate.packetHash!==contract.packetHash||!gate.synthetic)throw Error('SYNTHETIC_PACKET_CHANGED');
 };
 let permittedWire=null;
 const wireGuard=(method,body,ms)=>{assertActive();if(!permittedWire||permittedWire.method!==method)throw Error('UNAUTHORIZED_TELEGRAM_METHOD');
  if(['sendMessage','answerCallbackQuery'].includes(method)){
   const expected=permittedWire.args;
   if(method==='sendMessage'&&(body.chat_id!==expected[0]||body.text!==expected[1].text||canonical(body.reply_markup??null)!==canonical(expected[1].reply_markup??null)))throw Error('UNAPPROVED_TELEGRAM_MESSAGE');
   if(method==='answerCallbackQuery'&&(body.callback_query_id!==expected[0]||body.text!==expected[1]))throw Error('UNAPPROVED_CALLBACK_ACK');
  }
  if(method==='getUpdates'&&body.offset!==getRecord(db,'telegram_writing_cursor','primary').nextOffset)throw Error('TELEGRAM_CURSOR_MISMATCH');
  permittedWire=null;budget.check();return Math.min(ms,budget.remaining());
 };
 const invoke=async(kind,method,args,fn)=>{
  assertActive();const ms=budget.take(kind,{stopPhase:state.phase==='WAIT_STOP'});permittedWire={method,args};
  try{
   const value=await fn(ms);permittedWire=null;
   const entry=state.requestEvidence.at(-1);entry.status='API_RETURNED';entry.finishedAt=iso();save('WRITING_LIVE_REQUEST_RETURNED');
   // No subsequent decision or call after a late return. Keep acceptance evidence
   // if a message did return, even when the remaining execution window is gone.
   if(method==='sendMessage')state.messages.push({messageId:Number.isSafeInteger(value?.message_id)?value.message_id:null,apiReturned:true});
   budget.check();return value;
  }catch(error){permittedWire=null;const entry=state.requestEvidence.at(-1);entry.status=entry.status==='API_RETURNED'?'RETURNED_AFTER_CUTOFF':'UNCERTAIN_OR_FAILED';entry.error=safeError(error);save('WRITING_LIVE_REQUEST_FAILED');throw error;}
 };
 try{
  claim=claimWritingTest(db,contract,iso());state.status='RUNNING';save('WRITING_LIVE_CLAIMED');
  const p=getRecord(syntheticDb,'writing_packet',contract.packetHash);
  if(db===syntheticDb||db.location()&&db.location()===syntheticDb.location())throw Error('ISOLATED_SYNTHETIC_DATABASE_REQUIRED');
  if(!p?.synthetic||canonical(makeWritingTestContract(p,getRecord(db,'telegram_binding','primary')))!==canonical(contract))throw Error('PREPARED_CONTRACT_MISMATCH');
  assertActive();try{token=await loadToken(Math.min(5000,budget.remaining()));}catch(error){
   credentialCleanupConfirmed=['PROTECTED_STORAGE_UNAVAILABLE','WINDOWS_PROTECTION_UNAVAILABLE','WINDOWS_PROTECTION_FAILED'].includes(error?.message);
   throw Error(credentialCleanupConfirmed?'LOCAL_CREDENTIAL_UNAVAILABLE':'CREDENTIAL_CLEANUP_UNCONFIRMED');
  }
  assertActive();api=makeApi(token,wireGuard);token=null;
  if(api?.mode!=='LIVE_SYNTHETIC_WRITING'||typeof api.close!=='function')throw Error('LIVE_SYNTHETIC_TRANSPORT_REQUIRED');
  const identity=await invoke('getMe','getMe',[],ms=>api.identity(ms));if(identity?.id!==claim.pairing.botId||identity.is_bot!==true)throw Error('BOT_IDENTITY_MISMATCH');
  await invoke('getWebhookInfo','getWebhookInfo',[],ms=>api.checkWebhook(ms));
  review=issueWritingTelegramReview(syntheticDb,{id:TEST_ID,reviewId:p.reviewId,packetHash:p.hash,at:iso(),expiresAt:claim.deadline,expiryBasis:'EXPLICIT_SYNTHETIC_TEST'});
  const limited={mode:'LIVE_SYNTHETIC_WRITING',
   sendPage:(chat,page)=>invoke(state.phase==='SEND_INITIAL'?'initialMessages':'detailsMessages','sendMessage',[chat,page],ms=>api.sendPage(chat,page,ms)),
   answerCallback:(id,text)=>invoke('acknowledgments','answerCallbackQuery',[id,text],ms=>api.answerCallback(id,text,ms))};
  const adapter=bindLiveSyntheticWritingAdapter({db,syntheticDb,api:limited,assertAuthority:assertActive,timestampNow:iso});
  state.phase='SEND_INITIAL';save('WRITING_LIVE_PHASE');
  const delivery=await adapter.deliver(TEST_ID,budget.remaining(),iso());state.delivery=delivery;save('WRITING_LIVE_INITIAL_DELIVERY');
  if(delivery.status!=='API_CONFIRMED')throw Error('DELIVERY_UNCERTAIN');
  review=getRecord(syntheticDb,'telegram_writing_review',TEST_ID);state.phase='INTERACTIONS';save('WRITING_LIVE_PHASE');
  emit({event:'READY_FOR_DETAILS',messageIds:delivery.accepted.map(x=>x.messageId),remainingMs:budget.remaining()});
  let actionIndex=0;
  while(true){
   assertActive();state.phase=actionIndex===5?'WAIT_STOP':'INTERACTIONS';
   const offset=getRecord(db,'telegram_writing_cursor','primary').nextOffset;
   const updates=await invoke('polls','getUpdates',[offset],ms=>api.poll(offset,ms));
   const entries=classifyWritingUpdates(db,syntheticDb,review,updates,iso());
   for(const entry of entries){
    if(entry.duplicate)continue;
    assertActive();
    if(entry.action!=='STOP'&&entry.action!==ACTIONS[actionIndex]){
     // Classification and current-packet checks passed; the stricter handler has
     // NOT run. Keep only non-reusable metadata, never callback IDs/data or text.
     const currentOffset=getRecord(db,'telegram_writing_cursor','primary').nextOffset;
     state.unexpectedAction={updateId:entry.update.update_id,updateType:'CALLBACK_QUERY',observedAction:entry.action,expectedAction:ACTIONS[actionIndex],sequenceIndex:actionIndex,phase:state.phase,classification:'BOUND_TEST_CALLBACK',actorChatCheck:'MATCHED',botCheck:'MATCHED',boundMessageId:review.messageId,receivedMessageId:entry.update.callback_query.message.message_id,packetVersion:review.version,packetVersionMatch:review.version===contract.packetVersion,currentPacketCheck:'PASSED',handlerValidation:'NOT_RUN',handlerDispatched:false,observationPersisted:true,receiptCreatedForThisUpdate:false,decisionCommittedForThisUpdate:false,contentDecisionStatus:getRecord(syntheticDb,'telegram_writing_review',TEST_ID).status,offsetBefore:currentOffset,offsetAfter:currentOffset,consumed:false,remoteQueueStatus:'UNOBSERVED_MAY_REMAIN_PENDING'};
     save('WRITING_LIVE_UNEXPECTED_ACTION',{unexpectedAction:state.unexpectedAction});
     throw Error('UNEXPECTED_TEST_ACTION');
    }
    if(entry.action!=='STOP')budget.requireAction(entry.action);
    state.pendingUpdate={updateId:entry.update.update_id,updateHash:entry.updateHash,action:entry.action,status:'PROCESSING_INTENT'};save('WRITING_LIVE_UPDATE_INTENT');
    const handled=await adapter.consume(entry.update,budget.remaining(),iso());
    if(handled.endConsumption){stopped=true;budget.stop();}
    if(!handled.endConsumption&&(handled.response.status!=='API_CONFIRMED'||handled.details&&handled.details.status!=='API_CONFIRMED'))throw Error('CALLBACK_RESPONSE_UNCERTAIN');
    const expected=entry.action==='STOP'?'STOPPED':expectedOutcomes[actionIndex];
    if(handled.outcome.status!==expected)throw Error('UNEXPECTED_DECISION_OUTCOME');
    commitConsumedUpdate(db,claim,entry.update.update_id,{status:handled.outcome.status,updateHash:entry.updateHash},iso());
    state.commands.push({action:entry.action,outcome:handled.outcome.status,updateId:entry.update.update_id});state.pendingUpdate=null;save('WRITING_LIVE_UPDATE_RECORDED');
    emit({event:'ACTION_RECORDED',action:entry.action,outcome:handled.outcome.status});
    if(stopped){state.status=actionIndex===5?'COMPLETED':'STOPPED_INCOMPLETE';state.terminalReason=actionIndex===5?'REQUIRED_SEQUENCE_COMPLETED':'AUTHENTICATED_STOP_BEFORE_SEQUENCE_COMPLETE';return state;}
    actionIndex++;
   }
  }
 }catch(error){
  state.status='STOPPED_INCOMPLETE';state.terminalReason=safeError(error);return state;
 }finally{
  token=null;stopped=true;budget.stop();
  let transport={closed:true,remainingRequests:0};try{if(api)transport=await api.close();}catch{transport={closed:false,remainingRequests:null};}
  const transportConfirmed=transport?.closed===true&&transport.remainingRequests===0;
  const cleanupConfirmed=transportConfirmed&&credentialCleanupConfirmed;
  if(!cleanupConfirmed){state.status='STOPPED_INCOMPLETE';state.terminalReason=credentialCleanupConfirmed?'TRANSPORT_CLEANUP_UNCONFIRMED':'CREDENTIAL_CLEANUP_UNCONFIRMED';}
  if(claim){
   const grant=closeWritingTest(db,claim,state.terminalReason??'UNRESOLVED_LOCAL_FAILURE',iso(),{cleanupConfirmed});
   state.authorizationStatus=grant.status;state.cleanup={confirmed:cleanupConfirmed&&grant.cleanup==='LOCAL_OWNER_RELEASED',transport,credentialHelperConfirmed:credentialCleanupConfirmed,owner:grant.cleanup,pollingEnded:true};state.finishedAt=iso();state.elapsedMs=Math.floor(clock()-startedMono);state.budget=budget.snapshot();state.finalControls=controls(db);
   if(state.elapsedMs>180000){state.status='STOPPED_INCOMPLETE';state.terminalReason='TOTAL_DEADLINE_EXCEEDED';}
   save('WRITING_LIVE_CLOSED');
  }else{state.authorizationStatus=getRecord(db,'telegram_writing_authorization',TEST_ID)?.status??'ABSENT';state.cleanup={transport,pollingEnded:true};}
 }
}
