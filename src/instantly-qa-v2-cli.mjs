// Run only by the operator after separate live approval and successful binding.
import {DatabaseSync} from 'node:sqlite';
import {existsSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {join} from 'node:path';
import {performance} from 'node:perf_hooks';
import {INSTANTLY_QA_V2_ID} from './instantly-qa-contract.mjs';
import {cancelAcceptance} from './acceptance-authority.mjs';
import {getRecord} from './store.mjs';
import {acceptanceErrorCode} from './acceptance-controller.mjs';
import {runInstantlyQaV2Entry,recordInstantlyQaOpenRefusal} from './instantly-qa-v2-entry.mjs';

const root=fileURLToPath(new URL('../',import.meta.url));
const startedAtMs=Math.floor(performance.timeOrigin),now=()=>startedAtMs+Math.floor(performance.now());
const runtime=()=>({platform:process.platform,stdinIsTTY:process.stdin.isTTY===true,stdoutIsTTY:process.stdout.isTTY===true,args:process.argv.slice(2),
 agentContext:['CODEX_THREAD_ID','CODEX_SANDBOX','CODEX_CI','CODEX_INTERNAL_ORIGINATOR_OVERRIDE'].some(key=>Object.hasOwn(process.env,key)),
 background:process.stdin.isTTY!==true||process.stdout.isTTY!==true||typeof process.send==='function'});
let db,cancelled=false,invocationId,commandEntered=false;
const cancel=()=>{
 cancelled=true;
 try{if(invocationId&&getRecord(db,'acceptance_authorization',INSTANTLY_QA_V2_ID)?.claimInvocationId===invocationId)cancelAcceptance(db,now(),INSTANTLY_QA_V2_ID,invocationId);}
 catch{console.log('CANCELLATION_PERSISTENCE_UNCONFIRMED. Bounded cleanup still applies; do not retry.');}
};
try{
 const path=join(root,'data/elya.sqlite');if(!existsSync(path))throw Error('EXISTING_DATABASE_REQUIRED');
 db=new DatabaseSync(path);db.exec('PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000; PRAGMA synchronous=FULL;');
 process.on('SIGINT',cancel);process.on('SIGTERM',cancel);
 const result=await runInstantlyQaV2Entry({db,root,runtime,now,startedAtMs,startedMono:0,onInvocation:id=>{invocationId=id;commandEntered=true;},
  cancelled:()=>cancelled,emit:event=>console.log(typeof event==='string'?event:JSON.stringify(event))});
 console.log(JSON.stringify(result,null,2));process.exitCode=result.exitCode;
}catch(error){
 const result=commandEntered?{id:INSTANTLY_QA_V2_ID,status:'BLOCKED',reason:acceptanceErrorCode(error),firstFailingStage:'LOCAL_CLI_COMMAND',attemptExternalActivity:'UNRESOLVED_SEE_INVOCATION_EVIDENCE',noAutomaticRetry:true}:recordInstantlyQaOpenRefusal({root,error,startedAtMs,now});
 console.log(JSON.stringify(result));process.exitCode=2;
}finally{process.removeListener('SIGINT',cancel);process.removeListener('SIGTERM',cancel);db?.close();}
