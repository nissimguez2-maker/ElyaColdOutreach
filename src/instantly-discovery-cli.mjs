// Fixed operator-only command. Importing other discovery modules never launches.
import {DatabaseSync} from 'node:sqlite';
import {existsSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {join} from 'node:path';
import {performance} from 'node:perf_hooks';
import {cancelAcceptance} from './acceptance-authority.mjs';
import {getRecord} from './store.mjs';
import {DISCOVERY_CAPTURE_ID} from './instantly-discovery-profile.mjs';
import {runDiscoveryEntry,recordDiscoveryOpenRefusal} from './instantly-discovery-entry.mjs';

const root=fileURLToPath(new URL('../',import.meta.url)),startedAtMs=Math.floor(performance.timeOrigin),now=()=>startedAtMs+Math.floor(performance.now());
const runtime=()=>({platform:process.platform,stdinIsTTY:process.stdin.isTTY===true,stdoutIsTTY:process.stdout.isTTY===true,args:process.argv.slice(2),agentContext:['CODEX_THREAD_ID','CODEX_SANDBOX','CODEX_CI','CODEX_INTERNAL_ORIGINATOR_OVERRIDE'].some(key=>Object.hasOwn(process.env,key)),background:process.stdin.isTTY!==true||process.stdout.isTTY!==true||typeof process.send==='function'});
let db,invocationId,cancelled=false;
const cancel=()=>{cancelled=true;try{if(invocationId&&getRecord(db,'acceptance_authorization',DISCOVERY_CAPTURE_ID)?.claimInvocationId===invocationId)cancelAcceptance(db,now(),DISCOVERY_CAPTURE_ID,invocationId);}catch{console.log('CANCELLATION_PERSISTENCE_UNCONFIRMED. Bounded cleanup still applies; do not retry.');}};
try{
 const path=join(root,'data/elya.sqlite');if(!existsSync(path))throw Error('EXISTING_DATABASE_REQUIRED');db=new DatabaseSync(path);db.exec('PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000; PRAGMA synchronous=FULL;');
 process.on('SIGINT',cancel);process.on('SIGTERM',cancel);
 const result=await runDiscoveryEntry({db,root,runtime,now,startedAtMs,cancelled:()=>cancelled,onInvocation:id=>{invocationId=id;},emit:event=>console.log(JSON.stringify(event))});
 console.log(JSON.stringify(result,null,2));process.exitCode=result.exitCode;
}catch(error){console.log(JSON.stringify(recordDiscoveryOpenRefusal({root,error,startedAtMs,now,invocationId})));process.exitCode=2;}
finally{process.removeListener('SIGINT',cancel);process.removeListener('SIGTERM',cancel);db?.close();}
