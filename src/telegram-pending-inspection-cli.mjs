import {DatabaseSync} from 'node:sqlite';
import {performance} from 'node:perf_hooks';
import {readFileSync,writeFileSync,existsSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {resolve} from 'node:path';
import {digest} from './values.mjs';
import {readProtected} from './windows-protected-storage.mjs';
import {createTelegramWritingLiveApi} from './telegram-api.mjs';
import {runPendingInspection} from './telegram-pending-inspection.mjs';

const startedMono=performance.now(),startedWall=Date.now();
const root=fileURLToPath(new URL('../',import.meta.url)),dir=resolve(root,'work/telegram-pending-inspection-v1');
let db,syntheticDb;
try{
 if(process.argv.length!==2||!process.stdin.isTTY||!process.stdout.isTTY)throw Error('NORMAL_USER_TERMINAL_REQUIRED');
 if(existsSync(resolve(dir,'result.json')))throw Error('INSPECTION_ALREADY_ATTEMPTED');
 const approved=JSON.parse(readFileSync(resolve(dir,'approval.json'),'utf8'));
 for(const [file,expected]of Object.entries(approved.sourceFingerprints)){
  if(!/^src\/[a-z-]+\.mjs$/.test(file)||digest(readFileSync(resolve(root,file)))!==expected)throw Error('INSPECTION_SOURCE_CHANGED');
 }
 if(digest(readFileSync(resolve(root,'work/telegram-writing-live-v1/result.json')))!==approved.closedAttemptResultHash)throw Error('CLOSED_ATTEMPT_EVIDENCE_CHANGED');
 db=new DatabaseSync(resolve(root,'data/elya.sqlite'));db.exec('PRAGMA busy_timeout=100; PRAGMA synchronous=FULL;');
 syntheticDb=new DatabaseSync(resolve(root,'work/telegram-writing-live-v1/synthetic.sqlite'),{readOnly:true});
 console.log('One pending-update inspection: at most 3 API attempts, 30 seconds total; no commands, acknowledgments, messages or cursor changes.');
 const result=await runPendingInspection({db,syntheticDb,approved,startedMono,startedWall,loadToken:ms=>readProtected(resolve(root,'data/private/telegram-token.dpapi'),ms),makeApi:createTelegramWritingLiveApi});
 writeFileSync(resolve(dir,'result.json'),JSON.stringify(result,null,2),{flag:'wx',mode:0o600});
 console.log(JSON.stringify(result,null,2));if(result.status!=='COMPLETE')process.exitCode=1;
}catch(e){console.error(/^[A-Z][A-Z0-9_]{0,99}$/.test(e?.message??'')?e.message:'UNRESOLVED_LOCAL_FAILURE');process.exitCode=1;}
finally{syntheticDb?.close();db?.close();}
