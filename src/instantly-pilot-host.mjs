// Local file handoff for the fixed direct-plugin controller. No provider client.
// Business payloads never pass through terminal display or stdin line parsing.
import {readFileSync,writeFileSync,existsSync} from 'node:fs';
import {join} from 'node:path';
import {setTimeout as sleep} from 'node:timers/promises';
import {canonical,digest,assertSafe} from './values.mjs';

export function savePilotEvidence(directory,name,value){
 assertSafe(value);
 const path=join(directory,name);
 if(existsSync(path))throw Error('LOCAL_EVIDENCE_ALREADY_EXISTS');
 writeFileSync(path,JSON.stringify(value,null,2)+'\n',{flag:'wx',flush:true});
 // Publish only after the complete bytes are closed/flushed. This avoids
 // Windows terminal wrapping and sandbox-sensitive rename semantics.
 writeFileSync(path+'.ready','',{flag:'wx',flush:true});
}
export function createPilotFileHandoff(directory){
 const cancellation=new AbortController();let pending=false;
 return Object.freeze({
  async invoke(call,{index,deadlineAt}){
   if(cancellation.signal.aborted)throw Error('LOCAL_HANDOFF_CLOSED');
   if(pending)throw Error('LOCAL_HANDOFF_OVERLAP');
   if(!Number.isInteger(index)||index<0||index>3||call?.server!=='codex_apps'||!['instantly_ai.get_campaign','instantly_ai.get_lead','instantly_ai.update_lead'].includes(call.tool))throw Error('LOCAL_HANDOFF_SCOPE_MISMATCH');
   const deadline=Date.parse(deadlineAt);
   if(!Number.isFinite(deadline)||Date.now()>=deadline)throw Error('LOCAL_HANDOFF_DEADLINE');
   const callHash=digest(canonical(call));pending=true;
   try{
    savePilotEvidence(directory,`request-${index}.json`,{index,call,callHash,deadlineAt});
    const responsePath=join(directory,`response-${index}.json`);
    while(!existsSync(responsePath+'.ready')){
     if(Date.now()>=deadline)throw Error('LOCAL_HANDOFF_DEADLINE');
     await sleep(Math.min(50,deadline-Date.now()),undefined,{signal:cancellation.signal});
    }
    if(cancellation.signal.aborted)throw Error('LOCAL_HANDOFF_CLOSED');
    if(Date.now()>=deadline)throw Error('LOCAL_HANDOFF_DEADLINE');
    const value=JSON.parse(readFileSync(responsePath,'utf8'));assertSafe(value);
    if(value.index!==index||value.callHash!==callHash||!Object.hasOwn(value,'response'))throw Error('LOCAL_RESULT_BINDING_MISMATCH');
    return value.response;
   }catch(e){if(cancellation.signal.aborted)throw Error('LOCAL_HANDOFF_CLOSED');throw e;}
   finally{pending=false;}
  },
  close(){cancellation.abort();},
 });
}
