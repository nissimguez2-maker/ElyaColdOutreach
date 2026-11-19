import {writeFileSync,existsSync,mkdirSync} from 'node:fs';
import {randomUUID} from 'node:crypto';
import {join} from 'node:path';
import {performance} from 'node:perf_hooks';
import {getRecord,controls} from './store.mjs';
import {assertSafe} from './values.mjs';
import {INSTANTLY_QA_ID,INSTANTLY_QA_V2_ID,instantlyQaRelativeDirectory} from './instantly-qa-contract.mjs';
import {checkInstantlyQaReadiness,instantlyQaAuthorizationState,assertInstantlyQaDatabasePath} from './instantly-qa-readiness.mjs';
import {closeAcceptance} from './acceptance-authority.mjs';
import {runAcceptanceSequence,acceptanceErrorCode} from './acceptance-controller.mjs';
import {runAcceptanceInstantly} from './acceptance-instantly.mjs';

// Imports never connect. The only production launch is supplied by the fixed CLI;
// fixtures cannot replace the provider runner when using a file-backed database.
export async function runInstantlyQaCommand({db,root,authorizationId=INSTANTLY_QA_ID,now=Date.now,startedAtMs=now(),startedMono=performance.now(),cancelled=()=>false,emit=()=>{},entryCheck,onInvocation,phaseRunner,manifestPath=join(root,instantlyQaRelativeDirectory(authorizationId),'manifest.json')}){
 const base=join(root,instantlyQaRelativeDirectory(authorizationId)),directory=join(base,'live-once'),v2=authorizationId===INSTANTLY_QA_V2_ID;
 let result,createdDirectory=false,publish=false,stage='LOCAL_PREFLIGHT',phaseEntered=false,databaseVerified=false;
 let entryEligible=!v2;
 const checkEntry=()=>{entryEligible=false;if(v2&&typeof entryCheck!=='function')throw Error('OPERATOR_ENTRY_ELIGIBILITY_REQUIRED');const value=entryCheck?.();if(v2&&value!==true)throw Error('OPERATOR_ENTRY_ELIGIBILITY_REQUIRED');entryEligible=true;return true;};
 const attemptId=randomUUID(),attemptsDirectory=join(base,'attempts');
 const entryState=instantlyQaAuthorizationState(db,authorizationId);
 try{
  assertInstantlyQaDatabasePath(db,root);databaseVerified=true;
  onInvocation?.(attemptId);
  try{
   mkdirSync(attemptsDirectory,{recursive:true});
   const entry={attemptId,id:authorizationId,startedAt:new Date(startedAtMs).toISOString(),authorizationState:entryState};
   assertSafe(entry);writeFileSync(join(attemptsDirectory,`${attemptId}.started.json`),JSON.stringify(entry,null,2),{flag:'wx',flush:true});
  }catch{throw Error('INSTANTLY_QA_ATTEMPT_EVIDENCE_PERSISTENCE_FAILED');}
  if(v2)checkEntry();
  const {manifest,...readiness}=checkInstantlyQaReadiness({db,root,authorizationId,now,manifestPath});
  if(!v2)entryCheck?.();
  const dbPath=db.prepare('PRAGMA database_list').all().find(r=>r.name==='main')?.file;
  if(phaseRunner&&dbPath)throw Error('INSTANTLY_FIXTURE_REQUIRES_IN_MEMORY_DATABASE');
  result=await runAcceptanceSequence({db,manifest,root,now,startedAtMs,startedMono,cancelled,emit,invocationId:attemptId,entryCheck:v2?()=>{
    checkEntry();checkInstantlyQaReadiness({db,root,authorizationId,now,manifestPath});return true;
   }:undefined,
   instantly:options=>{
    if(options.phase===1){
     if(existsSync(directory))throw Error('INSTANTLY_QA_DIRECTORY_EXISTS_NO_REPLAY');
     mkdirSync(directory);createdDirectory=true;
    }
    stage=`INSTANTLY_PHASE_${options.phase}`;
    phaseEntered=true;
    return (phaseRunner??runAcceptanceInstantly)({...options,db,manifest,directory,startedMono,startedWall:startedAtMs});
   },
  });result.readiness=readiness;publish=true;
 }catch(error){
  result={id:authorizationId,status:'BLOCKED',reason:acceptanceErrorCode(error),firstFailingStage:stage,finishedAt:new Date(now()).toISOString(),elapsedMs:Math.max(0,now()-startedAtMs),noAutomaticRetry:true,finalControls:controls(db)};
  // A duplicate command must never close the authorization claimed by another
  // process. A preclaim failure consumes only an unstarted, still-approved grant.
  if(databaseVerified&&entryEligible&&getRecord(db,'acceptance_authorization',authorizationId)?.status==='APPROVED'){
   result.notLaunched=true;result.liveCalls=0;result.authorizationStatus='CLOSED';
   try{closeAcceptance(db,result,now());publish=true;}
   catch(closureError){
    if(closureError.message!=='ACCEPTANCE_UNSTARTED_CLOSURE_LOST_OWNERSHIP')throw closureError;
    delete result.notLaunched;delete result.liveCalls;result.reason=closureError.message;result.authorizationStatus=getRecord(db,'acceptance_authorization',authorizationId)?.status??'MISSING';
   }
  }else result.authorizationStatus=getRecord(db,'acceptance_authorization',authorizationId)?.status??'MISSING';
 }
 result.attemptId=attemptId;
 result.authorizationState=instantlyQaAuthorizationState(db,authorizationId);
 result.attemptExternalActivity=phaseEntered?'SEE_PHASE_EVIDENCE':'NOT_STARTED';
 if(publish){
  try{assertSafe(result);writeFileSync(join(createdDirectory?directory:base,createdDirectory?'result.json':'blocked-before-runtime.json'),JSON.stringify(result,null,2),{flag:'wx',flush:true});}
  catch{result={...result,localReportError:'RESULT_FILE_PERSISTENCE_FAILED',durableResultKind:'acceptance_result',noAutomaticRetry:true};}
 }
 // Every invocation gets separate evidence, including refusal of a CLOSED grant.
 // Never replace the original run result or pretend this is a new authorization.
 try{assertSafe(result);writeFileSync(join(attemptsDirectory,`${attemptId}.result.json`),JSON.stringify(result,null,2),{flag:'wx',flush:true});}
 catch{result={...result,attemptEvidenceError:'INSTANTLY_QA_ATTEMPT_EVIDENCE_PERSISTENCE_FAILED'};}
 return result;
}
