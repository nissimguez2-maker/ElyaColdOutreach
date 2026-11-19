// General execution remains disabled until explicit policy, authority and the
// contained production adapter are supplied. Legacy isolated fixtures are kept.
import {isDeepStrictEqual} from 'node:util';
import {canonical,digest,required,timestamp,decimal,assertSafe} from './values.mjs';
import {getRecord,putRecord,transaction,journal,now} from './store.mjs';
import {latestBatch} from './batches.mjs';
import {prepareWritingHandoff} from './writing-handoff.mjs';
import {reserveOperation,beginOperation,recordOutcome,reconcileOperation,operation,budgetStatus} from './operations.mjs';
import {permitsIsolatedHandoff,fixtureHandoffTransport} from './handoff-isolation.mjs';
import {isProductionHandoffAdapter,productionHandoffOptions,productionHandoffTransport,productionHandoffClock,assertProductionHandoffEnabled} from './handoff-production.mjs';
import {assertWorkflowDispatchBinding} from './workflow-runtime.mjs';
import {FIRST_TOUCH_CONTRACT,LEGACY_WRITING_CONTRACT,writingMode,messageStepsForMode} from './writing-mode.mjs';
export {createIsolatedHandoffAdapter} from './handoff-isolation.mjs';
export {createProductionHandoffAdapter} from './handoff-production.mjs';

const hash=value=>digest(canonical(value));
const atomic=(db,fn)=>db.isTransaction?fn():transaction(db,fn);
const toolPrefix='mcp__codex_apps__instantly_ai_';
// Exact declarations captured in work/instantly-capability-inspection.json.
// Unknown schema revisions stay blocked until their serialization is reviewed.
const schemaHashes={create_lead:'2d004ea0be8a9e291f36a9cd4c38d0a7bd9dcf9f98876a1024e64a9223c424b3',update_lead:'f49d98e04ffe80ff744a6ad9aeb5fb5227fa59264ca8e9ea436dc73af6e1ff45',get_lead:'4381ac95e55f99bf2859f572932b2d53e5e87345bf928bca4381501e6855623b'};
export const HANDOFF_VARIABLES=Object.freeze([1,2,3].flatMap(i=>[`pilot_subject_${i}`,`pilot_body_${i}`]));
const variableNamesFor=mode=>messageStepsForMode(mode).flatMap(i=>[`pilot_subject_${i}`,`pilot_body_${i}`]);
const contractMode=contract=>writingMode(contract.writingContractVersion===undefined?{}:{contractVersion:contract.writingContractVersion});
const seal=data=>({...data,hash:hash(data)});
function checkedSealed(value,label){
 if(!value)throw Error(`Handoff ${label} missing`);
 const {hash:stored,...body}=value;if(stored!==hash(body))throw Error(`Handoff ${label} integrity mismatch`);return value;
}
function timeRange(start,end){if(timestamp(end)<=timestamp(start))throw Error('Handoff authority time range invalid');}
function scalarVariables(value,names=HANDOFF_VARIABLES){
 if(!value||Object.getPrototypeOf(value)!==Object.prototype||canonical(Object.keys(value).sort())!==canonical([...names].sort())||Object.values(value).some(v=>typeof v!=='string'||!v.trim()))throw Error('Handoff approved scalar variables mismatch');
 canonical(value);return value;
}
export function buildSavedInstantlyContract(input){
 const {id,campaignId,snapshot,sourceRef,approvedBy,approvedAt,expiresAt,fixtureOnly=false}=input;
 const mode=contractMode(input),firstTouch=mode===FIRST_TOUCH_CONTRACT,names=variableNamesFor(mode);
 for(const v of [id,campaignId,sourceRef,approvedBy])required(v);timeRange(approvedAt,expiresAt);
 if(typeof fixtureOnly!=='boolean')throw Error('Handoff contract fixture scope invalid');
 const schemas=Object.fromEntries(Object.entries(schemaHashes).map(([name,wanted])=>{
  const found=snapshot?.schemas?.find(s=>s.name===toolPrefix+name);
  if(typeof found?.schema!=='string'||digest(found.schema)!==wanted)throw Error('Handoff contract schema missing or unsupported: '+name);
  return [name,{tool:found.name,schemaHash:wanted}];
 }));
 let campaignEvidence=null;
 if(!fixtureOnly||firstTouch){
  const observed=snapshot?.snapshot?.campaign?.value?.structuredContent,rule=input.campaignStatusRule;
  if(observed?.id!==campaignId||!Number.isFinite(observed.status)||!Array.isArray(rule?.approvedStatuses)||!rule.approvedStatuses.includes(observed.status)||typeof rule.evidenceRef!=='string'||!rule.evidenceRef.trim())throw Error('Handoff current approved campaign status contract required');
  const steps=observed.sequences?.length===1?observed.sequences[0].steps:null;
  if(firstTouch&&!Array.isArray(observed.sequences)||!Array.isArray(steps)||steps.length!==messageStepsForMode(mode).length||steps.some((s,i)=>s.variants?.length!==1||s.variants[0].subject!==`{{pilot_subject_${i+1}}}`||s.variants[0].body!==`{{pilot_body_${i+1}}}`||firstTouch&&(!Array.isArray(s.variants)||s.type!=='email'||s.variants[0].v_disabled!==false)))throw Error('Handoff current approved campaign variable mapping required');
  if(timestamp(input.observedAt)>timestamp(approvedAt))throw Error('Handoff campaign observation is future dated');
  campaignEvidence={observedAt:input.observedAt,status:observed.status,rule,sequenceHash:hash(observed.sequences)};
 }
 if(input.readbackRequired!==undefined&&typeof input.readbackRequired!=='boolean')throw Error('Handoff readback contract invalid');
 if(firstTouch&&input.readbackRequired!==true)throw Error('Handoff first-touch readback required');
 return seal({id,provider:'instantly',version:firstTouch?'captured-first-touch-create-update-v1':'captured-create-update-v1',...(firstTouch?{writingContractVersion:mode}:{}),campaignId,sourceRef,sourceHash:hash(snapshot.schemas),schemas,variableNames:names,approvedBy,approvedAt,expiresAt,fixtureOnly,campaignEvidence,activationAllowed:false,...(input.readbackRequired?{readbackRequired:true}:{})});
}
export function buildHandoffAuthorization(db,input){
 const {id,batchId,approvalId,contractId,budgetId,notBefore,expiresAt,approvedBy,fixtureOnly=false,maxRequests,reservation='0'}=input;
 for(const v of [id,batchId,approvalId,contractId,budgetId,approvedBy])required(v);timeRange(notBefore,expiresAt);decimal(reservation);
 const b=latestBatch(db,batchId),contract=checkedSealed(getRecord(db,'instantly_handoff_contract',contractId),'contract');
 if(!b)throw Error('Handoff authorization batch missing');
 const content=JSON.parse(b.content_json);
 if(!Number.isSafeInteger(maxRequests)||maxRequests!==content.recipients.length*(contract.readbackRequired?3:2)||maxRequests>200||typeof fixtureOnly!=='boolean')throw Error('Handoff authority requires exact bounded create/update/readback request count');
 return seal({id,status:'OPEN',batchId,batchVersion:b.version,batchHash:b.hash,approvalId,campaignId:content.campaignId,contractId,contractHash:contract.hash,budgetId,notBefore,expiresAt,approvedBy,fixtureOnly,maxRequests,reservation,recipients:content.recipients.map(r=>({candidateId:r.candidateId,email:r.email})),activationAllowed:false});
}
function checkBoundary(db,input,options,at){
 if(options.production)assertProductionHandoffEnabled(db);
 const isolated=permitsIsolatedHandoff(db,options.fixtureAdapter),payload=prepareWritingHandoff(db,input.batchId,input.approvalId,at,options);
 const contract=checkedSealed(getRecord(db,'instantly_handoff_contract',input.contractId),'contract');
 const authority=checkedSealed(getRecord(db,'handoff_authorization',input.authorizationId),'authority');
 const mode=contractMode(contract),names=variableNamesFor(mode);
 if(contract.provider!=='instantly'||contract.activationAllowed!==false||contract.campaignId!==payload.campaignId||canonical(contract.variableNames)!==canonical(names)||Object.entries(schemaHashes).some(([name,value])=>contract.schemas?.[name]?.schemaHash!==value||contract.schemas[name].tool!==toolPrefix+name)||timestamp(contract.approvedAt)>timestamp(at)||timestamp(contract.expiresAt)<=timestamp(at)||(options.production||mode===FIRST_TOUCH_CONTRACT)&&contract.readbackRequired!==true)throw Error('Handoff contract unapproved, stale or mismatched');
 if(contract.fixtureOnly!==isolated||authority.fixtureOnly!==isolated)throw Error('Handoff fixture contract cannot be used for a real export');
 if(!isolated&&!contract.campaignEvidence)throw Error('Handoff current approved live contract required');
 const identities=payload.recipients.map(r=>({candidateId:r.candidateId,email:r.email}));
 if(authority.status!=='OPEN'||authority.activationAllowed!==false||authority.batchId!==input.batchId||authority.batchHash!==payload.hash||authority.batchVersion!==payload.version||authority.approvalId!==input.approvalId||authority.campaignId!==payload.campaignId||authority.contractId!==input.contractId||authority.contractHash!==contract.hash||authority.budgetId!==input.budgetId||authority.reservation!==input.reservation||authority.approvedBy!==contract.approvedBy||canonical(authority.recipients)!==canonical(identities)||authority.maxRequests!==identities.length*(contract.readbackRequired?3:2)||timestamp(authority.notBefore)>timestamp(at)||timestamp(authority.expiresAt)<=timestamp(at))throw Error('Handoff authority mismatch, closed or expired');
 const batch=JSON.parse(latestBatch(db,input.batchId).content_json);
 if(mode===FIRST_TOUCH_CONTRACT&&batch.recipients.length!==1||batch.recipients.some(r=>(getRecord(db,'writing_packet',r.writing.packetHash)?.contractVersion??LEGACY_WRITING_CONTRACT)!==mode))throw Error('Handoff writing contract mode mismatch');
 if(batch.recipients.some(r=>getRecord(db,'writing_packet',r.writing.packetHash)?.policy.approver!==authority.approvedBy))throw Error('Handoff authority actor mismatch');
 for(const r of payload.recipients)scalarVariables(r.variables,names);
 return {payload,contract,authority,mode:options.production?(isolated?'PRODUCTION_BOUNDARY_FIXTURE':'PRODUCTION'):(isolated?'ISOLATED_FIXTURE':'OFFLINE_PREPARED_ONLY')};
}
const importKey=(campaignId,email)=>hash({campaignId,email});
function assertLeadIdentity(db,campaignId,email,leadId){
 for(const row of db.prepare("SELECT data_json FROM records WHERE kind='handoff_import' AND json_extract(data_json,'$.leadId')=?").all(leadId)){
  const existing=JSON.parse(row.data_json);
  if(existing.campaignId!==campaignId||existing.email!==email)throw Error('Handoff provider lead identity conflicts with another import');
 }
}
function persistImport(db,h,r,status,evidenceRef){
 putRecord(db,'handoff_import',importKey(h.campaignId,r.email),{status,campaignId:h.campaignId,leadId:r.leadId??null,candidateId:r.candidateId,email:r.email,importOperationId:h.id,evidenceRef,variablesHash:hash(r.variables)},'assessment');
}
export function prepareHandoff(db,input,{fixtureAdapter,productionAdapter}={}){
 const at=input.at??now();timestamp(at);required(input.id);if(fixtureAdapter&&productionAdapter)throw Error('Handoff adapter scope conflict');const options=productionAdapter?productionHandoffOptions(db,productionAdapter):{fixtureAdapter};
 const checked=checkBoundary(db,input,options,at);
 const identity={id:input.id,batchId:input.batchId,approvalId:input.approvalId,contractId:input.contractId,authorizationId:input.authorizationId,budgetId:input.budgetId,reservation:input.reservation};
 const prepared=seal({...identity,mode:checked.mode,...(checked.contract.writingContractVersion?{writingContractVersion:checked.contract.writingContractVersion}:{}),campaignId:checked.payload.campaignId,batchVersion:checked.payload.version,batchHash:checked.payload.hash,contractHash:checked.contract.hash,authorityHash:checked.authority.hash,recipients:checked.payload.recipients});
 return transaction(db,()=>{
  const old=getRecord(db,'handoff',input.id);
  if(old){if(old.prepared.hash!==prepared.hash)throw Error('Handoff operation intent mismatch');if(operation(db,input.id)?.status!=='PREPARED')throw Error('Handoff terminal or reconciliation state; no replay');return old.prepared;}
  for(const r of prepared.recipients)if(getRecord(db,'handoff_import',importKey(prepared.campaignId,r.email)))throw Error('Duplicate handoff: recipient already imported or requires reconciliation');
  reserveOperation(db,{id:input.id,kind:'RELEASE',budgetId:input.budgetId,reservation:input.reservation,authorizationRef:input.authorizationId,payload:{batchId:input.batchId,approvalId:input.approvalId,campaignId:prepared.campaignId,handoffHash:prepared.hash}});
  const handoff={id:input.id,prepared,campaignId:prepared.campaignId,status:'PREPARED',requestCount:0,recipients:prepared.recipients.map(r=>({...r,status:'PREPARED',leadId:null})),lastEvidence:null};
  putRecord(db,'handoff',input.id,handoff);
  for(const r of handoff.recipients)persistImport(db,handoff,r,'PREPARED',`handoff:${input.id}`);
  journal(db,'HANDOFF_PREPARED',input.id,{hash:prepared.hash,mode:prepared.mode,activationAllowed:false});return prepared;
 });
}
function currentHandoff(db,id){
 const h=getRecord(db,'handoff',id);if(!h)throw Error('Handoff missing');checkedSealed(h.prepared,'prepared payload');
 const op=operation(db,id),intent=op?JSON.parse(op.intent_json):null;
 if(intent?.payload.handoffHash!==h.prepared.hash||h.id!==id||h.campaignId!==h.prepared.campaignId||canonical(h.recipients.map(({status,leadId,...r})=>r))!==canonical(h.prepared.recipients))throw Error('Handoff operation integrity mismatch');return h;
}
function currentBoundary(db,h,adapter,at){
 const options=isProductionHandoffAdapter(adapter)?productionHandoffOptions(db,adapter):{fixtureAdapter:adapter,...(!adapter&&h.prepared.mode==='PRODUCTION'?{production:true}:{})};
 const c=checkBoundary(db,h.prepared,options,at);
 if(h.workflowBinding)checkWorkflowBinding(db,h.id,h.workflowBinding,at);
 if(options.production&&budgetStatus(db,h.prepared.budgetId).blocked)throw Error('HANDOFF_PRODUCTION_BUDGET_BLOCKED');
 if(c.contract.hash!==h.prepared.contractHash||c.authority.hash!==h.prepared.authorityHash||hash(c.payload.recipients)!==hash(h.prepared.recipients))throw Error('Handoff authority or payload changed after preparation');return c;
}
function checkWorkflowBinding(db,id,binding,at){
 const task=assertWorkflowDispatchBinding(db,binding,at);
 if(task.action!=='HANDOFF'||task.arguments.importId!==id)throw Error('HANDOFF_WORKFLOW_IMPORT_MISMATCH');
}
function providerLead(response,wanted,withVariables,names=HANDOFF_VARIABLES,preservedVariables=null){
 const object=x=>x!==null&&typeof x==='object'&&!Array.isArray(x);
 if(!object(response)||!Array.isArray(response.content)||response.isError===true||('isError'in response&&response.isError!==null&&typeof response.isError!=='boolean'))throw Error('Handoff provider protocol or tool error');
 const values=[];
 if('structuredContent'in response){if(!object(response.structuredContent))throw Error('Handoff provider structure invalid');values.push(response.structuredContent);}
 for(const p of response.content){if(!object(p)||typeof p.type!=='string')throw Error('Handoff provider content invalid');if(p.type==='text'){if(typeof p.text!=='string'||p.text.length>2000000)throw Error('Handoff provider text invalid');const value=JSON.parse(p.text);if(!object(value))throw Error('Handoff provider result invalid');values.push(value);}}
 if(!values.length)throw Error('Handoff provider result missing');
 const summaries=values.map(v=>{
  required(v.id);if(v.id.length>200||v.campaign!==wanted.campaignId||v.email!==wanted.email||wanted.leadId&&v.id!==wanted.leadId)throw Error('Handoff provider lead identity mismatch');
  if(object(v.payload)&&(v.payload.email!==undefined&&v.payload.email!==wanted.email||v.payload.campaign!==undefined&&v.payload.campaign!==wanted.campaignId))throw Error('Handoff provider payload identity mismatch');
  let variables;
  const firstTouch=names.length===2,unrelatedVariables={};
  if(firstTouch){
   for(const representation of [v.custom_variables,v.payload].filter(object))for(const [key,value]of Object.entries(representation)){
    if(names.includes(key)||key==='email'||key==='campaign')continue;
    if(Object.hasOwn(unrelatedVariables,key)&&!isDeepStrictEqual(unrelatedVariables[key],value))throw Error('Handoff provider unrelated variable representations conflict');
    Object.defineProperty(unrelatedVariables,key,{value,enumerable:true,configurable:true,writable:true});
   }
   if(preservedVariables&&Object.entries(preservedVariables).some(([key,value])=>!Object.hasOwn(unrelatedVariables,key)||!isDeepStrictEqual(unrelatedVariables[key],value)))throw Error('Handoff provider unrelated variables changed or missing');
  }
  if(withVariables){
   const representations=[];
   if(Object.hasOwn(v,'custom_variables')){
    if(!object(v.custom_variables)||names.some(k=>!Object.hasOwn(v.custom_variables,k)))throw Error('Handoff provider variables missing or invalid');
    representations.push(scalarVariables(firstTouch?Object.fromEntries(names.map(k=>[k,v.custom_variables[k]])):v.custom_variables,names));
   }
   // Actual saved QA get_lead response: structuredContent.payload.<variable>.
   // Payload also contains core lead fields; select only the declared keys.
   if(Object.hasOwn(v,'payload')){
    if(!object(v.payload)||names.some(k=>!Object.hasOwn(v.payload,k)))throw Error('Handoff provider payload variables missing or invalid');
    representations.push(scalarVariables(Object.fromEntries(names.map(k=>[k,v.payload[k]])),names));
   }
   if(!representations.length||representations.some(value=>canonical(value)!==canonical(wanted.variables)))throw Error('Handoff provider scalar variables missing, conflicting or mismatched');
   variables=representations[0];
  }
  return {leadId:v.id,campaignId:v.campaign,email:v.email,...(withVariables?{variables}:{}),...(firstTouch?{unrelatedVariables}:{})};
 });
 if(summaries.some(s=>canonical(s)!==canonical(summaries[0])))throw Error('Handoff provider representations conflict');return summaries[0];
}
function recordProgress(db,id,index,status,leadId,evidenceRef){
 return atomic(db,()=>{
  const h=currentHandoff(db,id);assertLeadIdentity(db,h.campaignId,h.recipients[index].email,leadId);h.recipients[index]={...h.recipients[index],status,leadId};h.status='DISPATCHING';h.lastEvidence=evidenceRef;
  putRecord(db,'handoff',id,h);persistImport(db,h,h.recipients[index],status,evidenceRef);journal(db,'HANDOFF_PROGRESS',id,{index,status,leadId,evidenceRef});return h;
 });
}
function claimCall(db,id,index,stage,adapter,at){
 return transaction(db,()=>{
  const h=currentHandoff(db,id),{authority,contract}=currentBoundary(db,h,adapter,at),r=h.recipients[index];
  if(operation(db,id)?.status!=='DISPATCHING'||h.requestCount>=authority.maxRequests)throw Error('Handoff dispatch state or request cap');
  if(stage==='create'&&r.status!=='PREPARED'||stage==='update'&&(r.status!=='CREATED'||!r.leadId)||stage==='readback'&&(r.status!=='UPDATED'||!r.leadId||!contract.readbackRequired))throw Error('Handoff stage cannot be replayed');
  let call=stage==='create'?{tool:contract.schemas.create_lead.tool,arguments:{campaign:h.campaignId,email:r.email}}:stage==='update'?{tool:contract.schemas.update_lead.tool,arguments:{id:r.leadId,custom_variables:scalarVariables(r.variables,contract.variableNames)}}:{tool:contract.schemas.get_lead.tool,arguments:{id:r.leadId}};
  if(isProductionHandoffAdapter(adapter))call={server:'codex_apps',tool:'instantly_ai.'+call.tool.slice(toolPrefix.length),arguments:call.arguments};
  h.requestCount++;h.recipients[index].status=stage==='create'?'CREATING':stage==='update'?'UPDATING':'READING';putRecord(db,'handoff',id,h);persistImport(db,h,h.recipients[index],h.recipients[index].status,`handoff:${id}:request:${h.requestCount}`);
  if(isProductionHandoffAdapter(adapter))putRecord(db,'handoff_call',`${id}:${h.requestCount}`,{operationId:id,index,stage,requestCount:h.requestCount,call,callHash:hash(call),status:'INTENT',workflowBinding:h.workflowBinding??null});
  journal(db,'HANDOFF_CALL_INTENT',id,{index,stage,requestCount:h.requestCount,callHash:hash(call)});return call;
 });
}
// Invoked both in-process and by the contained worker immediately before RPC.
// Durable one-use state prevents concurrent workers from submitting the same call.
export function permitHandoffProviderCall(db,id,requestCount,call,at=now(),adapter,worker=false){
 return transaction(db,()=>{
  const h=currentHandoff(db,id),key=`${id}:${requestCount}`,intent=getRecord(db,'handoff_call',key);
  currentBoundary(db,h,adapter,at);
  const wantedState=worker?'LAUNCHING':'INTENT';
  if(operation(db,id)?.status!=='DISPATCHING'||h.requestCount!==requestCount||intent?.status!==wantedState||intent.callHash!==hash(call)||canonical(intent.call)!==canonical(call)||canonical(intent.workflowBinding??null)!==canonical(h.workflowBinding??null))throw Error('HANDOFF_PRODUCTION_CALL_NOT_AUTHORIZED');
  if(worker&&h.prepared.mode!=='PRODUCTION')throw Error('HANDOFF_PRODUCTION_WORKER_SCOPE_REQUIRED');
  const status=h.prepared.mode==='PRODUCTION'&&!worker?'LAUNCHING':'SUBMITTED';
  putRecord(db,'handoff_call',key,{...intent,status});journal(db,'HANDOFF_PROVIDER_PERMITTED',id,{requestCount,callHash:intent.callHash,status});return JSON.parse(canonical(call));
 });
}
function providerAcknowledgement(response){
 const object=x=>x!==null&&typeof x==='object'&&!Array.isArray(x);
 if(!object(response)||!Array.isArray(response.content)||response.isError===true||('isError'in response&&response.isError!==null&&typeof response.isError!=='boolean'))throw Error('Handoff update acknowledgement invalid');
 const values=[];
 if(Object.hasOwn(response,'structuredContent')){if(!object(response.structuredContent))throw Error('Handoff update acknowledgement invalid');values.push(response.structuredContent);}
 for(const part of response.content){if(!object(part)||typeof part.type!=='string')throw Error('Handoff update acknowledgement invalid');if(part.type==='text'){if(typeof part.text!=='string'||part.text.length>2000000)throw Error('Handoff update acknowledgement invalid');const v=JSON.parse(part.text);if(!object(v))throw Error('Handoff update acknowledgement invalid');values.push(v);}}
 if(!values.length)throw Error('Handoff update acknowledgement missing');
 for(const a of values)for(const b of values)for(const key of Object.keys(a))if(Object.hasOwn(b,key)&&!isDeepStrictEqual(a[key],b[key]))throw Error('Handoff update acknowledgement conflicts');
}
export async function executeHandoff(db,id,adapter,at=now(),options={}){
 const production=isProductionHandoffAdapter(adapter),execute=production?productionHandoffTransport(db,adapter):fixtureHandoffTransport(db,adapter),initial=currentHandoff(db,id);
 const started=Date.now(),baseTime=timestamp(at),fallback=()=>new Date(baseTime+Date.now()-started).toISOString(),readClock=options.clock??(production?productionHandoffClock(db,adapter,fallback):fallback),boundaryAt=()=>{
  options.signal?.throwIfAborted();
  if(options.assertDispatch){const allowed=options.assertDispatch();if(allowed===false||typeof allowed?.then==='function')throw Error('HANDOFF_JOB_DISPATCH_DISABLED');}
  const value=readClock();timestamp(value);return value;
 };
 const deadline=Math.min(timestamp(getRecord(db,'handoff_authorization',initial.prepared.authorizationId)?.expiresAt),timestamp(getRecord(db,'instantly_handoff_contract',initial.prepared.contractId)?.expiresAt));
 if(production?!['PRODUCTION','PRODUCTION_BOUNDARY_FIXTURE'].includes(initial.prepared.mode):initial.prepared.mode!=='ISOLATED_FIXTURE')throw Error('Real handoff transport is not enabled');
 beginOperation(db,id,boundaryAt(),()=>{
  currentBoundary(db,initial,adapter,boundaryAt());
  if(options.workflowBinding){checkWorkflowBinding(db,id,options.workflowBinding,boundaryAt());putRecord(db,'handoff',id,{...initial,workflowBinding:JSON.parse(canonical(options.workflowBinding))});}
 },production?productionHandoffOptions(db,adapter):{fixtureAdapter:adapter});
 const call=async(index,stage)=>{
  const proposed=claimCall(db,id,index,stage,adapter,boundaryAt()),requestCount=currentHandoff(db,id).requestCount;
  const response=await execute(proposed,deadline-timestamp(boundaryAt()),exact=>permitHandoffProviderCall(db,id,requestCount,exact,boundaryAt(),adapter),{operationId:id,requestCount,workflowBinding:currentHandoff(db,id).workflowBinding??null},options.signal);
  if(production){const key=`${id}:${requestCount}`,intent=getRecord(db,'handoff_call',key);if(intent?.status!=='SUBMITTED')throw Error('HANDOFF_PRODUCTION_SUBMISSION_UNCONFIRMED');assertSafe(response);putRecord(db,'handoff_call',key,{...intent,status:'RESULT_RECEIVED',responseHash:digest(JSON.stringify(response))},'provider_result');}
  return response;
 };
 try{
  for(let i=0;i<initial.recipients.length;i++){
   let h=currentHandoff(db,id),r=h.recipients[i];
   const contract=getRecord(db,'instantly_handoff_contract',h.prepared.contractId),names=contract.variableNames,firstTouch=contractMode(contract)===FIRST_TOUCH_CONTRACT;
   const created=providerLead(await call(i,'create'),{campaignId:h.campaignId,email:r.email},false,names);
   if(firstTouch)putRecord(db,'handoff_variable_snapshot',`${id}:${i}`,{leadId:created.leadId,unrelatedVariables:created.unrelatedVariables},'provider_result');
   h=recordProgress(db,id,i,'CREATED',created.leadId,`handoff:${id}:create:${i}`);r=h.recipients[i];
   const update=await call(i,'update');
   if(production||firstTouch){providerAcknowledgement(update);recordProgress(db,id,i,'UPDATED',r.leadId,`handoff:${id}:update-ack:${i}`);providerLead(await call(i,'readback'),{campaignId:h.campaignId,email:r.email,leadId:r.leadId,variables:r.variables},true,names,firstTouch?created.unrelatedVariables:null);}
   else providerLead(update,{campaignId:h.campaignId,email:r.email,leadId:r.leadId,variables:r.variables},true);
   recordProgress(db,id,i,'IMPORTED',r.leadId,`handoff:${id}:update:${i}`);
  }
  return atomic(db,()=>{const h=currentHandoff(db,id),real=h.prepared.mode==='PRODUCTION';const result=recordOutcome(db,id,{status:'SUCCEEDED',actual:real?null:'0',remoteId:id,evidence:`${real?'Provider readback confirmed; cost evidence unresolved':'Isolated fixture import confirmed'}; handoff:${id}; no activation`});putRecord(db,'handoff',id,{...h,status:result.status});journal(db,'HANDOFF_COMPLETED',id,{mode:h.prepared.mode,activationAllowed:false});return result;});
 }catch{
  // Even a validation error follows an attempted side effect. Preserve uncertainty,
  // identifiers and reservation, and require explicit evidence before any recovery.
  return atomic(db,()=>{const h=currentHandoff(db,id);const result=recordOutcome(db,id,{status:'AMBIGUOUS',actual:null,evidence:`Uncertain handoff:${id}; inspect journal and reconcile provider state before replay`});putRecord(db,'handoff',id,{...h,status:'RECONCILIATION'});return result;});
 }
}
export function reconcileHandoff(db,id,evidence,at=now()){
 timestamp(at);required(evidence.evidenceRef);decimal(evidence.actual);
 const h=currentHandoff(db,id);
 if(operation(db,id)?.status!=='RECONCILIATION')throw Error('Handoff reconciliation state required');
 if(!Array.isArray(evidence.recipients)||evidence.recipients.length!==h.recipients.length)throw Error('Handoff reconciliation recipient mismatch');
 const firstTouch=h.prepared.writingContractVersion===FIRST_TOUCH_CONTRACT,contract=firstTouch?checkedSealed(getRecord(db,'instantly_handoff_contract',h.prepared.contractId),'contract'):null;
 if(firstTouch&&contract.hash!==h.prepared.contractHash)throw Error('Handoff reconciliation contract changed');
 const seen=new Set(),confirmed=h.recipients.map((r,index)=>{
  const matching=evidence.recipients.filter(e=>e.campaignId===h.campaignId&&e.email===r.email);
  if(matching.length!==1)throw Error('Handoff reconciliation identity mismatch');const found=matching[0];required(found.leadId);
  let variables=found.custom_variables;
  if(firstTouch){
   const baseline=getRecord(db,'handoff_variable_snapshot',`${id}:${index}`);
   if(!baseline||baseline.leadId!==found.leadId||!variables||Object.getPrototypeOf(variables)!==Object.prototype||Object.entries(baseline.unrelatedVariables).some(([key,value])=>!Object.hasOwn(variables,key)||!isDeepStrictEqual(variables[key],value)))throw Error('Handoff reconciliation unrelated variable preservation missing');
   variables=scalarVariables(Object.fromEntries(contract.variableNames.map(key=>[key,variables[key]])),contract.variableNames);
  }
  if(seen.has(found.leadId)||r.leadId&&r.leadId!==found.leadId||canonical(variables)!==canonical(r.variables))throw Error('Handoff reconciliation content or lead mismatch');assertLeadIdentity(db,h.campaignId,r.email,found.leadId);seen.add(found.leadId);return {...r,leadId:found.leadId,status:'IMPORTED'};
 });
 return transaction(db,()=>{
  const current=currentHandoff(db,id);putRecord(db,'handoff',id,{...current,status:'SUCCEEDED',recipients:confirmed,lastEvidence:evidence.evidenceRef});
  for(const r of confirmed)persistImport(db,h,r,'IMPORTED',evidence.evidenceRef);
  // reconcileOperation owns an SQLite transaction; keep its outcome atomic with
  // the imported mappings through the shared operation transaction helper.
  const result=reconcileOperation(db,id,{status:'SUCCEEDED',actual:evidence.actual,remoteId:id,evidence:evidence.evidenceRef});
  journal(db,'HANDOFF_RECONCILIATION_CONFIRMED',id,{evidenceRef:evidence.evidenceRef,at});return result;
 });
}
