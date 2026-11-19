// Exact-content Telegram delivery bindings. Imports/previews never load a token,
// start a consumer, enable dispatch, approve content, or send a message.
import {canonical,digest,required,timestamp,decimal} from './values.mjs';
import {getRecord,putRecord,transaction,journal,controls,now} from './store.mjs';
import {reserveOperation,beginOperation,recordOutcome,reconcileOperation,operation,budgetStatus} from './operations.mjs';
import {renderReplyNotification,dispatchScopedReplyNotification,recoverMonitoring,monitoringReport} from './monitoring.mjs';
import {createTelegramConsumerApi} from './telegram-api.mjs';
import {assertMonitoringFixtureIsolation} from './monitoring-isolation.mjs';

const hash=value=>digest(canonical(value));
const positive=value=>Number.isSafeInteger(value)&&value>0;
function fixtureIsolation(db,preview){
 if(preview.kind==='REPLY_NOTIFICATION'){
  const n=getRecord(db,'reply_notification',preview.subjectId);
  assertMonitoringFixtureIsolation(db,{bindingId:preview.destination.bindingId,campaignId:n.campaignId,candidateId:n.candidateId,email:n.email});
 }else assertMonitoringFixtureIsolation(db,{bindingId:preview.destination.bindingId,campaignId:preview.scope.campaignId});
}
function pairing(db,bindingId='primary'){
 const b=getRecord(db,'telegram_binding',bindingId);
 if(b?.confirmed!==true||![b.userId,b.chatId,b.botId].every(positive)||b.chatId!==b.userId||b.chatType&&b.chatType!=='private')throw Error('MONITOR_PRIVATE_PAIRING_REQUIRED');
 return {bindingId,userId:b.userId,chatId:b.chatId,botId:b.botId};
}
function contentHash(preview){return hash({kind:preview.kind,subjectId:preview.subjectId,destination:preview.destination,pages:preview.pages,snapshotHash:preview.snapshotHash??null});}
function validatePreview(preview){
 if(!preview||!['REPLY_NOTIFICATION','MONITORING_REPORT'].includes(preview.kind)||!Array.isArray(preview.pages)||preview.pages.length!==1||Object.keys(preview.pages[0]).join(',')!=='text'||typeof preview.pages[0].text!=='string'||!preview.pages[0].text.length||preview.pages[0].text.length>4096||contentHash(preview)!==preview.contentHash)throw Error('MONITOR_DELIVERY_CONTENT_MISMATCH');
 if(preview.report&&hash(preview.report)!==preview.snapshotHash)throw Error('MONITOR_DELIVERY_CONTENT_MISMATCH');
 required(preview.subjectId);return preview;
}
export function previewReplyDelivery(db,id){
 required(id);const n=getRecord(db,'reply_notification',id);if(!n)throw Error('MONITOR_NOTIFICATION_UNKNOWN');
 const destination=pairing(db,n.destination.bindingId);if(canonical(destination)!==canonical(n.destination))throw Error('MONITOR_PAIRING_CHANGED');
 const payload=renderReplyNotification(db,id),preview={kind:'REPLY_NOTIFICATION',subjectId:id,destination,pages:[{text:payload.text}]};
 return validatePreview({...preview,contentHash:contentHash(preview)});
}
/** Creates a local immutable snapshot. PREVIEW is not a send authorization. */
export function prepareMonitoringReportDelivery(db,input={},at=now()){
 const {reportId,campaignId=null,includeSynthetic=false,destinationBindingId='primary'}=input;required(reportId);timestamp(at);
 if(campaignId!==null)required(campaignId);if(typeof includeSynthetic!=='boolean')throw Error('MONITOR_REPORT_SCOPE_INVALID');
 const scope={campaignId,includeSynthetic,destinationBindingId},existing=getRecord(db,'monitor_report_delivery',reportId);
 if(existing){if(canonical(existing.scope)!==canonical(scope))throw Error('MONITOR_REPORT_SCOPE_MISMATCH');return validatePreview(existing);}
 const report=monitoringReport(db,{...(campaignId?{campaignId}:{}),includeSynthetic},at);
 const lines=['Outreach monitoring report',`As of: ${at}`,`Campaign: ${campaignId??'all locally recorded campaigns'}`,`Population: ${report.population}`,'',...['prepared','approved','handoffApproved','imported'].map(k=>`${({prepared:'Prepared',approved:'Content approved',handoffApproved:'Handoff approved',imported:'Imported'})[k]}: ${report[k].observedCount} local`),'',...['scheduled','sent','bounced','replied'].map(k=>`${k[0].toUpperCase()+k.slice(1)}: ${report[k].observedCount} observed`),'Remote totals: unknown; observed events are not complete remote coverage.',`Monitoring failures: ${report.health.filter(h=>h.state==='FAILED').length}`,`Notifications requiring reconciliation: ${report.notifications.filter(n=>n.status==='RECONCILIATION').length}`,'','Review replies manually. No automatic replies are enabled.'];
 const preview={kind:'MONITORING_REPORT',subjectId:reportId,destination:pairing(db,destinationBindingId),pages:[{text:lines.join('\n')}],snapshotHash:hash(report)};
 const open=report.escalations.filter(e=>e.status==='OPEN');
 preview.pages[0].text+=`\nOpen reply escalations: ${open.length}`;
 for(const escalation of open.slice(0,5))preview.pages[0].text+=`\n${escalation.code} (${escalation.streamId.slice(0,80)}): ${escalation.evidenceRef.slice(0,160)}`;
 if(open.length>5)preview.pages[0].text+='\nAdditional escalations remain in the local monitoring report.';
 const record=validatePreview({...preview,contentHash:contentHash(preview),report,scope,status:'PREVIEW',attempts:0,maxAttempts:2,operationId:null,createdAt:at,updatedAt:at});
 transaction(db,()=>{putRecord(db,'monitor_report_delivery',reportId,record,'assessment');journal(db,'MONITOR_REPORT_PREVIEWED',reportId,{contentHash:record.contentHash,snapshotHash:record.snapshotHash});});return record;
}
function authority(db,preview,api,options,{setup=false}={}){
 if(options.enabled!==true)throw Error('MONITOR_DELIVERY_DISABLED');validatePreview(preview);
 if(options.signal?.aborted)throw Error('MONITOR_JOB_ABORTED');
 if(options.assertDispatch!==undefined){if(typeof options.assertDispatch!=='function')throw Error('MONITOR_DISPATCH_ASSERTION_REQUIRED');options.assertDispatch();}
 if(!['OFFLINE_FIXTURE','AUTHORIZED_TELEGRAM_OPERATIONAL'].includes(api?.mode)||typeof api.sendPage!=='function')throw Error('MONITOR_TELEGRAM_TRANSPORT_REQUIRED');
 if(api.mode==='OFFLINE_FIXTURE')fixtureIsolation(db,preview);
 const grant=getRecord(db,'monitor_delivery_authorization',options.authorizationId);
 if(grant?.id!==options.authorizationId||grant.status!=='APPROVED'||grant.enabled!==true)throw Error('MONITOR_DELIVERY_AUTHORIZATION_REQUIRED');
 if(grant.kind!==preview.kind||grant.subjectId!==preview.subjectId||grant.contentHash!==preview.contentHash||canonical(grant.destination)!==canonical(preview.destination)||grant.transportMode!==api.mode)throw Error('MONITOR_DELIVERY_CONTENT_AUTHORITY_MISMATCH');
 const at=(options.clock??now)();if(timestamp(at)<timestamp(grant.approvedAt)||timestamp(at)>=timestamp(grant.expiresAt))throw Error('MONITOR_DELIVERY_AUTHORIZATION_EXPIRED');
 if(!positive(grant.timeoutMs)||grant.timeoutMs>25000)throw Error('MONITOR_DELIVERY_TIMEOUT_REQUIRED');required(grant.budgetId);required(grant.evidenceRef);
 if(controls(db).stopped)throw Error('MONITOR_SYSTEM_STOPPED');
 if(canonical(pairing(db,preview.destination.bindingId))!==canonical(preview.destination))throw Error('MONITOR_PAIRING_CHANGED');
 if(budgetStatus(db,grant.budgetId).blocked)throw Error('Budget blocked');
 const timeoutMs=Math.min(grant.timeoutMs,timestamp(grant.expiresAt)-timestamp(at));
 const request={method:'sendMessage',chatId:preview.destination.chatId,page:preview.pages[0],timeoutMs,authorizationId:options.authorizationId};
 if(api.mode==='AUTHORIZED_TELEGRAM_OPERATIONAL'&&!setup){const checker=options.assertAuthority??api.assertAuthority;if(typeof checker!=='function'||checker(request)!==true)throw Error('MONITOR_TELEGRAM_REQUEST_AUTHORITY_REQUIRED');}
 if(api.mode==='AUTHORIZED_TELEGRAM_OPERATIONAL'&&(grant.requestCostUsd!=='0'||typeof grant.costEvidenceRef!=='string'||!grant.costEvidenceRef.trim()))throw Error('MONITOR_TELEGRAM_COST_EVIDENCE_REQUIRED');
 return {...grant,timeoutMs};
}
function storedPreview(db,preview){
 const current=preview.kind==='REPLY_NOTIFICATION'?previewReplyDelivery(db,preview.subjectId):getRecord(db,'monitor_report_delivery',preview.subjectId);
 validatePreview(current);if(current.contentHash!==preview.contentHash)throw Error('MONITOR_DELIVERY_CONTENT_CHANGED');return current;
}
/** Optional production composition. The caller supplies the existing protected
 * credential loader. It runs only after persisted exact-content authority passes.
 * The existing Telegram transport enforces timeout and socket cleanup. Expose no
 * identity/read/poll methods, and permit only the approved sendMessage body. */
export async function createMonitoringTelegramApi(db,preview,options={}, {createApi=createTelegramConsumerApi}={}){
 if(typeof options.loadToken!=='function')throw Error('MONITOR_CREDENTIAL_LOADER_REQUIRED');
 const shape={mode:'AUTHORIZED_TELEGRAM_OPERATIONAL',sendPage(){}};
 const check=()=>authority(db,storedPreview(db,preview),shape,options,{setup:true});check();
 const source=getRecord(db,preview.kind==='REPLY_NOTIFICATION'?'reply_notification':'monitor_report_delivery',preview.subjectId);
 if(['DISPATCHING','RECONCILIATION'].includes(source?.status)||db.prepare("SELECT id FROM operations WHERE status IN ('DISPATCHING','RECONCILIATION') LIMIT 1").get())throw Error('MONITOR_DELIVERY_RECONCILIATION_REQUIRED');
 if(!['PENDING','PREVIEW'].includes(source?.status)||source.attempts>=source.maxAttempts)throw Error('MONITOR_DELIVERY_TERMINAL');
 const checkRequest=request=>{
  const grant=check();if(request.method!=='sendMessage'||request.chatId!==preview.destination.chatId||canonical(request.page)!==canonical(preview.pages[0])||request.authorizationId!==options.authorizationId||!positive(request.timeoutMs)||request.timeoutMs>grant.timeoutMs)throw Error('MONITOR_TELEGRAM_REQUEST_SCOPE');return true;
 };
 let api;
 try{
  const token=await options.loadToken();check();
  api=createApi(token,(method,body,ms)=>{
   const grant=check(),expected={chat_id:preview.destination.chatId,...preview.pages[0],allow_paid_broadcast:false,link_preview_options:{is_disabled:true}};
   if(method!=='sendMessage'||canonical(body)!==canonical(expected)||!positive(ms)||ms>grant.timeoutMs)throw Error('MONITOR_TELEGRAM_REQUEST_SCOPE');
   transaction(db,()=>{
    const current=getRecord(db,preview.kind==='REPLY_NOTIFICATION'?'reply_notification':'monitor_report_delivery',preview.subjectId),op=current&&operation(db,current.operationId);
    const intent=op&&JSON.parse(op.intent_json),receiptId=`${preview.kind}:${preview.subjectId}:${current?.attempts}`,receipt=getRecord(db,'monitor_delivery_receipt',receiptId);
    if(current?.status!=='DISPATCHING'||op?.status!=='DISPATCHING'||op.kind!=='NOTIFY'||op.budget_id!==grant.budgetId||intent.authorizationRef!==options.authorizationId||intent.payload[preview.kind==='REPLY_NOTIFICATION'?'notificationId':'reportId']!==preview.subjectId||receipt?.status!=='INTENT'||receipt.contentHash!==preview.contentHash||receipt.authorizationId!==options.authorizationId)throw Error('MONITOR_TELEGRAM_DISPATCH_INTENT_REQUIRED');
    putRecord(db,'monitor_delivery_receipt',receiptId,{...receipt,status:'API_DISPATCHING',operationId:op.id},'confirmed');
   });
   return Math.min(ms,grant.timeoutMs);
  });
 }catch{throw Error('MONITOR_CREDENTIAL_SETUP_FAILED');}
 return Object.freeze({mode:api.mode,sendPage:api.sendPage,close:api.close,assertAuthority:checkRequest});
}
async function sendBounded(api,preview,timeoutMs,signal){
 let timer,onAbort;const cancelled=new Promise((_,reject)=>{onAbort=()=>reject(Error('MONITOR_TELEGRAM_ABORTED'));signal?.addEventListener('abort',onAbort,{once:true});if(signal?.aborted)onAbort();timer=setTimeout(()=>reject(Error('MONITOR_TELEGRAM_TIMEOUT')),timeoutMs);});
 try{return await Promise.race([cancelled,api.sendPage(preview.destination.chatId,preview.pages[0],timeoutMs)]);}finally{clearTimeout(timer);signal?.removeEventListener('abort',onAbort);}
}
function boundTransport(db,preview,api,options,attempt){
 const assertBoundary=()=>authority(db,storedPreview(db,preview),api,options);
 return {mode:'SCOPED_TELEGRAM_MONITORING',assertBoundary,async send(payload){
  let grant;
  // A gate change before calling the API is definitive no-dispatch. After the
  // invocation, even malformed results remain uncertain and cannot auto-replay.
  try{grant=assertBoundary();if(payload.chatId!==preview.destination.chatId||payload.text!==preview.pages[0].text)throw Error();}
  catch{return {status:'NOT_DISPATCHED',actualUsd:'0',evidenceRef:'local:monitor-delivery-boundary-rejected-before-api'};}
  const id=`${preview.kind}:${preview.subjectId}:${attempt}`,at=(options.clock??now)();
  putRecord(db,'monitor_delivery_receipt',id,{status:'INTENT',contentHash:preview.contentHash,destination:preview.destination,authorizationId:options.authorizationId,attempt,at},'confirmed');
  try{
   const r=await sendBounded(api,preview,grant.timeoutMs,options.signal);
   if(!positive(r?.message_id)||r.chat?.id!==preview.destination.chatId||r.chat?.type!=='private'||r.from?.id!==preview.destination.botId||r.from?.is_bot!==true)throw Error('MONITOR_TELEGRAM_ACCEPTANCE_MISMATCH');
   putRecord(db,'monitor_delivery_receipt',id,{status:'ACCEPTED',acceptance:'TELEGRAM_API_ACCEPTED',contentHash:preview.contentHash,destination:preview.destination,authorizationId:options.authorizationId,attempt,messageId:r.message_id,at:(options.clock??now)(),recipientReadProven:false},'provider_result');
   return {status:'DELIVERED',actualUsd:'0',remoteId:String(r.message_id),evidenceRef:`monitor_delivery_receipt:${id}`};
  }catch{
   putRecord(db,'monitor_delivery_receipt',id,{status:'UNCERTAIN',contentHash:preview.contentHash,destination:preview.destination,authorizationId:options.authorizationId,attempt,at:(options.clock??now)(),automaticReplayPermitted:false},'assessment');
   return {status:'UNCERTAIN',actualUsd:null,evidenceRef:`monitor_delivery_receipt:${id}`};
  }
 }};
}
export async function deliverReplyNotification(db,id,api,options={}){
 const preview=previewReplyDelivery(db,id),grant=authority(db,preview,api,options),n=getRecord(db,'reply_notification',id);
 return dispatchScopedReplyNotification(db,id,boundTransport(db,preview,api,options,n.attempts+1),{authorizationRef:options.authorizationId,budgetId:grant.budgetId,expiresAt:grant.expiresAt,allowWhileStopped:false,at:(options.clock??now)()});
}
function reportOutcome(db,id,receipt,at,reconciliation=false){
 required(receipt.evidenceRef);if(!['DELIVERED','NOT_DISPATCHED','UNCERTAIN'].includes(receipt.status))throw Error('MONITOR_REPORT_RECEIPT_INVALID');if(receipt.actualUsd!==null)decimal(receipt.actualUsd);
 if(receipt.status==='DELIVERED')required(receipt.remoteId);if(receipt.status==='NOT_DISPATCHED'&&receipt.actualUsd!=='0')throw Error('MONITOR_REPORT_RECEIPT_INVALID');
 return transaction(db,()=>{
  const r=getRecord(db,'monitor_report_delivery',id),expected=reconciliation?'RECONCILIATION':'DISPATCHING';if(r?.status!==expected||operation(db,r.operationId)?.status!==expected)throw Error('MONITOR_REPORT_OPERATION_STATE');
  const op=(reconciliation?reconcileOperation:recordOutcome)(db,r.operationId,{status:receipt.status==='DELIVERED'?'SUCCEEDED':receipt.status==='NOT_DISPATCHED'?'FAILED':'AMBIGUOUS',actual:receipt.actualUsd,remoteId:receipt.remoteId??null,evidence:receipt.evidenceRef});
  const status=op.status==='RECONCILIATION'?'RECONCILIATION':receipt.status==='DELIVERED'?'DELIVERED':r.attempts<r.maxAttempts?'PREVIEW':'FAILED';
  const next={...r,status,evidenceRef:receipt.evidenceRef,remoteId:receipt.remoteId??null,updatedAt:at};putRecord(db,'monitor_report_delivery',id,next,'assessment');journal(db,'MONITOR_REPORT_DELIVERY_OUTCOME',id,{status,evidenceRef:receipt.evidenceRef});return next;
 });
}
export async function deliverMonitoringReport(db,id,api,options={}){
 let report=getRecord(db,'monitor_report_delivery',id);if(!report)throw Error('MONITOR_REPORT_PREVIEW_REQUIRED');const grant=authority(db,report,api,options);
 if(report.status==='DELIVERED')return report;if(['DISPATCHING','RECONCILIATION'].includes(report.status))throw Error('MONITOR_REPORT_RECONCILIATION_REQUIRED');
 if(report.status!=='PREVIEW'||report.attempts>=report.maxAttempts)throw Error('MONITOR_REPORT_ATTEMPTS_EXHAUSTED');
 const attempt=report.attempts+1,operationId=`monitor-report:${id}:${attempt}`,at=(options.clock??now)();
 const transport=boundTransport(db,report,api,options,attempt);
 reserveOperation(db,{id:operationId,kind:'NOTIFY',budgetId:grant.budgetId,reservation:'0',authorizationRef:options.authorizationId,payload:{reportId:id,contentHash:report.contentHash,attempt,destinationHash:hash(report.destination)}});
 beginOperation(db,operationId,at,()=>{transport.assertBoundary();const current=getRecord(db,'monitor_report_delivery',id);if(current.status!=='PREVIEW'||current.attempts+1!==attempt)throw Error('MONITOR_REPORT_CONCURRENT_CLAIM');report={...current,status:'DISPATCHING',attempts:attempt,operationId,updatedAt:at};putRecord(db,'monitor_report_delivery',id,report,'assessment');});
 let receipt;try{receipt=await transport.send({chatId:report.destination.chatId,text:report.pages[0].text});}catch{receipt={status:'UNCERTAIN',actualUsd:null,evidenceRef:'local:report-delivery-failed-reconcile'};}
 return reportOutcome(db,id,receipt,(options.clock??now)());
}
export function reconcileMonitoringReport(db,id,receipt,at=now()){
 timestamp(at);if(receipt.status==='UNCERTAIN')throw Error('MONITOR_DEFINITIVE_RECONCILIATION_REQUIRED');return reportOutcome(db,id,receipt,at,true);
}
export function recoverMonitoringDeliveries(db,at=now()){
 timestamp(at);const replies=recoverMonitoring(db,at);
 const reports=transaction(db,()=>db.prepare("SELECT id,data_json FROM records WHERE kind='monitor_report_delivery'").all().map(row=>JSON.parse(row.data_json)).filter(r=>r.status==='DISPATCHING').map(r=>{
  const op=operation(db,r.operationId);if(op?.status==='DISPATCHING')db.prepare("UPDATE operations SET status='RECONCILIATION',updated_at=? WHERE id=?").run(at,r.operationId);
  const status=op?.status==='SUCCEEDED'?'DELIVERED':op?.status==='FAILED'?(r.attempts<r.maxAttempts?'PREVIEW':'FAILED'):'RECONCILIATION';const next={...r,status,updatedAt:at};putRecord(db,'monitor_report_delivery',r.subjectId,next,'assessment');journal(db,'MONITOR_REPORT_RECOVERED',r.subjectId,{status});return next;
 }));return {replies,reports};
}
