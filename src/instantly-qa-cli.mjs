// Fixed ordinary-user, run-once entry. No Telegram import or credential access.
import {DatabaseSync} from 'node:sqlite';
import {existsSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {join} from 'node:path';
import {performance} from 'node:perf_hooks';
import {INSTANTLY_QA_ID} from './instantly-qa-contract.mjs';
import {cancelAcceptance} from './acceptance-authority.mjs';
import {acceptanceErrorCode} from './acceptance-controller.mjs';
import {runInstantlyQaCommand} from './instantly-qa-command.mjs';

const root=fileURLToPath(new URL('../',import.meta.url));
const startedAtMs=Math.floor(performance.timeOrigin),now=()=>startedAtMs+Math.floor(performance.now());
let db,cancelled=false;
const cancel=()=>{
 cancelled=true;
 try{cancelAcceptance(db,now(),INSTANTLY_QA_ID);console.log('Cancellation recorded. No next dispatch; waiting for bounded cleanup. Accepted external actions cannot be recalled.');}
 catch{console.log('CANCELLATION_PERSISTENCE_UNCONFIRMED. Waiting for bounded cleanup; do not retry.');}
};
try{
 const path=join(root,'data/elya.sqlite');if(!existsSync(path))throw Error('EXISTING_DATABASE_REQUIRED');
 db=new DatabaseSync(path);db.exec('PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000; PRAGMA synchronous=FULL;');
 process.on('SIGINT',cancel);process.on('SIGTERM',cancel);
 console.log('ONE Instantly-only acceptance: 150 seconds total; two contained launches, each 60 seconds / readiness 20 / provider cutoff 40 / 10 status requests. At most seven exact business calls and one approved write. No Telegram, activation or sending.');
 const result=await runInstantlyQaCommand({db,root,now,startedAtMs,startedMono:0,cancelled:()=>cancelled,emit:event=>console.log(typeof event==='string'?event:JSON.stringify(event)),entryCheck:()=>{
  if(process.argv.slice(2).join(' ')!=='--run-once')throw Error('USE_RUN_ONCE_ARGUMENT_ONLY');
  if(process.platform!=='win32'||!process.stdin.isTTY||!process.stdout.isTTY)throw Error('NORMAL_USER_INTERACTIVE_POWERSHELL_REQUIRED');
 }});
 console.log(JSON.stringify(result,null,2));process.exitCode=result.status==='PASS'&&!result.localReportError&&!result.attemptEvidenceError?0:2;
}catch(error){
 console.log(JSON.stringify({id:INSTANTLY_QA_ID,status:'BLOCKED',reason:acceptanceErrorCode(error),firstFailingStage:'LOCAL_CLI_PREFLIGHT',noAutomaticRetry:true}));process.exitCode=2;
}finally{process.removeListener('SIGINT',cancel);process.removeListener('SIGTERM',cancel);db?.close();}
