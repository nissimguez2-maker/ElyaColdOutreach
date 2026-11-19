// Exact normal-user, one-use entry. Importing shared modules performs no network work.
import {DatabaseSync} from 'node:sqlite';
import {readFileSync,writeFileSync,existsSync,mkdirSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {join} from 'node:path';
import {performance} from 'node:perf_hooks';
import {openStore,getRecord} from './store.mjs';
import {CONTINUATION_ID,validateContinuationManifest} from './acceptance-continuation-contract.mjs';
import {cancelAcceptance,closeAcceptance} from './acceptance-authority.mjs';
import {runAcceptanceSequence,acceptanceErrorCode} from './acceptance-controller.mjs';
import {runAcceptanceContinuationTelegram} from './acceptance-continuation-telegram.mjs';
import {runAcceptanceInstantly} from './acceptance-instantly.mjs';
import {createTelegramConsumerApi} from './telegram-api.mjs';
import {readProtected} from './windows-protected-storage.mjs';
import {formatAcceptanceEvent} from './acceptance-guidance.mjs';

const root=fileURLToPath(new URL('../',import.meta.url));
const directory=join(root,'work/acceptance-continuation-v1/live-once');
const startedAtMs=Math.floor(performance.timeOrigin),now=()=>startedAtMs+Math.floor(performance.now());
let db,syntheticDb,cancelled=false;
const cancel=()=>{
 cancelled=true;
 try{const saved=db&&cancelAcceptance(db,now(),CONTINUATION_ID);console.log(saved?'Cancellation saved. No next dispatch; waiting for bounded cleanup. Accepted external actions cannot be recalled.':'Cancellation requested before launch.');}
 catch{console.log('CANCELLATION_PERSISTENCE_UNCONFIRMED. No later stage will start; waiting for bounded cleanup.');}
};
function emit(event){console.log(typeof event==='string'?event:formatAcceptanceEvent(event)??JSON.stringify(event));}

try{
 if(process.argv.slice(2).join(' ')!=='--run-once')throw Error('USE_RUN_ONCE_ARGUMENT_ONLY');
 if(process.platform!=='win32'||!process.stdin.isTTY||!process.stdout.isTTY)throw Error('NORMAL_USER_INTERACTIVE_POWERSHELL_REQUIRED');
 const dbPath=join(root,'data/elya.sqlite');if(!existsSync(dbPath))throw Error('EXISTING_DATABASE_REQUIRED');
 db=new DatabaseSync(dbPath);db.exec('PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000; PRAGMA synchronous=FULL;');
 if(getRecord(db,'acceptance_authorization',CONTINUATION_ID)?.status!=='APPROVED')throw Error('FRESH_APPROVED_ONE_USE_AUTHORIZATION_REQUIRED');
 const manifest=validateContinuationManifest(JSON.parse(readFileSync(join(root,'work/acceptance-continuation-v1/manifest.json'),'utf8')));
 process.on('SIGINT',cancel);process.on('SIGTERM',cancel);
 console.log('Starting ONE approved continuation: Telegram 240 seconds / API cutoff 230 seconds / 20 requests; then at most 7 exact Instantly QA calls in two contained launches. Follow only the current NEXT ACTION. No business launch or sending.');
 const result=await runAcceptanceSequence({db,manifest,root,startedAtMs,startedMono:0,now,cancelled:()=>cancelled,emit,
  telegram:options=>{
   // Directory/setup failures occur after the one-use claim and therefore close it.
   if(existsSync(directory))throw Error('CONTINUATION_DIRECTORY_EXISTS_NO_SECOND_ATTEMPT');
   mkdirSync(directory);syntheticDb=openStore(join(directory,'synthetic.sqlite'));
   return runAcceptanceContinuationTelegram({...options,db,syntheticDb,manifest,
    loadToken:ms=>readProtected(join(root,'data/private/telegram-token.dpapi'),ms),makeApi:createTelegramConsumerApi});
  },
  instantly:options=>runAcceptanceInstantly({...options,db,manifest,directory,startedMono:0,startedWall:startedAtMs}),
 });
 const resultPath=existsSync(directory)?join(directory,'result.json'):join(root,'work/acceptance-continuation-v1/blocked-before-runtime.json');
 writeFileSync(resultPath,JSON.stringify(result,null,2),{flag:'wx'});console.log(JSON.stringify(result,null,2));process.exitCode=result.status==='PASS'?0:2;
}catch(error){
 if(db&&getRecord(db,'acceptance_authorization',CONTINUATION_ID)?.status==='APPROVED')closeAcceptance(db,{id:CONTINUATION_ID,status:'BLOCKED',reason:acceptanceErrorCode(error),notLaunched:true,liveCalls:0},now());
 console.log(JSON.stringify({id:CONTINUATION_ID,status:'BLOCKED',reason:acceptanceErrorCode(error),authorizationStatus:db?getRecord(db,'acceptance_authorization',CONTINUATION_ID)?.status??'MISSING':'NOT_OPENED',noAutomaticRetry:true,evidenceDirectory:directory}));process.exitCode=2;
}finally{
 process.removeListener('SIGINT',cancel);process.removeListener('SIGTERM',cancel);syntheticDb?.close();db?.close();
}
