// Suitable for a future explicitly approved scheduler invocation. It runs once
// in the foreground and never registers a task, loops, retries or enables itself.
import {DatabaseSync} from 'node:sqlite';
import {fileURLToPath} from 'node:url';import {resolve} from 'node:path';
import {readFileSync} from 'node:fs';
import {randomUUID} from 'node:crypto';
import {getRecord} from './store.mjs';
import {runtimeStatus,registerWorkflowTask,defineWorkflowSchedule,recoverWorkflowRuntime,runWorkflowTask,runScheduledReportsOnce} from './workflow-runtime.mjs';
import {productionWorkflowServices} from './workflow-runtime-services.mjs';
import {recoverWorkflowOwnership} from './workflow-jobs.mjs';
import {startOperationalObservation,recordOperationalIntervention,operationalObservationReport} from './workflow-observation.mjs';
const root=fileURLToPath(new URL('../',import.meta.url)),args=process.argv.slice(2);
const dbPath=args[0]==='--database'?resolve(args.splice(0,2)[1]??''):resolve(root,'data/elya.sqlite');
const [command='status',id,...extra]=args;let db;
const abort=new AbortController(),cancel=()=>abort.abort();
process.on('SIGINT',cancel);process.on('SIGTERM',cancel);
try{
 if(extra.length||!['status','plan','schedule-plan','recover','recover-owner','run-once','tick-local-reports-once','observation-start','observation-status','observation-note'].includes(command)||(['plan','schedule-plan','run-once','recover-owner','observation-start','observation-status','observation-note'].includes(command)?!id:!!id))throw Error('WORKFLOW_ENTRY_ARGUMENTS');
 db=new DatabaseSync(dbPath,{readOnly:['status','observation-status'].includes(command)});
 db.exec('PRAGMA busy_timeout=5000;');
 if(command==='status')console.log(JSON.stringify(runtimeStatus(db),null,2));
 else if(command==='plan'||command==='schedule-plan'){
  const spec=JSON.parse(readFileSync(resolve(id),'utf8'));
  console.log(JSON.stringify(command==='plan'?registerWorkflowTask(db,spec):defineWorkflowSchedule(db,spec),null,2));
 }else if(command==='recover')console.log(JSON.stringify(recoverWorkflowRuntime(db),null,2));
 else if(command==='recover-owner')console.log(JSON.stringify(recoverWorkflowOwnership(db,id),null,2));
 else if(command==='observation-status')console.log(JSON.stringify(operationalObservationReport(db,id),null,2));
 else if(command==='observation-start'||command==='observation-note'){
  const input=JSON.parse(readFileSync(resolve(id),'utf8'));console.log(JSON.stringify(command==='observation-start'?startOperationalObservation(db,input):recordOperationalIntervention(db,input),null,2));
 }
 else if(command==='run-once'){
  const task=getRecord(db,'workflow_task',id);if(!task)throw Error('WORKFLOW_TASK_NOT_FOUND');
  const services=['COLLECT','HANDOFF','POLL_REPLIES','NOTIFY','DELIVER_REPORT'].includes(task.action)?productionWorkflowServices(db,task,{root,dbPath,clock:()=>new Date().toISOString()}):{};
  const result=await runWorkflowTask(db,id,{ownerId:'foreground:'+randomUUID(),services,signal:abort.signal});console.log(JSON.stringify(result,null,2));if(result.status!=='SUCCEEDED')process.exitCode=1;
 }else{
  console.log(JSON.stringify(await runScheduledReportsOnce(db,{ownerId:'foreground:'+randomUUID(),signal:abort.signal}),null,2));
 }
}catch(error){console.error(/^[A-Z][A-Z0-9_:]+$/.test(error?.message??'')?error.message:'WORKFLOW_ENTRY_FAILED_INSPECT_LOCAL_RECORDS');process.exitCode=1;}
finally{db?.close();process.removeListener('SIGINT',cancel);process.removeListener('SIGTERM',cancel);if(abort.signal.aborted)process.exitCode=130;}
