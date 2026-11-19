import {parentPort,workerData,threadId} from 'node:worker_threads';
import {DatabaseSync} from 'node:sqlite';
import {readFileSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {mock} from 'node:test';
import {claimAcceptance,cancelAcceptance,closeAcceptance} from '../../src/acceptance-authority.mjs';
import {acceptanceErrorCode} from '../../src/acceptance-controller.mjs';
import {blockNetwork} from './network-block.mjs';

const cleanups=[],network=blockNetwork({mock,after:cleanup=>cleanups.push(cleanup)});
const {root,atMs,invocationId,barrier,mode}=workerData;
let db,result;
try{
 const path=resolve(root,'data/elya.sqlite');
 if(!path.startsWith(resolve(root)+ '\\')&&!path.startsWith(resolve(root)+'/'))throw Error('FIXTURE_DATABASE_PATH_INVALID');
 db=new DatabaseSync(path);db.exec('PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000; PRAGMA synchronous=FULL;');
 const manifest=JSON.parse(readFileSync(join(root,'work/instantly-qa-acceptance-v2/manifest.json'),'utf8'));
 parentPort.postMessage({type:'ready',threadId,invocationId});
 const signal=new Int32Array(barrier);
 if(Atomics.wait(signal,0,0,10000)==='timed-out')throw Error('FIXTURE_BARRIER_TIMEOUT');
 if(mode==='claim'){
  try{
   const grant=claimAcceptance(db,manifest,atMs,{root,now:()=>atMs,entryCheck:()=>true,invocationId});
   result={outcome:'CLAIMED',invocationId,threadId,claimInvocationId:grant.claimInvocationId,startedAt:grant.startedAt,deadlineAt:grant.deadlineAt};
  }catch(error){
   result={outcome:'DENIED',invocationId,threadId,reason:acceptanceErrorCode(error)};
   if(result.reason==='ACCEPTANCE_AUTHORIZATION_CLAIMED'){
    const snapshot=()=>JSON.stringify(['records','record_history','journal'].map(table=>db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()));
    const before=snapshot(),attempt=fn=>{try{fn();return 'SUCCEEDED';}catch(error){return acceptanceErrorCode(error);}};
    result.nonownerCancel=attempt(()=>cancelAcceptance(db,atMs,manifest.id,invocationId));
    result.unstartedClose=attempt(()=>closeAcceptance(db,{id:manifest.id,status:'BLOCKED',reason:'OFFLINE_DUPLICATE',notLaunched:true,claimInvocationId:invocationId},atMs));
    result.nonownerClose=attempt(()=>closeAcceptance(db,{id:manifest.id,status:'BLOCKED',reason:'OFFLINE_NONOWNER_CLOSE',claimInvocationId:invocationId},atMs));
    result.protectedFromLoser=snapshot()===before;
   }
  }
 }else if(mode==='duplicate-entry'){
  const {runInstantlyQaV2Entry}=await import('../../src/instantly-qa-v2-entry.mjs');
  const value=await runInstantlyQaV2Entry({db,root,startedAtMs:atMs,startedMono:0,now:()=>atMs,runtime:{platform:'win32',stdinIsTTY:true,stdoutIsTTY:true,args:['--run-once'],agentContext:false,background:false},emit:()=>{}});
  result={outcome:'ENTRY_RESULT',invocationId,threadId,value};
 }else throw Error('FIXTURE_WORKER_MODE_INVALID');
}catch(error){result={outcome:'ERROR',invocationId,threadId,reason:acceptanceErrorCode(error)};}
finally{db?.close();result.networkAttempts=network.attempts;for(const cleanup of cleanups)cleanup();parentPort.postMessage({type:'done',result});parentPort.close();}
