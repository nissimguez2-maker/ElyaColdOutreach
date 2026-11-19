import { PairingSession,requireStopped } from './telegram-pairing.mjs';
import { validBotToken } from './telegram-api.mjs';
const safeErrors=new Set(['INVALID_TOKEN_FORMAT','TELEGRAM_AUTHENTICATION_FAILED','TELEGRAM_CONSUMER_CONFLICT','TELEGRAM_EXISTING_WEBHOOK','TELEGRAM_NETWORK_UNCERTAIN','TELEGRAM_INVALID_RESPONSE','TELEGRAM_INVALID_UPDATES','TELEGRAM_REQUEST_FAILED','TELEGRAM_DEADLINE_OR_METHOD','PAIRING_EXPIRED','INVALID_BOT_IDENTITY','WINDOWS_PROTECTION_FAILED','WINDOWS_PROTECTION_UNAVAILABLE','PROTECTED_STORAGE_EXISTS_OR_UNAVAILABLE','LOCAL_INPUT_TIMEOUT','LOCAL_CANCELLED','BUSINESS_MUST_REMAIN_STOPPED','LOCAL_PAIRING_REJECTED']);
export const safeSetupError=error=>safeErrors.has(error?.message)?error.message:'SETUP_STOPPED_UNRESOLVED';
export async function runTelegramSetup({db,ask,display,storeToken,makeApi,clock=Date.now}){
 const session=new PairingSession(db,clock);session.claim();let token,code,errorCode=null;
 try{
  token=await ask('Paste the dedicated bot token (masked; never paste it in chat):',{masked:true,ms:900000});
  code=session.startWindow();if(!validBotToken(token))throw Error('INVALID_TOKEN_FORMAT');
  const api=makeApi(token);
  const remaining=()=>{requireStopped(db);const r=session.remaining();if(r<=0)throw Error('PAIRING_EXPIRED');return r;};
  const identity=await api.identity(remaining());await api.checkWebhook(remaining());
  session.setBot(identity);await storeToken(token,remaining());token=null;
  display('bot',session.state().botUsername);display('code',code);code=null;
  while(remaining()>0){
   const updates=await api.poll(session.state().lastUpdateId+1,remaining());
   for(const update of updates){const candidate=session.consider(update);if(!candidate)continue;
    display('candidate',candidate);
    const answer=await ask(`Confirm locally by typing PAIR ${candidate.userId} ${candidate.chatId}, or anything else to stop:`,{ms:remaining()});
    if(answer!==`PAIR ${candidate.userId} ${candidate.chatId}`)throw Error('LOCAL_PAIRING_REJECTED');
    session.confirm(candidate.userId,candidate.chatId);
    await session.acknowledge((chatId,_text,ms)=>api.acknowledge(chatId,ms));return session.state();
   }
   // Rate bound also applies if the server returns empty/duplicate updates immediately.
   await new Promise(resolve=>setTimeout(resolve,Math.min(250,remaining())));
  }
 }catch(error){errorCode=safeSetupError(error);display('error',errorCode);}
 finally{token=null;code=null;session.stop();}
 return{...session.state(),errorCode};
}
