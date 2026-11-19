// Optional provider-neutral boundary. No provider SDK, credentials, network,
// model choice or subscription-to-API assumption is made in this module.
import {canonical,digest,required,timestamp,decimal,compareMoney,addMoney,assertSafe} from './values.mjs';
import {getRecord,putRecord,transaction,journal,controls,now} from './store.mjs';
import {reserveOperation,beginOperation,recordOutcome,reconcileOperation,operation,budgetStatus} from './operations.mjs';
import {previewDraftingContext} from './writing.mjs';
import {validateDraftingPacket,createDraftProvenanceTemplate,prepareAssistedImport,createCriticalReviewPacket,validateCriticalReviewResult} from './drafting-handoff.mjs';

const hash=value=>digest(canonical(value)),active=new WeakMap(),VERSION='elya-drafting-caller-v1';
const clone=value=>JSON.parse(canonical(value));
function exact(value,keys,error){if(!value||Object.getPrototypeOf(value)!==Object.prototype||Object.keys(value).some(k=>!keys.includes(k))||keys.some(k=>!Object.hasOwn(value,k)))throw Error(error);}
function bound(value,min,max){return Number.isSafeInteger(value)&&value>=min&&value<=max;}
export function validateDraftingCallerConfig(input={}){
 canonical(input);
 if(input.enabled===undefined||input.enabled===false){if(Object.keys(input).some(k=>!['enabled','version'].includes(k))||input.version!==undefined&&input.version!==VERSION)throw Error('DRAFTING_DISABLED_CONFIG_SHAPE');return {version:VERSION,enabled:false};}
 exact(input,['version','enabled','interface','provider','generation','review','timeoutMs','maxInputBytes','maxOutputBytes','maxOutputTokens','maxRevisions','chargeContract'],'DRAFTING_CONFIG_SHAPE');
 if(input.enabled!==true||input.version!==VERSION||input.interface!=='API'||typeof input.provider!=='string'||!input.provider.trim())throw Error('DRAFTING_EXPLICIT_API_PROVIDER_REQUIRED');
 for(const selection of [input.generation,input.review]){
  exact(selection,['model','settings'],'DRAFTING_MODEL_CONFIG_SHAPE');
  if(typeof selection.model!=='string'||!selection.model.trim()||!selection.settings||Object.getPrototypeOf(selection.settings)!==Object.prototype||Object.keys(selection.settings).some(k=>!['temperature','topP','seed','reasoningEffort'].includes(k)))throw Error('DRAFTING_EXPLICIT_MODEL_SETTINGS_REQUIRED');
 }
 if(!bound(input.timeoutMs,1,120000)||!bound(input.maxInputBytes,1,2000000)||!bound(input.maxOutputBytes,1,200000)||!bound(input.maxOutputTokens,1,16384)||!bound(input.maxRevisions,0,1))throw Error('DRAFTING_BOUNDS_REQUIRED');
 exact(input.chargeContract,['sourceRef','maximumPerCallUsd','coversAllCharges'],'DRAFTING_CHARGE_CONTRACT_SHAPE');
 required(input.chargeContract.sourceRef);decimal(input.chargeContract.maximumPerCallUsd);
 if(input.chargeContract.coversAllCharges!==true||compareMoney(input.chargeContract.maximumPerCallUsd,'0')<=0)throw Error('DRAFTING_CHARGE_CONTRACT_REQUIRED');
 return clone(input);
}
function preflight(db,config,input,at,assertDispatch){
 if(!config.enabled)throw Error('DRAFTING_CALLER_DISABLED');
 if(input.signal?.aborted)throw Error('DRAFTING_ABORTED_BEFORE_DISPATCH');
 if(controls(db).stopped)throw Error('DRAFTING_SYSTEM_STOPPED');
 if(assertDispatch!==undefined){if(typeof assertDispatch!=='function')throw Error('DRAFTING_DISPATCH_GUARD_INVALID');const answer=assertDispatch();if(answer===false||answer?.then)throw Error('DRAFTING_DISPATCH_GUARD_DENIED');}
 required(input.id);validateDraftingPacket(input.packet);timestamp(at);
 exact(input.authority,['budgetId','authorizationRef','notBefore','expiresAt','maximumTotalUsd'],'DRAFTING_AUTHORITY_SHAPE');
 const a=input.authority;required(a.budgetId);required(a.authorizationRef);decimal(a.maximumTotalUsd);
 if(timestamp(a.notBefore)>timestamp(at)||timestamp(a.expiresAt)<=timestamp(at))throw Error('DRAFTING_AUTHORITY_EXPIRED_OR_NOT_YET_VALID');
 let maximum='0';for(let i=0;i<2+config.maxRevisions*2;i++)maximum=addMoney(maximum,config.chargeContract.maximumPerCallUsd);
 if(compareMoney(maximum,a.maximumTotalUsd)>0)throw Error('DRAFTING_CHARGE_AUTHORITY_INSUFFICIENT');
 const sql=db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='operations'").get()?.sql;
 if(!sql||!/'DRAFT'/.test(sql))throw Error('DRAFT_ACCOUNTING_SCHEMA_UNAVAILABLE');
 if(previewDraftingContext(db,input.packet.spec).hash!==input.packet.context.hash)throw Error('DRAFTING_STALE_CONTEXT');
}
function receiptMetadata(receipt,request,at){
 exact(receipt,['response','provider','model','requestId','actual','chargeEvidenceRef'],'DRAFTING_RECEIPT_SHAPE');
 if(receipt.provider!==request.provider||receipt.model!==request.model)throw Error('DRAFTING_RECEIPT_IDENTITY_MISMATCH');
 required(receipt.requestId);timestamp(at);
 if(receipt.actual!==null){decimal(receipt.actual);required(receipt.chargeEvidenceRef);}else if(receipt.chargeEvidenceRef!==null)required(receipt.chargeEvidenceRef);
 const value={provider:receipt.provider,model:receipt.model,requestId:receipt.requestId,actual:receipt.actual,chargeEvidenceRef:receipt.chargeEvidenceRef,recordedAt:at};canonical(value);return value;
}
function receiptValue(receipt,request,config,at){
 const metadata=receiptMetadata(receipt,request,at);
 const raw=typeof receipt.response==='string'?receipt.response:canonical(receipt.response);assertSafe(raw);
 if(Buffer.byteLength(raw)>config.maxOutputBytes)throw Error('DRAFTING_OUTPUT_TOO_LARGE');
 return {...metadata,responseJson:raw,responseHash:digest(raw)};
}
function recordCallResult(db,id,details,{reconciliation=false,evidenceRef}={}){
 return transaction(db,()=>{
  const prior=getRecord(db,'drafting_call',id),state=operation(db,id),expected=reconciliation?'RECONCILIATION':'DISPATCHING';
  if(!prior||!state)throw Error('DRAFTING_CALL_REQUIRED');
  const duplicate=details.requestId&&db.prepare("SELECT id FROM records WHERE kind='drafting_call' AND id<>? AND json_extract(data_json,'$.provider')=? AND json_extract(data_json,'$.requestId')=? LIMIT 1").get(id,details.provider,details.requestId);
  if(reconciliation&&duplicate)throw Error('DRAFTING_RECEIPT_DUPLICATE_ID');
  const succeeded=state.status===expected&&details.actual!==null&&details.responseJson!==null&&!duplicate;
  const value={...prior,...details,status:succeeded?'SUCCEEDED':'RECONCILIATION'};
  putRecord(db,'drafting_call',id,value,'provider_result');
  if(state.status===expected)(reconciliation?reconcileOperation:recordOutcome)(db,id,{status:succeeded?'SUCCEEDED':'AMBIGUOUS',actual:details.actual,remoteId:details.requestId,evidence:evidenceRef??'drafting_call:'+id});
  journal(db,reconciliation?'DRAFTING_CALL_RECONCILED':'DRAFTING_CALL_RESULT',id,{status:value.status,responseHash:details.responseHash,chargeEvidenceRef:details.chargeEvidenceRef});return value;
 });
}
function assertStoredCall(call){
 if(call.requestHash!==hash(call.request)||call.configHash!==hash(call.config)||call.responseJson!==null&&call.responseHash!==digest(call.responseJson))throw Error('DRAFTING_CALL_INTEGRITY');
}
export function reconcileDraftingCall(db,id,receipt,{at=now()}={}){
 required(receipt.evidenceRef);const {evidenceRef,...raw}=receipt,prior=getRecord(db,'drafting_call',id);
 if(!prior||operation(db,id)?.status!=='RECONCILIATION')throw Error('DRAFTING_RECONCILIATION_REQUIRED');assertStoredCall(prior);
 const details=receiptValue(raw,prior.request,prior.config,at);
 if(details.actual===null)throw Error('DRAFTING_RECONCILIATION_CHARGE_REQUIRED');
 if(prior.requestId&&prior.requestId!==details.requestId||prior.responseHash&&prior.responseHash!==details.responseHash)throw Error('DRAFTING_RECONCILIATION_RECEIPT_MISMATCH');
 return recordCallResult(db,id,{...details,error:null},{reconciliation:true,evidenceRef});
}
function provenanceFor(packet,calls,result){
 const generations=calls.filter(c=>c.request.stage!=='REVIEW'),first=generations[0],p=createDraftProvenanceTemplate(JSON.parse(first.responseJson));
 p.generation={interface:'Explicit API transport',provider:first.provider,modelLabel:first.model,identityBasis:'RECEIPT_REFERENCE_ONLY',reportedBy:'Configured trusted transport; model identity not independently verified',generatedAt:first.recordedAt,settings:{status:'OPERATOR_REPORTED',values:first.request.settings},receipt:{sourceRef:'drafting_call:'+first.id,sha256:first.responseHash,assertedModelLabel:first.model,identityAssessment:'NOT_VALIDATED'}};
 let previous=p.generatedDraftHash;
 for(const call of generations.slice(1)){const next=hash(JSON.parse(call.responseJson).drafts);if(next!==previous){p.materialEdits.push({at:call.recordedAt,editor:'Configured drafting transport',reason:'Bounded revision in response to retained critical review',beforeDraftHash:previous,afterDraftHash:next});previous=next;}}
 const review=calls.filter(c=>c.request.stage==='REVIEW').at(-1);
 if(review){const r=JSON.parse(review.responseJson);p.review={method:review.model!==first.model?'DIFFERENT_MODEL':'SEPARATE_CONTEXT',reviewerLabel:review.model,reviewedAt:review.recordedAt,reviewedDraftHash:r.reviewedDraftHash,artifact:{sourceRef:'drafting_call:'+review.id,sha256:review.responseHash}};}
 return p;
}
export function createDraftingCaller(input,{transport,clock=now,assertDispatch}={}){
 const config=validateDraftingCallerConfig(input),configHash=hash(config);
 if(config.enabled&&typeof transport?.generate!=='function')throw Error('DRAFTING_TRUSTED_TRANSPORT_REQUIRED');
 return Object.freeze({mode:config.enabled?'explicit-api-drafting':'disabled',async run(db,input){
  if(!config.enabled)throw Error('DRAFTING_CALLER_DISABLED');
  if(Object.keys(input).some(k=>!['id','packet','authority','signal'].includes(k)))throw Error('DRAFTING_REQUEST_SHAPE');
  preflight(db,config,input,clock(),assertDispatch);
  if(db.prepare("SELECT id FROM records WHERE kind='drafting_session' AND id<>? AND json_extract(data_json,'$.authority.authorizationRef')=? LIMIT 1").get(input.id,input.authority.authorizationRef))throw Error('DRAFTING_AUTHORITY_ALREADY_BOUND');
  const identity={id:input.id,packet:input.packet,authority:input.authority,configHash},inputHash=hash(identity),old=getRecord(db,'drafting_session',input.id);
  if(old?.inputHash&&old.inputHash!==inputHash)throw Error('DRAFTING_SESSION_IMMUTABLE');
  if(['UNAPPROVED_NOT_SENDABLE','INVALID_OUTPUT'].includes(old?.status))return old.result;
  const running=active.get(db)??new Set();active.set(db,running);if(running.has(input.id))throw Error('DRAFTING_SESSION_ALREADY_RUNNING');running.add(input.id);
  const calls=[];let result,review,reviewBinding,proposal;
  const persist=(status,extra={})=>{
   const value={status,sessionId:input.id,packetHash:input.packet.hash,configHash,calls:calls.map(c=>({id:c.id,status:c.status,requestHash:c.requestHash,responseHash:c.responseHash,actual:c.actual})),contentApproval:false,releaseAuthorized:false,...extra};
   putRecord(db,'drafting_session',input.id,{...identity,inputHash,status,result:value},'assessment');return value;
  };
  const performCall=async(stage,index,messages,outputSchema)=>{
   const selection=stage==='REVIEW'?config.review:config.generation,id=`${input.id}:${index}:${stage}`;
   const request={operationId:id,stage,provider:config.provider,model:selection.model,settings:selection.settings,messages,outputSchema,maxOutputTokens:config.maxOutputTokens,maxTotalChargeUsd:config.chargeContract.maximumPerCallUsd,chargeContractRef:config.chargeContract.sourceRef};
   if(Buffer.byteLength(canonical(request))>config.maxInputBytes)throw Error('DRAFTING_INPUT_TOO_LARGE');
   const saved=getRecord(db,'drafting_call',id),requestHash=hash(request);
   if(saved){assertStoredCall(saved);if(saved.requestHash!==requestHash||saved.configHash!==configHash)throw Error('DRAFTING_CALL_IMMUTABLE');const state=operation(db,id);if(state?.status==='SUCCEEDED'&&saved.status==='SUCCEEDED'){calls.push(saved);return JSON.parse(saved.responseJson);}if(state?.status!=='PREPARED'){calls.push(saved);throw Error('DRAFTING_RECONCILIATION_REQUIRED');}}
   preflight(db,config,input,clock(),assertDispatch);
   transaction(db,()=>{
    reserveOperation(db,{id,kind:'DRAFT',budgetId:input.authority.budgetId,reservation:config.chargeContract.maximumPerCallUsd,authorizationRef:input.authority.authorizationRef,payload:{sessionId:input.id,packetHash:input.packet.hash,configHash,request}});
    if(!saved)putRecord(db,'drafting_call',id,{id,sessionId:input.id,request,requestHash,config,configHash,status:'PREPARED',responseJson:null,responseHash:null,requestId:null,actual:null,chargeEvidenceRef:null,error:null},'configuration');
   });
   const check=()=>preflight(db,config,input,clock(),assertDispatch);
   beginOperation(db,id,clock(),check);
   let details={responseJson:null,responseHash:null,requestId:null,actual:null,chargeEvidenceRef:null,recordedAt:clock(),error:'DRAFTING_TRANSPORT_OR_RECEIPT_UNCERTAIN'},timer,onAbort;
   const controller=new AbortController();
   try{
    const receipt=await Promise.race([
     Promise.resolve().then(()=>{check();return transport.generate(clone(request),{signal:controller.signal});}),
     new Promise((_,reject)=>{timer=setTimeout(()=>{controller.abort();reject(Error('DRAFTING_TIMEOUT'));},config.timeoutMs);}),
     new Promise((_,reject)=>{onAbort=()=>{controller.abort();reject(Error('DRAFTING_CANCELLED'));};input.signal?.addEventListener('abort',onAbort,{once:true});if(input.signal?.aborted)onAbort();})
    ]);
    details={...details,...receiptMetadata(receipt,request,clock())};
    details={...receiptValue(receipt,request,config,clock()),error:null};
   }catch{/* Provider errors may contain credentials. Persist only the stable code. */}
   finally{clearTimeout(timer);if(onAbort)input.signal?.removeEventListener('abort',onAbort);}
   const value=recordCallResult(db,id,details);calls.push(value);
   if(value.status!=='SUCCEEDED')throw Error('DRAFTING_RECONCILIATION_REQUIRED');
   if(budgetStatus(db,input.authority.budgetId).blocked)throw Error('DRAFTING_CHARGE_LIMIT_EXCEEDED');
   try{return JSON.parse(value.responseJson);}catch{throw Object.assign(Error('DRAFTING_OUTPUT_JSON_INVALID'),{draftingStatus:'INVALID_OUTPUT'});}
  };
  const call=async(...args)=>{try{return await performCall(...args);}catch(error){if(!error.draftingStatus)error.draftingStatus='BLOCKED';throw error;}};
  try{
   persist('RUNNING');
   result=await call('GENERATE',0,input.packet.generationMessages,input.packet.outputSchema);
   for(let cycle=0;cycle<=config.maxRevisions;cycle++){
    proposal=prepareAssistedImport(db,{packet:input.packet,result,provenance:provenanceFor(input.packet,calls,result)});
    reviewBinding=createCriticalReviewPacket(input.packet,result);
    review=await call('REVIEW',cycle,reviewBinding.messages,reviewBinding.outputSchema);validateCriticalReviewResult(reviewBinding,review);
    if(review.verdict!=='REVISE'||cycle===config.maxRevisions)break;
    const messages=[...input.packet.generationMessages,{role:'user',content:'UNTRUSTED_EXACT_PRIOR_RESULT_AND_BOUND_REVIEW\n'+canonical({result,review,reviewBindingHash:reviewBinding.hash})+'\nRevise only within the original supplied facts and writing rules. Return the original exact draft schema; no approval or external actions.'}];
    result=await call('REVISE',cycle+1,messages,input.packet.outputSchema);
   }
   const envelope={packet:input.packet,result,provenance:provenanceFor(input.packet,calls,result)};proposal=prepareAssistedImport(db,envelope);
   return persist('UNAPPROVED_NOT_SENDABLE',{envelope,proposal,reviewBinding,review,revisionLimitReached:review.verdict==='REVISE',exactFirstTouchHash:hash({subject:result.drafts[0].subject,body:result.drafts[0].body}),independence:'NOT_ESTABLISHED'});
  }catch(error){
   const uncertain=calls.some(c=>c.status==='RECONCILIATION')||calls.some(c=>['DISPATCHING','RECONCILIATION'].includes(operation(db,c.id)?.status));
   return persist(uncertain?'RECONCILIATION':error.draftingStatus??'INVALID_OUTPUT',{error:uncertain?'DRAFTING_RECONCILIATION_REQUIRED':error.draftingStatus==='BLOCKED'?'DRAFTING_DISPATCH_BLOCKED':'DRAFTING_OUTPUT_OR_CURRENT_CONTEXT_INVALID'});
  }finally{running.delete(input.id);}
 }});
}
