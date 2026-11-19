// Production-shaped bounded intents, with no live transport or scheduler.
// The saved request shapes are examples of observed contracts, not live grants.
import {realpathSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {relative,sep} from 'node:path';
import {canonical,digest,required,timestamp,decimal,compareMoney,parseLossless,assertSafe} from './values.mjs';
import {getRecord,putRecord,transaction,journal,controls,now} from './store.mjs';
import {reserveOperation,beginOperation,recordOutcome,reconcileOperation,operation} from './operations.mjs';
import {validateCollectionTargets,validateCollectionEvidence,recordCollectionEvidence} from './collection.mjs';

const PAGE='apify/rag-web-browser',VERIFIER='bounceverify/bounceverify-email-verifier',CONTACT='vdrmota/contact-info-scraper';
const hash=x=>digest(canonical(x)),atomic=(db,fn)=>db.isTransaction?fn():transaction(db,fn),capabilities=new WeakMap();
export const COLLECTION_LIVE_PREREQUISITES=Object.freeze([
 'Reviewed exact current call-actor and get-dataset-items tool declarations and dispatch binding',
 'Reviewed current actor input/build contract for each approved bounded actor',
 'Fresh source/cost caps, current pricing/add-on/proxy allowances and explicit selection of any targeted source-text fallback',
 'Authoritative per-operation total charge receipt and reconciliation mapping; run stats are not billing',
 'Fresh bounded operation authorization and approved freshness policy before recipient adoption'
]);
function isolate(db){
 const marker=getRecord(db,'settings','collection-fixture-isolation');
 if(marker?.isolated!==true||typeof marker.fixtureId!=='string'||!marker.fixtureId.trim())throw Error('COLLECTION_ISOLATION_MARKER_REQUIRED');
 const path=db.prepare('PRAGMA database_list').all().find(r=>r.name==='main')?.file;
 if(path){const r=relative(realpathSync(tmpdir()),realpathSync(path));if(r.startsWith('..')||r.includes(':')||!/^elya-(?:collection|integration|acceptance)-/.test(r.split(sep)[0]))throw Error('COLLECTION_ISOLATION_TEMP_PATH_REQUIRED');}
 for(const row of db.prepare("SELECT kind,id,data_json FROM records WHERE kind IN ('contact','candidate')").all()){
  const value=JSON.parse(row.data_json);
  if(row.kind==='contact'?!/@[^@]+\.(?:test|invalid|example)$/i.test(row.id):value.synthetic!==true&&value.syntheticOnly!==true)throw Error('COLLECTION_ISOLATION_SYNTHETIC_RECORDS_REQUIRED');
 }
}
export function createIsolatedCollectionAdapter(db,transport){
 isolate(db);if(typeof transport?.execute!=='function')throw Error('COLLECTION_FIXTURE_TRANSPORT_REQUIRED');
 const timeoutMs=transport.timeoutMs??5000;if(!Number.isSafeInteger(timeoutMs)||timeoutMs<1||timeoutMs>30000)throw Error('COLLECTION_BOUNDED_TIMEOUT_REQUIRED');
 const adapter=Object.freeze({mode:'isolated-collection-fixture'});capabilities.set(adapter,{db,execute:transport.execute.bind(transport),timeoutMs});return adapter;
}
function checkedRun(db,spec){
 required(spec.runOperationId);const run=getRecord(db,'collection_operation',spec.runOperationId),result=getRecord(db,'collection_operation_result',spec.runOperationId);
 if(!run||run.step!=='RUN_ACTOR'||operation(db,run.id)?.status!=='SUCCEEDED'||result?.status!=='SUCCEEDED')throw Error('COLLECTION_RUN_NOT_RECONCILED');
 if(run.actor!==spec.actor||canonical(run.targets)!==canonical(spec.targets))throw Error('COLLECTION_READ_SCOPE_MISMATCH');
 const response=parseLossless(result.responseJson),value=response.structuredContent??response;
 required(value.storages?.datasets?.default?.id);return {run,result,value};
}
function requestFor(db,spec){
 if(spec.step==='READ_DATASET')return JSON.stringify({datasetId:checkedRun(db,spec).value.storages.datasets.default.id,offset:0,limit:spec.targets.length*(spec.actor===CONTACT?2:1)});
 // These bounded parameters are preserved from the locally saved requests.
 const cap=Number(spec.reservation);
 if(!Number.isFinite(cap)||compareMoney(String(cap),spec.reservation)!==0||compareMoney(spec.reservation,'0')<=0||compareMoney(spec.reservation,'1')>0)throw Error('COLLECTION_EXACT_CHARGE_CAP_REQUIRED');
 if(spec.actor===CONTACT)return JSON.stringify({actor:CONTACT,input:{startUrls:spec.targets.map(t=>({url:t.url})),maxRequestsPerStartUrl:2,maxRequests:spec.targets.length*2,maxDepth:1,sameDomain:true,mergeContacts:false,considerChildFrames:false,maximumLeadsEnrichmentRecords:0,verifyLeadsEnrichmentEmails:false,scrapeSocialMediaProfiles:{facebooks:false,instagrams:false,youtubes:false,tiktoks:false,twitters:false},useBrowser:false,waitUntil:'domcontentloaded',proxyConfig:{useApifyProxy:true}},callOptions:{build:'0.2.254',memory:4096,timeout:300,maxTotalChargeUsd:cap},waitSecs:30});
 return JSON.stringify(spec.actor===PAGE?{
  actor:PAGE,input:{query:spec.targets[0].url,maxResults:1,outputFormats:['markdown','links'],requestTimeoutSecs:40,scrapingTool:'browser-playwright',desiredConcurrency:1,maxRequestRetries:0,serpMaxRetries:0,removeElementsCssSelector:'script, style, noscript, svg',htmlTransformer:'none',debugMode:false},callOptions:{build:'1.0.35',maxTotalChargeUsd:cap,memory:8192,timeout:90},waitSecs:30
 }:{actor:VERIFIER,input:{emails:spec.targets.map(t=>t.email),concurrency:2,timeoutSecs:30,skipInvalidSyntax:true},callOptions:{maxTotalChargeUsd:cap,memory:512,timeout:300},waitSecs:30});
}
function validate(db,spec,at){
 canonical(spec);timestamp(at);for(const k of ['id','sourceRef','budgetId','authorizationRef'])required(spec[k]);decimal(spec.reservation);
 if(Object.keys(spec).some(k=>!['id','sourceRef','budgetId','authorizationRef','reservation','actor','step','notBefore','expiresAt','targets','runOperationId'].includes(k))||spec.step==='RUN_ACTOR'&&spec.runOperationId!==undefined)throw Error('COLLECTION_OPERATION_SHAPE');
 if(![PAGE,VERIFIER,CONTACT].includes(spec.actor))throw Error('COLLECTION_ACTOR_CONTRACT_UNAVAILABLE');
 if(!['RUN_ACTOR','READ_DATASET'].includes(spec.step))throw Error('COLLECTION_STEP_CONTRACT_UNAVAILABLE');
 if(timestamp(spec.notBefore)>timestamp(at)||timestamp(spec.expiresAt)<=timestamp(at))throw Error('COLLECTION_AUTHORITY_EXPIRED_OR_NOT_YET_VALID');
 validateCollectionTargets(spec.actor,spec.targets);
 return requestFor(db,spec);
}
export function prepareCollectionOperation(db,input,{at=now()}={}){
 const spec=structuredClone(input);spec.targets=validateCollectionTargets(spec.actor,spec.targets);const requestJson=validate(db,spec,at),specHash=hash(spec);
 return atomic(db,()=>{
  const old=getRecord(db,'collection_operation',spec.id);if(old){if(old.specHash!==specHash)throw Error('COLLECTION_OPERATION_IMMUTABLE');return old;}
  const kind=spec.step==='READ_DATASET'?'READ':spec.actor===VERIFIER?'VERIFY':'COLLECT';
  reserveOperation(db,{id:spec.id,kind,budgetId:spec.budgetId,reservation:spec.reservation,authorizationRef:spec.authorizationRef,payload:{collectionVersion:1,step:spec.step,actor:spec.actor,targets:spec.targets,requestJson}});
  const value={...spec,specHash,requestJson,liveDispatchEnabled:false,missingContracts:[...COLLECTION_LIVE_PREREQUISITES]};
  putRecord(db,'collection_operation',spec.id,value,'configuration');journal(db,'COLLECTION_OPERATION_PREPARED',spec.id,{specHash,step:spec.step,liveDispatchEnabled:false});return value;
 });
}
function boundary(db,spec,at){
 isolate(db);if(controls(db).stopped)throw Error('COLLECTION_SYSTEM_STOPPED');
 const {specHash,requestJson,liveDispatchEnabled,missingContracts,...body}=spec;
 if(hash(body)!==specHash||liveDispatchEnabled!==false||validate(db,body,at)!==requestJson)throw Error('COLLECTION_OPERATION_INTEGRITY');
 for(const target of spec.targets){const host=spec.actor!==VERIFIER?new URL(target.url).hostname:target.email.split('@')[1];if(!/\.(?:test|invalid|example)$/i.test(host))throw Error('COLLECTION_SYNTHETIC_TARGET_REQUIRED');}
}
function responseText(value){
 const text=typeof value==='string'?value:JSON.stringify(value);required(text);assertSafe(text);
 if(Buffer.byteLength(text)>2_000_000)throw Error('COLLECTION_RESPONSE_TOO_LARGE');return text;
}
function validateResponse(db,spec,responseJson,at){
 const parsed=parseLossless(responseJson),value=parsed.structuredContent??parsed;
 if(parsed.isError===true)throw Error('COLLECTION_PROVIDER_ERROR');
 if(spec.step==='RUN_ACTOR'){
  if(value.actorName!==spec.actor||value.status!=='SUCCEEDED'||typeof value.runId!=='string'||!value.runId||typeof value.storages?.datasets?.default?.id!=='string')throw Error('COLLECTION_RUN_RESULT_UNCERTAIN');
  if(timestamp(value.startedAt)>timestamp(value.finishedAt)||timestamp(value.finishedAt)>timestamp(at))throw Error('COLLECTION_RUN_RESULT_UNCERTAIN');return value.runId;
 }
 const request=JSON.parse(spec.requestJson);
 if(value.datasetId!==request.datasetId||!Array.isArray(value.items)||value.items.length>request.limit||String(value.offset)!=='0'||String(value.itemCount)!==String(value.items.length)||String(value.totalItemCount)!==String(value.items.length))throw Error('COLLECTION_DATASET_RESULT_UNCERTAIN');
 validateCollectionEvidence({id:spec.id,actor:spec.actor,targets:spec.targets,sourceRef:spec.sourceRef,receivedAt:at,run:checkedRun(db,spec).result.responseJson,results:responseJson});
 return value.datasetId;
}
export async function executeCollectionOperation(db,id,{adapter,at=now(),signal,assertDispatch,clock=()=>at}={}){
 if(!adapter)throw Error('COLLECTION_DISPATCH_DISABLED_MISSING_LIVE_CONTRACTS');
 const transport=capabilities.get(adapter);if(transport?.db!==db)throw Error('COLLECTION_ISOLATION_CAPABILITY_MISMATCH');
 const spec=getRecord(db,'collection_operation',id);if(!spec)throw Error('COLLECTION_OPERATION_REQUIRED');
 const check=()=>{
  if(signal?.aborted)throw Error('COLLECTION_ABORTED_BEFORE_DISPATCH');
  if(assertDispatch!==undefined){if(typeof assertDispatch!=='function')throw Error('COLLECTION_DISPATCH_GUARD_INVALID');const value=assertDispatch();if(value===false||value?.then)throw Error('COLLECTION_DISPATCH_GUARD_DENIED');}
  boundary(db,spec,clock());
 };
 check();
 const prior=operation(db,id);if(prior?.status==='SUCCEEDED')return getRecord(db,'collection_operation_result',id);
 if(prior?.status!=='PREPARED')throw Error('COLLECTION_RECONCILIATION_OR_TERMINAL_NO_RETRY');
 beginOperation(db,id,clock(),check);
 let responseJson=null,chargeEvidenceRef=null,actual=null,remoteId=null,outcome='AMBIGUOUS',reason='Transport outcome or cost unresolved; reconcile without replay',timer;
 const controller=new AbortController();let onAbort;
 try{
  const receipt=await Promise.race([
   Promise.resolve().then(()=>{check();return transport.execute({step:spec.step,requestJson:spec.requestJson},{signal:controller.signal});}),
   new Promise((_,reject)=>{timer=setTimeout(()=>{controller.abort();reject(Error('COLLECTION_TIMEOUT'));},transport.timeoutMs);}),
   new Promise((_,reject)=>{onAbort=()=>{controller.abort();reject(Error('COLLECTION_CANCELLED'));};signal?.addEventListener('abort',onAbort,{once:true});if(signal?.aborted)onAbort();})
  ]);
  if(receipt.actual!==null&&receipt.actual!==undefined){decimal(receipt.actual);required(receipt.chargeEvidenceRef);actual=receipt.actual;chargeEvidenceRef=receipt.chargeEvidenceRef;}
  responseJson=responseText(receipt.response);remoteId=validateResponse(db,spec,responseJson,clock());
  if(actual!==null){outcome='SUCCEEDED';reason='Explicit isolated fixture response and charge evidence';}
 }catch{reason='Transport failed, timed out or returned unsupported evidence; reconcile without replay';}
 finally{clearTimeout(timer);if(onAbort)signal?.removeEventListener('abort',onAbort);}
 return atomic(db,()=>{
  const state=operation(db,id);
  const value={id,status:state.status==='DISPATCHING'&&outcome==='SUCCEEDED'?'SUCCEEDED':'RECONCILIATION',responseJson,chargeEvidenceRef,actual,remoteId,reason,recordedAt:at};
  putRecord(db,'collection_operation_result',id,value,'provider_result');
  if(state.status==='DISPATCHING')recordOutcome(db,id,{status:outcome,actual,remoteId,evidence:'collection_operation_result:'+id});
  journal(db,'COLLECTION_OPERATION_RESULT',id,{status:value.status,remoteId,responseHash:responseJson?digest(responseJson):null,chargeEvidenceRef});return value;
 });
}

// Reconciliation consumes explicit saved response/charge evidence. It never
// repeats the original actor request or silently clears an uncertain operation.
export function reconcileCollectionOperation(db,id,receipt,{at=now()}={}){
 timestamp(at);decimal(receipt.actual);required(receipt.chargeEvidenceRef);required(receipt.evidenceRef);
 return atomic(db,()=>{
  const spec=getRecord(db,'collection_operation',id),previous=getRecord(db,'collection_operation_result',id);
  if(!spec||operation(db,id)?.status!=='RECONCILIATION')throw Error('COLLECTION_RECONCILIATION_REQUIRED');
  const responseJson=responseText(receipt.response),remoteId=validateResponse(db,spec,responseJson,at);
  if(previous?.remoteId&&previous.remoteId!==remoteId)throw Error('COLLECTION_RECONCILIATION_REMOTE_ID_MISMATCH');
  const value={id,status:'SUCCEEDED',responseJson,chargeEvidenceRef:receipt.chargeEvidenceRef,actual:receipt.actual,remoteId,reason:'Explicit saved evidence reconciliation; actor request not replayed',recordedAt:at,reconciliationRef:receipt.evidenceRef};
  putRecord(db,'collection_operation_result',id,value,'provider_result');
  reconcileOperation(db,id,{status:'SUCCEEDED',actual:receipt.actual,remoteId,evidence:receipt.evidenceRef});
  journal(db,'COLLECTION_OPERATION_RECONCILED',id,{remoteId,evidenceRef:receipt.evidenceRef,responseHash:digest(responseJson)});return value;
 });
}

// Read-only input validation followed by one atomic evidence/binding write.
// Existing operation receipts remain the source of charge attribution; no run
// or read is dispatched here and no eligibility or approval record is changed.
export function ingestCompletedCollectionOperation(db,input){
 canonical(input);if(Object.keys(input).sort().join(',')!=='id,readOperationId,receivedAt,runOperationId,sourceRef')throw Error('COLLECTION_BRIDGE_SHAPE');
 for(const key of ['id','runOperationId','readOperationId','sourceRef'])required(input[key]);timestamp(input.receivedAt);
 return atomic(db,()=>{
  const read=getRecord(db,'collection_operation',input.readOperationId),result=getRecord(db,'collection_operation_result',input.readOperationId),state=operation(db,input.readOperationId);
  if(read?.step!=='READ_DATASET'||read.runOperationId!==input.runOperationId||state?.status!=='SUCCEEDED'||result?.status!=='SUCCEEDED')throw Error('COLLECTION_READ_NOT_RECONCILED_OR_SCOPE_MISMATCH');
  const {run,result:runResult}=checkedRun(db,read);
  for(const spec of [read,run]){
   const {specHash,requestJson,liveDispatchEnabled,missingContracts,...body}=spec;
   if(hash(body)!==specHash||requestFor(db,spec)!==requestJson)throw Error('COLLECTION_OPERATION_INTEGRITY');
  }
  if(result.remoteId!==state.remote_id||result.actual!==state.actual_usd||runResult.remoteId!==operation(db,run.id).remote_id||runResult.actual!==operation(db,run.id).actual_usd)throw Error('COLLECTION_RECEIPT_ACCOUNTING_MISMATCH');
  const binding=getRecord(db,'collection_operation_evidence',input.id),inputHash=hash(input);
  if(binding&&binding.inputHash!==inputHash)throw Error('COLLECTION_BRIDGE_IMMUTABLE');
  const evidence=recordCollectionEvidence(db,{id:input.id,actor:run.actor,targets:run.targets,sourceRef:input.sourceRef,receivedAt:input.receivedAt,run:runResult.responseJson,results:result.responseJson});
  if(binding){if(binding.evidenceHash!==evidence.hash)throw Error('COLLECTION_BRIDGE_INTEGRITY');return evidence;}
  putRecord(db,'collection_operation_evidence',input.id,{...input,inputHash,evidenceHash:evidence.hash,runResponseHash:digest(runResult.responseJson),readResponseHash:digest(result.responseJson),runChargeEvidenceRef:runResult.chargeEvidenceRef,readChargeEvidenceRef:result.chargeEvidenceRef},'provider_result');
  journal(db,'COLLECTION_OPERATION_EVIDENCE_BOUND',input.id,{runOperationId:run.id,readOperationId:read.id,evidenceHash:evidence.hash});return evidence;
 });
}
