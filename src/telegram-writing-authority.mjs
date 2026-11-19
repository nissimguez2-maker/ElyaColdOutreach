// Local one-use test authority and shared Telegram consumption state. No transport.
import {canonical,digest,timestamp,required} from './values.mjs';
import {getRecord,putRecord,transaction,journal} from './store.mjs';
import {numericId,requireStopped} from './telegram-pairing.mjs';

export const WRITING_TEST_ID='telegram-writing-live-v1';
const grantKind='telegram_writing_authorization',ownerKind='telegram_consumer_owner';
const sha=/^[a-f0-9]{64}$/;
const caps={getMe:1,getWebhookInfo:1,initialMessages:4,detailsMessages:1,acknowledgments:5,polls:12,total:24};
const deadlines={totalMs:180000,apiMs:170000};
const actions=['DETAILS','APPROVED','APPROVED','REVISION_REQUESTED','REJECTED','STOP'];
const atomic=(db,fn)=>db.isTransaction?fn():transaction(db,fn);
const hash=value=>digest(canonical(value));
const safeReason=value=>typeof value==='string'&&/^[A-Z][A-Z0-9_]{0,99}$/.test(value)?value:'UNRESOLVED_LOCAL_FAILURE';
function storedPairing(db){const b=getRecord(db,'telegram_binding','primary');if(b?.confirmed!==true||!numericId(b.userId)||!numericId(b.chatId)||!numericId(b.botId))throw Error('PAIRING_REQUIRED');return {userId:b.userId,chatId:b.chatId,botId:b.botId};}
export function validateWritingTestContract(c){
 try{
  canonical(c);
  if(Object.keys(c).sort().join(',')!=='actions,caps,cardHash,deadlines,id,packetHash,packetVersion,pairing,sourceFingerprints'||c.id!==WRITING_TEST_ID||!sha.test(c.cardHash)||!sha.test(c.packetHash)||c.packetVersion!==1||canonical(c.caps)!==canonical(caps)||canonical(c.deadlines)!==canonical(deadlines)||canonical(c.actions)!==canonical(actions))throw Error();
  if(Object.keys(c.pairing).sort().join(',')!=='botId,chatId,userId'||Object.values(c.pairing).some(v=>!numericId(v)))throw Error();
  if(!c.sourceFingerprints||Array.isArray(c.sourceFingerprints)||!Object.keys(c.sourceFingerprints).length||Object.entries(c.sourceFingerprints).some(([key,value])=>!key.length||key.length>300||/[\r\n]/.test(key)||!sha.test(value)))throw Error();
 }catch{throw Error('WRITING_TEST_CONTRACT_INVALID');}
 return hash(c);
}
function legacyInactive(db){
 for(const row of db.prepare("SELECT data_json FROM records WHERE kind='telegram_live_test'").all()){const r=JSON.parse(row.data_json);if(r.status==='RUNNING'||r.pollingEnded===false)throw Error('LEGACY_CONSUMER_ACTIVE');}
 for(const row of db.prepare("SELECT data_json FROM records WHERE kind='telegram_pairing'").all()){const r=JSON.parse(row.data_json);if(!['ACK_CONFIRMED','ACK_UNCERTAIN','STOPPED'].includes(r.stage))throw Error('PAIRING_ACTIVE');}
}
/** Shared local ownership only. It does not establish absence of an external poller. */
export function assertNoActiveTelegramConsumer(db){
 const owner=getRecord(db,ownerKind,'primary');if(owner&&owner.status!=='RELEASED')throw Error('TELEGRAM_CONSUMER_BUSY');
 legacyInactive(db);
}
export function acquireTelegramConsumer(db,ownerId,at){
 required(ownerId);timestamp(at);
 return atomic(db,()=>{assertNoActiveTelegramConsumer(db);const owner={ownerId,status:'ACTIVE',acquiredAt:at,externalExclusivityProven:false};putRecord(db,ownerKind,'primary',owner,'configuration');journal(db,'TELEGRAM_CONSUMER_ACQUIRED',ownerId,{localOnly:true});return owner;});
}
export function releaseTelegramConsumer(db,ownerId,at){
 timestamp(at);return atomic(db,()=>{const owner=getRecord(db,ownerKind,'primary');if(owner?.ownerId!==ownerId)throw Error('CONSUMER_OWNER_MISMATCH');if(owner.status==='RELEASED')return owner;if(owner.status!=='ACTIVE')throw Error('CONSUMER_RECONCILIATION_REQUIRED');const next={...owner,status:'RELEASED',releasedAt:at};putRecord(db,ownerKind,'primary',next,'configuration');journal(db,'TELEGRAM_CONSUMER_RELEASED',ownerId,{});return next;});
}
/** Read only; retain old source records. No negative offset, drain or queue reset. */
export function inspectTelegramCursor(db){
 const candidates=[];
 const add=(kind,id,value)=>{if(!Number.isSafeInteger(value)||value<0)throw Error('TELEGRAM_CURSOR_UNRESOLVED');candidates.push({kind,id,nextOffset:value});};
 const current=getRecord(db,'telegram_writing_cursor','primary');if(current)add('telegram_writing_cursor','primary',current.nextOffset);
 for(const row of db.prepare("SELECT id,data_json FROM records WHERE kind='telegram_live_test'").all()){
  const r=JSON.parse(row.data_json);if(!Object.hasOwn(r,'offset'))continue;
  if(r.status==='RUNNING'||r.pollingEnded!==true)throw Error('TELEGRAM_CURSOR_UNRESOLVED');add('telegram_live_test',row.id,r.offset);
 }
 for(const row of db.prepare("SELECT id,data_json FROM records WHERE kind='telegram_pairing'").all()){
  const r=JSON.parse(row.data_json);if(!['ACK_CONFIRMED','ACK_UNCERTAIN','STOPPED'].includes(r.stage)||!Number.isSafeInteger(r.lastUpdateId)||r.lastUpdateId< -1)throw Error('TELEGRAM_CURSOR_UNRESOLVED');add('telegram_pairing',row.id,r.lastUpdateId+1);
 }
 if(!candidates.length)throw Error('TELEGRAM_CURSOR_UNRESOLVED');
 return {nextOffset:Math.max(...candidates.map(x=>x.nextOffset)),sources:candidates};
}
export function armWritingTest(db,contract,at){
 const contractHash=validateWritingTestContract(contract);timestamp(at);
 return transaction(db,()=>{requireStopped(db);if(canonical(storedPairing(db))!==canonical(contract.pairing))throw Error('PAIRING_MISMATCH');if(getRecord(db,grantKind,contract.id))throw Error('AUTHORIZATION_ALREADY_EXISTS');const grant={id:contract.id,status:'ARMED',contract,contractHash,armedAt:at,businessLaunchAuthorized:false};putRecord(db,grantKind,contract.id,grant,'configuration');journal(db,'WRITING_TEST_AUTHORIZATION_ARMED',contract.id,{contractHash});return grant;});
}
export function claimWritingTest(db,contract,at){
 try{
  const contractHash=validateWritingTestContract(contract),time=timestamp(at);
  return transaction(db,()=>{
   const grant=getRecord(db,grantKind,contract.id);if(!grant)throw Error('AUTHORIZATION_ABSENT');if(grant.status!=='ARMED')throw Error('AUTHORIZATION_NOT_ARMED');
   if(grant.contractHash!==contractHash||canonical(grant.contract)!==canonical(contract))throw Error('AUTHORIZATION_MISMATCH');
   requireStopped(db);if(canonical(storedPairing(db))!==canonical(contract.pairing))throw Error('PAIRING_MISMATCH');
   acquireTelegramConsumer(db,contract.id,at);const cursor=inspectTelegramCursor(db);
   const claim={id:contract.id,contractHash,pairing:contract.pairing,ownerId:contract.id,startedAt:at,deadline:new Date(time+180000).toISOString(),apiDeadline:new Date(time+170000).toISOString(),nextOffset:cursor.nextOffset};
   putRecord(db,'telegram_writing_cursor','primary',{nextOffset:cursor.nextOffset,sourceBasis:cursor.sources,recordedAt:at},'confirmed');
   putRecord(db,grantKind,contract.id,{...grant,status:'CLAIMED',claim},'configuration');journal(db,'WRITING_TEST_AUTHORIZATION_CLAIMED',contract.id,{contractHash,deadline:claim.deadline});return claim;
  });
 }catch(error){
  // A failed launch consumes only this pending authorization; another consumer is untouched.
  const grant=getRecord(db,grantKind,WRITING_TEST_ID);if(grant?.status==='ARMED')transaction(db,()=>{putRecord(db,grantKind,WRITING_TEST_ID,{...grant,status:'CLOSED',closedAt:at,reason:safeReason(error.message)},'configuration');journal(db,'WRITING_TEST_AUTHORIZATION_CLOSED',WRITING_TEST_ID,{reason:safeReason(error.message),beforeDispatch:true});});
  throw error;
 }
}
export function assertWritingTest(db,claim,at){
 const time=timestamp(at);requireStopped(db);const grant=getRecord(db,grantKind,claim?.id),owner=getRecord(db,ownerKind,'primary');
 if(!grant||grant.status!=='CLAIMED'||grant.contractHash!==claim.contractHash||hash(grant.contract)!==grant.contractHash||canonical(grant.claim)!==canonical(claim))throw Error('AUTHORIZATION_CLAIM_MISMATCH');
 if(owner?.ownerId!==claim.ownerId||owner.status!=='ACTIVE')throw Error('CONSUMER_OWNER_MISMATCH');
 if(canonical(storedPairing(db))!==canonical(claim.pairing))throw Error('PAIRING_MISMATCH');
 if(time<timestamp(claim.startedAt)||time>=timestamp(claim.deadline))throw Error('WRITING_TEST_DEADLINE');return grant;
}
export function closeWritingTest(db,claim,reason,at,{cleanupConfirmed=true}={}){
 if(typeof cleanupConfirmed!=='boolean')throw Error('CLEANUP_EVIDENCE_REQUIRED');
 timestamp(at);return transaction(db,()=>{const grant=getRecord(db,grantKind,claim?.id);if(!grant||grant.contractHash!==claim.contractHash||canonical(grant.claim)!==canonical(claim))throw Error('AUTHORIZATION_CLAIM_MISMATCH');if(grant.status==='CLOSED')return grant;if(grant.status!=='CLAIMED')throw Error('AUTHORIZATION_NOT_CLAIMED');
  const owner=getRecord(db,ownerKind,'primary');let cleanup='OWNER_MISMATCH_REQUIRES_RECONCILIATION';
  if(owner?.ownerId===claim.ownerId&&owner.status==='ACTIVE'){
   if(cleanupConfirmed){releaseTelegramConsumer(db,claim.ownerId,at);cleanup='LOCAL_OWNER_RELEASED';}
   else{putRecord(db,ownerKind,'primary',{...owner,status:'RECONCILIATION',observedAt:at},'configuration');cleanup='CLEANUP_UNCONFIRMED_REQUIRES_RECONCILIATION';}
  }
  const next={...grant,status:'CLOSED',reason:safeReason(reason),closedAt:at,cleanup};putRecord(db,grantKind,claim.id,next,'configuration');journal(db,'WRITING_TEST_AUTHORIZATION_CLOSED',claim.id,{reason:next.reason,cleanup});return next;
 });
}
/** No automatic owner stealing or replay after an abrupt process exit. */
export function recoverWritingTest(db,id,at){
 timestamp(at);return transaction(db,()=>{const grant=getRecord(db,grantKind,id);if(!grant||grant.status!=='CLAIMED')throw Error('NO_INTERRUPTED_WRITING_TEST');const next={...grant,status:'CLOSED',reason:'INTERRUPTED_REQUIRES_RECONCILIATION',closedAt:at};putRecord(db,grantKind,id,next,'configuration');const owner=getRecord(db,ownerKind,'primary');if(owner?.ownerId===id&&owner.status==='ACTIVE')putRecord(db,ownerKind,'primary',{...owner,status:'RECONCILIATION',observedAt:at},'configuration');journal(db,'WRITING_TEST_INTERRUPTED',id,{replayPermitted:false,ownerNotStolen:true});return next;});
}
const consumedStatuses=new Set(['APPROVED','REJECTED','REVISION_REQUESTED','DETAILS','ALREADY_DECIDED','CONFLICTING_DECISION','STOPPED','DUPLICATE_UPDATE','DUPLICATE_CALLBACK']);
/** Parent must classify the complete returned batch first; never call for unrelated data.
 * Exact update fingerprints distinguish replay from a changed update with the same ID.
 */
export function commitConsumedUpdate(db,claim,updateId,outcome,at){
 if(!Number.isSafeInteger(updateId)||updateId<0||!outcome||!consumedStatuses.has(outcome.status)||!sha.test(outcome.updateHash)||Object.keys(outcome).some(k=>!['status','updateHash'].includes(k)))throw Error('CONSUMED_UPDATE_SHAPE');
 return transaction(db,()=>{
  assertWritingTest(db,claim,at);const id=`${claim.pairing.botId}:${updateId}`,prior=getRecord(db,'telegram_writing_consumed',id),receipt=getRecord(db,'telegram_control_receipt',id),cursor=getRecord(db,'telegram_writing_cursor','primary');
  if(prior){if(prior.updateHash!==outcome.updateHash||prior.testId!==claim.id)throw Error('CONSUMED_UPDATE_MISMATCH');return {...prior,duplicate:true};}
  if(!cursor||updateId<cursor.nextOffset)throw Error('TELEGRAM_CURSOR_MISMATCH');
  if(receipt&&!(receipt.status==='STOPPED'&&outcome.status==='STOPPED'))throw Error('CONSUMED_UPDATE_REQUIRES_RECONCILIATION');
  const data={testId:claim.id,updateId,status:outcome.status,updateHash:outcome.updateHash,recordedAt:at,syntheticOnly:true};
  if(!receipt)putRecord(db,'telegram_control_receipt',id,data,'confirmed');
  putRecord(db,'telegram_writing_consumed',id,data,'confirmed');putRecord(db,'telegram_writing_cursor','primary',{...cursor,nextOffset:updateId+1,recordedAt:at},'confirmed');journal(db,'WRITING_TEST_UPDATE_CONSUMED',id,{testId:claim.id,status:outcome.status});return data;
 });
}
