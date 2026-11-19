// Exact QA exception for the approved acceptance manifest. This is not a general
// provider adapter: no activation, creation, retry, fallback or reply operation.
import {spawn} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import {readFileSync,writeFileSync,appendFileSync,mkdirSync,existsSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {homedir} from 'node:os';
import {fileURLToPath} from 'node:url';
import {isDeepStrictEqual} from 'node:util';
import {getRecord,putRecord,controls,transaction,journal} from './store.mjs';
import {canonical,digest,assertSafe} from './values.mjs';
import {inspectDiscovery} from './diagnostic-discovery.mjs';
import {prepareOutputSchema,checkOutputSchema,schemaPath,schemaValidationError,schemaTypes} from './diagnostic-output-schema.mjs';
import {captureLaunchProvenance} from './diagnostic-provenance.mjs';
import {HANDOFF_VARIABLES} from './handoff.mjs';
import {CONTINUATION_ID,validateContinuationManifest} from './acceptance-continuation-contract.mjs';
import {isInstantlyQaId,instantlyQaRelativeDirectory,validateInstantlyQaManifest} from './instantly-qa-contract.mjs';
import {DISCOVERY_TOOLS,validateDiscoveryManifest} from './instantly-discovery-profile.mjs';

const project=fileURLToPath(new URL('../',import.meta.url));
const ID='elya-acceptance-manifest-v1',CAMPAIGN='e0b018cf-160f-454c-9891-e73b4204d7cd',LEAD='01a1e4b0-51d4-799a-9249-e089d63d5fb0';
const TOOLS=['instantly_ai.get_campaign','instantly_ai.get_lead','instantly_ai.update_lead'];
const hash=v=>digest(canonical(v)),phaseId=(manifest,phase)=>`${manifest.id}:instantly:${phase}`,callId=(manifest,index)=>`${manifest.id}:instantly:call:${index}`;
const object=x=>x!==null&&typeof x==='object'&&!Array.isArray(x);
const safeReason=e=>/^[A-Z][A-Z0-9_]+$/.test(e?.message??'')?e.message:'INSTANTLY_ACCEPTANCE_VALIDATION_FAILED';
const clone=v=>JSON.parse(canonical(v));
const readJson=path=>{try{return JSON.parse(readFileSync(path,'utf8').replace(/^\uFEFF/,''));}catch{return null;}};
function saveJson(path,value){assertSafe(value);writeFileSync(path,JSON.stringify(value,null,2),{flag:'wx',flush:true});}
function checkManifest(m){
 const i=m?.instantly,l=m?.limits;
 const continuation=m?.id===CONTINUATION_ID,instantlyQa=isInstantlyQaId(m?.id);if(continuation)validateContinuationManifest(m);if(instantlyQa)validateInstantlyQaManifest(m);
 if(m?.id!==ID&&!continuation&&!instantlyQa||m.businessLaunchAuthorized!==false||i?.server!=='codex_apps'||i.campaignId!==CAMPAIGN||i.leadId!==LEAD||i.email!=='drosen@elyapartners.com'||canonical(i.tools)!==canonical(TOOLS)||i.requiredCampaignStatus!==0||canonical(i.requiredAssignedMailboxes)!=='[]'||i.requiredAllSendingDaysDisabled!==true||i.maxWrites!==1||i.plannedBusinessCalls!==7||i.restore!==false||i.writeArguments?.id!==LEAD||canonical(Object.keys(i.writeArguments).sort())!==canonical(['custom_variables','id'])||canonical(Object.keys(i.writeArguments.custom_variables).sort())!==canonical([...HANDOFF_VARIABLES].sort())||Object.values(i.writeArguments.custom_variables).some(v=>typeof v!=='string'||!v.trim()))throw Error('INSTANTLY_MANIFEST_MISMATCH');
 if(l?.maxContainedLaunches!==2||l.perContainedLaunchTotalMs!==60000||l.perContainedLaunchReadinessMs!==20000||l.perContainedLaunchProviderDeadlineMs!==40000||l.statusSchemaRequestsAcrossBothLaunches!==20||l.statusSchemaRequestsPerLaunch!==10||l.businessDataCallsAcrossBothLaunches!==(continuation||instantlyQa?7:10)||l.maxWriteAttempts!==1||l.retries!==false||l.fallbacks!==false||l.automaticRestarts!==false||l.newPurchasesUsd!=='0')throw Error('INSTANTLY_MANIFEST_LIMIT_MISMATCH');
 return i;
}
function guard(db,manifest,assertAuthority){
 checkManifest(manifest);const authority=typeof assertAuthority==='function'?assertAuthority():null;if(!authority)throw Error('INSTANTLY_ACCEPTANCE_AUTHORITY_REQUIRED');
 const c=controls(db);if(!c.stopped||c.launchAuthorized)throw Error('INSTANTLY_ACCEPTANCE_REQUIRES_BUSINESS_STOPPED');
 return authority;
}
export function instantlyAcceptanceCalls(manifest,phase){
 checkManifest(manifest);if(![1,2].includes(phase))throw Error('INSTANTLY_PHASE_INVALID');
 const campaign={server:'codex_apps',tool:TOOLS[0],arguments:{id:CAMPAIGN}},lead={server:'codex_apps',tool:TOOLS[1],arguments:{id:LEAD}},write={server:'codex_apps',tool:TOOLS[2],arguments:clone(manifest.instantly.writeArguments)};
 return clone(phase===1?[campaign,lead]:[campaign,lead,write,lead,campaign]);
}
// Reuse the existing bounded schema validator after reducing only equivalent
// scalar unions and nonasserting default/examples annotations.
export function inputSchema(schema,tool){
 const context={tool,side:'input'},fail=(path,keyword,value,category,rule,reason)=>{throw schemaValidationError(context,{path,keyword,value,category,rule,reason});};
 const normalize=(s,depth=0,path='/inputSchema',keyword='inputSchema')=>{
  if(s===undefined)fail(path,keyword,s,'ABSENT','SCHEMA_REQUIRED','Input schema is required.');
  if(!object(s))fail(path,keyword,s,typeof s==='boolean'?'UNSUPPORTED':'MALFORMED','OBJECT_SCHEMA_REQUIRED','Only object-form schemas are supported.');
  if(depth>12)fail(path,keyword,s,'UNSUPPORTED','SCHEMA_COMPLEXITY_LIMIT','Schema exceeds the 12-level validation bound.');
  const v={...s};delete v.default;delete v.examples;
  if('anyOf'in v){
   const p=schemaPath(path,'anyOf');
   if(!Array.isArray(v.anyOf)||!v.anyOf.length)fail(p,'anyOf',v.anyOf,'MALFORMED','ANYOF_NONEMPTY_ARRAY','AnyOf must be a nonempty array.');
   if(depth===0)fail(p,'anyOf',v.anyOf,'UNSUPPORTED','ROOT_OBJECT_REQUIRED','The application requires an explicit object root schema, not a root union.');
   if('type'in v)fail(p,'anyOf',v.anyOf,'UNSUPPORTED','ANYOF_SIBLING_TYPE','A union with a sibling type cannot be reduced by this input validator.');
   for(const [index,branch]of v.anyOf.entries()){
    const b=schemaPath(p,index);
    if(!object(branch))fail(b,'anyOf',branch,'UNSUPPORTED','ANYOF_SCALAR_BRANCH','Only object branches declaring scalar types can be reduced.');
    for(const k of Object.keys(branch))if(!['type','description'].includes(k))fail(schemaPath(b,k),k,branch[k],'UNSUPPORTED','ANYOF_SCALAR_BRANCH','Union branches with additional constraints are not implemented.');
    if(typeof branch.type!=='string')fail(schemaPath(b,'type'),'type',branch.type,'UNSUPPORTED','ANYOF_SCALAR_TYPE','Union branches must each declare one type string.');
    if(!schemaTypes.includes(branch.type))fail(schemaPath(b,'type'),'type',branch.type,'MALFORMED','SCHEMA_TYPE_INVALID','Type must name a JSON Schema primitive.');
    if('description'in branch&&typeof branch.description!=='string')fail(schemaPath(b,'description'),'description',branch.description,'MALFORMED','ANNOTATION_STRING_REQUIRED','Description must be a string.');
   }
   v.type=v.anyOf.map(x=>x.type);delete v.anyOf;
  }
  if('properties'in v){
   if(!object(v.properties))fail(schemaPath(path,'properties'),'properties',v.properties,'MALFORMED','PROPERTIES_OBJECT_REQUIRED','Properties must be an object mapping names to schemas.');
   v.properties=Object.fromEntries(Object.entries(v.properties).map(([k,p])=>[k,normalize(p,depth+1,schemaPath(schemaPath(path,'properties'),k),k)]));
  }
  if(object(v.additionalProperties))v.additionalProperties=normalize(v.additionalProperties,depth+1,schemaPath(path,'additionalProperties'),'additionalProperties');
  for(const k of ['items','propertyNames'])if(k in v)v[k]=normalize(v[k],depth+1,schemaPath(path,k),k);return v;
 };
 return prepareOutputSchema(normalize(schema),context);
}
function captureContracts(inventory,directory,at){
 const selected=TOOLS.map(name=>{
  const {evidence,tool}=inspectDiscovery(inventory,{provider:'instantly',server:'codex_apps',tool:name});
  if(evidence.stopReason||!tool)throw Error(evidence.stopReason??'INSTANTLY_TOOL_MISSING');
  const contract={name,inputSchemaPresent:Object.hasOwn(tool,'inputSchema'),outputSchemaPresent:Object.hasOwn(tool,'outputSchema')};
  for(const key of ['inputSchema','outputSchema','description'])if(Object.hasOwn(tool,key))contract[key]=tool[key];
  if(object(tool.annotations))contract.annotations=Object.fromEntries(['readOnlyHint','destructiveHint','idempotentHint','openWorldHint'].filter(k=>Object.hasOwn(tool.annotations,k)).map(k=>[k,tool.annotations[k]]));
  return {evidence,contract};
 });
 const capture={stage:'BEFORE_SCHEMA_VALIDATION',capturedAt:at,server:'codex_apps',businessToolExecutionBegun:false,discovery:selected.map(s=>s.evidence),tools:selected.map(s=>s.contract)};
 // Reject sensitive evidence entirely rather than redact a contract and then
 // validate a different, weakened schema. Never save the full tool inventory.
 try{assertSafe(capture);}catch{throw Error('INSTANTLY_CONTRACT_EVIDENCE_UNSAFE');}
 try{saveJson(join(directory,'selected-contracts.json'),capture);}catch{throw Error('INSTANTLY_CONTRACT_EVIDENCE_PERSISTENCE_FAILED');}
 return capture;
}
function validateTools(inventory,manifest,declarations){
 const output={};
 for(const name of TOOLS){
  const {evidence,tool}=inspectDiscovery(inventory,{provider:'instantly',server:'codex_apps',tool:name});
  if(evidence.stopReason||evidence.runtimeStatus.value!=='connected')throw Error(evidence.stopReason??'INSTANTLY_RUNTIME_NOT_CONNECTED');
  if(name!==TOOLS[2]&&tool.annotations?.readOnlyHint===false)throw Error('INSTANTLY_READ_SCHEMA_CHANGED');
  const args=name===TOOLS[2]?manifest.instantly.writeArguments:{id:name===TOOLS[0]?CAMPAIGN:LEAD},schema=inputSchema(tool.inputSchema,name);
  if(!checkOutputSchema(schema,args)||Object.keys(args).some(k=>!Object.hasOwn(schema.properties??{},k)))throw Error('INSTANTLY_INPUT_SCHEMA_MISMATCH');
  if(name===TOOLS[2]){
   const saved=declarations?.find(x=>x.name==='mcp__codex_apps__instantly_ai_update_lead');
   const description=tool.inputSchema?.properties?.custom_variables?.description??'';
   if(!saved||digest(saved.schema)!=='f49d98e04ffe80ff744a6ad9aeb5fb5227fa59264ca8e9ea436dc73af6e1ff45'||!/Custom variables to merge into the lead/i.test(saved.schema)||!/\bmerge\b/i.test(description)||/\breplace|overwrite|remove|delete\b/i.test(description))throw Error('INSTANTLY_MERGE_SEMANTICS_UNESTABLISHED');
  }
  const contract={name,inputSchema:tool.inputSchema,inputSchemaHash:hash(tool.inputSchema),description:typeof tool.description==='string'?tool.description:null,outputSchemaPresent:Object.hasOwn(tool,'outputSchema')};
  if(contract.outputSchemaPresent){contract.outputSchema=prepareOutputSchema(tool.outputSchema,{tool:name,side:'output'});contract.outputSchemaHash=hash(tool.outputSchema);}
  output[name]=contract;
 }
 return output;
}
function decodeResult(response,contract){
 if(!object(response)||!Array.isArray(response.content)||('isError'in response&&response.isError!==null&&typeof response.isError!=='boolean'))throw Error('INSTANTLY_RESULT_PROTOCOL_INVALID');
 if(response.isError===true)throw Error('INSTANTLY_TOOL_ERROR');
 const representations=[];
 if(Object.hasOwn(response,'structuredContent')){if(!object(response.structuredContent))throw Error('INSTANTLY_RESULT_STRUCTURE_INVALID');representations.push(response.structuredContent);}
 for(const p of response.content){
  if(!object(p)||typeof p.type!=='string')throw Error('INSTANTLY_RESULT_CONTENT_INVALID');
  if(p.type==='text'){if(typeof p.text!=='string'||p.text.length>2000000)throw Error('INSTANTLY_RESULT_TEXT_INVALID');let v;try{v=JSON.parse(p.text);}catch{throw Error('INSTANTLY_RESULT_JSON_INVALID');}if(!object(v))throw Error('INSTANTLY_RESULT_ROOT_INVALID');representations.push(v);}
 }
 if(!representations.length)throw Error('INSTANTLY_RESULT_MISSING');
 if(contract.outputSchemaPresent&&(!object(response.structuredContent)||!checkOutputSchema(contract.outputSchema,response.structuredContent)))throw Error('INSTANTLY_OUTPUT_SCHEMA_MISMATCH');
 for(let a=0;a<representations.length;a++)for(let b=a+1;b<representations.length;b++)for(const key of Object.keys(representations[a]))if(Object.hasOwn(representations[b],key)&&!isDeepStrictEqual(representations[a][key],representations[b][key]))throw Error('INSTANTLY_RESULT_REPRESENTATIONS_CONFLICT');
 // Validate each root separately; one malformed representation cannot borrow a
 // required field from another root and manufacture an accepted result.
 return representations;
}
// Reused by the fixed inactive-setup scope; extraction semantics stay unchanged.
export {decodeResult as decodeInstantlyAcceptanceResult};
function snapshotCampaign(value,manifest){
 const i=manifest.instantly,schedules=value.campaign_schedule?.schedules;
 if(value.id!==i.campaignId||typeof value.status!=='number'||value.status!==0||!Array.isArray(value.email_list)||value.email_list.length||!Array.isArray(schedules)||!schedules.length||schedules.some(s=>!object(s.days)||Object.keys(s.days).sort().join()!=='0,1,2,3,4,5,6'||Object.values(s.days).some(v=>v!==false))||!object(value.custom_variables)||HANDOFF_VARIABLES.some(k=>value.custom_variables[k]!==true))throw Error('INSTANTLY_QA_CAMPAIGN_GUARD_FAILED');
 if(!Array.isArray(value.sequences)||value.sequences.length!==1||!object(value.sequences[0])||!Array.isArray(value.sequences[0].steps)||value.sequences[0].steps.length!==3||value.sequences[0].steps.some(step=>!object(step)))throw Error('INSTANTLY_QA_SEQUENCE_GUARD_FAILED');
 const data={id:value.id,status:value.status,email_list:value.email_list,campaign_schedule:value.campaign_schedule,sequences:value.sequences,custom_variables:value.custom_variables};
 assertSafe(value);return {kind:'campaign',hash:hash(value),data,templateHash:hash(value.sequences)};
}
function snapshotLead(value,manifest){
 const i=manifest.instantly;
 if(value.id!==i.leadId||value.campaign!==i.campaignId||value.email!==i.email||!object(value.payload)||HANDOFF_VARIABLES.some(k=>typeof value.payload[k]!=='string'))throw Error('INSTANTLY_QA_LEAD_GUARD_FAILED');
 if(Object.hasOwn(value,'custom_variables')&&(!object(value.custom_variables)||HANDOFF_VARIABLES.some(k=>Object.hasOwn(value.custom_variables,k)&&value.custom_variables[k]!==value.payload[k])))throw Error('INSTANTLY_LEAD_VARIABLE_REPRESENTATIONS_CONFLICT');
 if(value.payload.email!==undefined&&value.payload.email!==i.email||value.payload.campaign!==undefined&&value.payload.campaign!==i.campaignId)throw Error('INSTANTLY_LEAD_PAYLOAD_IDENTITY_CONFLICT');
 const unrelated=clone(value);delete unrelated.timestamp_updated;
 for(const key of HANDOFF_VARIABLES){delete unrelated.payload[key];if(object(unrelated.custom_variables))delete unrelated.custom_variables[key];}
 const data={id:value.id,campaign:value.campaign,email:value.email,payload:value.payload};
 assertSafe(value);return {kind:'lead',hash:hash(value),data,preservationHash:hash(unrelated),variablesHash:hash(Object.fromEntries(HANDOFF_VARIABLES.map(k=>[k,value.payload[k]])))};
}
function assess(response,contract,manifest,kind){
 const snapshots=decodeResult(response,contract).map(v=>kind==='campaign'?snapshotCampaign(v,manifest):snapshotLead(v,manifest));
 if(snapshots.some(v=>canonical(v.data)!==canonical(snapshots[0].data)))throw Error('INSTANTLY_SNAPSHOT_REPRESENTATIONS_CONFLICT');return snapshots[0];
}
function phaseState(db,manifest,phase){const s=getRecord(db,'acceptance_instantly_phase',phaseId(manifest,phase));if(!s)throw Error('INSTANTLY_PHASE_SLOT_REQUIRED');return s;}
function persist(db,manifest,phase,patch,event){
 return transaction(db,()=>{const value={...phaseState(db,manifest,phase),...patch};putRecord(db,'acceptance_instantly_phase',phaseId(manifest,phase),value);journal(db,event,phaseId(manifest,phase),patch);return value;});
}

// Same deterministic app-server route used by diagnostic-client.mjs. The older
// client binds historical IDs, so this narrowly scoped protocol owner keeps its
// one-use planner separate without changing that completed diagnostic route.
export function acceptanceClient({context,startProcess=spawn,audit,permit,clock=Date.now,sleep=ms=>new Promise(r=>setTimeout(r,ms)),discoveryOnly=false,captureInventory}){
 if(discoveryOnly){validateDiscoveryManifest(context.manifest);if(typeof captureInventory!=='function')throw Error('DISCOVERY_CAPTURE_REQUIRED');}
 const selectedTools=discoveryOnly?DISCOVERY_TOOLS:TOOLS;
 let child,sequence=0,threadId,buffer='',fatal=null,statusCount=0,initializationAttempted=false;const pending=new Map();
 const fail=reason=>{fatal??=reason;for(const p of pending.values()){clearTimeout(p.timer);p.reject(Error(fatal));}pending.clear();};
 const check=deadline=>{if(fatal)throw Error(fatal);if(clock()>=deadline)throw Error('INSTANTLY_PROVIDER_DEADLINE');};
 function request(method,params,deadline){
  if(discoveryOnly&&!['initialize','thread/start','mcpServerStatus/list'].includes(method))throw Error('DISCOVERY_BUSINESS_RPC_UNAVAILABLE');
  check(deadline);permit(method,params);
  const id=++sequence;audit({event:'RPC_REQUEST',id,method,server:params.server??params.serverName??null});
  return new Promise((resolve,reject)=>{
   const timer=setTimeout(()=>fail(method==='mcpServerStatus/list'||method==='initialize'||method==='thread/start'?'INSTANTLY_READINESS_DEADLINE':'INSTANTLY_PROVIDER_DEADLINE'),Math.max(1,deadline-clock()));pending.set(id,{resolve,reject,timer,method});
   child.stdin.write(JSON.stringify({id,method,params})+'\n',e=>{if(e)fail('INSTANTLY_PROTOCOL_WRITE_FAILED');else audit({event:'RPC_SUBMITTED',id,method});});
  });
 }
 return {
  async initialize(){
   if(discoveryOnly&&initializationAttempted)throw Error('DISCOVERY_INITIALIZATION_ALREADY_ATTEMPTED');initializationAttempted=true;
   check(context.readinessDeadlineMs);permit('START_PROCESS',{});
   child=startProcess(context.codex,['--no-daemon','app-server','--stdio','--strict-config'],{cwd:project,env:context.environment,windowsHide:true,stdio:['pipe','pipe','pipe']});
   audit({event:'APP_SERVER_STARTED',pid:child.pid??null});child.on('error',()=>fail('INSTANTLY_PROCESS_START_FAILED'));child.on('exit',()=>fail('INSTANTLY_APP_SERVER_EXITED'));child.stdin.on('error',()=>fail('INSTANTLY_PROTOCOL_WRITE_FAILED'));child.stderr.on('data',()=>{});
   child.stdout.on('data',bytes=>{
    buffer+=bytes.toString();if(buffer.length>8000000){buffer='';fail('INSTANTLY_PROTOCOL_SIZE_LIMIT');return;}
    let end;while((end=buffer.indexOf('\n'))>=0){const line=buffer.slice(0,end);buffer=buffer.slice(end+1);let m;try{m=JSON.parse(line);}catch{fail('INSTANTLY_PROTOCOL_JSON_INVALID');continue;}
     if(m.method&&m.id!==undefined){child.stdin.write(JSON.stringify({id:m.id,error:{code:-32601,message:'No additional actions or authentication changes authorized'}})+'\n');fail('INSTANTLY_AUTH_OR_ADDITIONAL_ACTION_REQUIRED');}
     else if(m.id!==undefined){const p=pending.get(m.id);if(!p){fail('INSTANTLY_UNMATCHED_PROTOCOL_RESULT');continue;}pending.delete(m.id);clearTimeout(p.timer);audit({event:'RPC_RESPONSE',id:m.id,method:p.method,matchingRequest:true,error:!!m.error});if(m.error){p.reject(Error('INSTANTLY_RPC_ERROR'));fail('INSTANTLY_RPC_ERROR');}else p.resolve(m.result);}
    }
   });
   await request('initialize',{clientInfo:{name:'elya_manifest_qa_acceptance',version:'1.0'},capabilities:{experimentalApi:true,explicitGatewayOauth:true}},context.readinessDeadlineMs);
   permit('initialized',{});child.stdin.write(JSON.stringify({method:'initialized',params:{}})+'\n');
   const t=await request('thread/start',{cwd:project,ephemeral:true,approvalPolicy:'never',approvalsReviewer:'user',sandbox:'read-only',environments:[],experimentalRawEvents:false,allowProviderModelFallback:false},context.readinessDeadlineMs);
   if(typeof t?.thread?.id!=='string'||!t.thread.id)throw Error('INSTANTLY_THREAD_INVALID');threadId=t.thread.id;
   for(let attempt=1;attempt<=10;attempt++){
    if(clock()>=context.readinessDeadlineMs)throw Error('INSTANTLY_READINESS_DEADLINE');
    statusCount++;const inventory=await request('mcpServerStatus/list',{threadId,serverName:'codex_apps',detail:'toolsAndAuthOnly'},context.readinessDeadlineMs);
    if(discoveryOnly){captureInventory(inventory,attempt);if(clock()>=context.readinessDeadlineMs)throw Error('INSTANTLY_READINESS_DEADLINE');}
    const observations=selectedTools.map(tool=>inspectDiscovery(inventory,{provider:'instantly',server:'codex_apps',tool}));
    for(const o of observations)audit({...o.evidence,attempt});
    if(observations.every(o=>!o.evidence.stopReason&&o.evidence.runtimeStatus.value==='connected'))return inventory;
    if(!observations.every(o=>o.evidence.stopReason==='DISCOVERY_RUNTIME_STARTING'&&o.evidence.matchingToolCount===1&&o.evidence.invalidToolEntryCount===0))throw Error(discoveryOnly?(observations.find(o=>o.evidence.stopReason)?.evidence.stopReason??'DISCOVERY_RUNTIME_NOT_CONNECTED'):'INSTANTLY_DISCOVERY_NOT_READY');
    if(attempt===10)throw Error('INSTANTLY_STATUS_REQUEST_CAP');
    await sleep(Math.min(2000,Math.max(0,context.readinessDeadlineMs-clock())));
   }
  },
  async call(call){const result=await request('mcpServer/tool/call',{threadId,...call},context.providerDeadlineMs);check(context.providerDeadlineMs);return result;},
  stop(){fail('INSTANTLY_CLIENT_CLOSED');},
 };
}

export async function runInstantlyPhaseWorker({db,manifest,phase,directory,context,assertAuthority,savedDeclarations,startProcess,clock,wallClock=Date.now,sleep}){
 const workerMono=performance.now(),workerWall=Date.now();clock??=()=>workerWall+Math.floor(performance.now()-workerMono);
 const calls=instantlyAcceptanceCalls(manifest,phase),offset=phase===1?0:2,trace=[],workerId=randomUUID();let client,schemaFailure=null,reason='INSTANTLY_WORKER_INCOMPLETE',status='FAILED',writeAttempted=false,ownsWorker=false;
 const audit=e=>{assertSafe(e);const v={at:new Date(wallClock()).toISOString(),...e};trace.push(v);appendFileSync(join(directory,'rpc.jsonl'),JSON.stringify(v)+'\n');};
 const active=()=>{guard(db,manifest,assertAuthority);if(clock()>=context.providerDeadlineMs)throw Error('INSTANTLY_PROVIDER_DEADLINE');};
 const permit=(method,params)=>{
  active();if(!['START_PROCESS','initialize','initialized','thread/start','mcpServerStatus/list','mcpServer/tool/call'].includes(method))throw Error('INSTANTLY_RPC_NOT_AUTHORIZED');
  if(method==='mcpServerStatus/list'){
   transaction(db,()=>{
    active();const s=phaseState(db,manifest,phase),other=getRecord(db,'acceptance_instantly_phase',phaseId(manifest,phase===1?2:1));
    if(s.workerId!==workerId||s.status!=='RUNNING'||params.serverName!=='codex_apps'||params.detail!=='toolsAndAuthOnly'||s.statusRequests>=10||s.statusRequests+(other?.statusRequests??0)>=20||clock()>=context.readinessDeadlineMs)throw Error('INSTANTLY_STATUS_REQUEST_CAP');
    putRecord(db,'acceptance_instantly_phase',phaseId(manifest,phase),{...s,statusRequests:s.statusRequests+1});journal(db,'ACCEPTANCE_INSTANTLY_STATUS_INTENT',phaseId(manifest,phase),{statusRequests:s.statusRequests+1});
   });
  }
  if(method==='mcpServer/tool/call'){
   const {threadId,...call}=params;
   transaction(db,()=>{
    active();const s=phaseState(db,manifest,phase),index=s.businessCalls;
    if(s.workerId!==workerId||s.status!=='RUNNING'||typeof threadId!=='string'||!calls[index]||canonical(call)!==canonical(calls[index]))throw Error('INSTANTLY_EXACT_CALL_DENIED');
    const id=callId(manifest,offset+index);if(getRecord(db,'acceptance_instantly_call',id))throw Error('INSTANTLY_CALL_ALREADY_CONSUMED_NO_REPLAY');
    const all=db.prepare("SELECT data_json FROM records WHERE kind='acceptance_instantly_call'").all().map(r=>JSON.parse(r.data_json)).filter(r=>r.manifestId===manifest.id);
    if(all.length>=7||call.tool===TOOLS[2]&&all.some(r=>r.tool===TOOLS[2]))throw Error('INSTANTLY_CALL_CAP');
    putRecord(db,'acceptance_instantly_call',id,{manifestId:manifest.id,phase,index:offset+index,tool:call.tool,arguments:call.arguments,callHash:hash(call),state:'INTENT',at:new Date(wallClock()).toISOString()});
    putRecord(db,'acceptance_instantly_phase',phaseId(manifest,phase),{...s,businessCalls:index+1});journal(db,'ACCEPTANCE_INSTANTLY_CALL_INTENT',id,{phase,tool:call.tool,callHash:hash(call)});
   });
   if(call.tool===TOOLS[2])writeAttempted=true;
  }
 };
 try{
  transaction(db,()=>{
   active();const slot=phaseState(db,manifest,phase);if(slot.manifestHash!==hash(manifest)||slot.contextHash!==hash(context)||context.phase!==phase||context.manifestId!==manifest.id||context.manifestHash!==hash(manifest)||context.readinessDeadlineMs!==context.launchStartedMs+20000||context.providerDeadlineMs!==context.launchStartedMs+40000||slot.workerStarted===true||slot.status!=='LAUNCH_INTENT')throw Error('INSTANTLY_WORKER_ALREADY_CONSUMED');
   putRecord(db,'acceptance_instantly_phase',phaseId(manifest,phase),{...slot,workerId,workerStarted:true,status:'RUNNING'});journal(db,'ACCEPTANCE_INSTANTLY_WORKER_STARTED',phaseId(manifest,phase),{workerId});
  });ownsWorker=true;
  client=acceptanceClient({context,startProcess,audit,permit,clock,sleep});
  const inventory=await client.initialize();active();
  const captured=captureContracts(inventory,directory,new Date(wallClock()).toISOString());active();
  if(isInstantlyQaId(manifest.id)){
   const approved=manifest.contracts.approvedContracts;
   if(!Array.isArray(approved)||approved.length!==captured.tools.length||captured.tools.some((contract,index)=>hash(contract)!==approved[index]?.sha256||canonical(contract)!==canonical(approved[index]?.contract)))throw Error('INSTANTLY_QA_CONTRACT_DRIFT');
  }
  const contracts=validateTools(inventory,manifest,savedDeclarations);saveJson(join(directory,'runtime-schemas.json'),contracts);persist(db,manifest,phase,{schemaHash:hash(contracts)},'ACCEPTANCE_INSTANTLY_SCHEMA_VALIDATED');
  const before=phase===2?phaseState(db,manifest,1).snapshots:null;let snapshots={};
  for(let n=0;n<calls.length;n++){
   active();const call=calls[n],kind=call.tool===TOOLS[0]?'campaign':'lead';
   const response=await client.call(call);active();
   if(call.tool===TOOLS[2]){
    // The saved declaration promises an arbitrary object, not a complete lead.
    // Validate that envelope without inventing success fields; the next exact
    // get_lead call alone establishes whether the requested values persisted.
    const representations=decodeResult(response,contracts[call.tool]);
    if(response.isError!==false)throw Error('INSTANTLY_WRITE_ACK_UNCONFIRMED');
    const id=callId(manifest,offset+n),ackHash=hash(representations);
    transaction(db,()=>{const r=getRecord(db,'acceptance_instantly_call',id);putRecord(db,'acceptance_instantly_call',id,{...r,state:'RESULT_ACCEPTED',snapshotHash:ackHash,validation:{protocol:'PASSED',toolError:'NO_ERROR_REPORTED',application:'READBACK_REQUIRED'}});journal(db,'ACCEPTANCE_INSTANTLY_WRITE_ACKNOWLEDGED',id,{ackHash,application:'READBACK_REQUIRED'});});
    saveJson(join(directory,'write-acknowledgment.json'),{ackHash,protocol:'PASSED',toolError:'NO_ERROR_REPORTED',application:'READBACK_REQUIRED'});continue;
   }
   const snapshot=assess(response,contracts[call.tool],manifest,kind);
   if(phase===2&&n<2&&snapshot.hash!==before[kind].hash)throw Error('INSTANTLY_PREWRITE_STATE_CHANGED');
   if(phase===2&&n>=2&&kind==='lead'&&(snapshot.variablesHash!==hash(manifest.instantly.writeArguments.custom_variables)||snapshot.preservationHash!==before.lead.preservationHash))throw Error('INSTANTLY_POSTWRITE_LEAD_MISMATCH');
   if(phase===2&&n===4&&snapshot.hash!==before.campaign.hash)throw Error('INSTANTLY_CAMPAIGN_CHANGED');
   const id=callId(manifest,offset+n);transaction(db,()=>{const r=getRecord(db,'acceptance_instantly_call',id);putRecord(db,'acceptance_instantly_call',id,{...r,state:'RESULT_ACCEPTED',snapshotHash:snapshot.hash,validation:{protocol:'PASSED',toolError:'NO_ERROR_REPORTED',application:'PASSED'}});journal(db,'ACCEPTANCE_INSTANTLY_RESULT_ACCEPTED',id,{snapshotHash:snapshot.hash});});
   snapshots[kind]=snapshot;saveJson(join(directory,`snapshot-${offset+n}-${kind}.json`),snapshot);persist(db,manifest,phase,{snapshots},'ACCEPTANCE_INSTANTLY_SNAPSHOT');
  }
  status='PASSED';reason=phase===1?'INSTANTLY_QA_PREFLIGHT_VALIDATED':'INSTANTLY_QA_MERGE_AND_READBACK_VALIDATED';
 }catch(e){reason=safeReason(e);status=writeAttempted?'UNCERTAIN':'FAILED';
  if(!ownsWorker)return {phase,status:'REJECTED',reason,workerOwnsSlot:false};
  if(e.schemaFailure){
   const detail={...e.schemaFailure,businessToolExecutionBegun:phaseState(db,manifest,phase).businessCalls>0};
   try{assertSafe(detail);schemaFailure=detail;}catch{schemaFailure={category:'REDACTED',reason:'Sensitive diagnostic content withheld',businessToolExecutionBegun:detail.businessToolExecutionBegun};}
   try{saveJson(join(directory,'schema-validation-error.json'),schemaFailure);}catch{reason='INSTANTLY_SCHEMA_DIAGNOSTIC_PERSISTENCE_FAILED';}
  }
  for(const row of db.prepare("SELECT id,data_json FROM records WHERE kind='acceptance_instantly_call'").all()){const r=JSON.parse(row.data_json);if(r.manifestId===manifest.id&&r.phase===phase&&r.state==='INTENT')putRecord(db,'acceptance_instantly_call',row.id,{...r,state:'UNCERTAIN',reason});}
 }finally{client?.stop();}
 const result={phase,status,reason,...(schemaFailure?{schemaFailure}:{}),workerOwnsSlot:true,writeAttempted,requestCounts:{statusSchema:phaseState(db,manifest,phase).statusRequests,business:phaseState(db,manifest,phase).businessCalls},protocolOutcomes:trace.filter(x=>x.event==='RPC_RESPONSE'&&x.method==='mcpServer/tool/call'),usageUsd:'NOT_EXPOSED',noActivation:true};
 persist(db,manifest,phase,{workerResult:result,status:'AWAITING_CLEANUP'},'ACCEPTANCE_INSTANTLY_WORKER_FINISHED');return result;
}

async function launchContained({directory,context}){
 const win=process.env.SystemRoot??'C:\\Windows';
 const owner=spawn(join(win,'System32','WindowsPowerShell','v1.0','powershell.exe'),['-NoProfile','-NonInteractive','-File',join(project,'work/connector-compatibility/owner.ps1'),'-Directory',directory,'-Node',process.execPath,'-Native',join(project,'work/containment-proof/Job.cs'),'-Worker',join(project,isInstantlyQaId(context.manifestId)?join(instantlyQaRelativeDirectory(context.manifestId),'instantly-worker.mjs'):context.manifestId===CONTINUATION_ID?'work/acceptance-continuation-v1/instantly-worker.mjs':'work/acceptance-manifest-v1/instantly-worker.mjs')],{cwd:project,windowsHide:true,stdio:'ignore'});
 const watchdog=setTimeout(()=>owner.kill(),Math.max(1,context.launchStartedMs+52000-Date.now()));
 let exit;try{exit=await new Promise(resolve=>{owner.once('error',()=>resolve({error:'OWNER_START_FAILED'}));owner.once('exit',(code,signal)=>resolve({code,signal}));});}finally{clearTimeout(watchdog);}
 return {owner:readJson(join(directory,'owner-result.json')),worker:readJson(join(directory,'worker-result.json')),exit};
}
export async function runAcceptanceInstantly({db,manifest,assertAuthority,phase,directory,emit=()=>{},startedMono=performance.now(),startedWall=Date.now(),fixtureLaunch}){
 guard(db,manifest,assertAuthority);instantlyAcceptanceCalls(manifest,phase);
 if(phase===2&&getRecord(db,'acceptance_instantly_phase',phaseId(manifest,1))?.status!=='PASSED')throw Error('INSTANTLY_PHASE_ONE_CLEAN_SUCCESS_REQUIRED');
 if(getRecord(db,'acceptance_instantly_phase',phaseId(manifest,phase)))throw Error('INSTANTLY_PHASE_ALREADY_CONSUMED_NO_REPLAY');
 const dbPath=db.prepare('PRAGMA database_list').all().find(r=>r.name==='main')?.file;
 if(fixtureLaunch&&dbPath)throw Error('INSTANTLY_FIXTURE_REQUIRES_IN_MEMORY_DATABASE');
 if(!fixtureLaunch&&(!dbPath||process.platform!=='win32'))throw Error('INSTANTLY_CONTAINED_WINDOWS_DATABASE_REQUIRED');
 const launchStartedMs=Date.now(),launchMono=performance.now(),phaseDirectory=join(directory,`instantly-phase-${phase}`);
 if(existsSync(phaseDirectory))throw Error('INSTANTLY_PHASE_DIRECTORY_EXISTS_NO_REPLAY');mkdirSync(phaseDirectory,{recursive:true});
 const environment={};for(const name of ['SystemRoot','WINDIR','COMSPEC','PATH','USERPROFILE','HOME','APPDATA','LOCALAPPDATA','CODEX_HOME','TEMP','TMP'])if(process.env[name])environment[name]=process.env[name];
 const context={manifestId:manifest.id,manifestHash:hash(manifest),phase,manifest,database:dbPath??'',project,codex:join(homedir(),'AppData/Local/OpenAI/Codex/bin/9e1da79431da526b/codex.exe'),environment,launchStartedMs,readinessDeadlineMs:launchStartedMs+20000,providerDeadlineMs:launchStartedMs+40000,deadlineAt:new Date(launchStartedMs+40000).toISOString(),hardDeadlineAt:new Date(launchStartedMs+60000).toISOString()};
 transaction(db,()=>{guard(db,manifest,assertAuthority);if(getRecord(db,'acceptance_instantly_phase',phaseId(manifest,phase)))throw Error('INSTANTLY_PHASE_ALREADY_CONSUMED_NO_REPLAY');putRecord(db,'acceptance_instantly_phase',phaseId(manifest,phase),{phase,manifestHash:hash(manifest),contextHash:hash(context),status:'LAUNCH_INTENT',workerStarted:false,statusRequests:0,businessCalls:0,launchStartedAt:new Date(launchStartedMs).toISOString(),directory:phaseDirectory});journal(db,'ACCEPTANCE_INSTANTLY_LAUNCH_INTENT',phaseId(manifest,phase),{manifestHash:hash(manifest),phase});});
 let outcome,launchAttempted=false;
 try{
  saveJson(join(phaseDirectory,'context.json'),context);
  const win=process.env.SystemRoot??'C:\\Windows',configRoot=environment.CODEX_HOME??join(environment.USERPROFILE??'','.codex');
  const provenance=fixtureLaunch?{phase:'BEFORE_CONNECTION_WORK',mode:'OFFLINE_FIXTURE',credentialsCopied:false}:captureLaunchProvenance({root:project,executables:[{label:'node',path:process.execPath},{label:'codex-app-server',path:context.codex},{label:'powershell-owner',path:join(win,'System32','WindowsPowerShell','v1.0','powershell.exe')}],configurationFiles:[{label:'user-config',path:join(configRoot,'config.toml')},{label:'project-config',path:join(project,'.codex','config.toml')},{label:'codex_app-package-not-assumed-codex_apps-owner',path:join(configRoot,'plugins/cache/openai-bundled/codex-app-tools/26.1106.51428/.mcp.json')}],settings:context});
  saveJson(join(phaseDirectory,'launch-provenance.json'),provenance);guard(db,manifest,assertAuthority);emit({event:'INSTANTLY_CONTAINED_LAUNCH',phase,maximumMs:60000});
  if(isInstantlyQaId(manifest.id)){
   const active=guard(db,manifest,assertAuthority),deadline=Date.parse(active.deadlineAt);
   if(active.id!==manifest.id||active.status!=='CLAIMED'||typeof active.deadlineAt!=='string'||!Number.isFinite(deadline))throw Error('INSTANTLY_QA_LAUNCH_DEADLINE_REQUIRED');
   if(deadline-Date.now()<70000)throw Error('INSUFFICIENT_SESSION_TIME_FOR_CONTAINED_LAUNCH');
  }
  launchAttempted=true;
  outcome=await (fixtureLaunch??launchContained)({db,manifest,phase,directory:phaseDirectory,context,assertAuthority});
 }
 catch(e){outcome={worker:null,owner:null,exit:{error:safeReason(e)}};}
 const owner=outcome.owner,worker=outcome.worker;
 const cleanup=owner?.cleanupConfirmed===true&&owner.noPostCleanupRpcWrites===true&&Array.isArray(owner.remainingMembers)&&owner.remainingMembers.length===0&&Array.isArray(owner.processChecks)&&owner.processChecks.length>0&&owner.processChecks.every(p=>p.wait===0)&&!owner.error&&!!owner.cleanupCompletedAt;
 let authorityStillValid=true;try{guard(db,manifest,assertAuthority);}catch{authorityStillValid=false;}
 for(const row of db.prepare("SELECT id,data_json FROM records WHERE kind='acceptance_instantly_call'").all()){const r=JSON.parse(row.data_json);if(r.manifestId===manifest.id&&r.phase===phase&&r.state==='INTENT')putRecord(db,'acceptance_instantly_call',row.id,{...r,state:'UNCERTAIN',reason:'INSTANTLY_WORKER_EXIT_WITHOUT_MATCHED_RESULT'});}
 const state=phaseState(db,manifest,phase),expected=instantlyAcceptanceCalls(manifest,phase),offset=phase===1?0:2;
 const durableComplete=state.businessCalls===expected.length&&expected.every((call,n)=>{const r=getRecord(db,'acceptance_instantly_call',callId(manifest,offset+n));return r?.state==='RESULT_ACCEPTED'&&r.callHash===hash(call);})&&state.workerResult&&canonical(state.workerResult)===canonical(worker);
 const elapsedMs=Math.floor(performance.now()-launchMono),passed=cleanup&&outcome.exit?.code===0&&!owner.timedOut&&worker?.status==='PASSED'&&durableComplete&&elapsedMs<60000&&authorityStillValid;
 const writeAttempted=worker?.writeAttempted===true||getRecord(db,'acceptance_instantly_call',callId(manifest,4))?.state!==undefined;
 const notLaunched=isInstantlyQaId(manifest.id)&&!launchAttempted;
 const result={phase,status:passed?'PASSED':writeAttempted?'UNCERTAIN':'FAILED',reason:passed?worker.reason:notLaunched?outcome.exit?.error??'INSTANTLY_WORKER_INCOMPLETE':!cleanup?'INSTANTLY_CLEANUP_UNCONFIRMED':!authorityStillValid?'INSTANTLY_AUTHORITY_CHANGED':elapsedMs>=60000?'INSTANTLY_LAUNCH_TOTAL_DEADLINE':worker?.reason??'INSTANTLY_WORKER_INCOMPLETE',...(notLaunched?{notLaunched:true}:{}),cleanup:{confirmed:cleanup,evidence:owner,fixture:!!fixtureLaunch},requestCounts:worker?.requestCounts??{statusSchema:state.statusRequests,business:state.businessCalls},protocolOutcomes:worker?.protocolOutcomes??[],writeAttempted,elapsedMs,sessionElapsedMs:Math.floor(performance.now()-startedMono),sessionStartedAt:new Date(startedWall).toISOString(),usageUsd:'NOT_EXPOSED',noActivation:true};
 if(worker?.schemaFailure)result.schemaFailure=worker.schemaFailure;
 // Final reporting must not throw away a completed write/readback or cleanup
 // outcome. A local reporting failure blocks continuation while retaining the
 // provider evidence; it never makes an attempted phase appear NOT_ATTEMPTED.
 const localFailure=code=>{
  result.providerOutcome??={status:result.status,reason:result.reason};
  result.localReportError??=code;result.reason=result.localReportError;
  result.status=result.providerOutcome.status==='UNCERTAIN'?'UNCERTAIN':'FAILED';
 };
 try{persist(db,manifest,phase,{status:result.status,result},'ACCEPTANCE_INSTANTLY_PHASE_CLOSED');}
 catch{localFailure('INSTANTLY_PHASE_JOURNAL_PERSISTENCE_FAILED');}
 try{saveJson(join(phaseDirectory,'phase-result.json'),result);}
 catch{localFailure('INSTANTLY_PHASE_RESULT_PERSISTENCE_FAILED');}
 try{emit({event:'INSTANTLY_PHASE_CLOSED',phase,status:result.status,reason:result.reason,...(result.schemaFailure?{schemaFailure:result.schemaFailure}:{})});}
 catch{localFailure('INSTANTLY_PHASE_RESULT_EMIT_FAILED');}
 if(result.localReportError){
  try{persist(db,manifest,phase,{status:result.status,result},'ACCEPTANCE_INSTANTLY_LOCAL_REPORT_FAILED');}
  catch{result.localJournalError='INSTANTLY_PHASE_JOURNAL_PERSISTENCE_FAILED';}
 }
 return result;
}
