// Fresh two-callback continuation. Imports cannot connect, arm, load credentials or replay.
import {performance} from 'node:perf_hooks';
import {canonical,digest,timestamp} from './values.mjs';
import {getRecord,putRecord,transaction,controls} from './store.mjs';
import {requireStopped,isPairedSender} from './telegram-pairing.mjs';
import {controlMessageRejection,handleSyntheticControl} from './telegram-decisions.mjs';
import {acquireTelegramConsumer,releaseTelegramConsumer} from './telegram-writing-authority.mjs';
import {seedAcceptanceFixture,prepareAcceptancePacket} from './acceptance-telegram.mjs';
import {issueWritingTelegramReview,bindWritingTelegramMessage,handleWritingCallback} from './telegram-writing-decisions.mjs';
import {renderTelegramWritingReview,WRITING_BUTTONS} from './telegram-writing-render.mjs';
import {evaluateWritingReview} from './writing.mjs';
import {acceptanceTarget,nextAcceptanceAction,acceptanceOutcome} from './acceptance-guidance.mjs';
import {validateContinuationManifest} from './acceptance-continuation-contract.mjs';

const hash=value=>digest(canonical(value)),safe=error=>/^[A-Z][A-Z0-9_]{0,99}$/.test(error?.message??'')?error.message:'CONTINUATION_LOCAL_FAILURE';
const CAPS={identity:1,webhook:1,preflight:1,initialMessages:2,acknowledgments:3,normalPolls:12};
const INITIAL=64381646,PAIR={botId:9077316901,userId:8473827686,chatId:8473827686};
const steps=[{key:'staleVersion',target:'v1',action:'APPROVED',expectedResult:'STALE_REVIEW'},{key:'requestChanges',target:'v2',action:'REVISION_REQUESTED',expectedResult:'REVISION_REQUESTED'}];
function checkedUpdates(updates){
 if(!Array.isArray(updates)||updates.length>=100)throw Error('QUEUE_MAY_BE_TRUNCATED');const seen=new Set();
 for(const u of updates){if(!Number.isSafeInteger(u?.update_id)||u.update_id<0||seen.has(u.update_id))throw Error('INVALID_UPDATE_RESPONSE');seen.add(u.update_id);}
 return [...updates].sort((a,b)=>a.update_id-b.update_id);
}
function authenticatedCallback(db,u,at){
 const q=u.callback_query,m=q?.message;
 return !!q&&isPairedSender(db,{from:q.from,chat:m?.chat})&&typeof q.id==='string'&&/^[A-Za-z0-9_-]{1,128}$/.test(q.id)&&!q.inline_message_id&&!u.message&&!u.edited_message&&!m.forward_origin&&!m.forward_date&&!m.sender_chat&&!m.via_bot&&m.from?.id===PAIR.botId&&m.from.is_bot===true&&Number.isSafeInteger(m.message_id)&&m.message_id>0&&Number.isSafeInteger(m.date)&&m.date>0&&m.date*1000<=timestamp(at)+60000;
}

export async function runAcceptanceContinuationTelegram({db,syntheticDb,manifest,loadToken,makeApi,assertAuthority,startedMono,startedWall,emit=()=>{},clock=()=>performance.now()}){
 const start=startedMono??clock(),wall=typeof startedWall==='string'?timestamp(startedWall):startedWall??Date.now(),iso=()=>new Date(wall+Math.floor(clock()-start)).toISOString();
 const result={id:manifest?.id??'invalid',status:'BLOCKED',reason:null,startedAt:iso(),attempts:[],counts:Object.fromEntries(Object.keys(CAPS).map(k=>[k,0])),scenarios:{staleVersion:{status:'PENDING'},requestChanges:{status:'PENDING'}},observations:[],operatorEvents:[],closure:{status:'NOT_ATTEMPTED'},remoteAcknowledgment:{lastSubmittedOffset:null,lastApiConfirmedOffset:null,status:'NOT_ATTEMPTED'},stopReceived:false,underlyingTransportRetries:'UNOBSERVED',cleanup:null};
 const ownerId=`${manifest?.id}:telegram`,targets={},reviews={};
 let owned=false,recorded=false,api=null,permit=null,communicationStopped=false,credentialCleanup=true,initialCursor=null,revised,uncertainResponse=false;
 const save=()=>{if(recorded)putRecord(db,'acceptance_telegram',manifest.id,result,'confirmed');};
 const remaining=()=>Math.floor(230000-(clock()-start));
 const active=()=>{
  if(typeof assertAuthority!=='function'||assertAuthority()!==true)throw Error('CONTINUATION_AUTHORITY_REQUIRED');
  requireStopped(db);requireStopped(syntheticDb);if(communicationStopped)throw Error('TELEGRAM_COMMUNICATION_STOPPED');if(remaining()<=0)throw Error('TELEGRAM_CONTINUATION_API_DEADLINE');
  const binding=getRecord(db,'telegram_binding','primary');if(binding?.confirmed!==true||Object.entries(PAIR).some(([k,v])=>binding[k]!==v))throw Error('PAIRING_MISMATCH');
  if(revised){const current=evaluateWritingReview(syntheticDb,revised.reviewId,null,iso());if(current.packetHash!==revised.hash||current.synthetic!==true)throw Error('REVISED_PACKET_INTEGRITY_CHANGED');}
  if(owned){const owner=getRecord(db,'telegram_consumer_owner','primary');if(owner?.ownerId!==ownerId||owner.status!=='ACTIVE')throw Error('CONSUMER_OWNER_MISMATCH');}
 };
 const operatorEvent=event=>{const saved={...event,recordedAt:iso()};result.operatorEvents.push(saved);save();emit(saved);};
 const prompt=()=>{const event=nextAcceptanceAction(steps,result.scenarios,targets,{workingPollsRemaining:Math.max(0,11-result.counts.normalPolls),apiSecondsRemaining:Math.max(0,Math.floor(remaining()/1000))});if(event)operatorEvent(event);};
 const guard=(method,body,ms)=>{
  active();if(!permit||permit.method!==method||permit.bodyHash!==hash(body)||result.attempts.length>=20||result.counts[permit.kind]>=CAPS[permit.kind])throw Error('CONTINUATION_WIRE_REQUEST_DENIED');
  const {kind,bodyHash}=permit;permit=null;result.counts[kind]++;result.attempts.push({method,kind,requestHash:bodyHash,status:'ATTEMPTED',at:iso(),...(Object.hasOwn(body,'offset')?{offset:body.offset}: {})});
  if(method==='getUpdates'&&Object.hasOwn(body,'offset'))result.remoteAcknowledgment={...result.remoteAcknowledgment,lastSubmittedOffset:body.offset,status:'SUBMITTED'};
  save();return Math.min(ms,remaining(),25000);
 };
 const invoke=async(kind,method,body,fn,requestMs=25000)=>{
  active();if(result.attempts.length>=20||result.counts[kind]>=CAPS[kind])throw Error('CONTINUATION_REQUEST_BUDGET_EXHAUSTED');
  const ms=Math.min(requestMs,remaining(),25000);if(ms<=0)throw Error('TELEGRAM_CONTINUATION_API_DEADLINE');
  const wire=typeof body==='function'?body(ms):body,index=result.attempts.length;permit={kind,method,bodyHash:hash(wire)};
  try{
   const value=await fn(ms);if(permit||result.attempts.length!==index+1)throw Error('CONTINUATION_TRANSPORT_GUARD_BYPASSED');permit=null;
   const attempt=result.attempts[index];attempt.status='API_RETURNED';attempt.finishedAt=iso();
   if(method==='sendMessage'&&Number.isSafeInteger(value?.message_id))attempt.returnedMessageId=value.message_id;
   if(method==='getUpdates'&&Object.hasOwn(wire,'offset'))result.remoteAcknowledgment={lastSubmittedOffset:wire.offset,lastApiConfirmedOffset:wire.offset,status:'API_CONFIRMED'};
   save();active();return value;
  }catch(error){permit=null;const attempt=result.attempts[index];if(attempt){const returned=attempt.status==='API_RETURNED';attempt.status=returned?'RETURNED_AFTER_CUTOFF':'FAILED_OR_UNCERTAIN';attempt.reason=safe(error);attempt.finishedAt=iso();if(!returned&&method==='getUpdates'&&Object.hasOwn(wire,'offset'))result.remoteAcknowledgment.status='UNCERTAIN';}save();throw error;}
 };
 const observe=(u,phase)=>{
  const q=u.callback_query,m=q?.message??u.message,ref=typeof q?.data==='string'?getRecord(syntheticDb,'telegram_writing_action',q.data):null,review=ref&&getRecord(syntheticDb,'telegram_writing_review',ref.telegramReviewId),current=review&&getRecord(syntheticDb,'writing_current',review.reviewId);
  const item={event:'UPDATE_CLASSIFICATION',phase,updateId:u.update_id,type:q?'CALLBACK_QUERY':u.message?'MESSAGE':'UNKNOWN',messageId:Number.isSafeInteger(m?.message_id)?m.message_id:null,actorMatch:(q?.from??m?.from)?.id===PAIR.userId&&(q?.from??m?.from)?.is_bot===false,chatMatch:m?.chat?.id===PAIR.chatId&&m.chat.type==='private',observedAction:ref?.action??(u.message?.text==='/stop'?'STOP':'UNKNOWN'),expectedAction:result.scenarios.staleVersion.status==='PASS'?'REVISION_REQUESTED':'APPROVED',expectedState:result.scenarios.staleVersion.status==='PASS'?'AWAITING_REQUEST_CHANGES':'AWAITING_STALE_VERSION',messageBindingMatch:review?review.messageId===m?.message_id:null,packetVersion:review?.version??null,currentPacketVersionMatch:current?current.packetHash===review.packetHash&&current.version===review.version:null,disposition:'LEFT_PENDING'};
  result.observations.push(item);save();return item;
 };
 const stopIfReceived=(updates,phase)=>{
  const stop=updates.find(u=>u.update_id>=getRecord(db,'telegram_writing_cursor','primary').nextOffset&&u.message?.text==='/stop'&&controlMessageRejection(db,u,iso())===null);
  if(!stop)return false;
  const outcome=handleSyntheticControl(db,stop,iso());if(outcome.status!=='STOPPED')throw Error('STOP_HANDLER_REJECTED');
  result.status='BLOCKED';result.reason='AUTHENTICATED_STOP';result.stopReceived=true;communicationStopped=true;result.observations.push({updateId:stop.update_id,phase,action:'STOP',status:'STOPPED',disposition:'LOCAL_STOP_RECORDED_REMOTE_PENDING'});save();return true;
 };
 const classify=updates=>{
  let expected=getRecord(db,'telegram_writing_cursor','primary').nextOffset;
  return updates.map(u=>{
   const observation=observe(u,'SESSION'),updateHash=hash(u),receipt=getRecord(db,'telegram_control_receipt',`${PAIR.botId}:${u.update_id}`);
   if(receipt){if(receipt.testId!==manifest.id||receipt.updateHash!==updateHash)throw Error('SESSION_RECEIPT_MISMATCH');observation.disposition='EXACT_DUPLICATE_NO_REPLAY';save();return {u,updateHash,duplicate:true,observation};}
   if(u.update_id!==expected)throw Error('SESSION_UPDATE_GAP');expected++;
   const q=u.callback_query,ref=typeof q?.data==='string'?getRecord(syntheticDb,'telegram_writing_action',q.data):null,review=ref&&getRecord(syntheticDb,'telegram_writing_review',ref.telegramReviewId),key=review?.id===reviews.v1?.id?'v1':review?.id===reviews.v2?.id?'v2':null;
   if(!authenticatedCallback(db,u,iso())||!key||review.messageId!==q.message.message_id||review.actions[ref.action]!==q.data||q.message.date<Math.floor(timestamp(review.issuedAt)/1000)||ref.action!==(key==='v1'?'APPROVED':'REVISION_REQUESTED'))throw Error('UNRELATED_SESSION_UPDATE');
   observation.disposition='BOUND_SESSION_UPDATE_AWAITING_HANDLER';save();return {u,updateHash,review,key,action:ref.action,observation};
  });
 };
 const commit=(entry,outcome)=>transaction(db,()=>{
  const saved=getRecord(syntheticDb,'telegram_control_receipt',`${PAIR.botId}:${entry.u.update_id}`),cursor=getRecord(db,'telegram_writing_cursor','primary');
  if(!saved||saved.updateHash!==entry.updateHash)throw Error('SYNTHETIC_RECEIPT_MISSING');if(cursor.nextOffset!==entry.u.update_id)throw Error('SESSION_CURSOR_MISMATCH');
  putRecord(db,'telegram_control_receipt',`${PAIR.botId}:${entry.u.update_id}`,{testId:manifest.id,updateId:entry.u.update_id,updateHash:entry.updateHash,status:outcome.status,contentStore:'ISOLATED_SYNTHETIC',recordedAt:iso()},'confirmed');
  putRecord(db,'telegram_writing_cursor','primary',{...cursor,nextOffset:entry.u.update_id+1,recordedAt:iso()},'confirmed');
 });
 const pendingRequired=()=>Object.values(result.scenarios).filter(s=>s.status!=='PASS').length;
 const reserve=({poll=false,requiredAck=false}={})=>{
  const sends=2-result.counts.initialMessages,acks=pendingRequired()-(requiredAck?1:0),extra=1;
  if(result.counts.acknowledgments+acks+(requiredAck?1:0)>3)throw Error('REQUIRED_ACK_SLOTS_RESERVED');
  if(result.attempts.length+sends+acks+1+extra>20)throw Error('REQUIRED_REQUEST_SLOTS_RESERVED');
  if(poll&&result.counts.normalPolls>=11)throw Error('CONTINUATION_POLL_BUDGET_EXHAUSTED');
  if(remaining()< (poll?25000:10000)+(sends+acks)*10000+2000)throw Error('INSUFFICIENT_TIME_FOR_REQUIRED_ACTIONS');
 };
 const acknowledge=async(outcome,updateId)=>{
  if(typeof outcome.callbackId!=='string')throw Error('CALLBACK_ACK_ID_MISSING');const id=digest(outcome.callbackId),prior=getRecord(syntheticDb,'telegram_callback_response',id);
  if(prior){if(prior.status==='API_CONFIRMED')return;throw Error('CALLBACK_RESPONSE_ALREADY_ATTEMPTED');}
  putRecord(syntheticDb,'telegram_callback_response',id,{status:'DISPATCH_INTENT',outcome:outcome.status,at:iso()},'confirmed');
  try{
   const accepted=await invoke('acknowledgments','answerCallbackQuery',{callback_query_id:outcome.callbackId,text:outcome.ackText,show_alert:false,cache_time:0},ms=>api.answerCallback(outcome.callbackId,outcome.ackText,ms),10000);
   if(accepted!==true)throw Error('CALLBACK_ACK_UNCERTAIN');putRecord(syntheticDb,'telegram_callback_response',id,{status:'API_CONFIRMED',outcome:outcome.status,at:iso()},'confirmed');operatorEvent({event:'OPERATOR_ACK_STATUS',status:'API_CONFIRMED',updateId});
  }catch(error){uncertainResponse=true;putRecord(syntheticDb,'telegram_callback_response',id,{status:'UNCERTAIN',outcome:outcome.status,mustNotResend:true,at:iso()},'confirmed');operatorEvent({event:'OPERATOR_ACK_STATUS',status:'UNCERTAIN',updateId});throw error;}
 };
 const deliver=async(packet,key,action)=>{
  active();if(packet.hash!==manifest.telegram.packetHashes[String(packet.version)])throw Error('SYNTHETIC_PACKET_HASH_MISMATCH');
  const id=`${manifest.id}-${key}`,review=issueWritingTelegramReview(syntheticDb,{id,reviewId:packet.reviewId,packetHash:packet.hash,at:iso(),expiresAt:new Date(wall+230000).toISOString(),expiryBasis:'EXPLICIT_SYNTHETIC_TEST'});
  const rendered=renderTelegramWritingReview(syntheticDb,packet,{review,at:manifest.telegram.snapshotAt}),source=rendered.pages.find(p=>p.reply_markup?.inline_keyboard?.length);
  const button=source?.reply_markup.inline_keyboard.flat().find(b=>b.callback_data===review.actions[action]),approved=manifest.telegram.approvedPages.find(p=>p.version===packet.version);
  if(!button||button.text!==WRITING_BUTTONS[action]||!approved||approved.action!==action||approved.buttonLabel!==button.text||approved.text!==source.text)throw Error('SYNTHETIC_PAGE_CONTENT_MISMATCH');
  const page={text:source.text,reply_markup:{inline_keyboard:[[button]]}},body={chat_id:PAIR.chatId,...page,allow_paid_broadcast:false,link_preview_options:{is_disabled:true}};
  putRecord(syntheticDb,'telegram_writing_delivery',id,{status:'DISPATCH_INTENT',packetHash:packet.hash,pageHash:hash(page),startedAt:iso()},'confirmed');
  try{
   const sent=await invoke('initialMessages','sendMessage',body,ms=>api.sendPage(PAIR.chatId,page,ms),10000);
   if(!Number.isSafeInteger(sent?.message_id)||sent.message_id<=0||sent.chat?.id!==PAIR.chatId||sent.chat.type!=='private'||sent.from?.id!==PAIR.botId||sent.from.is_bot!==true)throw Error('SYNTHETIC_DELIVERY_UNCERTAIN');
   const bound=bindWritingTelegramMessage(syntheticDb,id,sent.message_id,iso());reviews[key]=bound;targets[key]=acceptanceTarget(page,{version:bound.version,messageId:sent.message_id});
   putRecord(syntheticDb,'telegram_writing_delivery',id,{...getRecord(syntheticDb,'telegram_writing_delivery',id),status:'API_CONFIRMED',messageId:sent.message_id,finishedAt:iso()},'confirmed');result.observations.push({event:'MESSAGE_DELIVERED',version:packet.version,packetHash:packet.hash,messageId:sent.message_id,status:'API_CONFIRMED'});save();
  }catch(error){uncertainResponse=true;const current=getRecord(syntheticDb,'telegram_writing_delivery',id);putRecord(syntheticDb,'telegram_writing_delivery',id,{...current,status:'UNCERTAIN',finishedAt:iso(),mustNotResend:true},'confirmed');throw error;}
 };
 const poll=async(closure=false)=>{
  const offset=getRecord(db,'telegram_writing_cursor','primary').nextOffset;
  return checkedUpdates(await invoke('normalPolls','getUpdates',ms=>({offset,timeout:Math.max(0,Math.min(20,Math.floor(ms/1000)-2)),limit:100}),ms=>api.poll(offset,ms),closure?2000:25000));
 };
 try{
  validateContinuationManifest(manifest);active();if(getRecord(db,'acceptance_telegram',manifest.id))throw Error('CONTINUATION_ALREADY_ATTEMPTED');
  if(db===syntheticDb||db.location()&&db.location()===syntheticDb.location())throw Error('ISOLATED_SYNTHETIC_DATABASE_REQUIRED');
  initialCursor=getRecord(db,'telegram_writing_cursor','primary');if(initialCursor?.nextOffset!==INITIAL)throw Error('INITIAL_CURSOR_MISMATCH');
  acquireTelegramConsumer(db,ownerId,iso());owned=true;recorded=true;result.status='RUNNING';save();
  let token;try{token=await loadToken(Math.min(5000,remaining()));}catch(error){credentialCleanup=['PROTECTED_STORAGE_UNAVAILABLE','WINDOWS_PROTECTION_UNAVAILABLE','WINDOWS_PROTECTION_FAILED'].includes(error?.message);throw Error(credentialCleanup?'LOCAL_CREDENTIAL_UNAVAILABLE':'CREDENTIAL_CLEANUP_UNCONFIRMED');}
  try{active();api=makeApi(token,guard);}finally{token=null;}
  if(api?.mode!=='AUTHORIZED_TELEGRAM_OPERATIONAL'||typeof api.close!=='function')throw Error('CONTINUATION_PROTECTED_TRANSPORT_REQUIRED');
  const bot=await invoke('identity','getMe',{},ms=>api.identity(ms));if(bot?.id!==PAIR.botId||bot.is_bot!==true||bot.username!=='ElyaColdBot')throw Error('BOT_IDENTITY_MISMATCH');
  await invoke('webhook','getWebhookInfo',{},ms=>api.checkWebhook(ms));
  const preflight=checkedUpdates(await invoke('preflight','getUpdates',{timeout:0,limit:100},ms=>api.inspectPending(ms)));
  for(const u of preflight)observe(u,'PREFLIGHT');if(stopIfReceived(preflight,'PREFLIGHT'))return result;if(preflight.length)throw Error('UNKNOWN_PREFLIGHT_UPDATE');
  seedAcceptanceFixture(syntheticDb,PAIR,manifest.telegram.snapshotAt);const first=prepareAcceptancePacket(syntheticDb,'A',1,manifest.telegram.snapshotAt);
  // Reserve the send, a full working poll, all remaining required sends/ACKs,
  // closure and a small local-work margin before showing a new button.
  if(remaining()<68000)throw Error('INSUFFICIENT_TIME_FOR_REQUIRED_ACTIONS');
  await deliver(first,'v1','APPROVED');revised=prepareAcceptancePacket(syntheticDb,'A',2,manifest.telegram.snapshotAt);if(revised.hash!==manifest.telegram.packetHashes['2'])throw Error('SYNTHETIC_PACKET_HASH_MISMATCH');
  result.preparedPackets={v1:{version:1,hash:first.hash},v2:{version:2,hash:revised.hash},priorApprovalCreated:false};save();reserve({poll:true});prompt();
  while(result.scenarios.requestChanges.status!=='PASS'){
   reserve({poll:true});const updates=await poll();if(stopIfReceived(updates,'SESSION'))return result;const entries=classify(updates);
   for(const entry of entries){
    active();if(entry.duplicate)continue;
    const scenario=entry.key==='v1'?'staleVersion':'requestChanges',required=result.scenarios[scenario].status!=='PASS';reserve({requiredAck:required});
    if(result.counts.acknowledgments+1+pendingRequired()-(required?1:0)>3)throw Error('REQUIRED_ACK_SLOTS_RESERVED');
    const outcome=handleWritingCallback(syntheticDb,entry.u,iso());
    if(!['STALE_REVIEW','REVISION_REQUESTED','ALREADY_DECIDED','DUPLICATE_UPDATE','DUPLICATE_CALLBACK','CONFLICTING_DECISION'].includes(outcome.status))throw Error('CALLBACK_HANDLER_REJECTED');
    commit(entry,outcome);entry.observation.disposition='LOCAL_RECEIPT_AND_CURSOR_COMMITTED';save();operatorEvent(acceptanceOutcome(targets[entry.key],entry.action,outcome.status,entry.u.update_id));
    await acknowledge(outcome,entry.u.update_id);
    if(entry.key==='v1'&&outcome.status==='STALE_REVIEW')result.scenarios.staleVersion={status:'PASS',updateId:entry.u.update_id,packetHash:entry.review.packetHash,sharedHandler:true};
    if(entry.key==='v2'&&outcome.status==='REVISION_REQUESTED'&&!evaluateWritingReview(syntheticDb,entry.review.reviewId,outcome.decisionId,iso()).contentApproved)result.scenarios.requestChanges={status:'PASS',updateId:entry.u.update_id,decisionId:outcome.decisionId,packetHash:entry.review.packetHash};save();
   }
   if(result.scenarios.staleVersion.status==='PASS'&&!reviews.v2){if(remaining()<48000)throw Error('INSUFFICIENT_TIME_FOR_REQUIRED_ACTIONS');await deliver(revised,'v2','REVISION_REQUESTED');}
   if(entries.length&&result.scenarios.requestChanges.status!=='PASS'){reserve({poll:true});prompt();}
  }
  const offset=getRecord(db,'telegram_writing_cursor','primary').nextOffset;result.closure={status:'DISPATCH_INTENT',offset};save();
  let updates;try{updates=await poll(true);result.closure.status='API_CONFIRMED';save();}catch(error){result.closure.status='UNCERTAIN';save();throw error;}
  for(const u of updates)observe(u,'CLOSURE');if(stopIfReceived(updates,'CLOSURE'))return result;if(updates.length)throw Error('CLOSURE_UPDATES_LEFT_PENDING');
  result.status='PASSED';
 }catch(error){result.status=uncertainResponse||result.attempts.some(a=>['FAILED_OR_UNCERTAIN','RETURNED_AFTER_CUTOFF'].includes(a.status)&&(['sendMessage','answerCallbackQuery'].includes(a.method)||Object.hasOwn(a,'offset')))?'UNCERTAIN':'BLOCKED';result.reason??=safe(error);}
 finally{
  communicationStopped=true;permit=null;let transport={closed:true,remainingRequests:0};try{if(api)transport=await api.close();}catch{transport={closed:false,remainingRequests:null};}
  let released=!owned,ownerError=null;
  if(owned)try{if(transport.closed===true&&transport.remainingRequests===0&&credentialCleanup){releaseTelegramConsumer(db,ownerId,iso());released=true;}else{const owner=getRecord(db,'telegram_consumer_owner','primary');if(owner?.ownerId!==ownerId)throw Error('CONSUMER_OWNER_MISMATCH');putRecord(db,'telegram_consumer_owner','primary',{...owner,status:'RECONCILIATION',observedAt:iso()},'configuration');}}catch(error){ownerError=safe(error);}
  result.cleanup={confirmed:transport.closed===true&&transport.remainingRequests===0&&credentialCleanup&&released,transport,credentialCleanup,ownershipReleased:owned&&released,ownerError};
  if(!result.cleanup.confirmed){result.status='BLOCKED';result.reason??='CONTINUATION_CLEANUP_UNCONFIRMED';}
  result.elapsedMs=Math.floor(clock()-start);if(result.elapsedMs>240000){result.status='BLOCKED';result.reason??='CONTINUATION_TOTAL_DEADLINE_EXCEEDED';}
  result.finalCursor=getRecord(db,'telegram_writing_cursor','primary')?.nextOffset??null;result.localCursorChanged=initialCursor!==null&&result.finalCursor!==initialCursor.nextOffset;result.finishedAt=iso();result.finalControls=controls(db);result.reason??=result.status==='PASSED'?'CONTINUATION_TELEGRAM_OUTCOMES_CONFIRMED':'CONTINUATION_INCOMPLETE';save();
 }
 return result;
}
