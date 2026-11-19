import {getRecord,controls,now} from './store.mjs';
import {canonical} from './values.mjs';
import {validateCliJob,checkCliAuthorization,expectedTool} from './cli-jobs.mjs';
import {operation,reserveOperation,beginOperation,recordOutcome} from './operations.mjs';

export function checkDirectFixture(db,id,at=now()){
 const job=validateCliJob(getRecord(db,'cli_job',id));
 if(job.provider!=='local_fixture'){
  if(controls(db).stopped)throw Error('BUSINESS_STOPPED');
  throw Error('LIVE_PROVIDER_DISPATCH_DISABLED');
 }
 if(controls(db).launchAuthorized)throw Error('FIXTURE_REQUIRES_NO_LAUNCH_AUTHORITY');
 checkCliAuthorization(db,job,at);return job;
}
export function validateFixtureResult(response,job){
 if(!response||response.isError!==false||!Array.isArray(response.content)||response.content.length!==1||response.content[0].type!=='text'||typeof response.content[0].text!=='string'||response.content[0].text.length>8192)throw Error('INVALID_FIXTURE_RESPONSE');
 const value=JSON.parse(response.content[0].text);
 if(value?.resourceId!==job.resourceId||value.synthetic!==true||value.value!=='fixture-value'||typeof value.untrustedText!=='string')throw Error('MISMATCHED_FIXTURE_RESPONSE');
 // Provider instructions remain inert; retain only useful validated fields.
 return {resourceId:value.resourceId,synthetic:true,value:value.value};
}
export async function executeDirectFixture(db,id,transport,clock=now,hooks={}){
 if(transport?.mode!=='offline'||typeof transport.execute!=='function')throw Error('LIVE_PROVIDER_DISPATCH_DISABLED');
 const job=checkDirectFixture(db,id,clock()),opId='direct:'+id,call=expectedTool(job);
 if(operation(db,opId))throw Error('EXISTING_OPERATION_NO_AUTOMATIC_REPLAY');
 reserveOperation(db,{id:opId,kind:'READ',budgetId:job.budgetId,reservation:job.reservationUsd,authorizationRef:'cli_job_authorization:'+id,payload:{provider:job.provider,action:job.action,resourceId:job.resourceId}});
 await hooks.afterReserve?.();
 beginOperation(db,opId,clock(),()=>checkDirectFixture(db,id,clock()));
 await hooks.afterDispatch?.();
 let permitUsed=false,validated;
 const permit=proposed=>{
  const current=checkDirectFixture(db,id,clock());
  if(permitUsed||operation(db,opId)?.status!=='DISPATCHING'||canonical(current)!==canonical(job)||canonical(expectedTool(current))!==canonical(call)||canonical(proposed)!==canonical(call))throw Error('DISPATCH_BOUNDARY_MISMATCH');
  permitUsed=true;return JSON.parse(canonical(call));
 };
 try{
  const response=await transport.execute(JSON.parse(canonical(call)),permit);
  if(!permitUsed)throw Error('MISSING_PRE_DISPATCH_CHECK');
  validated=validateFixtureResult(response,job);
 }catch{
  return recordOutcome(db,opId,{status:'AMBIGUOUS',actual:null,remoteId:null,evidence:'Offline direct call unresolved; no retry. Inspect containment and provider records.'});
 }
 await hooks.afterResult?.();
 return recordOutcome(db,opId,{status:'SUCCEEDED',actual:'0',remoteId:null,evidence:'Validated local fake-provider result; synthetic cost only',validatedResult:validated});
}
