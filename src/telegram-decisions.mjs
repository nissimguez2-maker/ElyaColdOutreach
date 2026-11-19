import { canonical, digest, timestamp } from './values.mjs';
import { transaction, journal, putRecord, getRecord, controls, now } from './store.mjs';
import { insertBatch, latestBatch, hashBatch, insertApproval } from './batches.mjs';
import { isPairedSender, numericId, requireStopped } from './telegram-pairing.mjs';

const batchPattern=/^QA-TG-[A-Z0-9-]{1,32}$/;
const reviewPattern=/^qa-[a-z0-9-]{1,60}$/;
function binding(db){const b=getRecord(db,'telegram_binding','primary');if(!b?.confirmed||!numericId(b.userId)||!numericId(b.chatId)||!numericId(b.botId))throw Error('CONFIRMED_PAIRING_REQUIRED');return {userId:b.userId,chatId:b.chatId,botId:b.botId};}
export function syntheticContent(revision){
 if(!Number.isSafeInteger(revision)||revision<1||revision>100)throw Error('INVALID_SYNTHETIC_REVISION');
 return {campaignId:'SYNTHETIC-ONLY-NO-CAMPAIGN',recipients:[{candidateId:'SYNTHETIC-QA-ONLY',email:'qa@example.invalid',messages:[{subject:`Synthetic QA revision ${revision}`,body:`Synthetic message revision ${revision}. No outreach is authorized.`}]}],sequence:{steps:1,sendEnabled:false},settings:{syntheticOnly:true,revision}};
}
function syntheticBatch(db,id){
 if(!batchPattern.test(id))throw Error('SYNTHETIC_BATCH_REQUIRED');const b=latestBatch(db,id);if(!b)throw Error('SYNTHETIC_BATCH_REQUIRED');
 const content=JSON.parse(b.content_json),{eligibilityBindings,...rest}=content;
 if(canonical(rest)!==canonical(syntheticContent(content.settings?.revision))||hashBatch(content)!==b.hash)throw Error('SYNTHETIC_BATCH_INTEGRITY');return b;
}
/** Fixed fixture template only: no supplied addresses, prospect records or prose. */
export function createSyntheticBatch(db,id,revision){
 if(typeof id!=='string'||!batchPattern.test(id))throw Error('SYNTHETIC_BATCH_REQUIRED');const content=syntheticContent(revision);
 return transaction(db,()=>{requireStopped(db);if(latestBatch(db,id))syntheticBatch(db,id);const b=insertBatch(db,id,content);
  for(const row of db.prepare("SELECT id,data_json FROM records WHERE kind='telegram_review' AND json_extract(data_json,'$.batchId')=?").all(id)){
   const r=JSON.parse(row.data_json);if(r.version!==b.version&&r.status==='PENDING')putRecord(db,'telegram_review',row.id,{...r,status:'INVALIDATED'},'configuration');
  }return b;
 });
}
export function issueSyntheticReview(db,id,batchId,expiresAt,at=now()){
 if(typeof id!=='string'||!reviewPattern.test(id))throw Error('INVALID_REVIEW_ID');const expiry=timestamp(expiresAt),issued=timestamp(at);
 if(expiry<=issued||expiry-issued>300000)throw Error('REVIEW_WINDOW_MAX_FIVE_MINUTES');
 return transaction(db,()=>{requireStopped(db);const paired=binding(db),b=syntheticBatch(db,batchId);
  if(getRecord(db,'telegram_review',id)||db.prepare("SELECT id FROM records WHERE kind='telegram_review' AND json_extract(data_json,'$.batchId')=? AND json_extract(data_json,'$.version')=?").get(batchId,b.version))throw Error('REVIEW_ALREADY_ISSUED');
  const r={id,batchId,version:b.version,hash:b.hash,bindingHash:digest(canonical(paired)),issuedAt:at,expiresAt,status:'PENDING',syntheticOnly:true};putRecord(db,'telegram_review',id,r,'configuration');journal(db,'SYNTHETIC_REVIEW_ISSUED',id,{batchId,version:b.version,hash:b.hash});return r;
 });
}
export function syntheticReviewText(db,id){
 const r=getRecord(db,'telegram_review',id);if(!r)throw Error('UNKNOWN_REVIEW');const b=syntheticBatch(db,r.batchId);
 if(r.version!==b.version||r.hash!==b.hash)throw Error('STALE_REVIEW');const c=JSON.parse(b.content_json),m=c.recipients[0].messages[0];
 return `SYNTHETIC QA ONLY — decision test\nBatch: ${r.batchId}\nVersion: ${r.version}\nSHA-256: ${r.hash}\nRecipient: qa@example.invalid (not deliverable)\nSubject: ${m.subject}\nBody: ${m.body}\nApprove: /approve ${id}\nReject: /reject ${id}\nStop: /stop\nDecision only. Business remains stopped; launch is not authorized.`;
}

/** Trusted caller supplies a Telegram Update; no polling, credentials or transport here. */
export function controlMessageRejection(db,update,at){
 const m=update?.message,time=timestamp(at);
 if(!isPairedSender(db,m))return 'UNAUTHORIZED';
 if(update.edited_message||m.forward_origin||m.forward_date||m.sender_chat||m.via_bot||!numericId(m.message_id)||!Number.isSafeInteger(m.date)||m.date<0||m.date*1000>time+60000||typeof m.text!=='string'||m.text.length>100)return 'INVALID_MESSAGE';
 return null;
}
// Shared stop mutation. Caller supplies validated authority/evidence and owns the transaction.
export function applySyntheticStopSemantics(db,at){
 if(!db.isTransaction)throw Error('STOP_TRANSACTION_REQUIRED');timestamp(at);
 db.prepare("UPDATE controls SET stopped=1,reason='Authenticated synthetic Telegram stop',updated_at=? WHERE singleton=1").run(at);
 journal(db,'TELEGRAM_STOP','system',{syntheticOnly:true});
}
export function handleSyntheticControl(db,update,at=now()){
 const time=timestamp(at);if(!Number.isSafeInteger(update?.update_id)||update.update_id<0)return{status:'INVALID_UPDATE'};
 return transaction(db,()=>{
  let paired;try{paired=binding(db);}catch{return{status:'UNPAIRED'};}
  const receiptId=`${paired.botId}:${update.update_id}`;
  if(getRecord(db,'telegram_control_receipt',receiptId))return{status:'DUPLICATE_UPDATE'};
  const finish=(status,extra={})=>{const result={status,...extra};putRecord(db,'telegram_control_receipt',receiptId,{...result,updateId:update.update_id,recordedAt:at,syntheticOnly:true},'confirmed');journal(db,'SYNTHETIC_CONTROL_OUTCOME',receiptId,result);return result;};
  const m=update.message;
  const rejection=controlMessageRejection(db,update,at);if(rejection)return finish(rejection);
  if(m.text==='/stop'){
   applySyntheticStopSemantics(db,at);return finish('STOPPED');
  }
  const match=/^\/(approve|reject) (qa-[a-z0-9-]{1,60})$/.exec(m.text);if(!match)return finish('INVALID_COMMAND');
  const r=getRecord(db,'telegram_review',match[2]);if(!r||r.syntheticOnly!==true)return finish('UNKNOWN_REVIEW');
  let b;try{b=syntheticBatch(db,r.batchId);}catch{return finish('STALE_REVIEW');}
  if(r.version!==b.version||r.hash!==b.hash||r.status==='INVALIDATED')return finish('STALE_REVIEW');
  if(time<timestamp(r.issuedAt)||time>=timestamp(r.expiresAt)||m.date<Math.floor(timestamp(r.issuedAt)/1000))return finish('EXPIRED_OR_STALE_MESSAGE');
  if(r.bindingHash!==digest(canonical(paired)))return finish('PAIRING_CHANGED');
  if(r.status!=='PENDING')return finish('DUPLICATE_ACTION');
  const c=controls(db);if(!c.stopped||c.launchAuthorized)return finish('BUSINESS_CONTROL_MISMATCH');
  const decision=match[1]==='approve'?'APPROVED':'REJECTED';
  const a=insertApproval(db,r.batchId,r.version,r.hash,decision,`telegram:${paired.botId}:${paired.userId}:${paired.chatId}`,r.expiresAt,at);
  putRecord(db,'telegram_review',r.id,{...r,status:decision,approvalId:a.id,decidedAt:at},'configuration');return finish(decision,{approvalId:a.id,batchId:r.batchId,version:r.version,hash:r.hash});
 });
}
