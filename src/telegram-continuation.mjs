import {getRecord,putRecord,transaction,journal} from './store.mjs';
import {latestBatch,hashBatch,insertBatch} from './batches.mjs';
import {canonical,digest,timestamp} from './values.mjs';
import {syntheticContent} from './telegram-decisions.mjs';
import {pinnedBinding,verifyApprovedProposal} from './telegram-review-checks.mjs';
import {APPROVED_BATCH_ID,APPROVED_HASHES} from './telegram-live-contract.mjs';
import {assertNoActiveTelegramConsumer} from './telegram-writing-authority.mjs';
export const CONTINUATION_ID='synthetic-live-01-cont1';
export const CONTINUATION_REVIEW_ID='qa-tg-01-v1-cont1';
const SOURCE='synthetic-live-01',OLD_REVIEW='qa-tg-01-v1';

/** Narrow, once-only permission from the user's approved continuation; no generic reset. */
export function validateContinuation(db,at){
 const current=timestamp(at),paired=pinnedBinding(db),approvedHashes=verifyApprovedProposal(db);
 if(getRecord(db,'telegram_live_test',CONTINUATION_ID)||getRecord(db,'telegram_review',CONTINUATION_REVIEW_ID)||getRecord(db,'telegram_review','qa-tg-01-v2'))throw Error('CONTINUATION_ALREADY_CLAIMED_OR_STATE_CHANGED');
 const s=getRecord(db,'telegram_live_test',SOURCE),e=getRecord(db,'telegram_send_evidence',`${SOURCE}-v1`),seen=getRecord(db,'telegram_delivery_observation',`${SOURCE}-v1`),old=getRecord(db,'telegram_review',OLD_REVIEW),b=latestBatch(db,APPROVED_BATCH_ID);
 const fingerprint=digest(canonical({userId:paired.userId,chatId:paired.chatId,botId:paired.botId}));
 if(s?.status!=='STOPPED_INCOMPLETE'||s.phase!=='WAIT_APPROVE_V1'||s.errorCode!=='TELEGRAM_NETWORK_UNCERTAIN'||s.pollingEnded!==true||s.messages?.length!==2||s.messages[0].status!=='API_CONFIRMED'||s.messages[0].messageId!==4||s.messages[1].status!=='NOT_SENT'||s.commands?.length!==0||!Number.isSafeInteger(s.offset)||s.offset<0||e?.messageId!==4||e.apiAcceptance!=='API_CONFIRMED'||e.packetHash!==APPROVED_HASHES[0]||e.mustNotResend!==true||seen?.messageId!==4||seen.userReportedExactPacketReceived!==true)throw Error('CONTINUATION_DELIVERY_EVIDENCE_MISMATCH');
 if(!b||b.version!==1||b.hash!==APPROVED_HASHES[0]||hashBatch(JSON.parse(b.content_json))!==b.hash||old?.status!=='PENDING'||old.version!==1||old.hash!==b.hash||old.bindingHash!==fingerprint||timestamp(old.expiresAt)>current||db.prepare('SELECT id FROM approvals WHERE batch_id=? LIMIT 1').get(APPROVED_BATCH_ID))throw Error('CONTINUATION_REVIEW_OR_BATCH_MISMATCH');
 return {sourceId:SOURCE,sourceMessageId:4,sourceSnapshotHash:digest(canonical(s)),sourceReviewId:OLD_REVIEW,sourceReviewHash:digest(canonical(old)),offset:s.offset,approvedHashes};
}
export function claimContinuation(db,state,at){
 return transaction(db,()=>{
  assertNoActiveTelegramConsumer(db);
  const source=validateContinuation(db,at);if(state.sourceSnapshotHash!==source.sourceSnapshotHash||state.sourceReviewHash!==source.sourceReviewHash)throw Error('CONTINUATION_SOURCE_CHANGED');
  if(timestamp(state.deadline)<=timestamp(at)||timestamp(state.deadline)-timestamp(at)>180000)throw Error('CONTINUATION_DEADLINE');
  const old=getRecord(db,'telegram_review',OLD_REVIEW);
  const review={id:CONTINUATION_REVIEW_ID,batchId:APPROVED_BATCH_ID,version:1,hash:APPROVED_HASHES[0],bindingHash:old.bindingHash,issuedAt:at,expiresAt:state.deadline,status:'PENDING',syntheticOnly:true,continuationOf:OLD_REVIEW,approvalBasis:'User-approved three-minute continuation'};
  putRecord(db,'telegram_review',review.id,review,'configuration');putRecord(db,'telegram_live_test',CONTINUATION_ID,state,'configuration');journal(db,'SYNTHETIC_CONTINUATION_CLAIMED',CONTINUATION_ID,{sourceMessageId:4,sourceSnapshotHash:source.sourceSnapshotHash,deadline:state.deadline,reviewId:review.id});
 });
}
export function advanceContinuationRevision(db){
 return transaction(db,()=>{
  pinnedBinding(db);const state=getRecord(db,'telegram_live_test',CONTINUATION_ID),review=getRecord(db,'telegram_review',CONTINUATION_REVIEW_ID),b=latestBatch(db,APPROVED_BATCH_ID);
  if(state?.status!=='RUNNING'||b?.version!==1||b.hash!==APPROVED_HASHES[0]||review?.status!=='APPROVED')throw Error('CONTINUATION_REVISION_NOT_READY');
  const result=insertBatch(db,APPROVED_BATCH_ID,syntheticContent(2));if(result.version!==2||result.hash!==APPROVED_HASHES[1])throw Error('APPROVED_PROPOSAL_MISMATCH');
  putRecord(db,'telegram_review',CONTINUATION_REVIEW_ID,{...review,status:'INVALIDATED'},'configuration');return result;
 });
}
