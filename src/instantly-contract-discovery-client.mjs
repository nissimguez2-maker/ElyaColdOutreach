// One fixed contract-capture profile on the existing deterministic App Server
// transport. No tool-call method is available to this profile.
import {writeFileSync,appendFileSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {randomUUID} from 'node:crypto';
import {acceptanceClient,inputSchema} from './acceptance-instantly.mjs';
import {prepareOutputSchema} from './diagnostic-output-schema.mjs';
import {inspectDiscovery} from './diagnostic-discovery.mjs';
import {DISCOVERY_TOOLS,validateDiscoveryManifest} from './instantly-discovery-profile.mjs';
import {getRecord,putRecord,transaction,journal,controls} from './store.mjs';
import {canonical,digest,assertSafe} from './values.mjs';

const object=v=>v!==null&&typeof v==='object'&&!Array.isArray(v);
const hash=v=>digest(canonical(v));
const safeReason=e=>/^[A-Z][A-Z0-9_]+$/.test(e?.message??'')?e.message:'DISCOVERY_FAILED';
function save(path,value){assertSafe(value);writeFileSync(path,JSON.stringify(value,null,2),{flag:'wx',flush:true});}

export function captureDiscoveryContracts(inventory,directory,attempt,at){
 if(!Number.isSafeInteger(attempt)||attempt<1||attempt>10)throw Error('DISCOVERY_REQUEST_CAP');
 const servers=Array.isArray(inventory?.data)?inventory.data.filter(s=>object(s)&&s.name==='codex_apps'):[];
 const values=servers.length===1&&object(servers[0].tools)?Object.values(servers[0].tools):servers.length===1&&Array.isArray(servers[0].tools)?servers[0].tools:[];
 const selected=DISCOVERY_TOOLS.flatMap(name=>values.filter(t=>object(t)&&t.name===name));
 const observations=DISCOVERY_TOOLS.map(tool=>inspectDiscovery(inventory,{provider:'instantly',server:'codex_apps',tool}).evidence);
 const capture={stage:'BEFORE_SCHEMA_VALIDATION',capturedAt:at,attempt,server:'codex_apps',businessToolExecutionBegun:false,
  discovery:observations,presence:selected.map(t=>({name:t.name,inputSchemaPresent:Object.hasOwn(t,'inputSchema'),outputSchemaPresent:Object.hasOwn(t,'outputSchema')})),tools:selected};
 // Never redact an assertion and subsequently validate a different contract.
 // Unsafe selected content stops capture; unrelated inventory is never saved.
 try{assertSafe(capture);}catch{throw Error('DISCOVERY_EVIDENCE_UNSAFE');}
 try{save(join(directory,`selected-contracts-${String(attempt).padStart(2,'0')}.json`),capture);}catch{throw Error('DISCOVERY_EVIDENCE_PERSISTENCE_FAILED');}
 if(servers.length===1){
  if(DISCOVERY_TOOLS.some(name=>selected.filter(t=>t.name===name).length>1))throw Error('DISCOVERY_TARGET_CONFLICT');
  if(DISCOVERY_TOOLS.some(name=>selected.filter(t=>t.name===name).length===0))throw Error('DISCOVERY_TARGET_MISSING');
 }
 return capture;
}

export function validateDiscoveryContracts(capture){
 if(!Array.isArray(capture?.tools)||capture.tools.length!==2||capture.tools.some((t,i)=>t?.name!==DISCOVERY_TOOLS[i]))throw Error('DISCOVERY_CONTRACT_TARGET_MISMATCH');
 const validated=[];
 for(const tool of capture.tools){
  if(!object(tool)||'description'in tool&&typeof tool.description!=='string'||'annotations'in tool&&!object(tool.annotations))throw Error('DISCOVERY_CONTRACT_VALIDATION_FAILED');
  for(const key of ['readOnlyHint','destructiveHint','idempotentHint','openWorldHint'])if(Object.hasOwn(tool.annotations??{},key)&&typeof tool.annotations[key]!=='boolean')throw Error('DISCOVERY_CONTRACT_VALIDATION_FAILED');
  inputSchema(tool.inputSchema,tool.name);
  if(Object.hasOwn(tool,'outputSchema'))prepareOutputSchema(tool.outputSchema,{tool:tool.name,side:'output'});
  // JSON serialization preserves the complete advertised object, including
  // metadata. No invocation/result shape is inferred from a generic schema.
  validated.push({name:tool.name,advertisedContractSha256:digest(JSON.stringify(tool)),inputSchemaPresent:true,outputSchemaPresent:Object.hasOwn(tool,'outputSchema')});
 }
 return validated;
}

export async function runDiscoveryCaptureWorker({db,manifest,context,directory,assertAuthority,startProcess,clock,wallClock=Date.now,sleep}){
 const mono=performance.now(),wall=Date.now();clock??=()=>wall+Math.floor(performance.now()-mono);
 const workerId=randomUUID();let client,ownsWorker=false,lastCapture,reason='DISCOVERY_FAILED',status='FAILED',schemaFailure;
 const state=()=>getRecord(db,'acceptance_discovery_run',manifest.id);
 const persist=(patch,event)=>transaction(db,()=>{const next={...state(),...patch};putRecord(db,'acceptance_discovery_run',manifest.id,next);journal(db,event,manifest.id,patch);return next;});
 const audit=e=>{assertSafe(e);try{appendFileSync(join(directory,'rpc.jsonl'),JSON.stringify({at:new Date(wallClock()).toISOString(),...e})+'\n',{flush:true});}catch{throw Error('DISCOVERY_EVIDENCE_PERSISTENCE_FAILED');}};
 const active=()=>{
  validateDiscoveryManifest(manifest);if(typeof assertAuthority!=='function'||!assertAuthority())throw Error('DISCOVERY_AUTHORITY_REQUIRED');
  const c=controls(db);if(c.stopped!==true||c.launchAuthorized!==false)throw Error('DISCOVERY_BUSINESS_STOP_REQUIRED');
  if(clock()>=context.providerDeadlineMs)throw Error('DISCOVERY_WORK_DEADLINE');
 };
 const permit=(method,params)=>{
  active();if(!['START_PROCESS','initialize','initialized','thread/start','mcpServerStatus/list'].includes(method))throw Error('DISCOVERY_BUSINESS_RPC_UNAVAILABLE');
  if(method==='mcpServerStatus/list')transaction(db,()=>{
   active();const s=state(),at=clock();
   if(s?.workerId!==workerId||s.status!=='RUNNING'||params.serverName!=='codex_apps'||params.detail!=='toolsAndAuthOnly'||typeof params.threadId!=='string'||Object.keys(params).sort().join()!=='detail,serverName,threadId')throw Error('DISCOVERY_REQUEST_DENIED');
   if(at>=context.readinessDeadlineMs)throw Error('INSTANTLY_READINESS_DEADLINE');
   if(s.statusRequests>=10)throw Error('DISCOVERY_REQUEST_CAP');
   if(s.lastRequestAtMs!==undefined&&at-s.lastRequestAtMs<2000)throw Error('DISCOVERY_REQUEST_SPACING');
   putRecord(db,'acceptance_discovery_run',manifest.id,{...s,statusRequests:s.statusRequests+1,lastRequestAtMs:at});
   journal(db,'DISCOVERY_STATUS_ATTEMPT',manifest.id,{attempt:s.statusRequests+1,at:new Date(wallClock()).toISOString()});
  });
 };
 try{
  transaction(db,()=>{
   active();const s=state();
   if(s?.manifestHash!==hash(manifest)||s.contextHash!==hash(context)||context.manifestId!==manifest.id||context.manifestHash!==hash(manifest)||canonical(context.manifest)!==canonical(manifest)||context.readinessDeadlineMs!==context.launchStartedMs+20000||context.providerDeadlineMs!==context.launchStartedMs+40000||context.deadlineAt!==new Date(context.launchStartedMs+40000).toISOString()||context.hardDeadlineAt!==new Date(context.launchStartedMs+60000).toISOString()||resolve(s.directory)!==resolve(directory)||s.workerStarted||s.status!=='LAUNCH_INTENT'||s.statusRequests!==0||s.businessCalls!==0)throw Error('DISCOVERY_WORKER_ALREADY_CONSUMED_OR_CHANGED');
   putRecord(db,'acceptance_discovery_run',manifest.id,{...s,workerStarted:true,workerId,status:'RUNNING'});journal(db,'DISCOVERY_WORKER_STARTED',manifest.id,{workerId});
  });ownsWorker=true;
  client=acceptanceClient({context,startProcess,audit,permit,clock,sleep,discoveryOnly:true,captureInventory:(inventory,attempt)=>{active();lastCapture=captureDiscoveryContracts(inventory,directory,attempt,new Date(wallClock()).toISOString());active();}});
  await client.initialize();active();const contracts=validateDiscoveryContracts(lastCapture);active();
  try{save(join(directory,'validated-contracts.json'),{contracts,businessToolExecutionBegun:false});}catch{throw Error('DISCOVERY_EVIDENCE_PERSISTENCE_FAILED');}
  status='PASSED';reason='SELECTED_ADVERTISED_CONTRACTS_CAPTURED_AND_VALIDATED';
 }catch(e){
  reason=safeReason(e);if(!ownsWorker)return {status:'REJECTED',reason,workerOwnsSlot:false,requestCounts:{statusDiscovery:0,business:0}};
  if(e.schemaFailure){
   schemaFailure={...e.schemaFailure,businessToolExecutionBegun:false};
   reason=({ABSENT:'DISCOVERY_CONTRACT_SCHEMA_ABSENT',MALFORMED:'DISCOVERY_CONTRACT_MALFORMED',UNSUPPORTED:'DISCOVERY_SCHEMA_UNSUPPORTED'})[schemaFailure.category]??'DISCOVERY_CONTRACT_VALIDATION_FAILED';
   try{save(join(directory,'schema-validation-error.json'),schemaFailure);}catch{reason='DISCOVERY_EVIDENCE_PERSISTENCE_FAILED';}
  }
 }finally{client?.stop();}
 const result={status,reason,workerOwnsSlot:true,requestCounts:{statusDiscovery:state().statusRequests,business:0},businessToolExecutionBegun:false,underlyingNetworkRequests:'UNOBSERVED',usageUsd:'NOT_EXPOSED',...(schemaFailure?{schemaFailure}:{})};
 try{persist({workerResult:result,status:'AWAITING_CLEANUP'},'DISCOVERY_WORKER_FINISHED');}catch{result.status='FAILED';result.reason='DISCOVERY_DURABLE_RESULT_PERSISTENCE_FAILED';}
 return result;
}
