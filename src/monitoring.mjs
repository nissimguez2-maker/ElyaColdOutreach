// Local ingestion contract, NOT an Instantly webhook/list-emails response schema.
// A future provider decoder must be grounded in saved approved provider evidence.
import {canonical,digest,required,timestamp,decimal} from './values.mjs';
import {getRecord,putRecord,transaction,journal,controls,now} from './store.mjs';
import {operation,reserveOperation,beginOperation,recordOutcome,reconcileOperation} from './operations.mjs';
import {evaluateWritingReview} from './writing.mjs';

const rows=(db,kind)=>db.prepare('SELECT id,data_json FROM records WHERE kind=? ORDER BY id').all(kind).map(r=>({id:r.id,...JSON.parse(r.data_json)}));
const key=value=>digest(canonical(value));
const eventIdentity=({evidenceRef,conversation,...event})=>canonical(event);
const atomic=(db,fn)=>db.isTransaction?fn():transaction(db,fn);
function exact(value,keys,optional=[]){
 canonical(value);
 if(!value||Object.getPrototypeOf(value)!==Object.prototype||keys.some(k=>!Object.hasOwn(value,k))||Object.keys(value).some(k=>![...keys,...optional].includes(k)))throw Error('MONITOR_INVALID_FIELDS');
}
function email(value){required(value,'email');if(value!==value.toLowerCase()||!/^\S+@[^\s@]+\.[^\s@]+$/.test(value))throw Error('MONITOR_INVALID_EMAIL');}
function destination(db,bindingId){
 const b=getRecord(db,'telegram_binding',bindingId);
 if(!b?.confirmed||![b.chatId,b.userId,b.botId].every(Number.isSafeInteger))throw Error('MONITOR_TELEGRAM_BINDING_REQUIRED');
 return {bindingId,chatId:b.chatId,userId:b.userId,botId:b.botId};
}
export function registerLeadMapping(db,input){
 exact(input,['provider','campaignId','leadId','candidateId','email','importOperationId','evidenceRef']);
 for(const v of Object.values(input))required(v);email(input.email);
 if(input.provider!=='instantly')throw Error('MONITOR_PROVIDER_UNSUPPORTED');
 return atomic(db,()=>{
  const op=operation(db,input.importOperationId);
  if(!op||op.kind!=='RELEASE'||op.status!=='SUCCEEDED')throw Error('MONITOR_MAPPING_IMPORT_NOT_CONFIRMED');
  const intent=JSON.parse(op.intent_json);
  const batch=db.prepare('SELECT * FROM batches WHERE batch_id=?').all(intent.payload.batchId).find(b=>key({kind:'RELEASE',batchId:b.batch_id,version:b.version,hash:b.hash,campaignId:JSON.parse(b.content_json).campaignId})===op.action_key);
  const content=batch?JSON.parse(batch.content_json):null;
  if(content?.campaignId!==input.campaignId||!content.recipients.some(r=>r.candidateId===input.candidateId&&r.email===input.email))throw Error('MONITOR_MAPPING_RECIPIENT_MISMATCH');
  const imported=getRecord(db,'handoff_import',key({campaignId:input.campaignId,email:input.email}));
  if(imported?.status!=='IMPORTED'||['campaignId','leadId','candidateId','email','importOperationId'].some(k=>imported[k]!==input[k]))throw Error('MONITOR_MAPPING_IMPORT_EVIDENCE_MISMATCH');
  const id=key({provider:input.provider,campaignId:input.campaignId,leadId:input.leadId}),old=getRecord(db,'provider_lead_mapping',id);
  if(old&&canonical(old)!==canonical(input))throw Error('MONITOR_MAPPING_IMMUTABLE');
  const collision=rows(db,'provider_lead_mapping').find(r=>r.provider===input.provider&&r.campaignId===input.campaignId&&r.email===input.email&&r.leadId!==input.leadId);
  if(collision)throw Error('MONITOR_MAPPING_AMBIGUOUS_RECIPIENT');
  if(!old){putRecord(db,'provider_lead_mapping',id,input,'confirmed');journal(db,'PROVIDER_LEAD_MAPPED',id,{campaignId:input.campaignId,importOperationId:input.importOperationId,evidenceRef:input.evidenceRef});}
  return input;
 });
}
export function validateNormalizedProviderEvent(input,at=now()){
 exact(input,['version','provider','eventId','type','campaignId','leadId','email','occurredAt','evidenceRef'],['excerpt','conversation']);
 if(input.version!==1||input.provider!=='instantly'||!['SCHEDULED','SENT','BOUNCED','REPLIED'].includes(input.type))throw Error('MONITOR_NORMALIZED_EVENT_UNSUPPORTED');
 for(const k of ['eventId','campaignId','leadId','evidenceRef'])required(input[k],k);email(input.email);
 if(timestamp(input.occurredAt)>timestamp(at))throw Error('MONITOR_FUTURE_EVENT');
 if(input.excerpt!==undefined&&(typeof input.excerpt!=='string'||input.excerpt.length>2000))throw Error('MONITOR_EXCERPT_INVALID');
 if(input.conversation!==undefined){
  const c=input.conversation;exact(c,['recordId','rfcMessageId','threadId','organizationId','senderEmail','subject','url','bodyTruncated'],['urlEvidenceRef']);
  for(const k of ['recordId','rfcMessageId','threadId','organizationId','subject']){required(c[k]);if(c[k].length>500)throw Error('MONITOR_CONVERSATION_BOUND');}
  email(c.senderEmail);if(c.recordId!==input.eventId||typeof c.bodyTruncated!=='boolean')throw Error('MONITOR_CONVERSATION_IDENTITY_INVALID');
  if(c.url!==null){required(c.urlEvidenceRef);let url;try{url=new URL(c.url);}catch{throw Error('MONITOR_CONVERSATION_URL_INVALID');}if(url.protocol!=='https:'||url.username||url.password||c.url.length>1000)throw Error('MONITOR_CONVERSATION_URL_INVALID');}
 }
 return structuredClone(input);
}
export function recordMonitoringFailure(db,streamId,code,evidenceRef,at=now()){
 required(streamId);required(code);required(evidenceRef);timestamp(at);
 if(!/^[A-Z][A-Z0-9_]{0,100}$/.test(code))throw Error('MONITOR_FAILURE_CODE_REQUIRED');
 return atomic(db,()=>{
  const prior=getRecord(db,'monitor_health',streamId);
  const value={...prior,streamId,state:'FAILED',code,evidenceRef,failedAt:at};
  putRecord(db,'monitor_health',streamId,value,'assessment');
  const id=key({streamId,code,evidenceRef});
  if(!getRecord(db,'monitor_escalation',id))putRecord(db,'monitor_escalation',id,{id,streamId,campaignId:prior?.campaignId??null,status:'OPEN',code,evidenceRef,createdAt:at,action:'Inspect the saved evidence and native conversation; resolve direction, association or refusal scope manually. No automatic reply, suppression or remote pause.',autonomousAction:false},'assessment');
  journal(db,'MONITORING_FAILED',streamId,{code,evidenceRef});return value;
 });
}
export function ingestReplyPage(db,input,at=now()){
 exact(input,['streamId','campaignId','expectedCursor','nextCursor','events','evidenceRef'],['destinationBindingId','contractHash']);
 required(input.streamId);required(input.campaignId);required(input.evidenceRef);timestamp(at);
 for(const c of [input.expectedCursor,input.nextCursor])if(c!==null&&(typeof c!=='string'||!c.length||c.length>2000))throw Error('MONITOR_CURSOR_INVALID');
 if(!Array.isArray(input.events)||input.events.length>1000)throw Error('MONITOR_PAGE_BOUND');
 const receiptId=key(input);
 try{return atomic(db,()=>{
  const priorReceipt=getRecord(db,'monitor_page',receiptId);if(priorReceipt)return {...priorReceipt,duplicate:true};
  const checkpoint=getRecord(db,'monitor_checkpoint',input.streamId);
  if(checkpoint?.complete)throw Error('MONITOR_BACKFILL_COMPLETE_USE_NEW_STREAM');
  if((checkpoint?.cursor??null)!==input.expectedCursor||checkpoint&&checkpoint.campaignId!==input.campaignId)throw Error('MONITOR_CHECKPOINT_MISMATCH');
  const notificationIds=[];let inserted=0;
  for(const source of input.events){
   const event=validateNormalizedProviderEvent(source,at);
   if(event.campaignId!==input.campaignId)throw Error('MONITOR_MAPPING_CAMPAIGN_MISMATCH');
   const mapping=getRecord(db,'provider_lead_mapping',key({provider:event.provider,campaignId:event.campaignId,leadId:event.leadId}));
   if(!mapping||mapping.email!==event.email)throw Error('MONITOR_MAPPING_NOT_FOUND');
   const id=key({provider:event.provider,campaignId:event.campaignId,eventId:event.eventId}),old=getRecord(db,'provider_event',id);
   if(old){
    if(eventIdentity(old.event)!==eventIdentity(event)||old.event.conversation&&event.conversation&&canonical(old.event.conversation)!==canonical(event.conversation))throw Error('MONITOR_EVENT_IDENTITY_MISMATCH');
    // A new decoder may add previously absent metadata; preserve the original
    // event evidence and history, and never emit another notification.
    if(!old.event.conversation&&event.conversation){
     putRecord(db,'provider_event',id,{...old,event:{...old.event,conversation:event.conversation},conversationEvidenceRef:event.evidenceRef,conversationObservedAt:at},'provider_result');
     journal(db,'MONITOR_CONVERSATION_METADATA_ADDED',id,{evidenceRef:event.evidenceRef});
    }
    continue;
   }
   putRecord(db,'provider_event',id,{event,candidateId:mapping.candidateId,ingestedAt:at},'provider_result');inserted++;
   if(event.type==='REPLIED'){
    const target=destination(db,input.destinationBindingId??'primary');
    putRecord(db,'reply_notification',id,{id,eventId:id,campaignId:event.campaignId,candidateId:mapping.candidateId,email:event.email,destination:target,status:'PENDING',attempts:0,maxAttempts:2,operationId:null,createdAt:at,updatedAt:at},'assessment');notificationIds.push(id);
   }
  }
  const result={streamId:input.streamId,campaignId:input.campaignId,inserted,notificationIds,cursor:input.nextCursor,evidenceRef:input.evidenceRef,committedAt:at};
  putRecord(db,'monitor_page',receiptId,result,'confirmed');
  putRecord(db,'monitor_checkpoint',input.streamId,{streamId:input.streamId,campaignId:input.campaignId,cursor:input.nextCursor,complete:input.nextCursor===null,pageReceiptId:receiptId,committedAt:at,...(input.contractHash?{contractHash:input.contractHash}:{})},'confirmed');
  putRecord(db,'monitor_health',input.streamId,{streamId:input.streamId,campaignId:input.campaignId,state:'HEALTHY',lastSuccessfulPageAt:at,evidenceRef:input.evidenceRef,coverage:'OBSERVED_PAGES_ONLY'},'assessment');
  journal(db,'MONITOR_PAGE_COMMITTED',input.streamId,{receiptId,inserted,notifications:notificationIds.length});return result;
 });}catch(error){recordMonitoringFailure(db,input.streamId,/^MONITOR_[A-Z_]+$/.test(error.message)?error.message:'MONITOR_PAGE_REJECTED',input.evidenceRef,at);throw error;}
}
function notificationBoundary(db,n,options){
 if(!n)throw Error('MONITOR_NOTIFICATION_UNKNOWN');
 if(n.status==='RECONCILIATION'||n.status==='DISPATCHING')throw Error('MONITOR_NOTIFICATION_RECONCILIATION_REQUIRED');
 if(n.status!=='PENDING'||n.attempts>=n.maxAttempts)throw Error('MONITOR_NOTIFICATION_ATTEMPTS_EXHAUSTED');
 required(options.authorizationRef);required(options.budgetId);
 if(timestamp(options.expiresAt)<=timestamp(options.at))throw Error('MONITOR_NOTIFICATION_AUTHORIZATION_EXPIRED');
 if(controls(db).stopped&&options.allowWhileStopped!==true)throw Error('MONITOR_SYSTEM_STOPPED');
 if(canonical(destination(db,n.destination.bindingId))!==canonical(n.destination))throw Error('MONITOR_TELEGRAM_BINDING_CHANGED');
 if(options.assertBoundary)options.assertBoundary();
}
export function renderReplyNotification(db,id){
 const n=getRecord(db,'reply_notification',id),record=n&&getRecord(db,'provider_event',n.eventId);
 if(!record)throw Error('MONITOR_NOTIFICATION_UNKNOWN');
 const e=record.event,c=e.conversation,clean=value=>String(value).replace(/[\r\n\u0000-\u001f\u007f]/g,' ');
 const lines=['Reply received',`Campaign: ${clean(e.campaignId)}`,`Contact: ${clean(e.email)}`,`Received: ${e.occurredAt}`,`Lead ID: ${clean(e.leadId)}`,`Message record: ${clean(e.eventId)}`];
 if(c)lines.push(`Sender account: ${clean(c.senderEmail)}`,`Subject: ${clean(c.subject)}`,`Thread: ${clean(c.threadId)}`,`RFC Message-ID: ${clean(c.rfcMessageId)}`,c.url?`Conversation: ${c.url}`:'Conversation link: not established',`Body: ${c.bodyTruncated?'truncated; inspect the full native conversation':'preview only; inspect the full native conversation'}`);
 lines.push(`Native search: ${clean(e.email)}; match campaign, sender, subject, received time and identifiers above.`,...(e.excerpt?['',e.excerpt.slice(0,800)]:[]),'','Review reply and refusal scope manually. Escalate ambiguity; no automatic suppression or remote pause. No reply has been generated or sent.');
 return {chatId:n.destination.chatId,text:lines.join('\n')};
}
function receipt(value){
 exact(value,['status','actualUsd','evidenceRef'],['remoteId']);
 if(!['DELIVERED','NOT_DISPATCHED','UNCERTAIN'].includes(value.status))throw Error('MONITOR_NOTIFICATION_RECEIPT_INVALID');
 required(value.evidenceRef);if(value.actualUsd!==null)decimal(value.actualUsd);
 if(value.status==='DELIVERED')required(value.remoteId);
 if(value.status==='NOT_DISPATCHED'&&value.actualUsd!=='0')throw Error('MONITOR_PREDISPATCH_RECEIPT_INVALID');
 return value;
}
function persistNotificationOutcome(db,id,result,at,reconciliation=false){
 return atomic(db,()=>{
  const current=getRecord(db,'reply_notification',id),op=operation(db,current.operationId);
  if(current.status!==(reconciliation?'RECONCILIATION':'DISPATCHING')||op?.status!==(reconciliation?'RECONCILIATION':'DISPATCHING'))throw Error('MONITOR_NOTIFICATION_OPERATION_STATE');
  const opReceipt={status:result.status==='DELIVERED'?'SUCCEEDED':result.status==='NOT_DISPATCHED'?'FAILED':'AMBIGUOUS',actual:result.actualUsd,remoteId:result.remoteId??null,evidence:result.evidenceRef};
  // Shared billing and outbox state commit together, including their audit records.
  (reconciliation?reconcileOperation:recordOutcome)(db,current.operationId,opReceipt);
  const status=operation(db,current.operationId).status==='RECONCILIATION'?'RECONCILIATION':result.status==='DELIVERED'?'DELIVERED':current.attempts<current.maxAttempts?'PENDING':'FAILED';
  const next={...current,status,updatedAt:at,evidenceRef:result.evidenceRef,remoteId:result.remoteId??null};
  putRecord(db,'reply_notification',id,next,'assessment');journal(db,'REPLY_NOTIFICATION_OUTCOME',id,{status,evidenceRef:result.evidenceRef});return next;
 });
}
export async function dispatchReplyNotification(db,id,transport,options){
 if(transport?.mode!=='offline'||typeof transport.send!=='function')throw Error('MONITOR_OFFLINE_TRANSPORT_REQUIRED');
 return dispatchNotification(db,id,transport,options);
}
// Operational entry is distinct from the historical offline adapter. Its exact
// persisted content/pairing authority is rechecked in the dispatch transaction.
export async function dispatchScopedReplyNotification(db,id,transport,options){
 if(transport?.mode!=='SCOPED_TELEGRAM_MONITORING'||typeof transport.send!=='function'||typeof transport.assertBoundary!=='function')throw Error('MONITOR_SCOPED_TRANSPORT_REQUIRED');
 return dispatchNotification(db,id,transport,{...options,assertBoundary:transport.assertBoundary});
}
async function dispatchNotification(db,id,transport,options){
 const opts={...options,at:options?.at??now()};let n=getRecord(db,'reply_notification',id);
 if(n?.status==='DELIVERED')return n;
 notificationBoundary(db,n,opts);
 const attempt=n.attempts+1,operationId=`reply-notify:${id}:${attempt}`;
 reserveOperation(db,{id:operationId,kind:'NOTIFY',budgetId:opts.budgetId,reservation:'0',authorizationRef:opts.authorizationRef,payload:{notificationId:id,attempt,destinationHash:key(n.destination)}});
 beginOperation(db,operationId,opts.at,()=>{
  n=getRecord(db,'reply_notification',id);notificationBoundary(db,n,opts);
  if(n.attempts+1!==attempt)throw Error('MONITOR_NOTIFICATION_CONCURRENT_CLAIM');
  putRecord(db,'reply_notification',id,{...n,status:'DISPATCHING',attempts:attempt,operationId,updatedAt:opts.at},'assessment');
 });
 let result;
 try{result=receipt(await transport.send(renderReplyNotification(db,id)));}
 catch{result={status:'UNCERTAIN',actualUsd:null,evidenceRef:'Notification transport failed or returned invalid evidence; reconcile before replay'};}
 return persistNotificationOutcome(db,id,result,opts.at);
}
export function reconcileReplyNotification(db,id,result,at=now()){
 timestamp(at);if(getRecord(db,'reply_notification',id)?.status!=='RECONCILIATION')throw Error('MONITOR_NOTIFICATION_RECONCILIATION_REQUIRED');
 const normalized={...result,status:result.status==='NOT_DELIVERED'?'NOT_DISPATCHED':result.status};receipt(normalized);
 if(normalized.status==='UNCERTAIN')throw Error('MONITOR_DEFINITIVE_RECONCILIATION_REQUIRED');
 return persistNotificationOutcome(db,id,normalized,at,true);
}
export function recoverMonitoring(db,at=now()){
 timestamp(at);return atomic(db,()=>{
  const recovered=[];
  for(const n of rows(db,'reply_notification').filter(n=>n.status==='DISPATCHING')){
   const op=operation(db,n.operationId);
   let status='RECONCILIATION';
   if(op?.status==='SUCCEEDED')status='DELIVERED';
   else if(op?.status==='FAILED')status=n.attempts<n.maxAttempts?'PENDING':'FAILED';
   else if(op?.status==='DISPATCHING')db.prepare("UPDATE operations SET status='RECONCILIATION',updated_at=? WHERE id=?").run(at,n.operationId);
   const next={...n,status,updatedAt:at,evidenceRef:op?.evidence??'Interrupted notification requires reconciliation',remoteId:op?.remote_id??null};
   putRecord(db,'reply_notification',n.id,next,'assessment');journal(db,'REPLY_NOTIFICATION_RECOVERED',n.id,{status});recovered.push(next);
  }return recovered;
 });
}
export function monitoringReport(db,{campaignId,includeSynthetic=false}={},at=now()){
 timestamp(at);if(typeof includeSynthetic!=='boolean')throw Error('MONITOR_REPORT_SCOPE_INVALID');
 const syntheticCandidates=new Set(rows(db,'candidate').filter(r=>r.synthetic===true||r.syntheticOnly===true).map(r=>r.id));
 const syntheticCampaigns=new Set(rows(db,'campaign').filter(r=>r.purpose==='synthetic_qa'||r.synthetic===true||r.syntheticOnly===true).map(r=>r.id));
 syntheticCampaigns.add('SYNTHETIC-ONLY-NO-CAMPAIGN');
 const knownSynthetic=x=>x.synthetic===true||x.syntheticOnly===true||x.spec?.synthetic===true||x.settings?.syntheticOnly===true||syntheticCampaigns.has(x.campaignId)||syntheticCandidates.has(x.candidateId??(x.email?getRecord(db,'contact',x.email)?.candidateId:null));
 const belongs=x=>(!campaignId||x.campaignId===campaignId)&&(includeSynthetic||!knownSynthetic(x)),unique=values=>new Set(values).size;
 const batches=db.prepare('SELECT b.* FROM batches b WHERE version=(SELECT max(version) FROM batches WHERE batch_id=b.batch_id)').all().map(b=>({...b,content:JSON.parse(b.content_json)})).filter(b=>belongs(b.content)).map(b=>({...b,content:{...b.content,recipients:b.content.recipients.filter(r=>belongs({...r,campaignId:b.content.campaignId}))}}));
 const prepared=batches.flatMap(b=>b.content.recipients.map(r=>`${b.content.campaignId}:${r.email}`));
 const approved=batches.flatMap(b=>b.content.recipients.filter(r=>r.writing&&evaluateWritingReview(db,r.writing.reviewId,r.writing.decisionId,at).contentApproved).map(r=>`${b.content.campaignId}:${r.email}`));
 const packets=rows(db,'writing_current').map(r=>getRecord(db,'writing_packet',r.packetHash)).filter(p=>p&&belongs(p));
 prepared.push(...packets.map(p=>`${p.campaignId}:${p.email}`));
 for(const d of rows(db,'writing_decision')){
  const p=packets.find(p=>p.hash===d.packetHash);
  if(p&&evaluateWritingReview(db,d.reviewId,d.id,at).contentApproved)approved.push(`${p.campaignId}:${p.email}`);
 }
 const handoffApproved=batches.filter(b=>db.prepare("SELECT id FROM approvals WHERE batch_id=? AND version=? AND hash=? AND decision='APPROVED' AND created_at<=? AND expires_at>?").get(b.batch_id,b.version,b.hash,at,at)).flatMap(b=>b.content.recipients.map(r=>`${b.content.campaignId}:${r.email}`));
 const imported=[...rows(db,'provider_lead_mapping'),...rows(db,'handoff_import').filter(r=>r.status==='IMPORTED')].filter(belongs).map(r=>`${r.campaignId}:${r.email}`);
 const events=rows(db,'provider_event').filter(r=>belongs({...r.event,candidateId:r.candidateId})).map(r=>r.event),local=values=>({observedCount:unique(values),total:unique(values),scope:'LOCAL_RECORDS',unit:'unique campaign/contact'}),remote=type=>({observedCount:unique(events.filter(e=>e.type===type).map(e=>`${e.campaignId}:${e.email}`)),total:null,scope:'OBSERVED_EVENTS_ONLY',unit:'unique campaign/contact',unknownReason:'Remote coverage and totals have not been demonstrated'});
 return {asOf:at,campaignId:campaignId??null,population:includeSynthetic?'PROSPECTS_AND_SYNTHETIC':'PROSPECTS_ONLY',prepared:local(prepared),approved:local(approved),handoffApproved:local(handoffApproved),imported:local(imported),scheduled:remote('SCHEDULED'),sent:remote('SENT'),bounced:remote('BOUNCED'),replied:remote('REPLIED'),health:rows(db,'monitor_health').filter(r=>!r.campaignId||belongs(r)),escalations:rows(db,'monitor_escalation').filter(r=>!r.campaignId||belongs(r)),notifications:rows(db,'reply_notification').filter(belongs).map(({id,status,attempts})=>({id,status,attempts})),liveMonitoringEnabled:false,providerDecoder:'CAPTURED_RECEIVED_VARIANT_REQUIRES_APPROVED_PAGINATION_CONTRACT',autonomousRepliesEnabled:false};
}
