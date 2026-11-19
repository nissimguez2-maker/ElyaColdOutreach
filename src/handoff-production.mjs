// Trusted composition boundary. Importing/factory construction performs no I/O.
import {getRecord} from './store.mjs';
import {canonical,timestamp} from './values.mjs';
import {permitsIsolatedHandoff} from './handoff-isolation.mjs';
import {isContainedHandoffTransport} from './handoff-app-server.mjs';

const adapters=new WeakMap();
export function assertProductionHandoffEnabled(db){
 const settings=getRecord(db,'settings','handoff-production');
 if(settings?.enabled!==true||settings.generalDispatchEnabled!==true)throw Error('HANDOFF_PRODUCTION_DISPATCH_DISABLED');
}
export function createProductionHandoffAdapter(db,{transport,fixtureAdapter,clock,timeoutMs=30000}={}){
 const fixture=fixtureAdapter?permitsIsolatedHandoff(db,fixtureAdapter):false;
 if(!transport||typeof transport.execute!=='function'||(fixture?transport.mode!=='offline':!isContainedHandoffTransport(transport)))throw Error('HANDOFF_CONTAINED_TRANSPORT_REQUIRED');
 if(!Number.isSafeInteger(timeoutMs)||timeoutMs<1||timeoutMs>60000||clock!==undefined&&typeof clock!=='function')throw Error('HANDOFF_PRODUCTION_BOUNDS_INVALID');
 const adapter=Object.freeze({mode:fixture?'production-handoff-fixture':'production-handoff'});
 adapters.set(adapter,{db,transport,fixtureAdapter,clock,timeoutMs});return adapter;
}
export const isProductionHandoffAdapter=adapter=>adapters.has(adapter);
export function productionHandoffOptions(db,adapter){
 const value=adapters.get(adapter);if(value?.db!==db)throw Error('HANDOFF_PRODUCTION_ADAPTER_DATABASE_MISMATCH');
 if(value.fixtureAdapter)permitsIsolatedHandoff(db,value.fixtureAdapter);
 return {fixtureAdapter:value.fixtureAdapter,production:true};
}
export function productionHandoffClock(db,adapter,fallback){
 const value=adapters.get(adapter);if(value?.db!==db)throw Error('HANDOFF_PRODUCTION_ADAPTER_DATABASE_MISMATCH');
 return ()=>{const at=value.clock?value.clock():fallback();timestamp(at);return at;};
}
export function productionHandoffTransport(db,adapter){
 productionHandoffOptions(db,adapter);const {transport,timeoutMs}=adapters.get(adapter);
 return async(call,remainingMs,permit,context,lifetimeSignal)=>{
  if(remainingMs<=0)throw Error('HANDOFF_PRODUCTION_DEADLINE');
  let timer,used=false,rejectAbort;const controller=new AbortController(),exact=JSON.parse(canonical(call));
  const aborted=new Promise((_,reject)=>{rejectAbort=reject;});
  const cancel=()=>{controller.abort();rejectAbort(Error('HANDOFF_PRODUCTION_CANCELLED_UNCERTAIN'));};
  if(lifetimeSignal?.aborted)throw Error('HANDOFF_PRODUCTION_CANCELLED');
  lifetimeSignal?.addEventListener('abort',cancel,{once:true});
  const oneUse=proposed=>{
   controller.signal.throwIfAborted();if(used||canonical(proposed)!==canonical(exact))throw Error('HANDOFF_PRODUCTION_PERMIT_MISMATCH');
   const result=permit(proposed);used=true;return result;
  };
  try{
   const result=await Promise.race([
    Promise.resolve().then(()=>transport.execute(exact,{signal:controller.signal,permit:oneUse,context})),
    new Promise((_,reject)=>{timer=setTimeout(()=>{controller.abort();reject(Error('HANDOFF_PRODUCTION_TIMEOUT_UNCERTAIN'));},Math.min(timeoutMs,remainingMs));}),
    aborted,
   ]);
   if(!used)throw Error('HANDOFF_PRODUCTION_PRE_DISPATCH_PERMIT_MISSING');return result;
  }finally{clearTimeout(timer);lifetimeSignal?.removeEventListener('abort',cancel);}
 };
}
