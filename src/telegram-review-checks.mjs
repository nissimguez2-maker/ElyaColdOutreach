import {openStore,putRecord,getRecord} from './store.mjs';
import {latestBatch} from './batches.mjs';
import {createSyntheticBatch,issueSyntheticReview,syntheticReviewText} from './telegram-decisions.mjs';
import {requireStopped,numericId} from './telegram-pairing.mjs';
import {APPROVED_USER_ID,APPROVED_CHAT_ID,APPROVED_BATCH_ID,APPROVED_HASHES,APPROVED_PACKETS} from './telegram-live-contract.mjs';
export function pinnedBinding(db){requireStopped(db);const b=getRecord(db,'telegram_binding','primary');if(!b?.confirmed||b.userId!==APPROVED_USER_ID||b.chatId!==APPROVED_CHAT_ID||!numericId(b.botId))throw Error('PAIRING_MISMATCH');return b;}
export function exactPacket(db,version){const b=latestBatch(db,APPROVED_BATCH_ID);if(b?.version!==version||b.hash!==APPROVED_HASHES[version-1]||syntheticReviewText(db,`qa-tg-01-v${version}`)!==APPROVED_PACKETS[version-1])throw Error('APPROVED_PROPOSAL_MISMATCH');}
export function verifyApprovedProposal(db){
 const paired=pinnedBinding(db),scratch=openStore(':memory:');
 try{
  putRecord(scratch,'telegram_binding','primary',paired,'configuration');
  for(const [kind,id] of [['candidate','SYNTHETIC-QA-ONLY'],['contact','qa@example.invalid']]){const r=getRecord(db,kind,id);if(r)putRecord(scratch,kind,id,r,'configuration');}
  const hashes=[];for(const v of [1,2]){createSyntheticBatch(scratch,APPROVED_BATCH_ID,v);issueSyntheticReview(scratch,`qa-tg-01-v${v}`,APPROVED_BATCH_ID,'2026-11-16T17:05:00Z','2026-11-16T17:00:00Z');exactPacket(scratch,v);hashes.push(latestBatch(scratch,APPROVED_BATCH_ID).hash);}return hashes;
 }finally{scratch.close();}
}
