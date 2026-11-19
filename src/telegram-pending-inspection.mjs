import {performance} from 'node:perf_hooks';
import {getRecord,putRecord,journal,transaction,controls} from './store.mjs';
import {canonical,digest} from './values.mjs';
import {requireStopped} from './telegram-pairing.mjs';
import {acquireTelegramConsumer,releaseTelegramConsumer} from './telegram-writing-authority.mjs';

export const INSPECTION_ID='telegram-pending-inspection-v1';
const oldTest='telegram-writing-live-v1',kind='telegram_pending_inspection';
const safeError=e=>/^[A-Z][A-Z0-9_]{0,99}$/.test(e?.message??'')?e.message:'UNRESOLVED_LOCAL_FAILURE';
const number=v=>Number.isSafeInteger(v)&&v>=0?v:null;
const time=v=>Number.isSafeInteger(v)&&v>0&&v<=8640000000000?new Date(v*1000).toISOString():'UNKNOWN';
export function protectedInspectionHash(db){
 const records=db.prepare("SELECT * FROM records WHERE kind NOT IN ('telegram_pending_inspection','telegram_consumer_owner') ORDER BY kind,id").all();
 const tables=Object.fromEntries(['controls','approvals','batches','budgets','operations'].map(t=>[t,db.prepare(`SELECT * FROM ${t} ORDER BY rowid`).all()]));
 return digest(JSON.stringify({records,tables}));
}
export function inspectionReviewHash(db){
 const review=getRecord(db,'telegram_writing_review',oldTest);
 if(!review||review.version!==1||!review.actions||!Number.isSafeInteger(review.messageId))throw Error('CLOSED_REVIEW_UNAVAILABLE');
 return digest(JSON.stringify({review,actions:db.prepare("SELECT id,data_json FROM records WHERE kind='telegram_writing_action' ORDER BY id").all()}));
}
// No callbacks/commands are executed. Never retain raw text, references, usernames,
// callback IDs, or arbitrary provider field names in the sanitized inventory.
export function inventoryPending(updates,pairing,syntheticDb){
 const review=getRecord(syntheticDb,'telegram_writing_review',oldTest);
 const ids=new Set();
 return updates.map(u=>{
  if(ids.has(u.update_id))throw Error('DUPLICATE_UPDATE_ID');ids.add(u.update_id);
  const q=u.callback_query,m=q?.message??u.message??u.edited_message??u.channel_post??u.edited_channel_post;
  const actor=q?.from??m?.from,chat=m?.chat;
  const actorMatch=actor?.id===undefined?'UNKNOWN':actor.id===pairing.userId&&actor.is_bot!==true;
  const chatMatch=chat?.id===undefined?'UNKNOWN':chat.id===pairing.chatId&&chat.type==='private';
  const type=q?'CALLBACK_QUERY':u.message?'MESSAGE':u.edited_message?'EDITED_MESSAGE':u.channel_post?'CHANNEL_POST':u.edited_channel_post?'EDITED_CHANNEL_POST':'OTHER_OR_UNKNOWN';
  const ref=typeof q?.data==='string'&&/^wr_[A-Za-z0-9_-]{22}$/.test(q.data)?getRecord(syntheticDb,'telegram_writing_action',q.data):null;
  const mapped=!!ref&&ref.telegramReviewId===oldTest&&['DETAILS','APPROVED','REJECTED','REVISION_REQUESTED'].includes(ref.action)&&review.actions[ref.action]===q.data;
  const messageMatch=!!q&&m?.message_id===review.messageId&&m?.from?.id===pairing.botId&&m?.from?.is_bot===true;
  const bound=mapped&&messageMatch;
  const isStop=typeof u.message?.text==='string'?u.message.text==='/stop':false;
  return {updateId:u.update_id,type,actorMatch,chatMatch,messageId:number(m?.message_id),associatedMessageTimestamp:time(m?.date),actionTimestamp:q?'UNKNOWN':time(u.message?.date),timestampMeaning:q?'ORIGINAL_ASSOCIATED_MESSAGE_NOT_CALLBACK_TIME':'MESSAGE_TIME_IF_AVAILABLE',mapsToClosedPacket:bound,referenceMapsToClosedReview:mapped,decodedAction:mapped?ref.action:null,packetVersion:bound?review.version:null,isStop,classification:actorMatch===true&&chatMatch===true&&(bound||isStop)?(bound?'CLOSED_SYNTHETIC_CALLBACK':'PAIRED_STOP_NOT_EXECUTED'):(mapped?'BINDING_OR_IDENTITY_MISMATCH':type==='OTHER_OR_UNKNOWN'?'UNCLASSIFIABLE':'UNRELATED')};
 }).sort((a,b)=>a.updateId-b.updateId);
}

export async function runPendingInspection({db,syntheticDb,approved,loadToken,makeApi,clock=()=>performance.now(),wallClock=Date.now,startedMono=clock(),startedWall=wallClock()}){
 const iso=()=>new Date(startedWall+Math.floor(clock()-startedMono)).toISOString();
 let claimed=false,owned=false,api=null,credentialCleanupConfirmed=true;
 const result={id:INSPECTION_ID,startedAt:iso(),status:'STOPPED',reason:null,attempts:[],inventory:[],additionalUpdatesMayExist:false,underlyingTransportRetries:'UNOBSERVED',authorizationStatus:'NOT_CREATED'};
 const save=()=>putRecord(db,kind,INSPECTION_ID,result,'confirmed');
 const remaining=()=>{const ms=Math.floor(25000-(clock()-startedMono));if(ms<=0)throw Error('INSPECTION_API_DEADLINE');return ms;};
 const invariant=()=>{requireStopped(db);if(protectedInspectionHash(db)!==approved.protectedHash||inspectionReviewHash(syntheticDb)!==approved.reviewHash)throw Error('INSPECTION_BOUND_STATE_CHANGED');};
 const expected=[['getMe',{}],['getWebhookInfo',{}],['getUpdates',{timeout:0,limit:100}]];
 const guard=(method,body,ms)=>{
  invariant();const owner=getRecord(db,'telegram_consumer_owner','primary');
  if(!owned||owner?.ownerId!==INSPECTION_ID||owner.status!=='ACTIVE'||getRecord(db,kind,INSPECTION_ID)?.authorizationStatus!=='CLAIMED')throw Error('INSPECTION_AUTHORITY_MISMATCH');
  const next=expected[result.attempts.length];if(!next||method!==next[0]||canonical(body)!==canonical(next[1]))throw Error('INSPECTION_REQUEST_NOT_AUTHORIZED');
  const capped=Math.min(ms,remaining());result.attempts.push({method,status:'ATTEMPTED',at:iso()});save();return capped;
 };
 try{
  transaction(db,()=>{
   if(getRecord(db,kind,INSPECTION_ID))throw Error('INSPECTION_ALREADY_ATTEMPTED');
   result.authorizationStatus='CLAIMED';result.approvalBindingHash=digest(canonical(approved));claimed=true;save();journal(db,'PENDING_INSPECTION_CLAIMED',INSPECTION_ID,{scope:'ONE_OFFSET_FREE_READ',totalMs:30000,maxApiAttempts:3});
  });
  invariant();
  if(canonical(getRecord(db,'telegram_binding','primary'))!==canonical(approved.pairing)||!approved.pairing?.confirmed||getRecord(db,'telegram_writing_authorization',oldTest)?.status!=='CLOSED')throw Error('INSPECTION_PREREQUISITE_MISMATCH');
  acquireTelegramConsumer(db,INSPECTION_ID,iso());owned=true;
  let token;try{token=await loadToken(Math.min(5000,remaining()));}catch(e){credentialCleanupConfirmed=['PROTECTED_STORAGE_UNAVAILABLE','WINDOWS_PROTECTION_UNAVAILABLE','WINDOWS_PROTECTION_FAILED'].includes(e?.message);throw Error(credentialCleanupConfirmed?'LOCAL_CREDENTIAL_UNAVAILABLE':'CREDENTIAL_CLEANUP_UNCONFIRMED');}
  remaining();api=makeApi(token,guard);token=null;
  const returned=()=>{result.attempts.at(-1).status='API_RETURNED';result.attempts.at(-1).finishedAt=iso();save();};
  const identity=await api.identity(remaining());returned();
  if(identity?.id!==approved.pairing.botId||identity.is_bot!==true)throw Error('BOT_IDENTITY_MISMATCH');
  await api.checkWebhook(remaining());returned();
  const updates=await api.inspectPending(remaining());returned();
  result.inventory=inventoryPending(updates,approved.pairing,syntheticDb);result.additionalUpdatesMayExist=updates.length===100;save();
  remaining();invariant();result.status='COMPLETE';result.reason='INSPECTION_COMPLETE';
 }catch(e){result.reason=safeError(e);const a=result.attempts.at(-1);if(a?.status==='ATTEMPTED'){a.status='FAILED_OR_UNCERTAIN';a.reason=result.reason;}}
 finally{
  if(claimed){
   let transport={closed:true,remainingRequests:0};try{if(api)transport=await api.close();}catch{transport={closed:false,remainingRequests:null};}
   const transportConfirmed=transport?.closed===true&&transport.remainingRequests===0&&credentialCleanupConfirmed;
   let ownershipReleased=false,ownershipError=null;
   if(owned){try{
    if(transportConfirmed){releaseTelegramConsumer(db,INSPECTION_ID,iso());ownershipReleased=true;}
    else{const owner=getRecord(db,'telegram_consumer_owner','primary');if(owner?.ownerId!==INSPECTION_ID)throw Error('CONSUMER_OWNER_MISMATCH');putRecord(db,'telegram_consumer_owner','primary',{...owner,status:'RECONCILIATION'},'configuration');}
   }catch(e){ownershipError=safeError(e);}}
   const confirmed=transportConfirmed&&(!owned||ownershipReleased);
   result.cleanup={confirmed,transport,credentialCleanupConfirmed,ownershipAcquired:owned,ownershipReleased,ownershipError};
   if(!confirmed){result.status='STOPPED';result.reason='INSPECTION_CLEANUP_UNCONFIRMED';}
   result.protectedStateUnchanged=protectedInspectionHash(db)===approved.protectedHash;
   if(!result.protectedStateUnchanged){result.status='STOPPED';result.reason='INSPECTION_BOUND_STATE_CHANGED';}
   result.authorizationStatus='CLOSED';result.finishedAt=iso();result.elapsedMs=Math.floor(clock()-startedMono);result.apiAttemptCount=result.attempts.length;result.finalControls=controls(db);
   if(result.elapsedMs>30000){result.status='STOPPED';result.reason='INSPECTION_TOTAL_DEADLINE_EXCEEDED';}
   save();journal(db,'PENDING_INSPECTION_CLOSED',INSPECTION_ID,{reason:result.reason,cleanupConfirmed:confirmed});
  }
 }
 return result;
}
