import {canonical,digest} from './values.mjs';
import {getRecord,putRecord,transaction,journal,controls} from './store.mjs';
import {createBudget,reserveOperation,beginOperation,operation,recordOutcome,cancelOperation,budgetStatus} from './operations.mjs';
import {ID,HISTORICAL,CALLS,INTENT,historicalHash,assertDiagnosticActive,diagnosticSpec,INSTANTLY_ID,priorClosedHash,DISCOVERY_ID,priorV2Hash,READINESS_ID,priorV3Hash,FUNCTIONAL_ID,priorV4Hash} from './diagnostic-policy.mjs';
export {ID,HISTORICAL,CALLS,INTENT};
export function startDiagnostic(db,startedMs,testId=ID){
 const {id:scopeId,calls:scopeCalls,intent:scopeIntent,maximumMs=180000,dispatchMs=160000,discovery,readiness,functional,readinessMs}=diagnosticSpec(testId);
 transaction(db,()=>{
  if(getRecord(db,'diagnostic_exception',scopeId)||operation(db,scopeIntent.id))throw Error('DIAGNOSTIC_ALREADY_CONSUMED_NO_RESTART');
  if([INSTANTLY_ID,DISCOVERY_ID,READINESS_ID,FUNCTIONAL_ID].includes(testId)&&(getRecord(db,'diagnostic_exception',ID)?.status!=='CLOSED'||operation(db,INTENT.id)?.status!=='CANCELLED'))throw Error('PRIOR_TEST_NOT_CLOSED');
  if([DISCOVERY_ID,READINESS_ID,FUNCTIONAL_ID].includes(testId)&&(getRecord(db,'diagnostic_exception',INSTANTLY_ID)?.status!=='CLOSED'||operation(db,diagnosticSpec(INSTANTLY_ID).intent.id)?.status!=='CANCELLED'))throw Error('PRIOR_TEST_NOT_CLOSED');
  if([READINESS_ID,FUNCTIONAL_ID].includes(testId)&&(getRecord(db,'diagnostic_exception',DISCOVERY_ID)?.status!=='CLOSED'||operation(db,diagnosticSpec(DISCOVERY_ID).intent.id)?.status!=='CANCELLED'))throw Error('PRIOR_TEST_NOT_CLOSED');
  if(functional&&(getRecord(db,'diagnostic_exception',READINESS_ID)?.status!=='CLOSED'||operation(db,diagnosticSpec(READINESS_ID).intent.id)?.status!=='CANCELLED'))throw Error('PRIOR_TEST_NOT_CLOSED');
  const c=controls(db),h=operation(db,HISTORICAL);
  if(!c.stopped||c.launchAuthorized||h?.status!=='RECONCILIATION'||h.reservation_usd!=='0.15'||h.actual_usd!==null)throw Error('DIAGNOSTIC_PREFLIGHT_CHANGED');
  if(!Number.isSafeInteger(startedMs)||startedMs>Date.now()||Date.now()-startedMs>5000)throw Error('INVALID_START_TIME');
  putRecord(db,'diagnostic_exception',scopeId,{status:'ACTIVE',startedAt:new Date(startedMs).toISOString(),deadlineAt:new Date(startedMs+dispatchMs).toISOString(),hardDeadlineAt:new Date(startedMs+maximumMs).toISOString(),intentHash:digest(canonical(scopeIntent)),historicalHash:historicalHash(db),...([INSTANTLY_ID,DISCOVERY_ID,READINESS_ID,FUNCTIONAL_ID].includes(testId)?{priorClosedHash:priorClosedHash(db)}:{}),...(discovery?{priorV2Hash:priorV2Hash(db),discoveryState:'NOT_DISPATCHED'}:{}),...(readiness?{priorV3Hash:priorV3Hash(db),discoveryRequestCount:0}:{}),...(functional?{priorV4Hash:priorV4Hash(db),readinessDeadlineAt:new Date(startedMs+readinessMs).toISOString()}:{}),schemas:[],reads:scopeCalls.map(c=>({provider:c.provider,state:'NOT_DISPATCHED',matchingResultEvidence:false,resourceStatus:null}))},'configuration');
  journal(db,'ONE_USE_DIAGNOSTIC_CLAIMED',scopeId,{intentHash:digest(canonical(scopeIntent)),maximumTotalMs:maximumMs});
 });
 try{createBudget(db,scopeId,'0','0','0','Approved existing-auth read-only diagnostics; no discretionary spending');reserveOperation(db,scopeIntent);}catch(error){closeDiagnostic(db,'FAILED_PREPARATION',testId);throw error;}
}
export function beginDiagnostic(db,testId=ID){return beginOperation(db,diagnosticSpec(testId).intent.id,undefined,()=>assertDiagnosticActive(db,testId));}
export function claimDiscovery(db,target,testId){const spec=diagnosticSpec(testId);return transaction(db,()=>{
 const s=assertDiagnosticActive(db,testId);
 if(spec.functional&&Date.now()>=Date.parse(s.readinessDeadlineAt))throw Error('READINESS_DEADLINE');
 if(!spec.discovery||canonical(target)!==canonical(spec.discovery)||operation(db,spec.intent.id)?.status!=='PREPARED'||budgetStatus(db,spec.id).blocked)throw Error('DISCOVERY_CALL_DENIED');
 if(spec.readiness){
  const count=s.discoveryRequestCount;
  if(!Number.isSafeInteger(count)||count<0||count>=spec.requestCap||count===0&&s.discoveryState!=='NOT_DISPATCHED'||count>0&&(s.discoveryState!=='OBSERVED'||s.lastReadinessDecision!=='WAIT'||!Number.isFinite(Date.parse(s.discoveryAttemptedAt))||Date.now()-Date.parse(s.discoveryAttemptedAt)<spec.intervalMs))throw Error('DISCOVERY_CALL_DENIED');
 }else if(s.discoveryState!=='NOT_DISPATCHED')throw Error('DISCOVERY_CALL_DENIED');
 if(db.prepare("SELECT id FROM operations WHERE id NOT IN (?,?) AND status IN ('DISPATCHING','RECONCILIATION')").get(HISTORICAL,spec.intent.id))throw Error('NEW_RECONCILIATION_BLOCKER');
 putRecord(db,'diagnostic_exception',spec.id,{...s,discoveryState:'DISPATCH_INTENT',discoveryAttemptedAt:new Date().toISOString(),...(spec.readiness?{discoveryRequestCount:s.discoveryRequestCount+1}:{})},'confirmed');
 journal(db,'EXACT_DISCOVERY_CALL_INTENT',spec.id,{method:'mcpServerStatus/list',serverName:target.server,detail:'toolsAndAuthOnly'});
 return JSON.parse(canonical(target));
});}
export function recordDiscoveryObservation(db,e,testId){const spec=diagnosticSpec(testId);transaction(db,()=>{
 const s=assertDiagnosticActive(db,testId);
 if(!spec.readiness||s.discoveryState!=='DISPATCH_INTENT'||e.attempt!==s.discoveryRequestCount||e.server!==spec.discovery.server||e.tool!==spec.discovery.tool||!['WAIT','READY','STOP'].includes(e.readinessDecision))throw Error('INVALID_DISCOVERY_OBSERVATION');
 if(e.readinessDecision==='WAIT'&&(e.runtimeStatus?.value!=='starting'||e.readinessReason!=='DISCOVERY_RUNTIME_STARTING')||e.readinessDecision==='READY'&&e.runtimeStatus?.value!=='connected')throw Error('INVALID_DISCOVERY_OBSERVATION');
 putRecord(db,'diagnostic_exception',spec.id,{...s,discoveryState:'OBSERVED',lastReadinessDecision:e.readinessDecision},'provider_result');
 journal(db,'DISCOVERY_OBSERVED',spec.id,{attempt:e.attempt,decision:e.readinessDecision});
});}
export function setSchemas(db,schemas,testId=ID){const spec=diagnosticSpec(testId);transaction(db,()=>{const s=assertDiagnosticActive(db,testId);if(spec.functional&&(s.lastReadinessDecision!=='READY'||s.discoveryState!=='OBSERVED'))throw Error('READINESS_NOT_CONFIRMED');if(s.schemas.length||schemas.length!==spec.calls.length||schemas.some((x,i)=>x.provider!==spec.calls[i].provider||!/^[a-f0-9]{64}$/.test(x.schemaHash)))throw Error('INVALID_RUNTIME_SCHEMAS');putRecord(db,'diagnostic_exception',spec.id,{...s,schemas},'confirmed');});}
export function claimCall(db,call,testId=ID){const spec=diagnosticSpec(testId);return transaction(db,()=>{
 const s=assertDiagnosticActive(db,testId),index=spec.calls.findIndex(c=>canonical(c)===canonical(call));
 if(budgetStatus(db,spec.id).blocked)throw Error('DIAGNOSTIC_BUDGET_BLOCKED');
 if(index<0||s.schemas.length!==spec.calls.length||operation(db,spec.intent.id)?.status!=='DISPATCHING'||s.reads[index].state!=='NOT_DISPATCHED'||index>0&&s.reads[index-1].state!=='SUCCEEDED')throw Error('DIAGNOSTIC_CALL_DENIED');
 // No newly introduced outstanding operation may share this exception.
 if(db.prepare("SELECT id FROM operations WHERE id NOT IN (?,?) AND status IN ('DISPATCHING','RECONCILIATION')").get(HISTORICAL,spec.intent.id))throw Error('NEW_RECONCILIATION_BLOCKER');
 s.reads[index]={...s.reads[index],state:'DISPATCH_INTENT',attemptedAt:new Date().toISOString()};putRecord(db,'diagnostic_exception',spec.id,s,'confirmed');journal(db,'EXACT_DIAGNOSTIC_CALL_INTENT',spec.id,call);
 return JSON.parse(canonical(call));
});}
export function saveReadResult(db,provider,result,testId=ID){const spec=diagnosticSpec(testId);transaction(db,()=>{const s=assertDiagnosticActive(db,testId),i=spec.calls.findIndex(c=>c.provider===provider);if(i<0||s.reads[i].state!=='DISPATCH_INTENT'||result.matchingResultEvidence!==true||typeof result.resourceStatus!=='string')throw Error('INVALID_READ_RESULT');s.reads[i]={...s.reads[i],state:'SUCCEEDED',matchingResultEvidence:true,resourceStatus:result.resourceStatus,completedAt:new Date().toISOString()};putRecord(db,'diagnostic_exception',spec.id,s,'provider_result');journal(db,'MATCHING_DIAGNOSTIC_RESULT',spec.id,{provider,...result});});}
export function closeDiagnostic(db,reason,testId=ID){
 const spec=diagnosticSpec(testId),s=getRecord(db,'diagnostic_exception',spec.id);if(!s||s.status==='CLOSED')return;
 // Close authority first. If accounting subsequently fails, authority stays closed.
 transaction(db,()=>{putRecord(db,'diagnostic_exception',spec.id,{...s,status:'CLOSED',terminalReason:reason,closedAt:new Date().toISOString()},'confirmed');journal(db,'DIAGNOSTIC_EXCEPTION_CLOSED',spec.id,{reason});});
 const op=operation(db,spec.intent.id);
 if(op?.status==='PREPARED')cancelOperation(db,spec.intent.id,'Diagnostic closed before any business-data dispatch');
 else if(op?.status==='DISPATCHING')recordOutcome(db,spec.intent.id,{status:s.reads.every(r=>r.state==='SUCCEEDED')?'SUCCEEDED':'AMBIGUOUS',actual:null,evidence:'Diagnostic completion recorded separately; dollar usage not exposed; no replay',validatedResults:s.reads});
}
