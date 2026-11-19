import {existsSync,writeFileSync} from 'node:fs';import {fileURLToPath} from 'node:url';import {resolve} from 'node:path';import {performance} from 'node:perf_hooks';
import {openStore,controls,getRecord} from './store.mjs';
import {readProtected} from './windows-protected-storage.mjs';
import {createTelegramReviewApi} from './telegram-api.mjs';
import {runApprovedTelegramTest,verifyApprovedProposal,LIVE_TEST_ID} from './telegram-live-test.mjs';
const root=fileURLToPath(new URL('../',import.meta.url));let db;
try{
 const args=process.argv.slice(2);if(args.length>1||args.length===1&&!['--preflight','--status','--normal-user'].includes(args[0]))throw Error('INVALID_ARGUMENTS');
 if(args[0]==='--normal-user'&&!process.stdin.isTTY)throw Error('NORMAL_USER_TERMINAL_REQUIRED');
 const path=resolve(root,'data/elya.sqlite');if(!existsSync(path))throw Error('DATABASE_UNAVAILABLE');db=openStore(path);
 if(args[0]==='--status'){console.log(JSON.stringify({result:getRecord(db,'telegram_live_test',LIVE_TEST_ID),controls:controls(db)},null,2));}
 else if(args[0]==='--preflight'){console.log(JSON.stringify({approvedHashesVerified:verifyApprovedProposal(db),existingAttempt:!!getRecord(db,'telegram_live_test',LIVE_TEST_ID),controls:controls(db)},null,2));}
 else{
  console.log('Single five-minute synthetic Telegram test. No setup/pairing repeat. Watch the existing private bot chat. Only the two approved packets may be sent.');
  const wall=Date.now(),mono=performance.now();
  const result=await runApprovedTelegramTest({db,manualNormalUserHandoff:args[0]==='--normal-user',clock:()=>Math.floor(wall+performance.now()-mono),loadToken:ms=>readProtected(resolve(root,'data/private/telegram-token.dpapi'),ms),makeApi:createTelegramReviewApi,emit:event=>console.log(JSON.stringify(event))});
  writeFileSync(resolve(root,'work/telegram-live-test-result.json'),JSON.stringify(result,null,2));
  console.log(JSON.stringify({messages:result.messages,commands:result.commands,terminalReason:result.terminalReason,polling:result.polling,checkOutcomes:result.checkOutcomes,allowanceAtStartMs:result.allowanceAtStartMs,revisionInvalidationPassed:result.revisionInvalidationPassed,staleRejectionPassed:result.staleRejectionPassed,stopEndedPolling:result.stopEndedPolling,finalControls:result.finalControls,status:result.status},null,2));
  if(result.status!=='COMPLETED')process.exitCode=1;
 }
}catch(error){
 const permitted=new Set(['LOCAL_CREDENTIAL_UNAVAILABLE_USE_NORMAL_USER_TERMINAL','EXISTING_LIVE_TEST_NO_AUTOMATIC_RETRY','EXISTING_SYNTHETIC_STATE_REQUIRES_REVIEW','APPROVED_PROPOSAL_MISMATCH','PAIRING_MISMATCH','BUSINESS_MUST_REMAIN_STOPPED','INVALID_ARGUMENTS','DATABASE_UNAVAILABLE','NORMAL_USER_TERMINAL_REQUIRED','HANDOFF_NOT_ALLOWED']);
 const code=permitted.has(error?.message)?error.message:'UNRESOLVED_LOCAL_FAILURE';
 console.error(code);writeFileSync(resolve(root,'work/telegram-live-preflight-result.json'),JSON.stringify({recordedAt:new Date().toISOString(),errorCode:code,existingAttempt:db?!!getRecord(db,'telegram_live_test',LIVE_TEST_ID):null},null,2));process.exitCode=1;
}finally{db?.close();}
