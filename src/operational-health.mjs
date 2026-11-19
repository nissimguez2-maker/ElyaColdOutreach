// Optional observations only. No configuration, scheduling, business authority,
// paid retries or credential persistence is created by this module.
import {request} from 'node:https';
import {getRecord,controls} from './store.mjs';
import {appendOperationalLog} from './local-maintenance.mjs';

function pingOnce({url,body,signal}){
 return new Promise((resolve,reject)=>{
  const req=request(url,{method:'POST',agent:false,signal,headers:{'content-type':'text/plain; charset=utf-8','content-length':Buffer.byteLength(body)}},res=>{
   let text='';res.setEncoding('utf8');res.on('data',part=>{text+=part;if(text.length>64)req.destroy(Error('HEARTBEAT_RESPONSE_LIMIT'));});
   res.on('end',()=>resolve({statusCode:res.statusCode,body:text}));res.on('error',reject);
  });req.on('error',reject);req.end(body);
 });
}
const errorKeys=['release','jobId','stage','provider','category','elapsedMs'];
const label=value=>typeof value==='string'&&/^[A-Za-z0-9_.:-]{1,160}$/.test(value);
export function createOperationalHealth({db,root,loadPingUrl,transport=pingOnce,clock=Date.now,timeoutMs=1000}={}){
 if(!Number.isSafeInteger(timeoutMs)||timeoutMs<1||timeoutMs>2000)throw Error('HEARTBEAT_TIMEOUT_BOUND');
 const recent=new Map(),attempted=new Map(),inFlight=new Set();
 const log=event=>{try{appendOperationalLog(root,{at:new Date().toISOString(),...event});return true;}catch{return false;}};
 function recordError(event){
  if(!event||Object.keys(event).sort().join()!==[...errorKeys].sort().join()||errorKeys.filter(k=>k!=='elapsedMs').some(k=>!label(event[k]))||!Number.isSafeInteger(event.elapsedMs)||event.elapsedMs<0)return {status:'REJECTED'};
  const at=clock(),key=JSON.stringify(errorKeys.filter(k=>k!=='elapsedMs').map(k=>event[k]));
  for(const [k,time]of recent)if(at-time>=900000)recent.delete(k);
  if(recent.has(key))return {status:'DEDUPLICATED'};
  if(!log(event))return {status:'LOG_UNAVAILABLE'};
  if(recent.size>=128)recent.delete(recent.keys().next().value);recent.set(key,at);return {status:'RECORDED'};
 }
 async function ping(kind,evidence){
  const config=getRecord(db,'settings','operational-health');
  if(config?.healthchecksEnabled!==true||typeof config.approvedBy!=='string'||!config.approvedBy||!Number.isFinite(Date.parse(config.approvedAt))||typeof loadPingUrl!=='function')return {status:'DISABLED',kind};
  if(kind==='backup'&&evidence?.status!=='BACKUP_VERIFIED')return {status:'NOT_VERIFIED',kind};
  const start=clock();if(inFlight.has(kind)||attempted.has(kind)&&start-attempted.get(kind)<60000)return {status:'RATE_LIMITED',kind};
  attempted.set(kind,start);inFlight.add(kind);const abort=new AbortController();let timer;
  const stopped=controls(db).stopped;
  const body=kind==='worker'?`WORKER_LIVENESS_ONLY; ${stopped?'BUSINESS_STOPPED':'BUSINESS_NOT_STOPPED'}; no lead-processing success asserted`:'BACKUP_CREATION_VERIFIED; restore-test success is separate';
  let outcome;
  try{
   const work=Promise.resolve().then(async()=>{
    const url=await loadPingUrl(kind);abort.signal.throwIfAborted();
    if(typeof url!=='string'||!/^https:\/\/hc-ping\.com\/[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(url))throw Error('HEARTBEAT_DESTINATION_INVALID');
    if(JSON.stringify(getRecord(db,'settings','operational-health'))!==JSON.stringify(config))throw Error('HEARTBEAT_CONFIGURATION_CHANGED');
    const reply=await transport({url,body,signal:abort.signal});abort.signal.throwIfAborted();
    if(reply?.statusCode!==200||reply.body!=='OK')throw Error('HEARTBEAT_NOT_ACCEPTED');
    return {status:'ACCEPTED',kind};
   });
   outcome=await Promise.race([work,new Promise(resolve=>{timer=setTimeout(()=>{abort.abort();resolve({status:'TIMEOUT',kind});},timeoutMs);})]);
  }catch{outcome={status:abort.signal.aborted?'TIMEOUT':'FAILED',kind};}
  finally{clearTimeout(timer);inFlight.delete(kind);}
  if(outcome.status!=='ACCEPTED')recordError({release:'local',jobId:`heartbeat:${kind}`,stage:'HEARTBEAT',provider:'healthchecks',category:outcome.status,elapsedMs:Math.max(0,Math.floor(clock()-start))});
  return outcome;
 }
 return Object.freeze({recordError,workerAlive:()=>ping('worker'),backupSucceeded:evidence=>ping('backup',evidence),
  localStatus:()=>({dedupEntries:recent.size,inFlight:inFlight.size,maxDedupEntries:128,externalConfigurationPresent:getRecord(db,'settings','operational-health')?.healthchecksEnabled===true}),
  async observeWorkerCycle(work){
   // Never await monitoring before returning the business result. No failure in
   // this observer may repeat the supplied work or replace its original error.
   try{return await work();}finally{void ping('worker').catch(()=>{});}
  }
 });
}
