// Fixed foreground composition over existing domain adapters. This module neither
// installs a scheduler nor manufactures provider/business authorizations.
import {canonical,digest,required,timestamp,assertSafe} from './values.mjs';
import {getRecord,putRecord,controls,transaction,journal,now} from './store.mjs';
import {scheduleWorkflowJob,runWorkflowJob,recoverWorkflowJobs,workflowJobStatus,acquireWorkflowOwnership,releaseWorkflowOwnership} from './workflow-jobs.mjs';
import {bindWorkflowHandler} from './workflow-job-binding.mjs';
import {recoverOperations} from './operations.mjs';
import {recoverProviderReplyPolling} from './monitoring-provider.mjs';
import {recoverMonitoringDeliveries} from './monitoring-delivery.mjs';

const hash=x=>digest(canonical(x)),atomic=(db,fn)=>db.isTransaction?fn():transaction(db,fn);
const actions={
 INGEST:['evidence'],REFINE:['spec'],IMPORT_DRAFTS:['proposal'],PREPARE_REPORT:['campaignId','includeSynthetic'],PREPARE_REPORT_DELIVERY:['reportId','campaignId','includeSynthetic','destinationBindingId'],
 COLLECT:['operationId'],HANDOFF:['importId'],POLL_REPLIES:['options'],
 NOTIFY:['notificationId','authorizationId'],DELIVER_REPORT:['reportId','authorizationId']
};
const external=new Set(['COLLECT','HANDOFF','POLL_REPLIES','NOTIFY','DELIVER_REPORT']);
function exact(value,keys,reason){if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).sort().join()!==[...keys].sort().join())throw Error(reason);}
function taskSpec(input){
 exact(input,['id','action','arguments','runAt','timeoutMs'],'WORKFLOW_TASK_FIELDS');required(input.id);timestamp(input.runAt);
 if(!Object.hasOwn(actions,input.action))throw Error('WORKFLOW_TASK_ACTION_UNSUPPORTED');
 exact(input.arguments,actions[input.action],'WORKFLOW_TASK_ARGUMENTS');assertSafe(canonical(input));
 if(!Number.isSafeInteger(input.timeoutMs)||input.timeoutMs<10||input.timeoutMs>180000)throw Error('WORKFLOW_TASK_TIMEOUT');
 if(input.action==='PREPARE_REPORT'&&(typeof input.arguments.campaignId!=='string'||typeof input.arguments.includeSynthetic!=='boolean'))throw Error('WORKFLOW_TASK_ARGUMENTS');
 for(const key of ['operationId','importId','notificationId','authorizationId','reportId'])if(Object.hasOwn(input.arguments,key))required(input.arguments[key]);
 return structuredClone(input);
}
export function registerWorkflowTask(db,input){
 const spec=taskSpec(input),specHash=hash(spec);
 return atomic(db,()=>{
  const old=getRecord(db,'workflow_task',spec.id);if(old&&old.specHash!==specHash)throw Error('WORKFLOW_TASK_IMMUTABLE');
  if(!old)putRecord(db,'workflow_task',spec.id,{...spec,specHash},'configuration');
  scheduleWorkflowJob(db,{id:'task:'+spec.id,kind:'BOUND',runAt:spec.runAt,timeoutMs:spec.timeoutMs,maxAttempts:1,operationId:null,payload:{taskId:spec.id,taskHash:specHash}});
  return getRecord(db,'workflow_task',spec.id);
 });
}
function readTask(db,id){
 const stored=getRecord(db,'workflow_task',id);if(!stored)throw Error('WORKFLOW_TASK_NOT_FOUND');
 const {specHash,...spec}=stored;taskSpec(spec);if(specHash!==hash(spec))throw Error('WORKFLOW_TASK_HASH_MISMATCH');
 const job=getRecord(db,'workflow_job','task:'+id);
 if(job?.payload?.taskHash!==specHash||job.payload.taskId!==id||job.timeoutMs!==spec.timeoutMs)throw Error('WORKFLOW_TASK_JOB_MISMATCH');
 return stored;
}
function runtimeGate(db,task,at,{entry=true}={}){
 timestamp(at);const policy=getRecord(db,'settings','workflow-runtime');
 if(policy?.enabled!==true)throw Error('WORKFLOW_RUNTIME_DISABLED');
 if(policy.timeZone!=='America/New_York'||typeof policy.approvedBy!=='string'||!policy.approvedBy||typeof policy.revision!=='string'||!policy.revision||timestamp(policy.approvedAt)>timestamp(at))throw Error('WORKFLOW_RUNTIME_POLICY_UNAPPROVED');
 if(external.has(task.action)){
  if(policy.generalDispatchEnabled!==true)throw Error('WORKFLOW_GENERAL_DISPATCH_DISABLED');
  if(controls(db).stopped)throw Error('WORKFLOW_SYSTEM_STOPPED');
  if(entry&&db.prepare("SELECT id FROM operations WHERE status IN ('DISPATCHING','RECONCILIATION') LIMIT 1").get())throw Error('WORKFLOW_RECONCILIATION_REQUIRED');
 }
 if(task.id?.startsWith('schedule:')){
  const origin=getRecord(db,'workflow_schedule_occurrence',task.id),plan=origin&&getRecord(db,'workflow_schedule',origin.scheduleId);
  if(!plan?.enabled||plan.specHash!==origin.scheduleHash||!plan.approval?.by||timestamp(plan.approval.at)>timestamp(at))throw Error('WORKFLOW_SCHEDULE_DISABLED_OR_CHANGED');
 }
 return policy;
}
export function assertWorkflowDispatchBinding(db,binding,at){
 exact(binding,['taskId','taskHash','jobId'],'WORKFLOW_DISPATCH_BINDING_INVALID');
 const task=readTask(db,binding.taskId),job=getRecord(db,'workflow_job',binding.jobId);
 if(binding.jobId!=='task:'+task.id||binding.taskHash!==task.specHash||job?.status!=='RUNNING'||job.payload.taskHash!==task.specHash||timestamp(job.deadlineAt)<=timestamp(at))throw Error('WORKFLOW_DISPATCH_BINDING_REVOKED_OR_EXPIRED');
 runtimeGate(db,task,at,{entry:false});return task;
}
export function runtimeStatus(db){
 const p=getRecord(db,'settings','workflow-runtime');
 return {enabled:p?.enabled===true,generalDispatchEnabled:p?.generalDispatchEnabled===true,controls:controls(db),execution:'EXPLICIT_FOREGROUND_ONCE',timeZone:'America/New_York',installedScheduler:false,jobs:workflowJobStatus(db),contractGates:{collection:'Exact current tool/build/pricing and charge contract required',replyPolling:'Nonempty provider reply/pagination/link contract required',handoff:'Pinned create/update/get contracts plus approved active-target snapshot required'},drafting:'GPT-assisted outside runtime; no model API',gptSubscriptionBudget:'EXCLUDED'};
}
async function executeTask(db,task,services,clock,signal,assertBoundary){
 const a=task.arguments;assertBoundary();
 switch(task.action){
  case 'INGEST':{const module=await import('./collection.mjs');assertBoundary();return module.recordCollectionEvidence(db,a.evidence);}
  case 'REFINE':{const module=await import('./collection.mjs');assertBoundary();return module.refineCollectedEvidence(db,a.spec);}
  case 'IMPORT_DRAFTS':{const module=await import('./workflow.mjs');assertBoundary();return module.importDraftProposal(db,a.proposal);}
  case 'PREPARE_REPORT':{const module=await import('./monitoring.mjs');assertBoundary();return module.monitoringReport(db,a,clock());}
  case 'PREPARE_REPORT_DELIVERY':{const module=await import('./monitoring-delivery.mjs');assertBoundary();return module.prepareMonitoringReportDelivery(db,a,clock());}
  case 'COLLECT':{
   if(!services.collectionAdapter)throw Error('COLLECTION_TRANSPORT_CONTRACT_REQUIRED');
   return (await import('./collection-operation.mjs')).executeCollectionOperation(db,a.operationId,{adapter:services.collectionAdapter,at:clock(),signal,clock,assertDispatch:assertBoundary});
  }
  case 'HANDOFF':{
   if(!services.handoffAdapter)throw Error('HANDOFF_TRANSPORT_CONTRACT_REQUIRED');
   const result=await (await import('./handoff.mjs')).executeHandoff(db,a.importId,services.handoffAdapter,clock(),{signal,clock,assertDispatch:assertBoundary,workflowBinding:{taskId:task.id,taskHash:task.specHash,jobId:'task:'+task.id}});
   // node:sqlite rows have a null prototype; keep a minimal plain result record.
   return {id:result.id,status:result.status,actualUsd:result.actual_usd,reservationUsd:result.reservation_usd};
  }
  case 'POLL_REPLIES':{
   if(!services.replyDecoder||!services.replyTransport)throw Error('REPLY_PROVIDER_CONTRACT_REQUIRED');
   const {pollProviderReplies}=await import('./monitoring-provider.mjs');
   return pollProviderReplies(db,{...a.options,enabled:true,decoder:services.replyDecoder,transport:services.replyTransport,clock,signal,assertDispatch:assertBoundary});
  }
  case 'NOTIFY':case 'DELIVER_REPORT':{
   const module=await import('./monitoring-delivery.mjs');
   const preview=task.action==='NOTIFY'?module.previewReplyDelivery(db,a.notificationId,clock()):getRecord(db,'monitor_report_delivery',a.reportId);
   const api=services.telegramApi??(services.loadTelegramToken?await module.createMonitoringTelegramApi(db,preview,{enabled:true,authorizationId:a.authorizationId,clock,loadToken:services.loadTelegramToken,signal,assertDispatch:assertBoundary}):null);
   if(!api)throw Error('MONITORING_DELIVERY_BINDING_REQUIRED');
   try{return task.action==='NOTIFY'?await module.deliverReplyNotification(db,a.notificationId,api,{enabled:true,authorizationId:a.authorizationId,clock,signal,assertDispatch:assertBoundary}):await module.deliverMonitoringReport(db,a.reportId,api,{enabled:true,authorizationId:a.authorizationId,clock,signal,assertDispatch:assertBoundary});}
   finally{if(!services.telegramApi){const cleanup=await api.close();putRecord(db,'workflow_transport_cleanup',task.id,cleanup,'assessment');if(cleanup.closed!==true||cleanup.remainingRequests!==0)throw Error('WORKFLOW_TRANSPORT_CLEANUP_UNCONFIRMED');}}
  }
 }
}
function componentSucceeded(db,task,result){
 if(!external.has(task.action))return true;
 if(task.action==='HANDOFF')return result?.status==='SUCCEEDED';
 if(task.action==='COLLECT')return result?.status==='SUCCEEDED';
 if(task.action==='POLL_REPLIES')return result?.status==='COMPLETE';
 return result?.status==='DELIVERED';
}
export async function runWorkflowTask(db,id,{services={},ownerId,clock=now,signal}={}){
 if(signal?.aborted)throw Error('WORKFLOW_JOB_CANCELLED');
 required(ownerId);const task=readTask(db,id),started=clock();runtimeGate(db,task,started);
 if(task.action==='COLLECT'&&!services.collectionAdapter)throw Error('COLLECTION_TRANSPORT_CONTRACT_REQUIRED');
 if(task.action==='HANDOFF'&&!services.handoffAdapter)throw Error('HANDOFF_TRANSPORT_CONTRACT_REQUIRED');
 if(task.action==='POLL_REPLIES'&&(!services.replyDecoder||!services.replyTransport))throw Error('REPLY_PROVIDER_CONTRACT_REQUIRED');
 if(['NOTIFY','DELIVER_REPORT'].includes(task.action)&&!services.telegramApi&&!services.loadTelegramToken)throw Error('MONITORING_DELIVERY_BINDING_REQUIRED');
 const handler=bindWorkflowHandler(db,'task:'+id,{async execute(context){
  let result;
  try{result=await executeTask(db,task,services,clock,context.signal,context.assertBoundary);}
  catch(error){
   if(context.signal.aborted)throw error;
   const reason=/^[A-Z][A-Z0-9_:]{0,199}$/.test(error?.message??'')?error.message:'COMPONENT_FAILURE_INSPECT_ITS_DURABLE_EVIDENCE';
   putRecord(db,'workflow_task_failure',id,{taskHash:task.specHash,reason,recordedAt:clock(),automaticReplayPermitted:false},'assessment');throw error;
  }
  // Late returns never replace a timeout/recovery decision or become retry advice.
  if(context.signal.aborted)throw Error('WORKFLOW_TASK_LATE_RESULT');
  const saved={taskId:id,taskHash:task.specHash,action:task.action,result,recordedAt:clock()};
  putRecord(db,'workflow_task_result',id,saved,'assessment');journal(db,'WORKFLOW_TASK_RESULT',id,{action:task.action,resultHash:hash(result)});
  return {status:componentSucceeded(db,task,result)?'SUCCEEDED':'UNCERTAIN',evidenceRef:'workflow_task_result/'+id};
 }},at=>{
  const current=readTask(db,id);if(current.specHash!==task.specHash)throw Error('WORKFLOW_TASK_CHANGED');
  const job=getRecord(db,'workflow_job','task:'+id);
  if(!['SCHEDULED','RUNNING'].includes(job?.status)||job.status==='RUNNING'&&timestamp(job.deadlineAt)<=timestamp(at))throw Error('WORKFLOW_TASK_NO_LONGER_RUNNING');
  // Domain modules recheck their own exact operations at dispatch. Do not reject
  // their own in-flight operation here; this hook is only entry/claim gating.
  runtimeGate(db,current,at,{entry:false});
 });
 return runWorkflowJob(db,'task:'+id,handler,{ownerId,at:started,clock,signal});
}
export function recoverWorkflowRuntime(db,at=now()){
 const owner=acquireWorkflowOwnership(db,'explicit-recovery',at);
 try{return {operations:recoverOperations(db),polling:recoverProviderReplyPolling(db,at),deliveries:recoverMonitoringDeliveries(db,at),jobs:recoverWorkflowJobs(db,at),replay:false};}
 finally{releaseWorkflowOwnership(db,owner,at);}
}
export function defineWorkflowSchedule(db,input){
 exact(input,['id','action','arguments','localTime','weekdays','timeoutMs'],'WORKFLOW_SCHEDULE_FIELDS');
 if(input.action!=='PREPARE_REPORT')throw Error('WORKFLOW_RECURRENCE_LOCAL_REPORT_ONLY_REQUIRES_NEW_PROVIDER_AUTHORITY_PER_OCCURRENCE');
 taskSpec({id:input.id,action:input.action,arguments:input.arguments,runAt:'2026-01-01T00:00:00Z',timeoutMs:input.timeoutMs});
 if(!/^([01]\d|2[0-3]):[0-5]\d$/.test(input.localTime)||!Array.isArray(input.weekdays)||!input.weekdays.length||new Set(input.weekdays).size!==input.weekdays.length||input.weekdays.some(n=>!Number.isInteger(n)||n<0||n>6))throw Error('WORKFLOW_SCHEDULE_TIME');
 const value={...structuredClone(input),timeZone:'America/New_York',specHash:hash(input),enabled:false,approval:null,missedOccurrences:'NO_BACKFILL'};
 const old=getRecord(db,'workflow_schedule',input.id);if(old){if(old.specHash!==value.specHash)throw Error('WORKFLOW_SCHEDULE_IMMUTABLE');return old;}
 putRecord(db,'workflow_schedule',input.id,value,'configuration');return value;
}
export function materializeWorkflowSchedules(db,at=now()){
 timestamp(at);const format=new Intl.DateTimeFormat('en-CA',{timeZone:'America/New_York',year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hourCycle:'h23',weekday:'short'}),parts=Object.fromEntries(format.formatToParts(new Date(at)).map(p=>[p.type,p.value]));
 const date=`${parts.year}-${parts.month}-${parts.day}`,minute=`${parts.hour}:${parts.minute}`,day=['Sun','Mon','Tue','Wed','Thu','Fri','Sat'].indexOf(parts.weekday),created=[];
 return atomic(db,()=>{
  for(const {data_json} of db.prepare("SELECT data_json FROM records WHERE kind='workflow_schedule' ORDER BY id").all()){
   const p=JSON.parse(data_json);if(!p.enabled)continue;
   const {id,action,arguments:args,localTime,weekdays,timeoutMs}=p;
   if(hash({id,action,arguments:args,localTime,weekdays,timeoutMs})!==p.specHash||p.timeZone!=='America/New_York'||p.missedOccurrences!=='NO_BACKFILL'||!p.approval?.by||!p.approval?.revision||timestamp(p.approval.at)>timestamp(at))throw Error('WORKFLOW_SCHEDULE_APPROVAL_OR_HASH');
   if(action!=='PREPARE_REPORT')throw Error('WORKFLOW_RECURRENCE_LOCAL_REPORT_ONLY');
   if(!weekdays.includes(day)||minute<localTime)continue;
   const taskId=`schedule:${id}:${date}`;if(getRecord(db,'workflow_task',taskId))continue;
   runtimeGate(db,{action},at);
   created.push(registerWorkflowTask(db,{id:taskId,action,arguments:args,runAt:at,timeoutMs}));
   putRecord(db,'workflow_schedule_occurrence',taskId,{scheduleId:id,scheduleHash:p.specHash,date},'configuration');
  }return created;
 });
}
export async function runScheduledReportsOnce(db,{ownerId,clock=now,maxJobs=20,signal}={}){
 if(signal?.aborted)throw Error('WORKFLOW_JOB_CANCELLED');
 required(ownerId);if(!Number.isSafeInteger(maxJobs)||maxJobs<1||maxJobs>20)throw Error('WORKFLOW_TICK_JOB_LIMIT');
 const at=clock();materializeWorkflowSchedules(db,at);
 // Resume already materialized, never-dispatched occurrences after a crash.
 // RUNNING/RECONCILIATION work is deliberately excluded; no blind replay.
 const due=workflowJobStatus(db).filter(j=>j.status==='SCHEDULED'&&j.payload?.taskId?.startsWith('schedule:')&&timestamp(j.runAt)<=timestamp(at));
 const results=[],skipped=[],eligible=[];
 for(const j of due){
  const origin=getRecord(db,'workflow_schedule_occurrence',j.payload.taskId),plan=origin&&getRecord(db,'workflow_schedule',origin.scheduleId);
  if(!plan)throw Error('WORKFLOW_SCHEDULE_ORIGIN_MISSING');
  if(plan.enabled!==true){skipped.push({taskId:j.payload.taskId,reason:'SCHEDULE_DISABLED'});continue;}
  eligible.push(j);
 }
 for(const j of eligible.slice(0,maxJobs)){
  const task=readTask(db,j.payload.taskId);if(task.action!=='PREPARE_REPORT')throw Error('WORKFLOW_RECURRENCE_LOCAL_REPORT_ONLY');
  if(signal?.aborted)break;
  results.push(await runWorkflowTask(db,task.id,{ownerId,clock,signal}));
  if(results.at(-1).status!=='SUCCEEDED')break;
 }
 return {results,skipped,remainingDue:eligible.length-results.length,externalCalls:0,registeredSchedule:false};
}
