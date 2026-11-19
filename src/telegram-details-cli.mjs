import {DatabaseSync} from 'node:sqlite';
import {performance} from 'node:perf_hooks';
import {existsSync,readFileSync,writeFileSync,openSync,closeSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {resolve} from 'node:path';
import {openStore,getRecord} from './store.mjs';
import {canonical,digest} from './values.mjs';
import {readProtected} from './windows-protected-storage.mjs';
import {createTelegramWritingLiveApi} from './telegram-api.mjs';
import {runDetailsProcedure,DETAILS_ID} from './telegram-details-procedure.mjs';
const startedMono=performance.now(),startedWall=Date.now();
const root=fileURLToPath(new URL('../',import.meta.url)),dir=resolve(root,'work/telegram-details-only-v1');
let db,s;
try{
 if(process.argv.length!==2||!process.stdin.isTTY||!process.stdout.isTTY)throw Error('NORMAL_USER_TERMINAL_REQUIRED');
 db=new DatabaseSync(resolve(root,'data/elya.sqlite'));db.exec('PRAGMA busy_timeout=100; PRAGMA synchronous=FULL;');
 const grant=getRecord(db,'telegram_details_authorization',DETAILS_ID);
 if(grant?.status!=='APPROVED')throw Error('FRESH_LIVE_APPROVAL_REQUIRED');
 const proposal=JSON.parse(readFileSync(resolve(dir,'proposal.json'),'utf8'));
 if(canonical(grant.approved)!==canonical(proposal))throw Error('APPROVED_PROPOSAL_MISMATCH');
 for(const [path,expected]of Object.entries(proposal.sourceFingerprints)){
  if(!/^src\/[a-z-]+\.mjs$/.test(path)||digest(readFileSync(resolve(root,path)))!==expected)throw Error('DETAILS_SOURCE_CHANGED');
 }
 const evidence=JSON.parse(readFileSync(resolve(root,'work/telegram-pending-inspection-v1/result.json'),'utf8'));
 const priorApproval=JSON.parse(readFileSync(resolve(root,'work/telegram-pending-inspection-v1/approval.json'),'utf8'));
 if(existsSync(resolve(dir,'synthetic.sqlite'))||existsSync(resolve(dir,'result.json')))throw Error('EXISTING_ATTEMPT_NO_REPLAY');
 closeSync(openSync(resolve(dir,'launch.claim'),'wx'));
 s=openStore(resolve(dir,'synthetic.sqlite'));s.exec('PRAGMA busy_timeout=100;');
 const result=await runDetailsProcedure({db,syntheticDb:s,evidence,priorApproval,startedMono,startedWall,loadToken:ms=>readProtected(resolve(root,'data/private/telegram-token.dpapi'),ms),makeApi:createTelegramWritingLiveApi,emit:event=>console.log(JSON.stringify(event))});
 writeFileSync(resolve(dir,'result.json'),JSON.stringify(result,null,2),{flag:'wx',mode:0o600});
 console.log(JSON.stringify(result,null,2));if(result.status!=='COMPLETE')process.exitCode=1;
}catch(e){console.error(/^[A-Z][A-Z0-9_]{0,99}$/.test(e?.message??'')?e.message:'UNRESOLVED_LOCAL_FAILURE');process.exitCode=1;}
finally{s?.close();db?.close();}
