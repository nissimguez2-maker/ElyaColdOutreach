import {existsSync,mkdirSync,openSync,closeSync,writeFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {resolve} from 'node:path';
import {openStore,getRecord,controls} from './store.mjs';
import {createLocalPrompt} from './telegram-local.mjs';
import {readProtected} from './windows-protected-storage.mjs';
import {createTelegramWritingLiveApi} from './telegram-api.mjs';
import {TEST_ID,seedSyntheticWritingCard,makeWritingTestContract,cardHash} from './telegram-writing-live-card.mjs';
import {armWritingTest,inspectTelegramCursor,assertNoActiveTelegramConsumer,recoverWritingTest} from './telegram-writing-authority.mjs';
import {runWritingLiveTest} from './telegram-writing-live.mjs';
import {requireStopped} from './telegram-pairing.mjs';

const root=fileURLToPath(new URL('../',import.meta.url)),dir=resolve(root,'work/telegram-writing-live-v1'),syntheticPath=resolve(dir,'synthetic.sqlite');
let db,syntheticDb;
try{
 const args=process.argv.slice(2);if(args.length!==1||!['--status','--arm','--run','--recover'].includes(args[0]))throw Error('USE_STATUS_ARM_RUN_OR_RECOVER');
 if(args[0]!=='--status'&&(!process.stdin.isTTY||!process.stdout.isTTY))throw Error('NORMAL_USER_TERMINAL_REQUIRED');
 db=openStore(resolve(root,'data/elya.sqlite'));const grant=getRecord(db,'telegram_writing_authorization',TEST_ID);
 if(args[0]==='--status')console.log(JSON.stringify({testId:TEST_ID,authorization:grant?.status??'ABSENT',controls:controls(db),liveStarted:false}));
 if(args[0]==='--arm'){
  requireStopped(db);assertNoActiveTelegramConsumer(db);inspectTelegramCursor(db);
  if(grant||existsSync(syntheticPath))throw Error('EXISTING_ATTEMPT_REQUIRES_RECONCILIATION');
  const paired=getRecord(db,'telegram_binding','primary');if(!paired?.confirmed)throw Error('PAIRING_REQUIRED');
  console.log(`LOCAL ARMING ONLY — ${TEST_ID}\nCard: ${cardHash()}\nPrivate destination: user/chat ending ${String(paired.chatId).slice(-5)}\nOne future run: 180 seconds, API cutoff 170 seconds, 24 requests, 5 messages maximum.\nNo Telegram connection or live timer starts in this step. Run only after fresh approval.`);
  const answer=await createLocalPrompt()(`Type ARM ${TEST_ID} to record the approved one-use test authorization:`,{ms:300000});
  if(answer!==`ARM ${TEST_ID}`)throw Error('LOCAL_ARMING_CANCELLED');
  mkdirSync(dir,{recursive:true});closeSync(openSync(syntheticPath,'wx'));syntheticDb=openStore(syntheticPath);
  const at=new Date().toISOString(),packet=seedSyntheticWritingCard(syntheticDb,paired,at),contract=makeWritingTestContract(packet,paired);
  armWritingTest(db,contract,at);console.log(JSON.stringify({testId:TEST_ID,status:'ARMED_NOT_RUNNING',packetHash:packet.hash,packetPreparedAt:at,liveCalls:0}));
 }
 if(args[0]==='--recover'){
  const recovered=recoverWritingTest(db,TEST_ID,new Date().toISOString());console.log(JSON.stringify({status:recovered.status,reason:recovered.reason,replayAllowed:false}));
 }
 if(args[0]==='--run'){
  if(grant?.status!=='ARMED')throw Error(grant?.status==='CLAIMED'?'INTERRUPTED_RUN_REQUIRES_LOCAL_RECOVERY':'ONE_USE_AUTHORIZATION_NOT_ARMED');
  if(!existsSync(syntheticPath))throw Error('PREPARED_SYNTHETIC_DATABASE_MISSING');
  syntheticDb=openStore(syntheticPath);let cancelled=false;
  const cancel=()=>{cancelled=true;};process.once('SIGINT',cancel);process.once('SIGTERM',cancel);
  const watchdog=setTimeout(cancel,180000);
  try{
   console.log('Starting the one-use SYNTHETIC QA card. Watch the existing paired private bot chat. No business launch is authorized.');
   const result=await runWritingLiveTest({db,syntheticDb,contract:grant.contract,loadToken:ms=>readProtected(resolve(root,'data/private/telegram-token.dpapi'),ms),makeApi:createTelegramWritingLiveApi,cancelled:()=>cancelled,emit:event=>console.log(JSON.stringify(event))});
   writeFileSync(resolve(dir,'result.json'),JSON.stringify(result,null,2),{flag:'wx'});
   console.log(JSON.stringify(result,null,2));if(result.status!=='COMPLETED')process.exitCode=1;
  }finally{clearTimeout(watchdog);process.removeListener('SIGINT',cancel);process.removeListener('SIGTERM',cancel);}
 }
}catch(error){console.error(/^[A-Z][A-Z0-9_]{0,99}$/.test(error?.message??'')?error.message:'UNRESOLVED_LOCAL_FAILURE');process.exitCode=1;}
finally{syntheticDb?.close();db?.close();}
