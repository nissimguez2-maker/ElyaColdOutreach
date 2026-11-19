// Content decisions only. Transport, callback acknowledgment and delivery recovery
// stay outside this transaction. No batch approval, provider or release interface.
import {randomBytes} from 'node:crypto';
import {canonical,digest,timestamp} from './values.mjs';
import {getRecord,putRecord,transaction,journal,controls,now} from './store.mjs';
import {isPairedSender,numericId,requireStopped} from './telegram-pairing.mjs';
import {decideWritingReview,evaluateWritingReview,writingApprovalExpiryAllowed} from './writing.mjs';
import {FIRST_TOUCH_CONTRACT,writingMode} from './writing-mode.mjs';

const actions=['APPROVED','REJECTED','REVISION_REQUESTED','DETAILS'];
const referencePattern=/^wr_[A-Za-z0-9_-]{22}$/;
const hash=value=>digest(canonical(value));
function binding(db){
 const b=getRecord(db,'telegram_binding','primary');
 if(b?.confirmed!==true||!numericId(b.userId)||!numericId(b.chatId)||!numericId(b.botId))throw Error('CONFIRMED_PAIRING_REQUIRED');
 return {userId:b.userId,chatId:b.chatId,botId:b.botId};
}
function packetNow(db,reviewId,packetHash,at){
 const p=getRecord(db,'writing_packet',packetHash),g=evaluateWritingReview(db,reviewId,null,at);
 if(!p||p.reviewId!==reviewId||g.packetHash!==packetHash||g.reasons.some(reason=>['WRITING_RELATIVE_YEAR_EXPIRED','WRITING_EVENT_FRESHNESS_EXPIRED'].includes(reason)))throw Error('STALE_REVIEW');
 return p;
}
function decisionsFor(db,packetHash){return db.prepare("SELECT data_json FROM records WHERE kind='writing_decision' AND json_extract(data_json,'$.packetHash')=?").all(packetHash).map(r=>JSON.parse(r.data_json));}
function expiryAllowed(packet,basis,issuedAt,expiresAt){
 const mode=writingMode(packet.spec);
 if(mode===FIRST_TOUCH_CONTRACT)return basis===(packet.synthetic?'EXPLICIT_SYNTHETIC_TEST':'APPROVED_CONTENT_POLICY')&&writingApprovalExpiryAllowed(packet.policy,issuedAt,expiresAt,mode);
 if(packet.synthetic)return basis==='EXPLICIT_SYNTHETIC_TEST';
 return basis==='APPROVED_CONTENT_POLICY'&&writingApprovalExpiryAllowed(packet.policy,issuedAt,expiresAt,mode);
}

/** Trusted local issuer. No default business expiry: real reviews require the
 * explicitly approved, campaign-specific policy captured in the writing packet. */
export function issueWritingTelegramReview(db,{id,reviewId,packetHash,expiresAt,at=now(),expiryBasis}){
 if(typeof id!=='string'||!/^[-a-zA-Z0-9_:]{1,80}$/.test(id))throw Error('INVALID_TELEGRAM_REVIEW_ID');
 const issued=timestamp(at),expires=timestamp(expiresAt);if(expires<=issued)throw Error('REVIEW_EXPIRY_REQUIRED');
 return transaction(db,()=>{
  const paired=binding(db),p=packetNow(db,reviewId,packetHash,at);if(p.synthetic)requireStopped(db);
  if(!expiryAllowed(p,expiryBasis,at,expiresAt))throw Error('POLICY_EXPIRY_UNRESOLVED');
  if(getRecord(db,'telegram_writing_review',id)||db.prepare("SELECT id FROM records WHERE kind='telegram_writing_review' AND json_extract(data_json,'$.packetHash')=?").get(packetHash)||decisionsFor(db,packetHash).length)throw Error('REVIEW_ALREADY_ISSUED_OR_DECIDED');
  const refs={};for(const action of actions){const ref='wr_'+randomBytes(16).toString('base64url');if(getRecord(db,'telegram_writing_action',ref))throw Error('CALLBACK_REFERENCE_COLLISION');refs[action]=ref;putRecord(db,'telegram_writing_action',ref,{telegramReviewId:id,action},'configuration');}
  const review={id,reviewId,packetHash,version:p.version,bindingHash:hash(paired),issuedAt:at,expiresAt,expiryBasis,status:'PENDING',messageId:null,actions:refs,acknowledgedFindings:[...new Set(p.findings.filter(f=>f.severity==='REVIEW').map(f=>f.code))].sort(),syntheticOnly:p.synthetic};
  putRecord(db,'telegram_writing_review',id,review,'configuration');journal(db,'TELEGRAM_WRITING_REVIEW_ISSUED',id,{reviewId,packetHash,version:p.version,syntheticOnly:p.synthetic});return review;
 });
}
/** Invoke only after matching sendMessage acceptance is validated by the adapter. */
export function bindWritingTelegramMessage(db,id,messageId,at=now()){
 if(!numericId(messageId))throw Error('INVALID_MESSAGE_ID');
 return transaction(db,()=>{
  const r=getRecord(db,'telegram_writing_review',id);if(r?.syntheticOnly)requireStopped(db);
  if(!r||r.bindingHash!==hash(binding(db)))throw Error('REVIEW_OR_PAIRING_MISMATCH');
  if(timestamp(at)<timestamp(r.issuedAt)||timestamp(at)>=timestamp(r.expiresAt))throw Error('REVIEW_EXPIRED');
  packetNow(db,r.reviewId,r.packetHash,at);
  if(r.messageId!==null){if(r.messageId!==messageId)throw Error('MESSAGE_ALREADY_BOUND');return r;}
  if(r.status!=='PENDING')throw Error('REVIEW_ALREADY_DECIDED');
  const next={...r,messageId};putRecord(db,'telegram_writing_review',id,next,'configuration');journal(db,'TELEGRAM_WRITING_MESSAGE_BOUND',id,{messageId});return next;
 });
}
const messages={
 APPROVED:'Content approval recorded. Contact holds and sending restrictions remain unchanged.',
 REJECTED:'Content rejected. Nothing has been released or sent.',
 REVISION_REQUESTED:'Changes requested. This content remains unapproved.',
 DETAILS:'Details requested. No approval recorded.',
 INVALID_UPDATE:'Invalid update. No decision recorded.',UNPAIRED:'Private pairing is required. No decision recorded.',
 UNAUTHORIZED:'This user or chat is not authorized. No decision recorded.',INVALID_CALLBACK:'Unrecognized button. No decision recorded.',
 MESSAGE_NOT_BOUND:'This review message is not confirmed. No decision recorded.',MESSAGE_MISMATCH:'This button does not belong to this review message.',
 PAIRING_CHANGED:'Pairing has changed. This review cannot be used.',EXPIRED_REVIEW:'This review has expired. No decision recorded.',
 STALE_REVIEW:'This review is out of date. No decision recorded.',DUPLICATE_UPDATE:'This update was already processed. No additional decision recorded.',
 DUPLICATE_CALLBACK:'This callback was already processed. No additional decision recorded.',ALREADY_DECIDED:'This content was already decided. No additional decision recorded.',
 CONFLICTING_DECISION:'This content already has a different decision. Request a new review.',REVOKED_OR_SUPERSEDED:'The prior decision was revoked or superseded. These buttons cannot revive it.',
 BUSINESS_CONTROL_MISMATCH:'The required stopped controls changed. No decision recorded.',CONTENT_BLOCKED:'Writing has a blocking issue. No approval recorded.',POLICY_EXPIRY_UNRESOLVED:'Approval-expiry policy is unresolved. No decision recorded.',INTEGRITY_MISMATCH:'This update conflicts with an existing receipt. No decision recorded.'
};
function result(status,extra={}){return {status,ackText:messages[status],...extra};}
function callbackIdValid(value){
 if(typeof value!=='string'||!/^[A-Za-z0-9_-]{1,128}$/.test(value))return false;
 try{canonical(value);return true;}catch{return false;}
}

/** Takes an update from the existing, authenticated Bot API consumer. An opaque
 * reference is lookup data, never authority. No untrusted payload is logged. */
export function handleWritingCallback(db,update,at=now()){
 const time=timestamp(at),q=update?.callback_query;
 const callbackId=callbackIdValid(q?.id)?q.id:null;
 if(!Number.isSafeInteger(update?.update_id)||update.update_id<0)return result('INVALID_UPDATE',{callbackId});
 return transaction(db,()=>{
  let paired;try{paired=binding(db);}catch{return result('UNPAIRED',{callbackId});}
  const receiptId=`${paired.botId}:${update.update_id}`,callbackKey=callbackId?`${paired.botId}-${digest(callbackId)}`:null;
  const priorReceipt=getRecord(db,'telegram_control_receipt',receiptId);
  if(priorReceipt){if(priorReceipt.updateHash&&priorReceipt.updateHash!==hash(update))return result('INTEGRITY_MISMATCH',{callbackId:null,receiptId});return result('DUPLICATE_UPDATE',{callbackId,receiptId,originalStatus:priorReceipt.status,...(priorReceipt.detailsRequested?{detailsRequested:true,telegramReviewId:priorReceipt.telegramReviewId}: {})});}
  const finish=(status,extra={})=>{
   const outcome=result(status,extra);
   let updateHash=null;try{updateHash=hash(update);}catch{/* Invalid payloads never enter stored evidence. */}
   putRecord(db,'telegram_control_receipt',receiptId,{...outcome,updateId:update.update_id,updateHash,recordedAt:at},'confirmed');
   if(callbackKey&&!getRecord(db,'telegram_callback_receipt',callbackKey))putRecord(db,'telegram_callback_receipt',callbackKey,{receiptId,status,recordedAt:at},'confirmed');
   journal(db,'TELEGRAM_WRITING_CONTROL_OUTCOME',receiptId,outcome);
   return {...outcome,callbackId,receiptId};
  };
  if(callbackKey&&getRecord(db,'telegram_callback_receipt',callbackKey))return finish('DUPLICATE_CALLBACK');
  if(!isPairedSender(db,{from:q?.from,chat:q?.message?.chat}))return finish('UNAUTHORIZED');
  const m=q.message;
  if(!callbackId||q.inline_message_id||update.message||update.edited_message||m.forward_origin||m.forward_date||m.sender_chat||m.via_bot||m.from?.id!==paired.botId||m.from?.is_bot!==true||!numericId(m.message_id)||!Number.isSafeInteger(m.date)||m.date<1||m.date*1000>time+60000||typeof q.data!=='string'||!referencePattern.test(q.data))return finish('INVALID_CALLBACK');
  const ref=getRecord(db,'telegram_writing_action',q.data),r=ref&&getRecord(db,'telegram_writing_review',ref.telegramReviewId);
  if(!r||!actions.includes(ref.action)||r.actions[ref.action]!==q.data||typeof r.syntheticOnly!=='boolean')return finish('INVALID_CALLBACK');
  if(r.bindingHash!==hash(paired))return finish('PAIRING_CHANGED');
  if(r.messageId===null)return finish('MESSAGE_NOT_BOUND');
  if(r.messageId!==m.message_id)return finish('MESSAGE_MISMATCH');
  if(time<timestamp(r.issuedAt)||time>=timestamp(r.expiresAt)||m.date<Math.floor(timestamp(r.issuedAt)/1000))return finish('EXPIRED_REVIEW');
  let p;try{p=packetNow(db,r.reviewId,r.packetHash,at);}catch{return finish('STALE_REVIEW');}
  if(p.synthetic!==r.syntheticOnly||!expiryAllowed(p,r.expiryBasis,r.issuedAt,r.expiresAt))return finish('POLICY_EXPIRY_UNRESOLVED');
  const prior=decisionsFor(db,r.packetHash),owned=r.decisionId?getRecord(db,'writing_decision',r.decisionId):null;
  if(prior.some(d=>['REVOKED','INVALIDATED'].includes(d.decision))||(r.decisionId&&(!owned||owned.decision!==r.status)))return finish('REVOKED_OR_SUPERSEDED');
  const fields={telegramReviewId:r.id,reviewId:r.reviewId,packetHash:r.packetHash};
  if(ref.action==='DETAILS')return finish('DETAILS',{...fields,detailsRequested:true});
  if(r.status!=='PENDING'||prior.length)return finish(r.status===ref.action?'ALREADY_DECIDED':'CONFLICTING_DECISION');
  const c=controls(db);if(p.synthetic&&(!c.stopped||c.launchAuthorized))return finish('BUSINESS_CONTROL_MISMATCH');
  if(ref.action==='APPROVED'&&p.findings.some(f=>f.severity==='BLOCK'))return finish('CONTENT_BLOCKED');
  const d=decideWritingReview(db,{actionId:`telegram-writing-${paired.botId}-${digest(callbackId)}`,reviewId:r.reviewId,packetHash:r.packetHash,decision:ref.action,actor:p.policy.approver,at,expiresAt:r.expiresAt,acknowledgedFindings:r.acknowledgedFindings});
  putRecord(db,'telegram_writing_review',r.id,{...r,status:ref.action,decisionId:d.id,decidedAt:at},'assessment');
  return finish(ref.action,{...fields,decisionId:d.id});
 });
}
