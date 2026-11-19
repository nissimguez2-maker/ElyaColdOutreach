// One approved diagnostic only. Uses existing CLI auth; no model turn or config writes.
import {spawn} from 'node:child_process';
import {ID,diagnosticSpec} from './diagnostic-policy.mjs';
import {validateReadTool,validateReadResult} from './diagnostic-protocol.mjs';
import {canonical} from './values.mjs';
import {inspectDiscovery} from './diagnostic-discovery.mjs';
import {waitForDiscoveryReady} from './diagnostic-readiness.mjs';
import {validateInstantlyResult} from './instantly-result.mjs';
export function diagnosticClient({executable,cwd,env,deadlineAt,audit,startProcess=spawn,testId=ID,permitDiscovery,waitForReadiness=false,signal,assertReadinessActive,readinessDeadlineAt=deadlineAt,statusRequestLimit}){
 const {calls:CALLS,discovery,readiness,functional,requestCap=1}=diagnosticSpec(testId);
 if(functional){
  // The authorized profile may only tighten its fixed ceilings, never extend them.
  const workDeadline=Date.parse(deadlineAt),latestReadiness=workDeadline-20000;
  if(!Number.isFinite(workDeadline)||Date.parse(readinessDeadlineAt)>latestReadiness)readinessDeadlineAt=new Date(latestReadiness).toISOString();
  statusRequestLimit=Math.min(statusRequestLimit??requestCap,requestCap);
 }
 // Existing one-shot discovery authority cannot be expanded into polling.
 if(discovery&&waitForReadiness&&!readiness)throw Error('READINESS_NOT_AUTHORIZED_FOR_PROFILE');
 waitForReadiness=!!readiness||waitForReadiness;
 if(!Number.isFinite(Date.parse(readinessDeadlineAt))||Date.parse(readinessDeadlineAt)>Date.parse(deadlineAt)||statusRequestLimit!==undefined&&(!Number.isSafeInteger(statusRequestLimit)||statusRequestLimit<1||statusRequestLimit>20))throw Error('INVALID_DISCOVERY_BOUNDS');
 let child,next=0,threadId,fatal=null,buffer='',initializationAttempted=false,discoverySubmitted=0,statusSubmitted=0;const pending=new Map(),used=new Set(),schemas=new Map();
 const fail=reason=>{fatal??=reason;for(const p of pending.values())p.reject(Error(fatal));pending.clear();};
 const check=()=>{if(signal?.aborted)throw Error('DIAGNOSTIC_CANCELLED');if(fatal)throw Error(fatal);if(Date.now()>=Date.parse(deadlineAt))throw Error('DIAGNOSTIC_DEADLINE');};
 function request(method,params){
  check();if(!['initialize','thread/start','mcpServerStatus/list','mcpServer/tool/call'].includes(method))throw Error('RPC_NOT_ALLOWED');
  if(discovery&&!functional&&method==='mcpServer/tool/call')throw Error('RPC_NOT_ALLOWED');
  if(method==='mcpServerStatus/list'){
   if(Date.now()>=Date.parse(readinessDeadlineAt))throw Error('READINESS_DEADLINE');
   if(statusRequestLimit!==undefined&&statusSubmitted>=statusRequestLimit)throw Error('STATUS_REQUEST_CAP');
   statusSubmitted++;
  }
  if(discovery&&method==='mcpServerStatus/list'){
   if(discoverySubmitted>=requestCap||canonical(params)!==canonical({threadId,serverName:discovery.server,detail:'toolsAndAuthOnly'}))throw Error('DISCOVERY_CALL_DENIED');
   discoverySubmitted++;
  }
  const id=++next;audit({event:'RPC_REQUEST',id,method,server:params.server??params.serverName??null});
  return new Promise((resolve,reject)=>{pending.set(id,{resolve,reject,method});child.stdin.write(JSON.stringify({id,method,params})+'\n',error=>{if(error){fail('PROTOCOL_WRITE_FAILED');return;}audit({event:'RPC_SUBMITTED',id,method,provider:CALLS.find(c=>c.server===params.server&&c.tool===params.tool)?.provider??null});});});
 }
 return {
  async initialize(){
   if((discovery||waitForReadiness)&&initializationAttempted)throw Error('INITIALIZATION_ALREADY_ATTEMPTED');initializationAttempted=true;
   if(Date.now()>=Date.parse(readinessDeadlineAt))throw Error('READINESS_DEADLINE');
   const initializationTimer=setTimeout(()=>fail('READINESS_DEADLINE'),Math.max(0,Date.parse(readinessDeadlineAt)-Date.now()));
   const cancelInitialization=()=>fail('DIAGNOSTIC_CANCELLED');signal?.addEventListener('abort',cancelInitialization,{once:true});
   try{
   check();child=startProcess(executable,['--no-daemon','app-server','--stdio','--strict-config'],{cwd,env,windowsHide:true,stdio:['pipe','pipe','pipe']});
   audit({event:'APP_SERVER_STARTED',pid:child.pid??null});child.on('error',()=>fail('PROCESS_START_FAILURE'));child.on('exit',()=>fail('APP_SERVER_EXITED'));child.stdin.on('error',()=>fail('PROTOCOL_WRITE_FAILED'));
   child.stderr.on('data',()=>{}); // Never retain raw runtime diagnostics or authentication material.
   child.stdout.on('data',bytes=>{
    buffer+=bytes.toString();if(buffer.length>8000000){fail('PROTOCOL_SIZE_LIMIT');buffer='';return;}
    let end;while((end=buffer.indexOf('\n'))>=0){const line=buffer.slice(0,end);buffer=buffer.slice(end+1);let m;try{m=JSON.parse(line);}catch{fail('INVALID_PROTOCOL_JSON');continue;}
     if(m.method&&m.id!==undefined){child.stdin.write(JSON.stringify({id:m.id,error:{code:-32601,message:'Additional actions and authentication changes not authorized'}})+'\n');fail('AUTH_CONSENT_OR_ACTION_REQUIRED');}
     else if(m.id!==undefined){const p=pending.get(m.id);if(!p){fail('UNMATCHED_PROTOCOL_RESULT');continue;}pending.delete(m.id);audit({event:'RPC_RESPONSE',id:m.id,method:p.method,matchingRequest:true,error:!!m.error});if(m.error){fail('RPC_ERROR');p.reject(Error('RPC_ERROR'));}else p.resolve(m.result);}
    }
   });
   await request('initialize',{clientInfo:{name:'elya_bounded_read_diagnostic',version:'1.0'},capabilities:{experimentalApi:true,explicitGatewayOauth:true}});child.stdin.write(JSON.stringify({method:'initialized',params:{}})+'\n');
   const t=await request('thread/start',{cwd,ephemeral:true,approvalPolicy:'never',approvalsReviewer:'user',sandbox:'read-only',environments:[],experimentalRawEvents:false,allowProviderModelFallback:false});
   if(typeof t?.thread?.id!=='string')throw Error('INVALID_THREAD');threadId=t.thread.id;
   const results=[];
   for(const c of discovery?[discovery]:CALLS){
    try{
    const read=()=>{
     if(discovery&&(typeof permitDiscovery!=='function'||canonical(permitDiscovery(c))!==canonical(c)))throw Error('DISCOVERY_PERMIT_REQUIRED');
     return request('mcpServerStatus/list',{threadId,serverName:c.server,detail:'toolsAndAuthOnly'});
    };
    const {evidence,tool}=waitForReadiness
     ?await waitForDiscoveryReady({read,call:c,deadlineAt:readinessDeadlineAt,audit,signal,assertActive:()=>{check();assertReadinessActive?.();}})
     :inspectDiscovery(await read(),c);
    if(!waitForReadiness)audit(evidence);
    if(evidence.stopReason)throw Error(evidence.stopReason);
    if(discovery&&!functional)return evidence;
    // Preserve only this exact tool's input contract even if validation rejects it.
    audit({event:'RUNTIME_SCHEMA_OBSERVED',provider:c.provider,server:c.server,tool:c.tool,inputSchema:tool.inputSchema});
    if(c.provider==='instantly')audit({event:'TOOL_OUTPUT_CONTRACT_OBSERVED',provider:c.provider,tool:c.tool,outputSchemaPresent:Object.hasOwn(tool,'outputSchema'),...(Object.hasOwn(tool,'outputSchema')?{outputSchema:tool.outputSchema}:{})});
    const schema=validateReadTool(c.provider,tool);schemas.set(c.provider,schema);results.push(schema);
    audit({event:'RUNTIME_SCHEMA_CONFIRMED',provider:c.provider,server:c.server,tool:c.tool,schemaHash:schema.schemaHash});
    }catch(error){throw Error(c.provider.toUpperCase()+'_'+(/^[A-Z_]+$/.test(error.message)?error.message:'SCHEMA_ERROR'));}
   }
   return results;
   }finally{clearTimeout(initializationTimer);signal?.removeEventListener('abort',cancelInitialization);}
  },
  async read(provider,permit){
   check();const c=CALLS.find(x=>x.provider===provider);
   if(!c||schemas.size!==CALLS.length||used.has(provider))throw Error('CALL_NOT_ALLOWED');
   // Claim is durable immediately before the single protocol submission.
   const exact=permit(c);if(canonical(exact)!==canonical(c))throw Error('PERMIT_MISMATCH');
   used.add(provider);
   try{
    const response=await request('mcpServer/tool/call',{threadId,server:c.server,tool:c.tool,arguments:c.arguments});check();
    if(provider==='instantly'){const assessed=validateInstantlyResult(response,c.arguments.id,schemas.get(provider));audit({event:'TOOL_RESULT_VALIDATION',provider,validation:assessed.validation,observedCampaign:assessed.observedCampaign,campaignState:'EXPECTED_NUMERIC_ZERO',reason:null});return assessed.result;}
    return validateReadResult(provider,response);
   }catch(error){
    if(provider==='instantly')audit({event:'TOOL_RESULT_VALIDATION',provider,validation:error.validation??{protocol:'UNRESOLVED',toolError:'NOT_RUN',parsing:'NOT_RUN',outputSchema:'NOT_RUN',application:'NOT_RUN'},...(error.observedCampaign?{observedCampaign:error.observedCampaign,campaignState:error.campaignState}:{}),reason:/^[A-Z_]+$/.test(error.message)?error.message:'RESULT_ERROR',completion:error.validation?'RESULT_RECEIVED_NOT_ACCEPTED':'UNRESOLVED_NO_REPLAY'});
    throw Error(provider.toUpperCase()+'_'+(/^[A-Z_]+$/.test(error.message)?error.message:'RESULT_ERROR'));
   }
  }
 };
}
