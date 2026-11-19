import { randomBytes, timingSafeEqual, createHash } from 'node:crypto';
import { controls, getRecord, putRecord, transaction, journal } from './store.mjs';
import {assertNoActiveTelegramConsumer} from './telegram-writing-authority.mjs';

export const ACK_TEXT='Pairing test successful. This bot is connected for testing only. The business workflow remains stopped. No campaigns, provider jobs, or outreach have been launched.';
export const PAIRING_ID='private-setup-01';
const hash=s=>createHash('sha256').update(s).digest();
export const numericId=v=>Number.isSafeInteger(v)&&v>0;
export function requireStopped(db){const c=controls(db);if(!c.stopped||c.launchAuthorized)throw Error('BUSINESS_MUST_REMAIN_STOPPED');}
export function isPairedSender(db,message){const b=getRecord(db,'telegram_binding','primary');return !!(b?.confirmed&&message?.chat?.type==='private'&&message?.from?.is_bot===false&&message.from.id===b.userId&&message.chat.id===b.chatId);}
export function localDisplay(value){return typeof value==='string'?value.replace(/https?:\/\/\S+|\b\d{6,12}:[\w-]{20,}/g,'[redacted]').replace(/[^\p{L}\p{N} ._@'-]/gu,'').slice(0,80):'';}

/** Local trusted setup authority only; never accepts approval actions from Telegram. */
export class PairingSession {
 #db; #clock; #nonce=null; #candidate=null; #claimed=false;
 constructor(db,clock=Date.now){this.#db=db;this.#clock=clock;}
 state(){return getRecord(this.#db,'telegram_pairing',PAIRING_ID);}
 #save(state,event){putRecord(this.#db,'telegram_pairing',PAIRING_ID,state,'configuration');journal(this.#db,event,PAIRING_ID,{stage:state.stage});}
 claim(){transaction(this.#db,()=>{requireStopped(this.#db);if(this.state()||getRecord(this.#db,'telegram_binding','primary'))throw Error('EXISTING_PAIRING_ATTEMPT_REQUIRES_REVIEW');assertNoActiveTelegramConsumer(this.#db);this.#save({stage:'TOKEN_ENTRY',claimedAt:this.#clock(),lastUpdateId:-1,ackAttempts:0},'TELEGRAM_SETUP_CLAIMED');});this.#claimed=true;}
 startWindow(){if(!this.#claimed||this.state()?.stage!=='TOKEN_ENTRY')throw Error('INVALID_PAIRING_STAGE');this.#nonce=randomBytes(16).toString('base64url');const now=this.#clock();transaction(this.#db,()=>this.#save({...this.state(),stage:'IDENTITY_CHECK',enteredAt:now,deadline:now+300000},'TELEGRAM_WINDOW_STARTED'));return this.#nonce;}
 remaining(){const s=this.state();return s?.deadline?Math.max(0,s.deadline-this.#clock()):0;}
 #active(stage){requireStopped(this.#db);if(!this.#claimed||this.state()?.stage!==stage)throw Error('INVALID_PAIRING_STAGE');if(this.remaining()<=0)throw Error('PAIRING_EXPIRED');}
 setBot(bot){this.#active('IDENTITY_CHECK');if(!numericId(bot?.id)||bot.is_bot!==true||typeof bot.username!=='string'||!/^\w{5,32}$/.test(bot.username))throw Error('INVALID_BOT_IDENTITY');transaction(this.#db,()=>this.#save({...this.state(),stage:'POLLING',botId:bot.id,botUsername:bot.username},'TELEGRAM_IDENTITY_VERIFIED'));}
 consider(update){
  if(!this.#claimed||this.state()?.stage!=='POLLING'||this.remaining()<=0)return null;requireStopped(this.#db);
  const s=this.state();if(!Number.isSafeInteger(update?.update_id)||update.update_id<0||update.update_id<=s.lastUpdateId)return null;
  transaction(this.#db,()=>this.#save({...this.state(),lastUpdateId:update.update_id},'TELEGRAM_UPDATE_SEEN'));
  const m=update.message;
  if(m?.chat?.type!=='private'||!numericId(m.from?.id)||m.from.is_bot!==false||m.chat.id!==m.from.id||typeof m.text!=='string'||m.text.length>100||!Number.isSafeInteger(m.date)||m.date<Math.floor(s.enteredAt/1000))return null;
  if(!this.#nonce||!timingSafeEqual(hash(m.text),hash(this.#nonce)))return null;
  this.#nonce=null;
  this.#candidate={userId:m.from.id,chatId:m.chat.id,displayName:localDisplay(m.from.first_name)+' '+localDisplay(m.from.last_name),username:localDisplay(m.from.username)};
  transaction(this.#db,()=>this.#save({...this.state(),stage:'AWAITING_LOCAL_CONFIRMATION'},'TELEGRAM_CODE_CONSUMED'));
  return {...this.#candidate};
 }
 confirm(userId,chatId){
  transaction(this.#db,()=>{this.#active('AWAITING_LOCAL_CONFIRMATION');if(!this.#candidate||userId!==this.#candidate.userId||chatId!==this.#candidate.chatId)throw Error('PAIRING_CONFIRMATION_MISMATCH');
   putRecord(this.#db,'telegram_binding','primary',{confirmed:true,testOnly:true,userId,chatId,botId:this.state().botId,credentialRef:'data/private/telegram-token.dpapi',confirmedAt:this.#clock()},'configuration');
   this.#save({...this.state(),stage:'PAIRED'},'TELEGRAM_PRIVATE_PAIRING_CONFIRMED');});
 }
 async acknowledge(send){
  let binding;transaction(this.#db,()=>{this.#active('PAIRED');binding=getRecord(this.#db,'telegram_binding','primary');if(!binding?.confirmed||this.state().ackAttempts!==0)throw Error('ACK_ALREADY_ATTEMPTED');this.#save({...this.state(),stage:'ACK_DISPATCHING',ackAttempts:1},'TELEGRAM_ACK_INTENT');});
  let stage='ACK_UNCERTAIN',messageId=null;
  try{const result=await send(binding.chatId,ACK_TEXT,this.remaining());if(numericId(result?.message_id)&&result.chat?.type==='private'&&result.chat.id===binding.chatId&&result.from?.id===binding.botId&&result.from.is_bot===true&&result.text===ACK_TEXT){stage='ACK_CONFIRMED';messageId=result.message_id;}}catch{/* Deliberately discard raw error/URL; intent remains non-retryable. */}
  transaction(this.#db,()=>this.#save({...this.state(),stage,messageId,finishedAt:this.#clock()},'TELEGRAM_ACK_OUTCOME'));return stage;
 }
 stop(){if(!this.#claimed)return;this.#nonce=null;this.#candidate=null;transaction(this.#db,()=>{const s=this.state();if(s.stage==='ACK_DISPATCHING')this.#save({...s,stage:'ACK_UNCERTAIN',finishedAt:this.#clock()},'TELEGRAM_INTERRUPTED');else if(!['ACK_CONFIRMED','ACK_UNCERTAIN','STOPPED'].includes(s.stage))this.#save({...s,stage:'STOPPED',finishedAt:this.#clock()},'TELEGRAM_SETUP_STOPPED');});}
}
