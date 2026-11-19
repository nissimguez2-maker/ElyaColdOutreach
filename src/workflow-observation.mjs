// Explicit operator records over existing evidence. No timer, provider request,
// telemetry destination, approval, or business-state mutation is created here.
import {canonical,required,timestamp,addMoney} from './values.mjs';
import {getRecord,putRecord,journal,transaction,now} from './store.mjs';

const atomic=(db,fn)=>db.isTransaction?fn():transaction(db,fn);
function exact(input,keys){
 canonical(input);if(!input||Object.keys(input).sort().join()!==keys.sort().join())throw Error('OBSERVATION_FIELDS');
}
export function startOperationalObservation(db,input,at=now()){
 exact(input,['id','startedAt','approvedBy','approvalRef','cadence','startEvidenceRef','realOperationConfirmed']);
 for(const key of ['id','approvedBy','approvalRef','cadence','startEvidenceRef'])required(input[key]);
 if(input.realOperationConfirmed!==true)throw Error('OBSERVATION_REAL_OPERATION_CONFIRMATION_REQUIRED');
 if(timestamp(input.startedAt)>timestamp(at))throw Error('OBSERVATION_START_FUTURE');
 const value={...input,evidenceBasis:'user_reported',timeZone:'America/New_York',reviewAfter:new Date(timestamp(input.startedAt)+7*86400000).toISOString(),automaticallyAccepted:false};
 return atomic(db,()=>{
  const prior=getRecord(db,'operational_observation',input.id);
  if(prior){if(canonical(prior)!==canonical(value))throw Error('OBSERVATION_START_IMMUTABLE');return prior;}
  if(db.prepare("SELECT id FROM records WHERE kind='operational_observation' LIMIT 1").get())throw Error('OBSERVATION_ALREADY_STARTED');
  putRecord(db,'operational_observation',input.id,value,'user_reported');
  journal(db,'OPERATIONAL_OBSERVATION_STARTED',input.id,{startedAt:input.startedAt,approvalRef:input.approvalRef,startEvidenceRef:input.startEvidenceRef,evidenceBasis:'user_reported'});return value;
 });
}
export function recordOperationalIntervention(db,input,at=now()){
 exact(input,['id','observationId','occurredAt','actor','category','evidenceRef']);
 for(const key of ['id','observationId','actor','evidenceRef'])required(input[key]);
 if(!['MANUAL_INTERVENTION','MISSING_SIGNAL','MISLEADING_SIGNAL','RECOVERY'].includes(input.category))throw Error('OBSERVATION_CATEGORY');
 const observation=getRecord(db,'operational_observation',input.observationId);if(!observation)throw Error('OBSERVATION_NOT_STARTED');
 if(timestamp(input.occurredAt)<timestamp(observation.startedAt)||timestamp(input.occurredAt)>timestamp(at))throw Error('OBSERVATION_INTERVENTION_TIME');
 return atomic(db,()=>{
  const prior=getRecord(db,'operational_intervention',input.id);if(prior){if(canonical(prior)!==canonical(input))throw Error('OBSERVATION_INTERVENTION_IMMUTABLE');return prior;}
  putRecord(db,'operational_intervention',input.id,input,'user_reported');journal(db,'OPERATIONAL_INTERVENTION',input.id,{observationId:input.observationId,category:input.category,evidenceRef:input.evidenceRef,occurredAt:input.occurredAt});return input;
 });
}
export function operationalObservationReport(db,id,at=now()){
 required(id);timestamp(at);const observation=getRecord(db,'operational_observation',id);
 if(!observation)return {status:'NOT_STARTED',startedAt:null,automaticStart:false,externalCalls:0};
 if(timestamp(at)<timestamp(observation.startedAt))throw Error('OBSERVATION_REPORT_BEFORE_START');
 const from=observation.startedAt,to=new Date(Math.min(timestamp(at),timestamp(observation.reviewAfter))).toISOString();
 const inWindow="julianday(recorded_at)>=julianday(?) AND julianday(recorded_at)<=julianday(?)";
 const runs=Object.fromEntries(db.prepare(`SELECT json_extract(details_json,'$.status') AS status,count(*) AS count FROM journal WHERE event='WORKFLOW_JOB_OUTCOME' AND ${inWindow} GROUP BY status`).all(from,to).map(r=>[r.status,r.count]));
 const eventCounts=db.prepare(`SELECT event,count(*) AS count FROM journal WHERE ${inWindow} GROUP BY event ORDER BY event`).all(from,to).map(r=>({...r}));
 const operationRows=db.prepare('SELECT id,status,reservation_usd,actual_usd,remote_id,evidence FROM operations WHERE julianday(created_at)>=julianday(?) AND julianday(created_at)<=julianday(?) ORDER BY id LIMIT 1001').all(from,to);
 const totals=db.prepare('SELECT actual_usd FROM operations WHERE julianday(created_at)>=julianday(?) AND julianday(created_at)<=julianday(?)').all(from,to);
 const stateRows=db.prepare(`SELECT kind,id,hash,recorded_at AS recordedAt,json_extract(data_json,'$.status') AS status,json_extract(data_json,'$.verification') AS verification FROM record_history WHERE kind IN ('candidate','contact','draft','writing_decision','handoff_import','provider_event','workflow_job') AND ${inWindow} ORDER BY recorded_at,kind,id LIMIT 1001`).all(from,to);
 const countRecords=(kind,path,type,timePath)=>db.prepare(`SELECT count(*) AS count FROM records WHERE kind=? AND json_extract(data_json,?)=? AND julianday(json_extract(data_json,?))>=julianday(?) AND julianday(json_extract(data_json,?))<=julianday(?)`).get(kind,path,type,timePath,from,timePath,to).count;
 const manualInterventions=db.prepare("SELECT data_json FROM records WHERE kind='operational_intervention' AND json_extract(data_json,'$.observationId')=? AND julianday(json_extract(data_json,'$.occurredAt'))<=julianday(?) ORDER BY id LIMIT 1001").all(id,to).map(r=>JSON.parse(r.data_json));
 return {status:timestamp(at)>=timestamp(observation.reviewAfter)?'PERIOD_ELAPSED_REVIEW_EVIDENCE':'OBSERVING',observation,through:to,runs,eventCounts,
  recoveryEvents:eventCounts.filter(r=>/RECOVER|INTERRUPTED/.test(r.event)).reduce((n,r)=>n+r.count,0),
  replies:countRecords('provider_event','$.event.type','REPLIED','$.ingestedAt'),refusals:countRecords('manual_response_event','$.event.type','REFUSAL','$.recordedAt')+countRecords('manual_response_event','$.event.type','OPT_OUT','$.recordedAt'),
  stateTransitions:stateRows.slice(0,1000).map(r=>({...r})),stateTransitionsTruncated:stateRows.length>1000,
  costs:{cohort:'OPERATIONS_CREATED_DURING_OBSERVATION',settlementBasis:'CURRENT_RECORDED_SETTLEMENTS_AT_REPORT_TIME',settlementObservedAt:now(),knownActualUsd:totals.filter(r=>r.actual_usd!==null).reduce((n,r)=>addMoney(n,r.actual_usd),'0'),unknownActualOperations:totals.filter(r=>r.actual_usd===null).length,coverage:'RECORDED_OPERATIONS_ONLY_NOT_TOTAL_PROVIDER_BILLING',operations:operationRows.slice(0,1000).map(r=>({...r})),operationsTruncated:operationRows.length>1000},
  manualInterventions:manualInterventions.slice(0,1000),manualInterventionsTruncated:manualInterventions.length>1000,automaticAcceptance:false,externalCalls:0};
}
