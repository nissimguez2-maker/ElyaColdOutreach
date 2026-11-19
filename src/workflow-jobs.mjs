// Durable, explicitly invoked offline jobs. No timer, daemon, or live scheduler is installed.
import {canonical,digest,required,timestamp} from './values.mjs';
import {getRecord,putRecord,transaction,journal,controls,now} from './store.mjs';
import {operation,budgetStatus} from './operations.mjs';
import {evaluateRelease} from './batches.mjs';
import {workflowHandlerBoundary} from './workflow-job-binding.mjs';
import {randomUUID} from 'node:crypto';
import {hostname} from 'node:os';

const kinds={PREPARE:null,IMPORT:'RELEASE',MONITOR:'READ',NOTIFY:'NOTIFY',BOUND:null};
const all=db=>db.prepare("SELECT data_json FROM records WHERE kind='workflow_job' ORDER BY id").all().map(r=>JSON.parse(r.data_json));
const atomic=(db,fn)=>db.isTransaction?fn():transaction(db,fn);
export function acquireWorkflowOwnership(db,ownerId,at=now()){
 required(ownerId);timestamp(at);return atomic(db,()=>{
  if(getRecord(db,'workflow_runtime_owner','foreground')?.status==='ACTIVE')throw Error('WORKFLOW_RUNTIME_ALREADY_OWNED');
  const claim={ownerId,claimId:randomUUID(),pid:process.pid,host:hostname(),status:'ACTIVE',claimedAt:at};
  putRecord(db,'workflow_runtime_owner','foreground',claim,'assessment');journal(db,'WORKFLOW_RUNTIME_ACQUIRED',ownerId,{claimId:claim.claimId,pid:claim.pid});return claim;
 });
}
export function releaseWorkflowOwnership(db,claim,at=now()){
 timestamp(at);return atomic(db,()=>{
  const current=getRecord(db,'workflow_runtime_owner','foreground');
  if(current?.status!=='ACTIVE'||current.claimId!==claim.claimId)throw Error('WORKFLOW_RUNTIME_OWNERSHIP_LOST');
  putRecord(db,'workflow_runtime_owner','foreground',{...current,status:'RELEASED',releasedAt:at},'assessment');journal(db,'WORKFLOW_RUNTIME_RELEASED',current.ownerId,{claimId:current.claimId});
 });
}
// Explicit recovery only; PID reuse/foreign host/permission uncertainty fail closed.
export function recoverWorkflowOwnership(db,claimId,at=now()){
 required(claimId);timestamp(at);return atomic(db,()=>{
  const current=getRecord(db,'workflow_runtime_owner','foreground');
  if(current?.status!=='ACTIVE'||current.claimId!==claimId)throw Error('WORKFLOW_RUNTIME_OWNER_CHANGED');
  if(current.host!==hostname()||!Number.isSafeInteger(current.pid)||current.pid<1)throw Error('WORKFLOW_RUNTIME_OWNER_UNVERIFIED');
  try{process.kill(current.pid,0);throw Error('WORKFLOW_RUNTIME_OWNER_STILL_RUNNING');}
  catch(error){if(error.code!=='ESRCH')throw Error('WORKFLOW_RUNTIME_OWNER_NOT_CONFIRMED_DEAD');}
  const recovered={...current,status:'INTERRUPTED',recoveredAt:at};putRecord(db,'workflow_runtime_owner','foreground',recovered,'assessment');journal(db,'WORKFLOW_RUNTIME_OWNER_RECOVERED',current.ownerId,{claimId,pid:current.pid,replay:false});return recovered;
 });
}
function validate(input){
 canonical(input);const fields=['id','kind','runAt','timeoutMs','maxAttempts','operationId','payload'];
 if(!input||Object.keys(input).sort().join()!==fields.sort().join()||!Object.hasOwn(kinds,input.kind)||typeof input.payload!=='object'||!input.payload||Array.isArray(input.payload))throw Error('WORKFLOW_JOB_FIELDS');
 required(input.id);timestamp(input.runAt);
 if(!Number.isSafeInteger(input.timeoutMs)||input.timeoutMs<10||input.timeoutMs>180000||!Number.isSafeInteger(input.maxAttempts)||input.maxAttempts<1||input.maxAttempts>3)throw Error('WORKFLOW_JOB_BOUNDS');
 if(kinds[input.kind]===null?input.operationId!==null:typeof input.operationId!=='string'||!input.operationId)throw Error('WORKFLOW_OPERATION_REQUIRED');
 return structuredClone(input);
}
function boundary(db,job,at,handler){
 timestamp(at);
 if(job.kind==='BOUND'){workflowHandlerBoundary(db,job.id,handler)(at);return;}
 if(job.kind==='PREPARE')return;
 const op=operation(db,job.operationId);
 if(!op||op.kind!==kinds[job.kind]||op.status!=='PREPARED')throw Error('WORKFLOW_OPERATION_REQUIRES_RECONCILIATION_OR_AUTHORIZATION');
 if(budgetStatus(db,op.budget_id).blocked)throw Error('WORKFLOW_BUDGET_BLOCKED');
 const intent=JSON.parse(op.intent_json);
 if(job.kind==='IMPORT'){
  const gate=evaluateRelease(db,intent.payload.batchId,intent.payload.approvalId,at);
  if(!gate.allowed)throw Error(gate.reasons.join('; '));
 }else if(controls(db).stopped)throw Error('WORKFLOW_SYSTEM_STOPPED');
 const blockers=db.prepare("SELECT id FROM operations WHERE id<>? AND status IN ('DISPATCHING','RECONCILIATION')").all(op.id);
 if(blockers.length)throw Error('WORKFLOW_OPERATION_RECONCILIATION_REQUIRED');
}
export function scheduleWorkflowJob(db,input){
 const spec=validate(input),specHash=digest(canonical(spec));
 // Due time is scheduling metadata, not a new business action identity.
 const actionKey=digest(canonical({kind:spec.kind,operationId:spec.operationId,payload:spec.payload}));
 return atomic(db,()=>{
  const old=getRecord(db,'workflow_job',spec.id);
  if(old){if(old.specHash!==specHash)throw Error('WORKFLOW_JOB_IMMUTABLE');return old;}
  if(all(db).some(j=>j.actionKey===actionKey))throw Error('WORKFLOW_DUPLICATE_JOB_ACTION');
  if(spec.operationId){const op=operation(db,spec.operationId);if(!op||op.kind!==kinds[spec.kind])throw Error('WORKFLOW_OPERATION_REQUIRED');}
  const value={...spec,specHash,actionKey,status:'SCHEDULED',attempts:0,ownerId:null,claimedAt:null,deadlineAt:null,evidenceRef:null,createdAt:now(),updatedAt:now()};
  putRecord(db,'workflow_job',spec.id,value,'configuration');journal(db,'WORKFLOW_JOB_SCHEDULED',spec.id,{kind:spec.kind,runAt:spec.runAt,operationId:spec.operationId});return value;
 });
}
export function claimWorkflowJob(db,id,{ownerId,at=now(),handler}={}){
 required(ownerId);timestamp(at);
 return atomic(db,()=>{
  const job=getRecord(db,'workflow_job',id);
  if(!job||job.status!=='SCHEDULED')throw Error(`WORKFLOW_JOB_CLAIM_REJECTED_${job?.status??'UNKNOWN'}`);
  if(timestamp(job.runAt)>timestamp(at))throw Error('WORKFLOW_JOB_NOT_DUE');
  if(job.attempts>=job.maxAttempts)throw Error('WORKFLOW_JOB_ATTEMPTS_EXHAUSTED');
  boundary(db,job,at,handler);
  const next={...job,status:'RUNNING',attempts:job.attempts+1,ownerId,claimedAt:at,deadlineAt:new Date(timestamp(at)+job.timeoutMs).toISOString(),updatedAt:at};
  putRecord(db,'workflow_job',id,next,'assessment');journal(db,'WORKFLOW_JOB_CLAIMED',id,{ownerId,attempt:next.attempts,deadlineAt:next.deadlineAt});return next;
 });
}
function finish(db,job,result,at){
 canonical(result);required(result.evidenceRef);
 if(!['SUCCEEDED','NOT_DISPATCHED','UNCERTAIN'].includes(result.status))throw Error('WORKFLOW_JOB_RESULT_INVALID');
 return atomic(db,()=>{
  const current=getRecord(db,'workflow_job',job.id);
  if(current?.status!=='RUNNING'||current.ownerId!==job.ownerId||current.attempts!==job.attempts)throw Error('WORKFLOW_JOB_CLAIM_LOST');
  let status=result.status==='SUCCEEDED'?'SUCCEEDED':result.status==='NOT_DISPATCHED'?(job.attempts<job.maxAttempts?'RETRYABLE':'FAILED'):'RECONCILIATION';
  if(job.operationId){
   const op=operation(db,job.operationId);
   // External jobs must complete through their existing adapter and durable operation.
   if(result.status==='SUCCEEDED'&&op?.status!=='SUCCEEDED')status='RECONCILIATION';
   if(result.status==='NOT_DISPATCHED'&&op?.status!=='PREPARED')status='RECONCILIATION';
  }
  const next={...current,status,evidenceRef:result.evidenceRef,updatedAt:at};
  putRecord(db,'workflow_job',job.id,next,'assessment');journal(db,'WORKFLOW_JOB_OUTCOME',job.id,{status,evidenceRef:result.evidenceRef});return next;
 });
}
export async function runWorkflowJob(db,id,handler,{ownerId,at=now(),clock=()=>at,signal}={}){
 if(signal?.aborted)throw Error('WORKFLOW_JOB_CANCELLED');
 const bound=getRecord(db,'workflow_job',id)?.kind==='BOUND';
 if(bound)workflowHandlerBoundary(db,id,handler);
 else if(handler?.mode!=='offline'||typeof handler.execute!=='function')throw Error('WORKFLOW_OFFLINE_HANDLER_REQUIRED');
 const ownership=acquireWorkflowOwnership(db,ownerId,at),executionState={settled:true};
 try{return await executeOwnedJob(db,id,handler,{ownerId,at,clock,signal,executionState});}
 // An unsettled handler may still write or finish cleanup. Retain its claim for
 // explicit dead-process recovery; no late callback may release it after return.
 finally{if(executionState.settled)releaseWorkflowOwnership(db,ownership,clock());}
}
async function executeOwnedJob(db,id,handler,{ownerId,at,clock,signal,executionState}){
 const job=claimWorkflowJob(db,id,{ownerId,at,handler}),controller=new AbortController();let timer,abort;
 const cancelled=new Promise(resolve=>{abort=()=>{controller.abort();resolve({status:'UNCERTAIN',evidenceRef:'Operator cancelled; inspect durable evidence before any retry; remote cancellation is not established'});};signal?.addEventListener('abort',abort,{once:true});if(signal?.aborted)abort();});
 const timeout=new Promise(resolve=>{timer=setTimeout(()=>{controller.abort();resolve({status:'UNCERTAIN',evidenceRef:'Job exceeded its timeout; reconcile before replay; abort alone does not establish remote cancellation'});},job.timeoutMs);});
 const execution=Promise.resolve().then(()=>{
  if(controller.signal.aborted)throw Error('WORKFLOW_JOB_CANCELLED');
  boundary(db,job,clock(),handler);
  executionState.settled=false;
  return handler.execute({job:structuredClone(job),signal:controller.signal,assertBoundary:()=>{if(controller.signal.aborted)throw Error('WORKFLOW_JOB_CANCELLED');boundary(db,job,clock(),handler);}});
 }).catch(()=>({status:'UNCERTAIN',evidenceRef:'Job threw; inspect durable component evidence and reconcile before replay'})).finally(()=>{executionState.settled=true;});
 let result;
 try{result=await Promise.race([execution,timeout,cancelled]);}
 finally{clearTimeout(timer);signal?.removeEventListener('abort',abort);}
 try{return finish(db,job,result,clock());}
 catch(error){
  if(getRecord(db,'workflow_job',id)?.status!=='RUNNING')throw error;
  return finish(db,job,{status:'UNCERTAIN',evidenceRef:'Job returned invalid evidence; reconcile before replay'},clock());
 }
}
export function retryWorkflowJob(db,id,at=now()){
 timestamp(at);return atomic(db,()=>{
  const job=getRecord(db,'workflow_job',id);
  if(job?.status==='RECONCILIATION')throw Error('WORKFLOW_RECONCILIATION_REQUIRED');
  if(!job||job.status!=='RETRYABLE'||job.attempts>=job.maxAttempts)throw Error('WORKFLOW_RETRY_ATTEMPTS_EXHAUSTED');
  boundary(db,job,at);
  const next={...job,status:'SCHEDULED',ownerId:null,claimedAt:null,deadlineAt:null,updatedAt:at};
  putRecord(db,'workflow_job',id,next,'assessment');journal(db,'WORKFLOW_JOB_RETRY_AUTHORIZED',id,{attempts:job.attempts});return next;
 });
}
export function recoverWorkflowJobs(db,at=now()){
 timestamp(at);return atomic(db,()=>{
  const recovered=[];
  for(const job of all(db).filter(j=>j.status==='RUNNING')){
   const next={...job,status:'RECONCILIATION',updatedAt:at,evidenceRef:'Interrupted job: inspect durable operation and reconcile; no automatic retry'};
   if(job.operationId)db.prepare("UPDATE operations SET status='RECONCILIATION',updated_at=? WHERE id=? AND status='DISPATCHING'").run(at,job.operationId);
   putRecord(db,'workflow_job',job.id,next,'assessment');journal(db,'WORKFLOW_JOB_RECOVERY_REQUIRED',job.id,{operationId:job.operationId});recovered.push(next);
  }return recovered;
 });
}
export function reconcileWorkflowJob(db,id,{status,evidenceRef},at=now()){
 timestamp(at);required(evidenceRef);
 if(!['SUCCEEDED','NOT_DISPATCHED'].includes(status))throw Error('WORKFLOW_DEFINITIVE_RECONCILIATION_REQUIRED');
 return atomic(db,()=>{
  const job=getRecord(db,'workflow_job',id);if(job?.status!=='RECONCILIATION')throw Error('WORKFLOW_RECONCILIATION_REQUIRED');
  if(job.operationId){const op=operation(db,job.operationId);if(op?.status!==(status==='SUCCEEDED'?'SUCCEEDED':'PREPARED'))throw Error('WORKFLOW_RECONCILE_OPERATION_FIRST');}
  const next={...job,status:status==='SUCCEEDED'?'SUCCEEDED':job.attempts<job.maxAttempts?'RETRYABLE':'FAILED',evidenceRef,updatedAt:at};
  putRecord(db,'workflow_job',id,next,'assessment');journal(db,'WORKFLOW_JOB_RECONCILED',id,{status:next.status,evidenceRef});return next;
 });
}
export function workflowJobStatus(db){return all(db);}
