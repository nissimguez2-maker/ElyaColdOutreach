import { existsSync } from 'node:fs';import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';import { performance } from 'node:perf_hooks';
import { openStore,controls,getRecord,putRecord } from './store.mjs';
import { createLocalPrompt } from './telegram-local.mjs';
import { createTelegramApi } from './telegram-api.mjs';
import { storeProtected } from './windows-protected-storage.mjs';
import { runTelegramSetup,safeSetupError } from './telegram-setup-flow.mjs';
import { PAIRING_ID } from './telegram-pairing.mjs';
const root=fileURLToPath(new URL('../',import.meta.url));let db;
try{
 if(process.argv.length!==2||process.platform!=='win32')throw Error('SETUP_STOPPED_UNRESOLVED');
 const ask=createLocalPrompt(); // Never accept a token from redirected stdin or chat tooling.
 const path=resolve(root,'data/elya.sqlite');if(!existsSync(path))throw Error('SETUP_STOPPED_UNRESOLVED');db=openStore(path);
 if(getRecord(db,'telegram_pairing',PAIRING_ID))throw Error('EXISTING_PAIRING_ATTEMPT_REQUIRES_REVIEW');
 console.log('Dedicated Telegram bot setup — one private pairing test only.\nIf needed: open the verified @BotFather in Telegram, send /newbot, and create a dedicated bot. Keep its token private.\nDo not run this on a shared bot or alongside another polling process. No business data will be sent.\nThe five-minute window starts after token entry. Ctrl+C cancels; restarting never resends an acknowledgment.');
 const wall=Date.now(),mono=performance.now();
 const result=await runTelegramSetup({db,ask,clock:()=>Math.floor(wall+performance.now()-mono),
  storeToken:(value,ms)=>storeProtected(resolve(root,'data/private/telegram-token.dpapi'),value,ms),makeApi:createTelegramApi,
  display:(kind,value)=>{
   if(kind==='bot')console.log(`Verified bot: @${value}. Open its PRIVATE chat in Telegram.`);
   if(kind==='code')console.log(`Send this one-use code as a plain message to that bot now:\n${value}`);
   if(kind==='candidate')console.log(`Candidate: user ID ${value.userId}; private chat ID ${value.chatId}; displayed name ${value.displayName}; username ${value.username||'(none)'}. Verify these are yours.`);
   if(kind==='error')console.log(`Stopped: ${value}. No automatic retry.`);
  }});
 putRecord(db,'telegram_setup_result','latest',{stage:result.stage,errorCode:result.errorCode??null,finishedAt:new Date().toISOString(),pairingProcessStopped:true,controls:controls(db)},'confirmed');
 console.log(`Setup process stopped. Result: ${result.stage}. Business stopped: ${controls(db).stopped}; launch authorized: ${controls(db).launchAuthorized}.`);
 if(result.stage!=='ACK_CONFIRMED')process.exitCode=1;
}catch(error){console.error(error?.message==='EXISTING_PAIRING_ATTEMPT_REQUIRES_REVIEW'?'Existing setup attempt: stopped without polling or sending. Ask for review before another attempt.':safeSetupError(error));process.exitCode=1;}finally{db?.close();}
