import {CAPS,DEADLINES} from './telegram-writing-live-card.mjs';
export class WritingRequestBudget{
 #clock;#record;#start;#stopped=false;#counts=Object.fromEntries(Object.keys(CAPS).filter(k=>k!=='total').map(k=>[k,0]));
 constructor({clock,record,startedAt=clock()}){this.#clock=clock;this.#record=record;this.#start=startedAt;}
 snapshot(){return {attempts:Object.values(this.#counts).reduce((a,b)=>a+b,0),counts:{...this.#counts},elapsedMs:Math.max(0,Math.floor(this.#clock()-this.#start)),stopped:this.#stopped};}
 remaining(){return Math.floor(DEADLINES.apiMs-(this.#clock()-this.#start));}
 check(){if(this.#stopped)throw Error('TEST_COMMUNICATION_STOPPED');if(this.remaining()<=0)throw Error('API_DEADLINE');}
 requireAction(action){
  this.check();const details=action==='DETAILS',needed=details?2:1;
  if(this.#counts.acknowledgments>=CAPS.acknowledgments||details&&this.#counts.detailsMessages>=CAPS.detailsMessages||this.snapshot().attempts+needed>CAPS.total)throw Error('ACTION_REQUEST_BUDGET_EXHAUSTED');
  if(this.remaining()<needed*5000)throw Error('INSUFFICIENT_ACTION_TIME');
 }
 take(kind,{stopPhase=false}={}){
  this.check();if(!Object.hasOwn(this.#counts,kind))throw Error('UNAUTHORIZED_REQUEST_KIND');
  if(this.snapshot().attempts>=CAPS.total||this.#counts[kind]>=CAPS[kind])throw Error('REQUEST_BUDGET_EXHAUSTED');
  if(kind==='polls'&&!stopPhase&&this.#counts.polls>=CAPS.polls-1)throw Error('STOP_POLL_RESERVED');
  const remaining=this.remaining();if(remaining<(kind==='polls'?2000:5000))throw Error('INSUFFICIENT_REQUEST_TIME');
  // Disjoint hard buckets reserve all ACK/details slots; polling cannot borrow them.
  this.#counts[kind]++;this.#record(this.snapshot(),kind);
  this.check();return Math.min(kind==='polls'?12000:5000,this.remaining());
 }
 stop(){this.#stopped=true;}
}
