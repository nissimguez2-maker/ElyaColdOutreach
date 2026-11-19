// General handoff's concrete, dormant App Server transport. Only the fixed worker
// runs under the existing Windows JobObject owner; no model turn is supported.
import {spawn} from 'node:child_process';
import {mkdirSync,writeFileSync,readFileSync,appendFileSync} from 'node:fs';
import {join,isAbsolute,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {canonical,digest,required,timestamp,assertSafe} from './values.mjs';
import {getRecord,putRecord,openStore,transaction,journal} from './store.mjs';
import {prepareOutputSchema,checkOutputSchema} from './diagnostic-output-schema.mjs';
import {waitForDiscoveryReady} from './diagnostic-readiness.mjs';

const transports=new WeakSet(),hash=value=>digest(canonical(value)),clone=value=>JSON.parse(canonical(value));
const names=['instantly_ai.create_lead','instantly_ai.update_lead','instantly_ai.get_lead'];
const object=value=>value!==null&&typeof value==='object'&&!Array.isArray(value);
const readJson=path=>JSON.parse(readFileSync(path,'utf8').replace(/^\uFEFF/,''));
const sourceFiles=['src/handoff.mjs','src/handoff-production.mjs','src/handoff-app-server.mjs','src/handoff-app-server-worker.mjs','src/handoff-isolation.mjs','src/operations.mjs','src/batches.mjs','src/writing.mjs','src/writing-handoff.mjs','src/store.mjs','src/values.mjs','src/diagnostic-discovery.mjs','src/diagnostic-readiness.mjs','src/diagnostic-output-schema.mjs','src/workflow-runtime.mjs','src/workflow-jobs.mjs','src/workflow-job-binding.mjs','work/connector-compatibility/owner.ps1','work/containment-proof/Job.cs'];
export function snapshotHandoffRuntimeSources(root){return sourceFiles.map(path=>({path,sha256:digest(readFileSync(join(root,path)))}));}
function assertRuntimeSources(context){if(canonical(context.sources)!==canonical(snapshotHandoffRuntimeSources(context.project)))throw Error('HANDOFF_RUNTIME_SOURCE_CHANGED');}
export function claimHandoffWorker(db,context,directory){
 assertRuntimeSources(context);
 return transaction(db,()=>{
  const key=`${context.operationId}:${context.requestCount}`,intent=getRecord(db,'handoff_call',key);
  if(intent?.contextHash!==hash(context)||resolve(intent.directory)!==resolve(directory)||intent.status!=='LAUNCHING'||intent.workerStarted||canonical(intent.workflowBinding??null)!==canonical(context.workflowBinding??null))throw Error('HANDOFF_CONTAINED_CONTEXT_ALREADY_CLAIMED_OR_CHANGED');
  putRecord(db,'handoff_call',key,{...intent,workerStarted:true});return true;
 });
}
// Capture helpers add presence flags; those are evidence metadata, not advertised
// tool fields. Every actual advertised field remains part of the reviewed pin.
function advertisedTool(tool){const value=clone(tool);delete value.inputSchemaPresent;delete value.outputSchemaPresent;return value;}
function inputSchema(value){
 function normalize(s,depth=0){
  if(!object(s)||depth>12)throw Error('HANDOFF_RUNTIME_INPUT_SCHEMA_UNSUPPORTED');
  const v={...s};delete v.default;delete v.examples;
  if(v.anyOf){
   if(!Array.isArray(v.anyOf)||!v.anyOf.length||v.type||v.anyOf.some(x=>!object(x)||!['string','number','boolean','null'].includes(x.type)||Object.keys(x).some(k=>!['type','description'].includes(k))))throw Error('HANDOFF_RUNTIME_INPUT_SCHEMA_UNSUPPORTED');
   v.type=v.anyOf.map(x=>x.type);delete v.anyOf;
  }
  if(object(v.properties))v.properties=Object.fromEntries(Object.entries(v.properties).map(([k,p])=>[k,normalize(p,depth+1)]));
  for(const k of ['additionalProperties','items','propertyNames'])if(object(v[k]))v[k]=normalize(v[k],depth+1);
  return v;
 }
 return prepareOutputSchema(normalize(value),{side:'input'});
}
export function validateHandoffRuntimeContracts(value){
 if(!object(value)||!Array.isArray(value.tools))throw Error('HANDOFF_RUNTIME_CONTRACTS_REQUIRED');
 for(const key of ['sourceRef','approvedBy','approvedAt','expiresAt'])required(value[key]);
 if(timestamp(value.expiresAt)<=timestamp(value.approvedAt))throw Error('HANDOFF_RUNTIME_CONTRACT_WINDOW_INVALID');
 const contracts={};
 for(const name of names){
  const matching=value.tools.filter(t=>t.name===name);
  if(matching.length!==1)throw Error('HANDOFF_RUNTIME_CONTRACT_MISSING:'+name);
  const tool=matching[0];inputSchema(tool.inputSchema);prepareOutputSchema(tool.outputSchema);
  if(name==='instantly_ai.update_lead'&&(!/\bmerge\b/i.test(tool.inputSchema?.properties?.custom_variables?.description??'')||/\breplace|overwrite|remove|delete\b/i.test(tool.inputSchema.properties.custom_variables.description)))throw Error('HANDOFF_RUNTIME_MERGE_CONTRACT_REQUIRED');
  contracts[name]=advertisedTool(tool);
 }
 return {value:clone(value),contracts,hash:hash(value)};
}
function validateCall(call,contracts){
 if(call?.server!=='codex_apps'||!names.includes(call.tool)||canonical(Object.keys(call).sort())!==canonical(['arguments','server','tool']))throw Error('HANDOFF_RUNTIME_CALL_NOT_ALLOWED');
 const tool=contracts[call.tool],keys=call.tool==='instantly_ai.create_lead'?['campaign','email']:call.tool==='instantly_ai.update_lead'?['custom_variables','id']:['id'];
 if(!object(call.arguments)||canonical(Object.keys(call.arguments).sort())!==canonical([...keys].sort())||!checkOutputSchema(inputSchema(tool.inputSchema),call.arguments))throw Error('HANDOFF_RUNTIME_ARGUMENTS_INVALID');
}
export const isContainedHandoffTransport=value=>transports.has(value);
export function createContainedHandoffTransport({dbPath,root,directory,executable,environment={},runtimeContracts}={}){
 const saved=validateHandoffRuntimeContracts(runtimeContracts);
 if([dbPath,root,directory,executable].some(p=>typeof p!=='string'||!isAbsolute(p))||!object(environment)||Object.keys(environment).some(k=>!['SystemRoot','WINDIR','COMSPEC','PATH','USERPROFILE','HOME','APPDATA','LOCALAPPDATA','CODEX_HOME','TEMP','TMP'].includes(k))||Object.values(environment).some(v=>typeof v!=='string'))throw Error('HANDOFF_CONTAINED_CONFIGURATION_INVALID');
 const config=clone({dbPath,root,directory,executable,environment,runtimeContracts:saved.value});
 const transport=Object.freeze({mode:'contained-app-server',async execute(call,{signal,permit,context}){
  if(process.platform!=='win32')throw Error('HANDOFF_WINDOWS_CONTAINMENT_REQUIRED');
  validateCall(call,saved.contracts);signal.throwIfAborted();
  const exact=permit(call),at=Date.now(),key=`${context.operationId}:${context.requestCount}`;
  const db=openStore(config.dbPath);let work;
  try{
   const h=getRecord(db,'handoff',context.operationId),authority=h&&getRecord(db,'handoff_authorization',h.prepared.authorizationId),contract=h&&getRecord(db,'instantly_handoff_contract',h.prepared.contractId);
   if(h?.prepared.mode!=='PRODUCTION'||saved.value.approvedBy!==authority?.approvedBy||timestamp(saved.value.approvedAt)>at||timestamp(saved.value.expiresAt)<=at)throw Error('HANDOFF_RUNTIME_CONTRACT_NOT_APPROVED');
   const deadline=Math.min(at+40000,timestamp(authority.expiresAt),timestamp(contract.expiresAt),timestamp(saved.value.expiresAt));
   if(deadline-at<1000)throw Error('HANDOFF_RUNTIME_DEADLINE');
   const callDirectory=join(config.directory,hash({operationId:context.operationId,requestCount:context.requestCount}));
   work={database:config.dbPath,project:config.root,codex:config.executable,environment:config.environment,runtimeContracts:saved.value,sources:snapshotHandoffRuntimeSources(config.root),call:exact,operationId:context.operationId,requestCount:context.requestCount,workflowBinding:context.workflowBinding??null,deadlineAt:new Date(deadline).toISOString()};
   transaction(db,()=>{
    const intent=getRecord(db,'handoff_call',key);
    if(intent?.status!=='LAUNCHING'||intent.contextHash||intent.callHash!==hash(exact)||canonical(intent.workflowBinding??null)!==canonical(work.workflowBinding))throw Error('HANDOFF_CONTAINED_CALL_ALREADY_CLAIMED');
    putRecord(db,'handoff_call',key,{...intent,contextHash:hash(work),directory:callDirectory});journal(db,'HANDOFF_CONTAINED_LAUNCH_INTENT',context.operationId,{requestCount:context.requestCount,contextHash:hash(work)});
   });
   mkdirSync(config.directory,{recursive:true});mkdirSync(callDirectory,{recursive:false});assertSafe(work);writeFileSync(join(callDirectory,'context.json'),JSON.stringify(work),{flag:'wx',flush:true});
   const outcome=await launchOwner(config.root,callDirectory,deadline,signal);
   return assessContainedHandoffResult(outcome);
  }finally{db.close();}
 }});
 transports.add(transport);return transport;
}
export function assessContainedHandoffResult({owner,worker,exit}){
 if(exit?.code!==0||owner?.cleanupConfirmed!==true||owner.noPostCleanupRpcWrites!==true||owner.timedOut||owner.error||!owner.cleanupCompletedAt||!Array.isArray(owner.remainingMembers)||owner.remainingMembers.length||!Array.isArray(owner.processChecks)||!owner.processChecks.length||owner.processChecks.some(p=>p.wait!==0)||worker?.status!=='RESULT_RECEIVED')throw Error('HANDOFF_CONTAINED_OUTCOME_UNCERTAIN');
 return worker.response;
}
async function launchOwner(root,directory,deadline,signal){
 const win=process.env.SystemRoot??'C:\\Windows';
 const owner=spawn(join(win,'System32','WindowsPowerShell','v1.0','powershell.exe'),['-NoProfile','-NonInteractive','-File',join(root,'work/connector-compatibility/owner.ps1'),'-Directory',directory,'-Node',process.execPath,'-Native',join(root,'work/containment-proof/Job.cs'),'-Worker',fileURLToPath(new URL('./handoff-app-server-worker.mjs',import.meta.url))],{cwd:root,windowsHide:true,shell:false,stdio:'ignore'});
 const stop=()=>owner.kill(),timer=setTimeout(stop,Math.max(1,deadline+15000-Date.now()));signal.addEventListener('abort',stop,{once:true});
 try{
  const exit=await new Promise(resolve=>{owner.once('error',()=>resolve({error:'HANDOFF_OWNER_START_FAILED'}));owner.once('exit',(code,signal)=>resolve({code,signal}));});
  let cleanup=null,worker=null;try{cleanup=readJson(join(directory,'owner-result.json'));}catch{}try{worker=readJson(join(directory,'worker-result.json'));}catch{}
  return {owner:cleanup,worker,exit};
 }finally{clearTimeout(timer);signal.removeEventListener('abort',stop);}
}
// This protocol client is only composed with the JobObject-owned worker below.
// Tests inject a local fake process; it never accepts prompts or model methods.
export async function runHandoffAppServerCall({context,permit,startProcess=spawn,audit=()=>{},captureContract=()=>{},clock=Date.now,sleep}){
 const saved=validateHandoffRuntimeContracts(context.runtimeContracts);validateCall(context.call,saved.contracts);
 const deadline=timestamp(context.deadlineAt);let child,threadId,sequence=0,buffer='',fatal=null;const pending=new Map();
 const fail=code=>{fatal??=code;for(const p of pending.values()){clearTimeout(p.timer);p.reject(Error(fatal));}pending.clear();};
 const check=()=>{if(fatal)throw Error(fatal);if(timestamp(saved.value.approvedAt)>clock()||timestamp(saved.value.expiresAt)<=clock())throw Error('HANDOFF_RUNTIME_CONTRACT_EXPIRED');if(clock()>=deadline)throw Error('HANDOFF_RUNTIME_DEADLINE');};
 function request(method,params){
  check();if(!['initialize','thread/start','mcpServerStatus/list','mcpServer/tool/call'].includes(method))throw Error('HANDOFF_RUNTIME_METHOD_DENIED');
  const id=++sequence;audit({event:'RPC_REQUEST',id,method});
  return new Promise((resolve,reject)=>{
   const timer=setTimeout(()=>fail('HANDOFF_RUNTIME_DEADLINE'),Math.max(1,deadline-clock()));pending.set(id,{resolve,reject,timer});
   child.stdin.write(JSON.stringify({id,method,params})+'\n',error=>{if(error)fail('HANDOFF_PROTOCOL_WRITE_FAILED');});
  });
 }
 try{
  check();child=startProcess(context.codex,['--no-daemon','app-server','--stdio','--strict-config'],{cwd:context.project,env:context.environment,windowsHide:true,shell:false,stdio:['pipe','pipe','pipe']});
  child.on('error',()=>fail('HANDOFF_APP_SERVER_START_FAILED'));child.on('exit',()=>fail('HANDOFF_APP_SERVER_EXITED'));child.stdin.on('error',()=>fail('HANDOFF_PROTOCOL_WRITE_FAILED'));child.stderr.on('data',()=>{});
  child.stdout.on('data',bytes=>{
   buffer+=bytes.toString();if(buffer.length>8000000){buffer='';fail('HANDOFF_PROTOCOL_SIZE_LIMIT');return;}
   let end;while((end=buffer.indexOf('\n'))>=0){
    const line=buffer.slice(0,end);buffer=buffer.slice(end+1);let m;try{m=JSON.parse(line);}catch{fail('HANDOFF_PROTOCOL_JSON_INVALID');return;}
    if(m.method&&m.id!==undefined){child.stdin.write(JSON.stringify({id:m.id,error:{code:-32601,message:'Additional actions and authentication changes not authorized'}})+'\n');fail('HANDOFF_ADDITIONAL_ACTION_DENIED');return;}
    if(m.id!==undefined){const p=pending.get(m.id);if(!p){fail('HANDOFF_UNMATCHED_RESULT');return;}pending.delete(m.id);clearTimeout(p.timer);audit({event:'RPC_RESPONSE',id:m.id,error:!!m.error});if(m.error){p.reject(Error('HANDOFF_RPC_ERROR'));fail('HANDOFF_RPC_ERROR');}else p.resolve(m.result);}
   }
  });
  await request('initialize',{clientInfo:{name:'elya_general_handoff',version:'1.0'},capabilities:{experimentalApi:true,explicitGatewayOauth:true}});
  child.stdin.write(JSON.stringify({method:'initialized',params:{}})+'\n');
  const thread=await request('thread/start',{cwd:context.project,ephemeral:true,approvalPolicy:'never',approvalsReviewer:'user',sandbox:'read-only',environments:[],experimentalRawEvents:false,allowProviderModelFallback:false});
  required(thread?.thread?.id);threadId=thread.thread.id;
  const {evidence,tool}=await waitForDiscoveryReady({read:()=>request('mcpServerStatus/list',{threadId,serverName:'codex_apps',detail:'toolsAndAuthOnly'}),call:{provider:'instantly',server:'codex_apps',tool:context.call.tool},deadlineAt:new Date(Math.min(deadline,clock()+20000)).toISOString(),audit,now:clock,sleep,assertActive:check});
  if(tool){assertSafe(tool);captureContract(clone(tool));}
  if(evidence.stopReason||evidence.runtimeStatus.value!=='connected'||!tool||hash(advertisedTool(tool))!==hash(saved.contracts[context.call.tool]))throw Error('HANDOFF_RUNTIME_CONTRACT_CHANGED');
  check();const exact=permit(context.call);if(canonical(exact)!==canonical(context.call))throw Error('HANDOFF_RUNTIME_PERMIT_MISMATCH');
  const response=await request('mcpServer/tool/call',{threadId,...exact});check();
  if(!object(response?.structuredContent)||!checkOutputSchema(saved.contracts[context.call.tool].outputSchema,response.structuredContent))throw Error('HANDOFF_RUNTIME_RESULT_SCHEMA_MISMATCH');
  return response;
 }finally{fail('HANDOFF_RUNTIME_CLOSED');}
}
export async function runContainedHandoffWorker(directory){
 const context=readJson(join(directory,'context.json')),db=openStore(context.database);let result,ownsSlot=false;
 try{
  claimHandoffWorker(db,context,directory);ownsSlot=true;
  const {permitHandoffProviderCall}=await import('./handoff.mjs');
  const response=await runHandoffAppServerCall({context,permit:call=>{assertRuntimeSources(context);return permitHandoffProviderCall(db,context.operationId,context.requestCount,call,new Date().toISOString(),undefined,true);},audit:event=>appendFileSync(join(directory,'rpc.jsonl'),JSON.stringify(event)+'\n'),captureContract:tool=>writeFileSync(join(directory,'selected-contract.json'),JSON.stringify(tool),{flag:'wx',flush:true})});
  result={status:'RESULT_RECEIVED',response};
 }catch{result={status:'UNCERTAIN',reason:'HANDOFF_WORKER_CALL_UNRESOLVED'};}
 finally{db.close();}
 assertSafe(result);writeFileSync(join(directory,ownsSlot?'worker-result.json':`worker-rejected-${process.pid}.json`),JSON.stringify(result),{flag:'wx',flush:true});return result;
}
