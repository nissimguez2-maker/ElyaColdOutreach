import {spawn} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import {readFileSync,writeFileSync,mkdirSync,existsSync} from 'node:fs';
import {join} from 'node:path';
import {homedir} from 'node:os';
import {controls,getRecord,putRecord,transaction,journal} from './store.mjs';
import {assertSafe,canonical,digest} from './values.mjs';
import {claimAcceptance,assertAcceptance,closeAcceptance,verifyAcceptanceSources} from './acceptance-authority.mjs';
import {assertInstantlyQaOperatorEntry} from './instantly-qa-v2-entry.mjs';
import {instantlyQaAuthorizationState,assertInstantlyQaDatabasePath} from './instantly-qa-readiness.mjs';
import {acceptanceErrorCode} from './acceptance-controller.mjs';
import {captureLaunchProvenance} from './diagnostic-provenance.mjs';
import {DISCOVERY_CAPTURE_ID,DISCOVERY_DIRECTORY} from './instantly-discovery-profile.mjs';
import {checkDiscoveryReadiness} from './instantly-discovery-binding.mjs';

const hash=value=>digest(canonical(value));
const readJson=path=>{try{return JSON.parse(readFileSync(path,'utf8').replace(/^\uFEFF/,''));}catch{return null;}};
function save(path,value){assertSafe(value);writeFileSync(path,JSON.stringify(value,null,2),{flag:'wx',flush:true});}
function cleanupConfirmed(owner){return owner?.cleanupConfirmed===true&&owner.noPostCleanupRpcWrites===true&&Array.isArray(owner.remainingMembers)&&owner.remainingMembers.length===0&&Array.isArray(owner.processChecks)&&owner.processChecks.length>0&&owner.processChecks.every(p=>p.wait===0)&&!owner.error&&typeof owner.cleanupCompletedAt==='string';}

// The unchanged outside JobObject owner confirms termination independently of
// its contained worker. Killing local processes cannot cancel remote work.
async function launchContained({root,directory,context,now}){
 const win=process.env.SystemRoot??'C:\\Windows';
 const owner=spawn(join(win,'System32/WindowsPowerShell/v1.0/powershell.exe'),['-NoProfile','-NonInteractive','-File',join(root,'work/connector-compatibility/owner.ps1'),'-Directory',directory,'-Node',process.execPath,'-Native',join(root,'work/containment-proof/Job.cs'),'-Worker',join(root,DISCOVERY_DIRECTORY,'discovery-worker.mjs')],{cwd:root,windowsHide:true,stdio:'ignore'});
 const watchdog=setTimeout(()=>owner.kill(),Math.max(1,context.launchStartedMs+52000-now()));
 let exit;try{exit=await new Promise(resolve=>{owner.once('error',()=>resolve({error:'DISCOVERY_OWNER_START_FAILED'}));owner.once('exit',(code,signal)=>resolve({code,signal}));});}finally{clearTimeout(watchdog);}
 return {exit,owner:readJson(join(directory,'owner-result.json')),worker:readJson(join(directory,'worker-result.json'))};
}

// Same entry for the fixed operator CLI and isolated offline fixtures. Only an
// in-memory database may replace the launch; the CLI has no fixture arguments.
export async function runDiscoveryEntry({db,root,runtime,now=Date.now,startedAtMs=now(),cancelled=()=>false,emit=()=>{},onInvocation,fixtureLaunch}){
 const id=DISCOVERY_CAPTURE_ID,base=join(root,DISCOVERY_DIRECTORY),directory=join(base,'live-once'),attemptId=randomUUID(),attempts=join(base,'attempts');
 let result,grant,manifest,stage='LOCAL_PREFLIGHT',claimed=false,launchAttempted=false,createdDirectory=false;
 const checkEntry=()=>assertInstantlyQaOperatorEntry(typeof runtime==='function'?runtime():runtime);
 const active=()=>{if(cancelled())throw Error('LOCAL_CANCELLATION');const value=assertAcceptance(db,manifest,now());verifyAcceptanceSources(root,value);return value;};
 try{
  assertInstantlyQaDatabasePath(db,root);onInvocation?.(attemptId);
  try{mkdirSync(attempts,{recursive:true});save(join(attempts,`${attemptId}.started.json`),{id,attemptId,startedAt:new Date(startedAtMs).toISOString(),authorizationState:instantlyQaAuthorizationState(db,id)});}catch{throw Error('DISCOVERY_ATTEMPT_EVIDENCE_PERSISTENCE_FAILED');}
  checkEntry();({manifest}=checkDiscoveryReadiness({db,root,now}));
  const database=db.prepare('PRAGMA database_list').all().find(r=>r.name==='main')?.file??'';
  if(fixtureLaunch&&database)throw Error('DISCOVERY_FIXTURE_REQUIRES_IN_MEMORY_DATABASE');
  if(!fixtureLaunch&&(!database||process.platform!=='win32'))throw Error('DISCOVERY_CONTAINED_WINDOWS_DATABASE_REQUIRED');
  if(cancelled())throw Error('LOCAL_CANCELLATION');
  grant=claimAcceptance(db,manifest,startedAtMs,{root,now,invocationId:attemptId,entryCheck:()=>{checkEntry();checkDiscoveryReadiness({db,root,now});return true;}});claimed=true;
  result={id,attemptId,claimInvocationId:attemptId,startedAt:grant.startedAt,status:'BLOCKED',reason:'NOT_COMPLETED',requestCounts:{statusDiscovery:0,business:0},generalDispatchEnabled:false,usageUsd:'NOT_EXPOSED',underlyingNetworkAttempts:'UNOBSERVED',noAutomaticRetry:true};
  stage='LOCAL_CONTAINMENT_PREFLIGHT';active();
  if(existsSync(directory))throw Error('DISCOVERY_DIRECTORY_EXISTS_NO_REPLAY');mkdirSync(directory);createdDirectory=true;
  const environment={};for(const key of ['SystemRoot','WINDIR','COMSPEC','PATH','USERPROFILE','HOME','APPDATA','LOCALAPPDATA','CODEX_HOME','TEMP','TMP'])if(process.env[key])environment[key]=process.env[key];
  const context={manifestId:id,manifestHash:hash(manifest),manifest,database,project:root,codex:join(homedir(),'AppData/Local/OpenAI/Codex/bin/9e1da79431da526b/codex.exe'),environment,launchStartedMs:startedAtMs,readinessDeadlineMs:startedAtMs+20000,providerDeadlineMs:startedAtMs+40000,deadlineAt:new Date(startedAtMs+40000).toISOString(),hardDeadlineAt:new Date(startedAtMs+60000).toISOString()};
  transaction(db,()=>{active();if(getRecord(db,'acceptance_discovery_run',id))throw Error('DISCOVERY_RUN_ALREADY_CONSUMED');putRecord(db,'acceptance_discovery_run',id,{manifestHash:hash(manifest),contextHash:hash(context),status:'LAUNCH_INTENT',workerStarted:false,statusRequests:0,businessCalls:0,launchStartedAt:grant.startedAt,directory});journal(db,'DISCOVERY_LAUNCH_INTENT',id,{manifestHash:hash(manifest),contextHash:hash(context)});});
  try{save(join(directory,'context.json'),context);}catch{throw Error('DISCOVERY_CONTEXT_EVIDENCE_PERSISTENCE_FAILED');}
  const win=process.env.SystemRoot??'C:\\Windows',configRoot=environment.CODEX_HOME??join(environment.USERPROFILE??'','.codex');
  const provenance=fixtureLaunch?{phase:'BEFORE_CONNECTION_WORK',mode:'OFFLINE_FIXTURE',credentialsCopied:false}:captureLaunchProvenance({root,executables:[{label:'node',path:process.execPath},{label:'codex-app-server',path:context.codex},{label:'powershell-owner',path:join(win,'System32/WindowsPowerShell/v1.0/powershell.exe')}],configurationFiles:[{label:'user-config',path:join(configRoot,'config.toml')},{label:'project-config',path:join(root,'.codex/config.toml')}],settings:context});
  try{save(join(directory,'launch-provenance.json'),provenance);}catch{throw Error('DISCOVERY_PROVENANCE_PERSISTENCE_FAILED');}active();
  emit({event:'DISCOVERY_CONTAINED_LAUNCH',selectedTools:manifest.targets,maximumMs:60000,businessToolCalls:0});
  active();if(now()>=context.readinessDeadlineMs)throw Error('DISCOVERY_READINESS_DEADLINE_BEFORE_LAUNCH');
  stage='CONTAINED_DISCOVERY';launchAttempted=true;
  const outcome=await (fixtureLaunch??launchContained)({root,directory,context,db,manifest,assertAuthority:active,now});
  const slot=getRecord(db,'acceptance_discovery_run',id),worker=outcome.worker,clean=cleanupConfirmed(outcome.owner);
  result.cleanup={confirmed:clean,evidence:outcome.owner??null,fixture:!!fixtureLaunch};result.ownerExit=outcome.exit;
  result.requestCounts=worker?.requestCounts??{statusDiscovery:slot?.statusRequests??0,business:slot?.businessCalls??0};
  result.workerResult=worker??null;
  if(!clean)throw Error('DISCOVERY_CLEANUP_UNCONFIRMED');
  if(now()-startedAtMs>=60000)throw Error('DISCOVERY_TOTAL_DEADLINE');
  active();
  if(slot?.businessCalls!==0||result.requestCounts.business!==0)throw Error('DISCOVERY_BUSINESS_CALL_INVARIANT_FAILED');
  if(!slot?.workerResult||canonical(slot.workerResult)!==canonical(worker))throw Error('DISCOVERY_DURABLE_RESULT_MISMATCH');
  if(outcome.exit?.code!==0||outcome.owner?.timedOut||worker?.status!=='PASSED')throw Error(worker?.reason??'DISCOVERY_WORKER_INCOMPLETE');
  result.status='PASS';result.reason=worker.reason;
 }catch(error){
  result??={id,attemptId,...(claimed?{claimInvocationId:attemptId}:{}),startedAt:new Date(startedAtMs).toISOString(),requestCounts:{statusDiscovery:0,business:0},generalDispatchEnabled:false,noAutomaticRetry:true};
  result.status='BLOCKED';result.reason=acceptanceErrorCode(error);result.firstFailingStage=stage;
 }finally{
  result.finishedAt=new Date(now()).toISOString();result.elapsedMs=Math.max(0,now()-startedAtMs);result.finalControls=controls(db);result.attemptExternalActivity=launchAttempted?'SEE_CONTAINED_DISCOVERY_EVIDENCE':'NOT_STARTED';
  if(claimed){const slot=getRecord(db,'acceptance_discovery_run',id);result.requestCounts={statusDiscovery:slot?.statusRequests??0,business:slot?.businessCalls??0};}
  if(launchAttempted&&!result.cleanup)result.cleanup={confirmed:false,evidence:null,fixture:!!fixtureLaunch};
  if(claimed){
   result.authorizationStatus='CLOSED';
   try{closeAcceptance(db,result,now());}catch{result.authorizationStatus=getRecord(db,'acceptance_authorization',id)?.status??'MISSING';result.localReportError='DISCOVERY_AUTHORIZATION_CLOSURE_UNCONFIRMED';result.status='BLOCKED';}
   try{save(join(createdDirectory?directory:base,createdDirectory?'result.json':`${attemptId}.claimed-refusal.json`),result);}catch{result.localReportError??='DISCOVERY_RESULT_PERSISTENCE_FAILED';result.status='BLOCKED';}
  }else result.authorizationStatus=getRecord(db,'acceptance_authorization',id)?.status??'MISSING';
  result.authorizationState=instantlyQaAuthorizationState(db,id);
  try{save(join(attempts,`${attemptId}.result.json`),result);}catch{result.attemptEvidenceError='DISCOVERY_ATTEMPT_EVIDENCE_PERSISTENCE_FAILED';result.status='BLOCKED';}
 }
 return {...result,exitCode:result.status==='PASS'&&!result.localReportError&&!result.attemptEvidenceError?0:2};
}

export function recordDiscoveryOpenRefusal({root,error,startedAtMs,now=Date.now,invocationId}){
 const entered=typeof invocationId==='string'&&invocationId.length>0;
 const result={id:DISCOVERY_CAPTURE_ID,attemptId:entered?invocationId:randomUUID(),startedAt:new Date(startedAtMs).toISOString(),finishedAt:new Date(now()).toISOString(),status:'BLOCKED',reason:acceptanceErrorCode(error),firstFailingStage:entered?'LOCAL_CLI_COMMAND':'LOCAL_CLI_OPEN',authorizationStatus:entered?'UNRESOLVED_SEE_INVOCATION_EVIDENCE':'NOT_READ',attemptExternalActivity:entered?'UNRESOLVED_SEE_INVOCATION_EVIDENCE':'NOT_STARTED',noAutomaticRetry:true,exitCode:2};
 try{const directory=join(root,DISCOVERY_DIRECTORY,'attempts');mkdirSync(directory,{recursive:true});save(join(directory,`${result.attemptId}.${entered?'command-error':'result'}.json`),result);}catch{result.attemptEvidenceError='DISCOVERY_ATTEMPT_EVIDENCE_PERSISTENCE_FAILED';}
 return result;
}
