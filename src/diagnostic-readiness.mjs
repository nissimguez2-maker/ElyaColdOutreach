import {setTimeout as delay} from 'node:timers/promises';
import {inspectDiscovery} from './diagnostic-discovery.mjs';

export const READINESS_INTERVAL_MS=2000,READINESS_REQUEST_CAP=20;

// Only the installed protocol's "starting" state is treated as transitional.
// This waits for discovery readiness, never executes a tool or changes auth.
export async function waitForDiscoveryReady({read,call,deadlineAt,audit,signal,assertActive=()=>{},now=Date.now,sleep=delay}){
 const deadline=Date.parse(deadlineAt);
 if(!Number.isFinite(deadline))throw Error('READINESS_DEADLINE_INVALID');
 const controller=new AbortController();
 const cancel=()=>controller.abort(Error('READINESS_CANCELLED'));
 if(signal?.aborted)cancel();else signal?.addEventListener('abort',cancel,{once:true});
 const timer=setTimeout(()=>controller.abort(Error('READINESS_DEADLINE')),Math.max(0,deadline-now()));
 let rejectAbort;
 const aborted=new Promise((_,reject)=>{rejectAbort=()=>reject(controller.signal.reason);controller.signal.addEventListener('abort',rejectAbort,{once:true});});
 const check=()=>{controller.signal.throwIfAborted();if(now()>=deadline)throw Error('READINESS_DEADLINE');assertActive();};
 try{
  for(let attempt=1;attempt<=READINESS_REQUEST_CAP;attempt++){
   check();
   const inventory=await Promise.race([read(),aborted]);check();
   const result=inspectDiscovery(inventory,call),e=result.evidence;
   let reason=e.stopReason;
   if(reason==='DISCOVERY_RUNTIME_STARTING'){
    // Starting must not hide independent terminal catalog conditions.
    if(e.invalidToolEntryCount)reason='DISCOVERY_TOOL_ENTRY_INVALID';
    else if(e.matchingToolCount!==1)reason='EXACT_TOOL_UNAVAILABLE';
   }
   if(!reason&&e.runtimeStatus.value!=='connected')reason='READINESS_STATE_UNCONFIRMED';
   const decision=reason==='DISCOVERY_RUNTIME_STARTING'?'WAIT':reason?'STOP':'READY';
   audit({...e,attempt,readinessDecision:decision,readinessReason:reason});
   check();
   if(decision==='READY')return result;
   if(decision==='STOP')throw Error(reason);
   if(attempt===READINESS_REQUEST_CAP)throw Error('READINESS_REQUEST_CAP');
   check();
   await Promise.race([sleep(Math.min(READINESS_INTERVAL_MS,deadline-now()),undefined,{signal:controller.signal}),aborted]);
   check();
  }
 }catch(error){if(controller.signal.aborted)throw controller.signal.reason;throw error;}
 finally{clearTimeout(timer);signal?.removeEventListener('abort',cancel);controller.signal.removeEventListener('abort',rejectAbort);}
}
