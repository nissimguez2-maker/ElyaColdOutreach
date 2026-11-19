// No Instantly field, request or pagination schema is inferred here. The supplied
// decoder/transport are trusted adapters implementing an explicitly reviewed contract.
import {canonical,digest,required,timestamp,decimal} from './values.mjs';
import {getRecord,putRecord,transaction,journal,controls,now} from './store.mjs';
import {reserveOperation,beginOperation,recordOutcome,reconcileOperation,operation} from './operations.mjs';
import {ingestReplyPage,validateNormalizedProviderEvent,recordMonitoringFailure} from './monitoring.mjs';
import {assertMonitoringFixtureIsolation} from './monitoring-isolation.mjs';

const hash=value=>digest(canonical(value));
const exact=(value,keys,optional=[])=>{canonical(value);if(!value||Object.getPrototypeOf(value)!==Object.prototype||keys.some(k=>!Object.hasOwn(value,k))||Object.keys(value).some(k=>![...keys,...optional].includes(k)))throw Error('MONITOR_PROVIDER_CONTRACT_SHAPE');};
const boundedInteger=(value,min,max)=>Number.isSafeInteger(value)&&value>=min&&value<=max;
const safeCode=error=>/^(?:MONITOR|OBSERVED_REPLY)_[A-Z0-9_]+$/.test(error?.message)?error.message:'MONITOR_PROVIDER_PAGE_INVALID';
function contractShape(contract){
 exact(contract,['id','version','provider','basis','scope','pagination','evidence'],['adapter']);
 if(contract.version!==1||contract.provider!=='instantly'||!['SYNTHETIC_FIXTURE','APPROVED_SAVED_EVIDENCE'].includes(contract.basis)||contract.scope!=='EXACT_CAMPAIGN'||contract.pagination!=='OPAQUE_CURSOR_NULL_END')throw Error('MONITOR_PROVIDER_CONTRACT_UNSUPPORTED');
 required(contract.id);exact(contract.evidence,['request','response','pagination','identity','timestamps','cost']);for(const ref of Object.values(contract.evidence))required(ref);
 if(contract.basis==='APPROVED_SAVED_EVIDENCE'&&[contract.id,...Object.values(contract.evidence)].some(value=>/^(?:fixture|synthetic)(?:[:_-]|$)/i.test(value)))throw Error('MONITOR_SYNTHETIC_EVIDENCE_NOT_PROVIDER_CONTRACT');
}
/** A synthetic decoder is valid only with an offline transport and synthetic
 * campaign. Operational decoding additionally needs this exact approved contract
 * in monitor_provider_contract. No approved real contract ships with this module. */
export function createProviderReplyDecoder({contract,decodePage}={}){
 if(!contract||typeof decodePage!=='function')throw Error('MONITOR_PROVIDER_CONTRACT_REQUIRED');contractShape(contract);
 const spec=structuredClone(contract),contractHash=hash(spec);
 return Object.freeze({contract:structuredClone(spec),contractHash,decode(payload,context){
  if(canonical(payload).length>1048576)throw Error('MONITOR_PROVIDER_RESPONSE_BOUND');
  const result=decodePage(structuredClone(payload),Object.freeze({...context}));exact(result,['events','nextCursor']);
  if(!Array.isArray(result.events)||result.events.length>context.pageSize)throw Error('MONITOR_PROVIDER_PAGE_BOUND');
  if(result.nextCursor!==null&&(typeof result.nextCursor!=='string'||!result.nextCursor.length||result.nextCursor.length>2000))throw Error('MONITOR_PROVIDER_CURSOR_INVALID');
  const events=result.events.map(event=>validateNormalizedProviderEvent(event,context.at));
  if(events.some(event=>event.campaignId!==context.campaignId))throw Error('MONITOR_PROVIDER_CAMPAIGN_MISMATCH');
  return {events,nextCursor:result.nextCursor};
 }});
}
function authorize(db,o,at,{request=null}={}){
 if(o.enabled!==true)throw Error('MONITOR_POLL_DISABLED');
 if(o.signal?.aborted)throw Error('MONITOR_JOB_ABORTED');
 if(o.assertDispatch!==undefined){if(typeof o.assertDispatch!=='function')throw Error('MONITOR_DISPATCH_ASSERTION_REQUIRED');o.assertDispatch();}
 const d=o.decoder;if(!d||typeof d.decode!=='function'||!d.contract)throw Error('MONITOR_PROVIDER_CONTRACT_REQUIRED');contractShape(d.contract);
 if(hash(d.contract)!==d.contractHash)throw Error('MONITOR_PROVIDER_CONTRACT_CHANGED');
 if(!['offline','authorized-provider'].includes(o.transport?.mode)||typeof o.transport.fetchPage!=='function')throw Error('MONITOR_PROVIDER_TRANSPORT_REQUIRED');
 if(o.transport.assertReady!==undefined){if(typeof o.transport.assertReady!=='function')throw Error('MONITOR_PROVIDER_TRANSPORT_REQUIRED');o.transport.assertReady();}
 if(o.transport.mode==='offline')assertMonitoringFixtureIsolation(db,{bindingId:o.destinationBindingId,campaignId:o.campaignId});
 if(d.contract.basis==='SYNTHETIC_FIXTURE'){
  const campaign=getRecord(db,'campaign',o.campaignId);
  if(o.transport.mode!=='offline')throw Error('MONITOR_SYNTHETIC_TRANSPORT_ONLY');
  if(!(campaign?.synthetic===true||campaign?.syntheticOnly===true||campaign?.purpose==='synthetic_qa'))throw Error('MONITOR_SYNTHETIC_CAMPAIGN_REQUIRED');
 }else{
  const saved=getRecord(db,'monitor_provider_contract',d.contract.id);
  if(saved?.status!=='APPROVED'||saved.contractHash!==d.contractHash||canonical(saved.contract)!==canonical(d.contract))throw Error('MONITOR_APPROVED_PROVIDER_CONTRACT_REQUIRED');
  required(saved.evidenceRef);required(saved.approvedBy);timestamp(saved.approvedAt);
 }
 const grant=getRecord(db,'monitor_poll_authorization',o.authorizationId);
 if(grant?.id!==o.authorizationId||grant.status!=='APPROVED'||grant.enabled!==true)throw Error('MONITOR_POLL_AUTHORIZATION_REQUIRED');
 if(['streamId','campaignId'].some(k=>grant[k]!==o[k])||grant.contractHash!==d.contractHash||grant.transportMode!==o.transport.mode)throw Error('MONITOR_POLL_SCOPE_MISMATCH');
 if(timestamp(at)<timestamp(grant.approvedAt)||timestamp(at)>=timestamp(grant.expiresAt))throw Error('MONITOR_POLL_AUTHORIZATION_EXPIRED');
 if(!boundedInteger(grant.maxPages,1,100)||!boundedInteger(grant.pageSize,1,1000)||!boundedInteger(grant.timeoutMs,1,25000)||o.pageSize>grant.pageSize||o.timeoutMs>grant.timeoutMs)throw Error('MONITOR_POLL_AUTHORIZATION_BOUND');
 required(grant.budgetId);required(grant.evidenceRef);decimal(grant.reservationUsd);
 if(controls(db).stopped)throw Error('MONITOR_SYSTEM_STOPPED');
 if(request&&o.transport.mode==='authorized-provider'&&(typeof o.transport.assertAuthority!=='function'||o.transport.assertAuthority({...request,authorizationId:o.authorizationId,contractHash:d.contractHash})!==true))throw Error('MONITOR_PROVIDER_REQUEST_AUTHORITY_REQUIRED');
 return grant;
}
function saveRun(db,run){putRecord(db,'monitor_poll_run',run.runId,run,'assessment');journal(db,'MONITOR_POLL_STATE',run.runId,{status:run.status,pages:run.pages,reason:run.reason??null});return run;}
async function readBounded(transport,request,outerSignal){
 const abort=new AbortController();let timer,onAbort;
 const signal=outerSignal?AbortSignal.any([outerSignal,abort.signal]):abort.signal;
 const cancelled=new Promise((_,reject)=>{onAbort=()=>reject(Error('MONITOR_PROVIDER_READ_ABORTED'));signal.addEventListener('abort',onAbort,{once:true});if(signal.aborted)onAbort();});
 try{timer=setTimeout(()=>abort.abort(),request.timeoutMs);return await Promise.race([cancelled,transport.fetchPage({...request,signal})]);}
 finally{clearTimeout(timer);signal.removeEventListener('abort',onAbort);}
}
/** Bounded single invocation. No timer, credentials, default transport or grant
 * issuance. Successful raw reads are costed before decoding; received pages can
 * resume locally after STOP without another provider request. */
export async function pollProviderReplies(db,input={}){
 const o={enabled:false,maxPages:1,pageSize:100,timeoutMs:10000,destinationBindingId:'primary',clock:now,...input};
 for(const k of ['runId','streamId','campaignId','authorizationId','destinationBindingId'])required(o[k],k);
 if(!boundedInteger(o.maxPages,1,100)||!boundedInteger(o.pageSize,1,1000)||!boundedInteger(o.timeoutMs,1,25000)||typeof o.clock!=='function')throw Error('MONITOR_POLL_BOUND_REQUIRED');
 authorize(db,o,o.clock());
 const scopeHash=hash({streamId:o.streamId,campaignId:o.campaignId,authorizationId:o.authorizationId,contractHash:o.decoder.contractHash,pageSize:o.pageSize,destinationBindingId:o.destinationBindingId});
 let run=getRecord(db,'monitor_poll_run',o.runId);
 if(run&&run.scopeHash!==scopeHash)throw Error('MONITOR_POLL_RUN_SCOPE_MISMATCH');
 if(run?.status==='COMPLETE')return run;
 if(run?.status==='CLOSED')throw Error('MONITOR_POLL_NEW_RUN_REQUIRED');
 if(run&&['RECONCILIATION','RUNNING','FAILED'].includes(run.status))throw Error('MONITOR_POLL_RECONCILIATION_REQUIRED');
 run??={runId:o.runId,streamId:o.streamId,campaignId:o.campaignId,scopeHash,status:'PAUSED',pages:0,pendingPageId:null,activeOperationId:null};
 for(let i=0;i<o.maxPages;i++){
  let page=run.pendingPageId?getRecord(db,'monitor_poll_page',run.pendingPageId):null;
  if(!page){
   const at=o.clock(),grant=authorize(db,o,at),checkpoint=getRecord(db,'monitor_checkpoint',o.streamId);
   if(checkpoint?.campaignId&&checkpoint.campaignId!==o.campaignId)throw Error('MONITOR_POLL_SCOPE_MISMATCH');
   if(checkpoint?.contractHash&&checkpoint.contractHash!==o.decoder.contractHash)throw Error('MONITOR_POLL_CONTRACT_CHANGED_USE_NEW_STREAM');
   if(checkpoint?.complete)return saveRun(db,{...run,status:'COMPLETE',finishedAt:at});
   const usage=getRecord(db,'monitor_poll_usage',o.authorizationId)?.pages??0;if(usage>=grant.maxPages)throw Error('MONITOR_POLL_PAGE_LIMIT');
   const pageId=`${o.runId}:${run.pages+1}`,operationId=`monitor-read:${pageId}`;
   const request={campaignId:o.campaignId,cursor:checkpoint?.cursor??null,pageSize:o.pageSize,timeoutMs:Math.min(o.timeoutMs,timestamp(grant.expiresAt)-timestamp(at))};
   reserveOperation(db,{id:operationId,kind:'READ',budgetId:grant.budgetId,reservation:grant.reservationUsd,authorizationRef:o.authorizationId,payload:{streamId:o.streamId,runId:o.runId,pageId,contractHash:o.decoder.contractHash,request}});
   beginOperation(db,operationId,at,()=>{
    authorize(db,o,o.clock(),{request});
    if((getRecord(db,'monitor_poll_usage',o.authorizationId)?.pages??0)!==usage)throw Error('MONITOR_POLL_CONCURRENT_CLAIM');
    if((getRecord(db,'monitor_checkpoint',o.streamId)?.cursor??null)!==request.cursor)throw Error('MONITOR_CHECKPOINT_MISMATCH');
    putRecord(db,'monitor_poll_usage',o.authorizationId,{pages:usage+1,lastOperationId:operationId},'confirmed');
    run=saveRun(db,{...run,status:'RUNNING',activeOperationId:operationId});
   });
   let response;
   try{
    response=await readBounded(o.transport,request,o.signal);exact(response,['payload','evidenceRef','actualUsd']);required(response.evidenceRef);decimal(response.actualUsd);canonical(response.payload);
   }catch{
    return transaction(db,()=>{recordOutcome(db,operationId,{status:'AMBIGUOUS',actual:null,evidence:'Provider read failed or returned invalid cost evidence; reconcile before replay'});recordMonitoringFailure(db,o.streamId,'MONITOR_PROVIDER_READ_UNCERTAIN','local:uncertain-provider-read',o.clock());return saveRun(db,{...run,status:'RECONCILIATION',reason:'MONITOR_PROVIDER_READ_UNCERTAIN'});});
   }
   // Persist cost plus a response fingerprint/evidence pointer, not raw payload.
   // A crash before the decoded page commits requires a new scoped read run.
   transaction(db,()=>{recordOutcome(db,operationId,{status:'SUCCEEDED',actual:response.actualUsd,evidence:response.evidenceRef});putRecord(db,'monitor_poll_receipt',pageId,{operationId,evidenceRef:response.evidenceRef,payloadHash:hash(response.payload),actualUsd:response.actualUsd,contractHash:o.decoder.contractHash,receivedAt:o.clock()},'provider_result');});
   try{
    const decoded=o.decoder.decode(response.payload,{campaignId:o.campaignId,pageSize:o.pageSize,evidenceRef:response.evidenceRef,at:o.clock()});
    if(decoded.nextCursor!==null&&decoded.nextCursor===request.cursor)throw Error('MONITOR_PROVIDER_CURSOR_STALLED');
    if(decoded.nextCursor!==null&&db.prepare("SELECT data_json FROM records WHERE kind='monitor_page'").all().some(row=>{const receipt=JSON.parse(row.data_json);return receipt.streamId===o.streamId&&receipt.cursor===decoded.nextCursor;}))throw Error('MONITOR_PROVIDER_CURSOR_LOOP');
    page={pageId,status:'RECEIVED',input:{streamId:o.streamId,campaignId:o.campaignId,contractHash:o.decoder.contractHash,expectedCursor:request.cursor,nextCursor:decoded.nextCursor,events:decoded.events,evidenceRef:response.evidenceRef,destinationBindingId:o.destinationBindingId}};
    transaction(db,()=>{putRecord(db,'monitor_poll_page',pageId,page,'provider_result');run=saveRun(db,{...run,status:'PAUSED',pendingPageId:pageId,activeOperationId:null});});
   }catch(error){recordMonitoringFailure(db,o.streamId,safeCode(error),response.evidenceRef,o.clock());saveRun(db,{...run,status:'FAILED',reason:safeCode(error),activeOperationId:null});throw error;}
  }
  try{authorize(db,o,o.clock());}catch(error){if(error.message==='MONITOR_SYSTEM_STOPPED')return saveRun(db,{...run,status:'PAUSED',reason:error.message});throw error;}
  try{
   transaction(db,()=>{
    authorize(db,o,o.clock());
    const result=ingestReplyPage(db,page.input,o.clock());
    putRecord(db,'monitor_poll_page',page.pageId,{...page,status:'APPLIED',appliedAt:o.clock(),result},'confirmed');
    run=saveRun(db,{...run,status:page.input.nextCursor===null?'COMPLETE':'PAUSED',reason:null,pages:run.pages+1,pendingPageId:null,activeOperationId:null});
   });
  }catch(error){
   // An accepted RECEIVED page is durable. A local storage interruption rolls
   // back event, outbox and checkpoint together; retry that page without I/O.
   const invalid=/^(?:MONITOR|OBSERVED_REPLY)_/.test(error?.message??''),code=invalid?safeCode(error):'MONITOR_PAGE_PERSISTENCE_FAILED';
   recordMonitoringFailure(db,o.streamId,code,page.input.evidenceRef,o.clock());saveRun(db,{...run,status:invalid?'FAILED':'PAUSED',reason:code});throw error;
  }
  if(run.status==='COMPLETE')return run;
 }
 return saveRun(db,{...run,status:'PAUSED',reason:'INVOCATION_PAGE_LIMIT'});
}
/** Interruptions never restart a dispatched read; operator reconciliation is
 * required. A RECEIVED page has already settled its read and remains resumable. */
export function recoverProviderReplyPolling(db,at=now()){
 timestamp(at);return transaction(db,()=>db.prepare("SELECT id,data_json FROM records WHERE kind='monitor_poll_run'").all().map(row=>JSON.parse(row.data_json)).filter(run=>run.status==='RUNNING').map(run=>{
  const op=operation(db,run.activeOperationId);
  if(op&&['SUCCEEDED','FAILED'].includes(op.status))return saveRun(db,{...run,status:'CLOSED',reason:'COMPLETED_READ_WITHOUT_PAGE_NEW_RUN_REQUIRED',evidenceRef:op.evidence,closedAt:at});
  if(op?.status==='DISPATCHING')db.prepare("UPDATE operations SET status='RECONCILIATION',updated_at=? WHERE id=?").run(at,op.id);
  return saveRun(db,{...run,status:'RECONCILIATION',reason:'INTERRUPTED_PROVIDER_READ',recoveredAt:at});
 }));
}
/** Explicit operator evidence settles the interrupted READ, without fabricating
 * a response or resetting its cursor. A newly scoped run is needed afterward. */
export function reconcileProviderReplyPolling(db,runId,receipt,at=now()){
 required(runId);timestamp(at);exact(receipt,['status','actualUsd','evidenceRef']);required(receipt.evidenceRef);decimal(receipt.actualUsd);
 if(!['READ_CONFIRMED','NOT_DISPATCHED'].includes(receipt.status)||receipt.status==='NOT_DISPATCHED'&&receipt.actualUsd!=='0')throw Error('MONITOR_POLL_RECONCILIATION_RECEIPT');
 return transaction(db,()=>{
  const run=getRecord(db,'monitor_poll_run',runId),op=run&&operation(db,run.activeOperationId);
  if(run?.status!=='RECONCILIATION'||op?.status!=='RECONCILIATION')throw Error('MONITOR_POLL_RECONCILIATION_REQUIRED');
  reconcileOperation(db,op.id,{status:receipt.status==='READ_CONFIRMED'?'SUCCEEDED':'FAILED',actual:receipt.actualUsd,evidence:receipt.evidenceRef});
  return saveRun(db,{...run,status:'CLOSED',reason:'RECONCILED_WITHOUT_REPLY_PAGE',evidenceRef:receipt.evidenceRef,closedAt:at});
 });
}
