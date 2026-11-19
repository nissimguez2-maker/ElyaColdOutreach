// One approved acceptance session. No authority issuance, credential discovery,
// scheduler, retries, queue drain, real content decisions, or campaign operation.
import {performance} from 'node:perf_hooks';
import {canonical,digest,timestamp} from './values.mjs';
import {getRecord,putRecord,transaction,journal,controls} from './store.mjs';
import {requireStopped,isPairedSender} from './telegram-pairing.mjs';
import {controlMessageRejection,handleSyntheticControl} from './telegram-decisions.mjs';
import {acquireTelegramConsumer,releaseTelegramConsumer} from './telegram-writing-authority.mjs';
import {prepareWritingReview,evaluateWritingReview,reviewVariables} from './writing.mjs';
import {issueWritingTelegramReview,handleWritingCallback} from './telegram-writing-decisions.mjs';
import {renderTelegramWritingReview} from './telegram-writing-render.mjs';
import {bindLiveSyntheticWritingAdapter} from './telegram-writing-adapter.mjs';
import {acceptanceTarget,nextAcceptanceAction,acceptanceOutcome} from './acceptance-guidance.mjs';

const hash=value=>digest(canonical(value));
const safe=error=>/^[A-Z][A-Z0-9_]{0,99}$/.test(error?.message??'')?error.message:'ACCEPTANCE_LOCAL_FAILURE';
const CAPS={identity:1,webhook:1,preflight:1,prefixAcknowledgment:1,initialMessages:12,detailsMessages:0,acknowledgments:6,normalPolls:17};
const TARGET={botId:9077316901,botUsername:'ElyaColdBot',userId:8473827686,chatId:8473827686};
const INITIAL=64381638,BOUNDARY=64381642;
function validateManifest(m){
 const t=m?.telegram;
 if(m?.id!=='elya-acceptance-manifest-v1'||!t||Object.entries(TARGET).some(([k,v])=>t[k]!==v)||t.initialLocalOffset!==INITIAL||t.proposedHistoricalPrefixOffset!==BOUNDARY||t.maxObservableRequests!==40||t.totalMs!==600000||t.apiDeadlineMs!==580000||t.maxInitialMessages!==12||t.maxCallbackAcknowledgments!==6||t.maxNormalPollsIncludingClosure!==17||t.noAllowedUpdatesChange!==true||t.noResend!==true||canonical(t.preflightArguments)!==canonical({timeout:0,limit:100})||canonical(t.prefixAcknowledgmentArguments)!==canonical({offset:BOUNDARY,timeout:0,limit:100}))throw Error('ACCEPTANCE_MANIFEST_MISMATCH');
}
function body(step,revision=false){return `Hi QA team,\n\nSynthetic step ${step}: café, equipment & catering; the owner's checklist.${revision?'\n\nRevision 2.':''}\n\nTEST ONLY. No real-business approval or sending is authorized.\n\nDaniel Rosen\nHead of Operations and Underwriting\nElya Partners`;}
function seed(db,pair,at){
 if(db.prepare('SELECT count(*) n FROM records').get().n!==0)throw Error('EMPTY_SYNTHETIC_DATABASE_REQUIRED');
 const campaignId='qa-acceptance-campaign';
 putRecord(db,'telegram_binding','primary',{confirmed:true,testOnly:true,userId:pair.userId,chatId:pair.chatId,botId:pair.botId});
 putRecord(db,'campaign',campaignId,{purpose:'synthetic_qa',mustRemainInactive:true});
 putRecord(db,'writing_policy',campaignId,{revision:'acceptance-fixture-v1',sender:{name:'Daniel Rosen',title:'Head of Operations and Underwriting',company:'Elya Partners'},approver:'Daniel Rosen',sequence:{steps:3,cadenceApproved:false,endpointApproved:false},physicalAddressApproved:false,optOutApproved:false,synthetic:true});
 putRecord(db,'writing_evidence','acceptance-context',{text:'The synthetic café offers catering.',observedAt:at});
 putRecord(db,'operational_policy','acceptance-freshness',{emailVerification:{daysBeforeFirstRelease:14},contactRoleAttribution:{meaningfulCorroborationDays:90},operatingStatus:{daysBeforeFirstRelease:30},personalization:{timelyEventDays:90,ongoingOrFutureStatusCheckDays:30}});
 putRecord(db,'settings','current-contact-freshness',{policyKind:'operational_policy',revision:'acceptance-freshness'});
 for(const [key,email]of [['A','qa@example.invalid'],['B','qa-reject@example.invalid']]){
  const candidateId=`synthetic-acceptance-${key}`;
  putRecord(db,'candidate',candidateId,{name:`Synthetic Acceptance ${key}`,qualification:'QUALIFIED',synthetic:true,operatingStatusCheckedAt:at});
  putRecord(db,'contact',email,{candidateId,email,attribution:'Synthetic shared inbox',attributionClass:'GROUP_SHARED',verification:'CATCH_ALL',verifiedAt:at,attributionCorroboratedAt:at,suppressed:null});
  putRecord(db,'refinement_current',candidateId,{semanticHash:'fixture-v1',disposition:'QUALIFIED_FOR_REVIEW'});putRecord(db,'refinement_assessment',candidateId+':fixture-v1',{businessFit:{state:'PASS'},contacts:[]});
 }
}
function packet(db,key,version,at){
 // Revision writes and the invalidation performed by prepareWritingReview commit
 // together. The former approval can never revive if values are later restored.
 return transaction(db,()=>{
  const candidateId=`synthetic-acceptance-${key}`,email=key==='A'?'qa@example.invalid':'qa-reject@example.invalid',draftIds=[];
  for(let step=1;step<=3;step++){
   const id=`${candidateId}:v${version}:step${step}`;draftIds.push(id);
   putRecord(db,'draft',id,{candidateId,email,version,step,status:'UNAPPROVED',subject:`SYNTHETIC QA — ${key==='A'?'Acceptance':'Rejection'} v${version} — Step ${step}`,body:body(step,key==='A'&&version===2&&step===1)});
  }
  return prepareWritingReview(db,{reviewId:`qa-acceptance-${key}`,campaignId:'qa-acceptance-campaign',candidateId,email,draftIds,asOf:at,synthetic:true,recipient:{class:'GROUP_SHARED',greeting:'Hi QA team,'},facts:[{id:'catering',text:'Synthetic catering context',source:{kind:'writing_evidence',id:'acceptance-context',pointer:'/text',excerpt:'offers catering'},usage:'CONTEXT',eventDate:null}],salesHypotheses:['Synthetic test only; no real financing need.'],unknowns:['No real recipient or operating business.'],steps:draftIds.map(draftId=>({draftId,factIds:['catering'],angle:'Synthetic acceptance',findings:[{code:'FIXTURE_CAUTION',severity:'REVIEW',detail:'Synthetic wording only; no outreach authorization.'}]}))});
 });
}
function checkedUpdates(updates){
 if(!Array.isArray(updates)||updates.length>=100)throw Error('QUEUE_MAY_BE_TRUNCATED');const seen=new Set();
 for(const u of updates){if(!Number.isSafeInteger(u?.update_id)||u.update_id<0||seen.has(u.update_id))throw Error('INVALID_UPDATE_RESPONSE');seen.add(u.update_id);}
 return [...updates].sort((a,b)=>a.update_id-b.update_id);
}
function authenticatedCallback(db,u,pair,at){
 const q=u.callback_query,m=q?.message;
 return !!q&&isPairedSender(db,{from:q.from,chat:m?.chat})&&typeof q.id==='string'&&/^[A-Za-z0-9_-]{1,128}$/.test(q.id)&&!q.inline_message_id&&!u.message&&!u.edited_message&&!m.forward_origin&&!m.forward_date&&!m.sender_chat&&!m.via_bot&&m.from?.id===pair.botId&&m.from?.is_bot===true&&Number.isSafeInteger(m.message_id)&&m.message_id>0&&Number.isSafeInteger(m.date)&&m.date>0&&m.date*1000<=timestamp(at)+60000;
}
function historical(db,legacyDb,manifest,u,pair,at){
 if(u.update_id===64381640){
  const r=getRecord(db,'telegram_control_receipt',`${pair.botId}:64381640`);
  if(controlMessageRejection(db,u,at)!==null||u.callback_query||u.message.text!=='/stop'||u.message.message_id!==14||u.message.date!==1794865906||r?.status!=='STOPPED'||r.rawUpdateAvailable!==false||r.provenance!=='INSPECTION_SUMMARY_RECONCILIATION'||r.messageId!==14||r.messageTimestamp!==manifest.telegram.knownStop.messageTimestamp||r.recordedAt!==manifest.telegram.knownStop.recordedAt)throw Error('HISTORICAL_STOP_MISMATCH');
  return {updateId:u.update_id,updateHash:hash(u),sourceReceiptHash:hash(r),disposition:'HISTORICAL_STOP_RETIRED_WITHOUT_REEXECUTION'};
 }
 if(u.update_id===64381641){
  const q=u.callback_query,r=getRecord(legacyDb,'telegram_control_receipt',`${pair.botId}:64381641`),ref=typeof q?.data==='string'?getRecord(legacyDb,'telegram_writing_action',q.data):null,review=ref&&getRecord(legacyDb,'telegram_writing_review',ref.telegramReviewId),callback=typeof q?.id==='string'?getRecord(legacyDb,'telegram_callback_receipt',`${pair.botId}-${digest(q.id)}`):null,demonstration=getRecord(db,'telegram_details_test','telegram-details-only-v1');
  if(!authenticatedCallback(db,u,pair,at)||q.message.message_id!==15||ref?.action!=='DETAILS'||review?.actions?.DETAILS!==q.data||review.messageId!==15||review.packetHash!==manifest.telegram.knownDetails.packetHash||review.bindingHash!==hash({userId:pair.userId,chatId:pair.chatId,botId:pair.botId})||q.message.date<Math.floor(timestamp(review.issuedAt)/1000)||r?.status!=='DETAILS'||r.packetHash!==review.packetHash||r.telegramReviewId!==review.id||callback?.status!=='DETAILS'||callback.receiptId!==`${pair.botId}:64381641`||demonstration?.status!=='COMPLETE'||demonstration.acknowledgment?.status!=='API_CONFIRMED'||demonstration.acknowledgment.updateId!==64381641||demonstration.detailsDelivery?.status!=='API_CONFIRMED'||demonstration.detailsDelivery.messageId!==16||demonstration.cleanup?.confirmed!==true)throw Error('HISTORICAL_DETAILS_MISMATCH');
  return {updateId:u.update_id,updateHash:hash(u),sourceReceiptHash:hash(r),disposition:'HISTORICAL_DETAILS_RETIRED_WITHOUT_REEXECUTION'};
 }
 throw Error('UNKNOWN_PREFLIGHT_UPDATE');
}

export async function runAcceptanceTelegram({db,syntheticDb,legacyDb,manifest,loadToken,makeApi,assertAuthority,startedMono,startedWall,emit=()=>{},clock=()=>performance.now(),sleep}){
 const start=startedMono??clock(),wall=typeof startedWall==='string'?timestamp(startedWall):startedWall??Date.now(),iso=()=>new Date(wall+Math.floor(clock()-start)).toISOString();
 const result={id:manifest?.id??'invalid',status:'BLOCKED',reason:null,startedAt:iso(),attempts:[],counts:Object.fromEntries(Object.keys(CAPS).map(k=>[k,0])),scenarios:{a1Approval:{status:'PENDING'},a1InvalidationAndStale:{status:'PENDING'},a2Changes:{status:'PENDING'},b1Rejection:{status:'PENDING'}},observations:[],operatorEvents:[],prefixAcknowledgment:{status:'NOT_ATTEMPTED',offset:BOUNDARY},closure:{status:'NOT_ATTEMPTED'},remoteAcknowledgment:{lastSubmittedOffset:null,lastApiConfirmedOffset:null,status:'NOT_ATTEMPTED'},stopReceived:false,cleanup:null};
 let owned=false,recorded=false,api=null,permit=null,communicationStopped=false,credentialCleanup=true,initialCursor=null,expectedPages=[],a1=null,a2=null,b1=null,revisionCreated=false;
 const ownerId=`${manifest?.id}:telegram`,pair={userId:TARGET.userId,chatId:TARGET.chatId,botId:TARGET.botId};
 const save=()=>{if(recorded)putRecord(db,'acceptance_telegram',manifest.id,result,'confirmed');};
 const remaining=()=>Math.floor(580000-(clock()-start));
 const targets={};
 const steps=[{key:'a1Approval',target:'qa-acceptance-A-v1',action:'APPROVED',expectedResult:'APPROVED'},{key:'a1InvalidationAndStale',target:'qa-acceptance-A-v1',action:'APPROVED',expectedResult:'STALE_REVIEW'},{key:'a2Changes',target:'qa-acceptance-A-v2',action:'REVISION_REQUESTED',expectedResult:'REVISION_REQUESTED'},{key:'b1Rejection',target:'qa-acceptance-B-v1',action:'REJECTED',expectedResult:'REJECTED'}];
 const operatorEvent=event=>{const saved={...event,recordedAt:iso()};result.operatorEvents.push(saved);save();emit(saved);};
 const promptNext=()=>{const event=nextAcceptanceAction(steps,result.scenarios,targets,{workingPollsRemaining:Math.max(0,16-result.counts.normalPolls),apiSecondsRemaining:Math.max(0,Math.floor(remaining()/1000))});if(event)operatorEvent(event);};
 const active=()=>{
  if(typeof assertAuthority!=='function'||assertAuthority()!==true)throw Error('ACCEPTANCE_AUTHORITY_REQUIRED');
  requireStopped(db);requireStopped(syntheticDb);if(communicationStopped)throw Error('TELEGRAM_COMMUNICATION_STOPPED');if(remaining()<=0)throw Error('TELEGRAM_ACCEPTANCE_API_DEADLINE');
  const current=getRecord(db,'telegram_binding','primary');if(current?.confirmed!==true||['userId','chatId','botId'].some(k=>current[k]!==pair[k]))throw Error('PAIRING_MISMATCH');
  if(owned){const owner=getRecord(db,'telegram_consumer_owner','primary');if(owner?.ownerId!==ownerId||owner.status!=='ACTIVE')throw Error('CONSUMER_OWNER_MISMATCH');}
 };
 const guard=(method,wireBody,ms)=>{
  active();if(!permit||permit.method!==method||permit.bodyHash!==hash(wireBody)||result.attempts.length>=40||result.counts[permit.kind]>=CAPS[permit.kind])throw Error('ACCEPTANCE_WIRE_REQUEST_DENIED');
  const {kind,bodyHash}=permit;permit=null;result.counts[kind]++;result.attempts.push({method,kind,requestHash:bodyHash,status:'ATTEMPTED',at:iso(),...(Object.hasOwn(wireBody,'offset')?{offset:wireBody.offset}: {})});
  if(method==='getUpdates'&&Object.hasOwn(wireBody,'offset'))result.remoteAcknowledgment={...result.remoteAcknowledgment,lastSubmittedOffset:wireBody.offset,status:'SUBMITTED'};save();return Math.min(ms,remaining(),25000);
 };
 const invoke=async(kind,method,wireBody,fn,requestMs=25000)=>{
  active();if(result.attempts.length>=40||result.counts[kind]>=CAPS[kind])throw Error('ACCEPTANCE_REQUEST_BUDGET_EXHAUSTED');
  const ms=Math.min(requestMs,remaining(),25000);if(ms<=0)throw Error('TELEGRAM_ACCEPTANCE_API_DEADLINE');const index=result.attempts.length;permit={kind,method,bodyHash:hash(wireBody)};
  try{const value=await fn(ms);if(permit||result.attempts.length!==index+1)throw Error('ACCEPTANCE_TRANSPORT_GUARD_BYPASSED');permit=null;const attempt=result.attempts[index];attempt.status='API_RETURNED';attempt.finishedAt=iso();if(method==='sendMessage'&&Number.isSafeInteger(value?.message_id))attempt.returnedMessageId=value.message_id;if(method==='getUpdates'&&Object.hasOwn(wireBody,'offset'))result.remoteAcknowledgment={lastSubmittedOffset:wireBody.offset,lastApiConfirmedOffset:wireBody.offset,status:'API_CONFIRMED'};save();active();return value;}
  catch(error){permit=null;const attempt=result.attempts[index];if(attempt){const returned=attempt.status==='API_RETURNED';attempt.status=returned?'RETURNED_AFTER_CUTOFF':'FAILED_OR_UNCERTAIN';attempt.reason=safe(error);if(!returned&&method==='getUpdates'&&Object.hasOwn(wireBody,'offset'))result.remoteAcknowledgment.status='UNCERTAIN';}save();throw error;}
 };
 const exactShortPoll=kind=>invoke(kind,'getUpdates',{offset:BOUNDARY,timeout:0,limit:100},ms=>api.poll(BOUNDARY,ms),2000);
 const observeUpdate=(u,phase,source=syntheticDb)=>{
  const q=u.callback_query,m=q?.message??u.message,ref=typeof q?.data==='string'?getRecord(source,'telegram_writing_action',q.data):null,review=ref&&getRecord(source,'telegram_writing_review',ref.telegramReviewId),current=review?.reviewId?getRecord(source,'writing_current',review.reviewId):null;
  const observation={event:'UPDATE_CLASSIFICATION',phase,updateId:u.update_id,type:q?'CALLBACK_QUERY':u.message?'MESSAGE':'UNKNOWN',messageId:Number.isSafeInteger(m?.message_id)?m.message_id:null,actorMatch:(q?.from??m?.from)?.id===pair.userId&&(q?.from??m?.from)?.is_bot===false,chatMatch:m?.chat?.id===pair.chatId&&m?.chat?.type==='private',observedAction:ref?.action??(u.message?.text==='/stop'?'STOP':'UNKNOWN'),messageBindingMatch:review?review.messageId===m?.message_id:null,packetVersion:Number.isSafeInteger(review?.version)?review.version:null,currentPacketVersionMatch:current?current.packetHash===review.packetHash&&current.version===review.version:null,disposition:'LEFT_PENDING'};
  result.observations.push(observation);save();return observation;
 };
 const recordStop=entry=>{
  const outcome=handleSyntheticControl(db,entry,iso());if(outcome.status!=='STOPPED')throw Error('STOP_HANDLER_REJECTED');
  result.status='BLOCKED';result.stopReceived=true;result.reason='AUTHENTICATED_STOP';result.observations.push({updateId:entry.update_id,action:'STOP',status:'STOPPED',disposition:'LOCAL_STOP_RECORDED_REMOTE_PENDING'});communicationStopped=true;save();
 };
 const classifySession=(updates,phase='SESSION')=>{
  let expected=getRecord(db,'telegram_writing_cursor','primary').nextOffset;
  return checkedUpdates(updates).map(u=>{
   const observation=observeUpdate(u,phase),updateHash=hash(u),receipt=getRecord(db,'telegram_control_receipt',`${pair.botId}:${u.update_id}`);
   if(u.update_id<BOUNDARY)throw Error('HISTORICAL_UPDATE_AFTER_PREFIX_ACK');
   if(receipt){if(receipt.testId!==manifest.id||receipt.updateHash!==updateHash)throw Error('SESSION_RECEIPT_MISMATCH');observation.disposition='EXACT_DUPLICATE_NO_REPLAY';save();return {u,updateHash,duplicate:true,observation};}
   if(u.update_id!==expected)throw Error('SESSION_UPDATE_GAP');expected++;
   if(u.message?.text==='/stop'&&controlMessageRejection(db,u,iso())===null)return {u,updateHash,action:'STOP',observation};
   const q=u.callback_query,ref=typeof q?.data==='string'?getRecord(syntheticDb,'telegram_writing_action',q.data):null,review=ref&&getRecord(syntheticDb,'telegram_writing_review',ref.telegramReviewId);
   if(!authenticatedCallback(db,u,pair,iso())||!review||![a1?.id,a2?.id,b1?.id].includes(review.id)||review.messageId!==q.message.message_id||review.actions[ref.action]!==q.data||q.message.date<Math.floor(timestamp(review.issuedAt)/1000))throw Error('UNRELATED_SESSION_UPDATE');
   observation.disposition='BOUND_SESSION_UPDATE_AWAITING_HANDLER';save();return {u,updateHash,action:ref.action,review,observation};
  });
 };
 const commitReceipt=(entry,outcome)=>transaction(db,()=>{
  const saved=getRecord(syntheticDb,'telegram_control_receipt',`${pair.botId}:${entry.u.update_id}`);if(!saved||saved.updateHash!==entry.updateHash)throw Error('SYNTHETIC_RECEIPT_MISSING');
  const current=getRecord(db,'telegram_writing_cursor','primary');if(current.nextOffset!==entry.u.update_id)throw Error('SESSION_CURSOR_MISMATCH');
  putRecord(db,'telegram_control_receipt',`${pair.botId}:${entry.u.update_id}`,{testId:manifest.id,updateId:entry.u.update_id,updateHash:entry.updateHash,status:outcome.status,contentStore:'ISOLATED_SYNTHETIC',recordedAt:iso()},'confirmed');
  putRecord(db,'telegram_writing_cursor','primary',{...current,nextOffset:entry.u.update_id+1,recordedAt:iso()},'confirmed');
 });
 const acknowledge=async outcome=>{
  if(typeof outcome.callbackId!=='string')throw Error('CALLBACK_ACK_ID_MISSING');const id=digest(outcome.callbackId),prior=getRecord(syntheticDb,'telegram_callback_response',id);if(prior){if(prior.status==='API_CONFIRMED')return;throw Error('CALLBACK_RESPONSE_ALREADY_ATTEMPTED');}
  const text=outcome.detailsRequested?'Details are omitted from this acceptance session. No content decision recorded.':outcome.ackText;
  putRecord(syntheticDb,'telegram_callback_response',id,{status:'DISPATCH_INTENT',outcome:outcome.status,at:iso()},'confirmed');
  try{const accepted=await invoke('acknowledgments','answerCallbackQuery',{callback_query_id:outcome.callbackId,text,show_alert:false,cache_time:0},ms=>api.answerCallback(outcome.callbackId,text,ms));if(accepted!==true)throw Error('CALLBACK_ACK_UNCERTAIN');putRecord(syntheticDb,'telegram_callback_response',id,{status:'API_CONFIRMED',outcome:outcome.status,at:iso()},'confirmed');}
  catch(error){putRecord(syntheticDb,'telegram_callback_response',id,{status:'UNCERTAIN',outcome:outcome.status,mustNotResend:true,at:iso()},'confirmed');throw error;}
 };
 const scopedOutcome=entry=>{
  const permitted=entry.action==='DETAILS'||entry.review.id===a1?.id&&entry.action==='APPROVED'||entry.review.id===a2?.id&&entry.action==='REVISION_REQUESTED'||entry.review.id===b1?.id&&entry.action==='REJECTED';
  if(permitted)return handleWritingCallback(syntheticDb,entry.u,iso());
  return transaction(syntheticDb,()=>{
   const callbackId=entry.u.callback_query.id,id=`${pair.botId}:${entry.u.update_id}`,callbackKey=`${pair.botId}-${digest(callbackId)}`;
   const outcome={status:'ACTION_OUTSIDE_ACCEPTANCE_SCOPE',ackText:'This button is outside this acceptance scenario. No content decision recorded.'};
   putRecord(syntheticDb,'telegram_control_receipt',id,{...outcome,updateId:entry.u.update_id,updateHash:entry.updateHash,recordedAt:iso()},'confirmed');
   if(!getRecord(syntheticDb,'telegram_callback_receipt',callbackKey))putRecord(syntheticDb,'telegram_callback_receipt',callbackKey,{receiptId:id,status:outcome.status,recordedAt:iso()},'confirmed');
   return {...outcome,callbackId};
  });
 };
 let adapter;
 const deliver=async p=>{
  const r=issueWritingTelegramReview(syntheticDb,{id:`${p.reviewId}-v${p.version}`,reviewId:p.reviewId,packetHash:p.hash,at:iso(),expiresAt:new Date(wall+580000).toISOString(),expiryBasis:'EXPLICIT_SYNTHETIC_TEST'});
  const rendered=renderTelegramWritingReview(syntheticDb,p,{review:r,at:iso()});expectedPages=rendered.pages.map(hash);
  const sent=await adapter.deliver(r.id,Math.min(300000,remaining()),iso());if(sent.status!=='API_CONFIRMED')throw Error(result.attempts.find(a=>a.status==='FAILED_OR_UNCERTAIN'||a.status==='RETURNED_AFTER_CUTOFF')?.reason??'INITIAL_DELIVERY_UNCERTAIN');if(expectedPages.length)throw Error('INITIAL_PAGES_INCOMPLETE');
  const review=getRecord(syntheticDb,'telegram_writing_review',r.id),buttonPage=rendered.pages.findIndex(page=>page.reply_markup?.inline_keyboard?.length);targets[review.id]=acceptanceTarget(rendered.pages[buttonPage],{version:review.version,messageId:sent.accepted.find(page=>page.page===buttonPage)?.messageId});result.observations.push({packet:p.reviewId,version:p.version,packetHash:p.hash,messageId:review.messageId,status:'API_CONFIRMED'});save();return review;
 };
 const complete=()=>Object.values(result.scenarios).every(s=>s.status==='PASS');
 const reservePoll=()=>{
  const pages=12-result.counts.initialMessages,acks=Object.values(result.scenarios).filter(s=>s.status!=='PASS').length,slots=pages+acks+1;
  if(result.counts.acknowledgments+acks>6)throw Error('REQUIRED_ACK_SLOTS_RESERVED');
  if(result.counts.normalPolls>=16||result.attempts.length+slots+1>40)throw Error('ACCEPTANCE_POLL_BUDGET_EXHAUSTED');
  if(remaining()<25000+slots*1000)throw Error('INSUFFICIENT_TIME_FOR_REQUIRED_ACTIONS');
 };
 try{
  validateManifest(manifest);active();if(getRecord(db,'acceptance_telegram',manifest.id))throw Error('ACCEPTANCE_ALREADY_ATTEMPTED');
  if(db===syntheticDb||db===legacyDb||syntheticDb===legacyDb||[db,legacyDb].some(other=>other.location()&&other.location()===syntheticDb.location()))throw Error('ISOLATED_SYNTHETIC_DATABASE_REQUIRED');
  initialCursor=getRecord(db,'telegram_writing_cursor','primary');if(initialCursor?.nextOffset!==INITIAL)throw Error('INITIAL_CURSOR_MISMATCH');
  acquireTelegramConsumer(db,ownerId,iso());owned=true;recorded=true;result.status='RUNNING';save();
  let token;try{token=await loadToken(Math.min(5000,remaining()));}catch(error){credentialCleanup=['PROTECTED_STORAGE_UNAVAILABLE','WINDOWS_PROTECTION_UNAVAILABLE','WINDOWS_PROTECTION_FAILED'].includes(error?.message);throw Error(credentialCleanup?'LOCAL_CREDENTIAL_UNAVAILABLE':'CREDENTIAL_CLEANUP_UNCONFIRMED');}
  try{active();api=makeApi(token,guard);}finally{token=null;}
  if(api?.mode!=='AUTHORIZED_TELEGRAM_OPERATIONAL'||typeof api.close!=='function')throw Error('ACCEPTANCE_PROTECTED_TRANSPORT_REQUIRED');
  const bot=await invoke('identity','getMe',{},ms=>api.identity(ms));if(bot?.id!==pair.botId||bot.is_bot!==true||bot.username!==TARGET.botUsername)throw Error('BOT_IDENTITY_MISMATCH');await invoke('webhook','getWebhookInfo',{},ms=>api.checkWebhook(ms));
  const preflight=checkedUpdates(await invoke('preflight','getUpdates',{timeout:0,limit:100},ms=>api.inspectPending(ms)));
  const inventory=[];let stop=null;for(const u of preflight){const observation=observeUpdate(u,'PREFLIGHT',legacyDb);if(u.update_id>=BOUNDARY&&u.message?.text==='/stop'&&controlMessageRejection(db,u,iso())===null){stop=u;continue;}inventory.push(historical(db,legacyDb,manifest,u,pair,iso()));observation.disposition='MATCHED_HISTORY_NOT_REEXECUTED';save();}
  if(stop){recordStop(stop);return result;}
  active();transaction(db,()=>{
   if(getRecord(db,'telegram_writing_cursor','primary').nextOffset!==INITIAL||getRecord(db,'telegram_prefix_retirement',manifest.id))throw Error('RETIREMENT_STATE_CHANGED');
   putRecord(db,'telegram_prefix_retirement',manifest.id,{id:manifest.id,manifestHash:hash(manifest),fromOffset:INITIAL,nextOffset:BOUNDARY,allPendingIdsBelowBoundaryAuthorized:true,observed:inventory,unresolvedHistoricalIds:[64381638,64381639],historicalExecutionNotInferred:true,remoteAcknowledgment:'NOT_YET_ATTEMPTED',recordedAt:iso()},'confirmed');
   putRecord(db,'telegram_writing_cursor','primary',{...initialCursor,nextOffset:BOUNDARY,retirementId:manifest.id,recordedAt:iso()},'confirmed');journal(db,'ACCEPTANCE_PREFIX_RETIRED',manifest.id,{fromOffset:INITIAL,nextOffset:BOUNDARY,observedIds:inventory.map(x=>x.updateId)});
  });
  result.prefixAcknowledgment={status:'DISPATCH_INTENT',offset:BOUNDARY,allPendingIdsBelowOffset:true};save();let prefix;
  try{prefix=checkedUpdates(await exactShortPoll('prefixAcknowledgment'));result.prefixAcknowledgment.status='API_CONFIRMED';save();}catch(error){result.prefixAcknowledgment.status='UNCERTAIN';save();throw error;}
  if(prefix.length){for(const u of prefix)observeUpdate(u,'PREFIX_ACK_RESPONSE');const stops=prefix.filter(u=>u.message?.text==='/stop'&&controlMessageRejection(db,u,iso())===null);if(stops.length===prefix.length){recordStop(stops[0]);return result;}throw Error('UNKNOWN_PREFIX_ACK_RESPONSE');}
  seed(syntheticDb,pair,iso());const firstPacket=packet(syntheticDb,'A',1,iso());if(canonical(reviewVariables(firstPacket))!==canonical(manifest.instantly.writeArguments.custom_variables))throw Error('ACCEPTANCE_CONTENT_RECIPE_MISMATCH');
  const limited={mode:'LIVE_SYNTHETIC_WRITING',sendPage:async(chat,page)=>{
   if(chat!==pair.chatId||!expectedPages.length||hash(page)!==expectedPages[0])throw Error('UNAPPROVED_INITIAL_PAGE');expectedPages.shift();return invoke('initialMessages','sendMessage',{chat_id:chat,...page,allow_paid_broadcast:false,link_preview_options:{is_disabled:true}},ms=>api.sendPage(chat,page,ms));
  },answerCallback:()=>{throw Error('UNAPPROVED_ADAPTER_CALLBACK');}};
  adapter=bindLiveSyntheticWritingAdapter({db,syntheticDb,api:limited,assertAuthority:active,timestampNow:iso});
  a1=await deliver(firstPacket);promptNext();
  while(!complete()){
   reservePoll();const offset=getRecord(db,'telegram_writing_cursor','primary').nextOffset;
   const entries=classifySession(await invoke('normalPolls','getUpdates',{offset,timeout:20,limit:100},ms=>api.poll(offset,ms)));
   const stopped=entries.find(e=>e.action==='STOP');if(stopped){recordStop(stopped.u);return result;}
   for(const entry of entries){
    active();if(entry.duplicate){result.observations.push({updateId:entry.u.update_id,status:'DUPLICATE_UPDATE',disposition:'NO_REPLAY'});save();continue;}
    if(result.counts.acknowledgments>=6)throw Error('CALLBACK_ACK_BUDGET_EXHAUSTED');
    const expectedScenario=entry.review.id===a1.id&&entry.action==='APPROVED'?(revisionCreated?'a1InvalidationAndStale':'a1Approval'):entry.review.id===a2?.id&&entry.action==='REVISION_REQUESTED'?'a2Changes':entry.review.id===b1?.id&&entry.action==='REJECTED'?'b1Rejection':null;
    const remainingScenarios=Object.values(result.scenarios).filter(s=>s.status!=='PASS').length-(expectedScenario&&result.scenarios[expectedScenario].status!=='PASS'?1:0);
    if(result.counts.acknowledgments+1+remainingScenarios>6)throw Error('REQUIRED_ACK_SLOTS_RESERVED');
    if(result.attempts.length+1+(12-result.counts.initialMessages)+remainingScenarios+1>40)throw Error('REQUIRED_REQUEST_SLOTS_RESERVED');
    const outcome=scopedOutcome(entry);if(!['APPROVED','STALE_REVIEW','REVISION_REQUESTED','REJECTED','DETAILS','ALREADY_DECIDED','DUPLICATE_UPDATE','DUPLICATE_CALLBACK','CONFLICTING_DECISION','ACTION_OUTSIDE_ACCEPTANCE_SCOPE'].includes(outcome.status))throw Error('CALLBACK_HANDLER_REJECTED');commitReceipt(entry,outcome);entry.observation.disposition='LOCAL_RECEIPT_AND_CURSOR_COMMITTED';result.observations.push({updateId:entry.u.update_id,reviewId:entry.review.reviewId,version:entry.review.version,action:entry.action,status:outcome.status});save();
    operatorEvent(acceptanceOutcome(targets[entry.review.id],entry.action,outcome.status,entry.u.update_id));
    try{await acknowledge(outcome);}
    catch(error){operatorEvent({event:'OPERATOR_ACK_STATUS',status:'UNCERTAIN',updateId:entry.u.update_id});throw error;}
    operatorEvent({event:'OPERATOR_ACK_STATUS',status:'API_CONFIRMED',updateId:entry.u.update_id});
    if(entry.review.id===a1.id&&entry.action==='APPROVED'&&outcome.status==='APPROVED')result.scenarios.a1Approval={status:'PASS',decisionId:outcome.decisionId,packetHash:a1.packetHash};
    if(entry.review.id===a1.id&&entry.action==='APPROVED'&&outcome.status==='STALE_REVIEW'&&revisionCreated&&getRecord(syntheticDb,'writing_decision',result.scenarios.a1Approval.decisionId)?.decision==='INVALIDATED')result.scenarios.a1InvalidationAndStale={status:'PASS',updateId:entry.u.update_id};
    if(entry.review.id===a2?.id&&entry.action==='REVISION_REQUESTED'&&outcome.status==='REVISION_REQUESTED'&&!evaluateWritingReview(syntheticDb,a2.reviewId,outcome.decisionId,iso()).contentApproved)result.scenarios.a2Changes={status:'PASS',decisionId:outcome.decisionId};
    if(entry.review.id===b1?.id&&entry.action==='REJECTED'&&outcome.status==='REJECTED'&&!evaluateWritingReview(syntheticDb,b1.reviewId,outcome.decisionId,iso()).contentApproved)result.scenarios.b1Rejection={status:'PASS',decisionId:outcome.decisionId};save();
    if(result.scenarios.a1Approval.status==='PASS'&&!revisionCreated){
     const revised=packet(syntheticDb,'A',2,iso());if(getRecord(syntheticDb,'writing_decision',result.scenarios.a1Approval.decisionId)?.decision!=='INVALIDATED')throw Error('PRIOR_APPROVAL_NOT_INVALIDATED');revisionCreated=true;
     a2=await deliver(revised);b1=await deliver(packet(syntheticDb,'B',1,iso()));
    }
    promptNext();
   }
  }
  const offset=getRecord(db,'telegram_writing_cursor','primary').nextOffset;result.closure={status:'DISPATCH_INTENT',offset};save();
  let closure;try{closure=checkedUpdates(await invoke('normalPolls','getUpdates',{offset,timeout:0,limit:100},ms=>api.poll(offset,ms),2000));result.closure.status='API_CONFIRMED';save();}catch(error){result.closure.status='UNCERTAIN';save();throw error;}
  if(closure.length){const entries=classifySession(closure,'CLOSURE_RESPONSE'),stop=entries.find(e=>e.action==='STOP');if(stop){recordStop(stop.u);return result;}throw Error('CLOSURE_UPDATES_LEFT_PENDING');}
  result.status='PASSED';return result;
 }catch(error){result.status=result.attempts.some(a=>['FAILED_OR_UNCERTAIN','RETURNED_AFTER_CUTOFF'].includes(a.status)&&(['sendMessage','answerCallbackQuery'].includes(a.method)||Object.hasOwn(a,'offset')))?'UNCERTAIN':'BLOCKED';result.reason??=safe(error);return result;}
 finally{
  communicationStopped=true;permit=null;let transport={closed:true,remainingRequests:0};try{if(api)transport=await api.close();}catch{transport={closed:false,remainingRequests:null};}
  let released=!owned,ownerError=null;
  if(owned)try{if(transport.closed===true&&transport.remainingRequests===0&&credentialCleanup){releaseTelegramConsumer(db,ownerId,iso());released=true;}else{const owner=getRecord(db,'telegram_consumer_owner','primary');if(owner?.ownerId!==ownerId)throw Error('CONSUMER_OWNER_MISMATCH');putRecord(db,'telegram_consumer_owner','primary',{...owner,status:'RECONCILIATION',observedAt:iso()},'configuration');}}catch(error){ownerError=safe(error);}
  result.cleanup={confirmed:transport.closed===true&&transport.remainingRequests===0&&credentialCleanup&&released,transport,credentialCleanup,ownershipReleased:owned&&released,ownerError};
  if(!result.cleanup.confirmed){result.status='BLOCKED';result.reason??='ACCEPTANCE_CLEANUP_UNCONFIRMED';}
  result.elapsedMs=Math.floor(clock()-start);if(result.elapsedMs>600000){result.status='BLOCKED';result.reason??='ACCEPTANCE_TOTAL_DEADLINE_EXCEEDED';}
  result.finalCursor=getRecord(db,'telegram_writing_cursor','primary')?.nextOffset??null;result.localCursorChanged=initialCursor!==null&&result.finalCursor!==initialCursor.nextOffset;result.finishedAt=iso();result.finalControls=controls(db);result.reason??=result.status==='PASSED'?'ACCEPTANCE_SCENARIOS_CONFIRMED':'ACCEPTANCE_INCOMPLETE';save();
 }
}
export {seed as seedAcceptanceFixture,packet as prepareAcceptancePacket};
