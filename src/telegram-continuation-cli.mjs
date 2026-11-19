import {existsSync,writeFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {resolve} from 'node:path';
import {performance} from 'node:perf_hooks';
import {DatabaseSync} from 'node:sqlite';
import {openStore,controls,getRecord} from './store.mjs';
import {readProtected} from './windows-protected-storage.mjs';
import {createTelegramContinuationApi} from './telegram-api.mjs';
import {runApprovedTelegramContinuation} from './telegram-live-test.mjs';
import {CONTINUATION_ID,validateContinuation} from './telegram-continuation.mjs';

const root=fileURLToPath(new URL('../',import.meta.url));let db;
try{
 const args=process.argv.slice(2);
 if(args.length>1||(args.length===1&&!['--preflight','--status'].includes(args[0])))throw Error('INVALID_ARGUMENTS');
 // Only the human's normal local terminal may start the live continuation.
 if(args.length===0&&(process.platform!=='win32'||!process.stdin.isTTY))throw Error('NORMAL_USER_TERMINAL_REQUIRED');
 const path=resolve(root,'data/elya.sqlite');if(!existsSync(path))throw Error('DATABASE_UNAVAILABLE');db=args.length?new DatabaseSync(path,{readOnly:true}):openStore(path);
 if(args[0]==='--status'){
  console.log(JSON.stringify({result:getRecord(db,'telegram_live_test',CONTINUATION_ID),controls:controls(db)},null,2));
 }else if(args[0]==='--preflight'){
  console.log(JSON.stringify({preflight:validateContinuation(db,new Date().toISOString()),controls:controls(db),liveStarted:false},null,2));
 }else{
  console.log('Three-minute synthetic continuation. Delivered version 1 (message 4) will not be resent. At most the approved version-2 packet can be sent. Wait for READY before sending a command.');
  const wall=Date.now(),mono=performance.now();
  const result=await runApprovedTelegramContinuation({db,clock:()=>Math.floor(wall+performance.now()-mono),loadToken:ms=>readProtected(resolve(root,'data/private/telegram-token.dpapi'),ms),makeApi:createTelegramContinuationApi,emit:event=>{
   if(event.event==='ready')console.log(`READY — send ${event.command} now in the paired private Telegram chat. Remaining: ${Math.floor(event.remainingMs/1000)} seconds.`);
   else if(event.event==='message')console.log('Version 2: API_CONFIRMED. After it arrives, send /approve qa-tg-01-v1-cont1 again.');
   else if(event.event==='command'){
    console.log(JSON.stringify(event));
    if(event.outcome==='STALE_REVIEW')console.log('Stale approval rejected. Now send /reject qa-tg-01-v2.');
    else if(event.outcome==='REJECTED')console.log('Version 2 rejected. Now send /stop.');
   }else console.log(JSON.stringify(event));
  }});
  writeFileSync(resolve(root,'work/telegram-continuation-result.json'),JSON.stringify(result,null,2));
  console.log(JSON.stringify({status:result.status,messages:result.messages,commands:result.commands,terminalReason:result.terminalReason,checkOutcomes:result.checkOutcomes,startedAt:result.startedAt,finishedAt:result.finishedAt,pollingEnded:result.pollingEnded,finalControls:result.finalControls},null,2));
  if(result.status!=='COMPLETED')process.exitCode=1;
 }
}catch(error){
 const permitted=new Set(['LOCAL_CREDENTIAL_UNAVAILABLE_USE_NORMAL_USER_TERMINAL','CONTINUATION_ALREADY_CLAIMED_OR_STATE_CHANGED','CONTINUATION_DELIVERY_EVIDENCE_MISMATCH','CONTINUATION_REVIEW_OR_BATCH_MISMATCH','CONTINUATION_SOURCE_CHANGED','CONTINUATION_DEADLINE','APPROVED_PROPOSAL_MISMATCH','PAIRING_MISMATCH','BUSINESS_MUST_REMAIN_STOPPED','INVALID_ARGUMENTS','DATABASE_UNAVAILABLE','NORMAL_USER_TERMINAL_REQUIRED']);
 const code=permitted.has(error?.message)?error.message:'UNRESOLVED_LOCAL_FAILURE';
 console.error(code);process.exitCode=1;
}finally{db?.close();}
