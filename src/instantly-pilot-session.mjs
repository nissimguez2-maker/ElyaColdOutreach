// Fixed pilot controllers over the existing approval/journal machinery.
// It supplies no network transport and cannot activate a campaign.
import {readFileSync} from 'node:fs';
import {join} from 'node:path';
import {canonical,digest,assertSafe,required} from './values.mjs';
import {getRecord,putRecord,transaction,journal,controls} from './store.mjs';
import {claimAcceptance,assertAcceptance,closeAcceptance,verifyAcceptanceSources} from './acceptance-authority.mjs';
import {decodeInstantlyAcceptanceResult} from './acceptance-instantly.mjs';
import {isInactiveLeadCopyId,validateInactiveSetupManifest,validateInactiveLeadCopyManifest} from './instantly-pilot-scope.mjs';

const hash=v=>digest(canonical(v)),clone=v=>JSON.parse(canonical(v));
const object=v=>v!==null&&typeof v==='object'&&!Array.isArray(v);
const same=(a,b)=>canonical(a)===canonical(b);
const reason=e=>/^[A-Z][A-Z0-9_]+$/.test(e?.message??'')?e.message:'INACTIVE_SETUP_VALIDATION_FAILED';
const isWrite=c=>c.tool==='instantly_ai.update_campaign'||c.tool==='instantly_ai.update_lead';
const withoutTimestamp=v=>{const copy=clone(v);delete copy.timestamp_updated;return copy;};
function leadIdentity(v,m){
 const t=m.targets;
 if(v.id!==t.leadId||v.campaign!==t.campaignId||v.email!==t.recipient||!object(v.payload))throw Error('INACTIVE_SETUP_LEAD_IDENTITY_MISMATCH');
 if(v.payload.email!==undefined&&v.payload.email!==t.recipient||v.payload.campaign!==undefined&&v.payload.campaign!==t.campaignId)throw Error('INACTIVE_SETUP_LEAD_IDENTITY_CONFLICT');
 if(v.custom_variables!==undefined){
  if(!object(v.custom_variables))throw Error('INACTIVE_SETUP_LEAD_VARIABLE_CONFLICT');
  for(const k of Object.keys(v.custom_variables))if(Object.hasOwn(v.payload,k)&&!same(v.custom_variables[k],v.payload[k]))throw Error('INACTIVE_SETUP_LEAD_VARIABLE_CONFLICT');
 }
}
function preservedLead(v,m){
 const out=withoutTimestamp(v);
 for(const key of Object.keys(m.calls.find(c=>c.tool==='instantly_ai.update_lead').arguments.custom_variables)){delete out.payload[key];if(object(out.custom_variables))delete out.custom_variables[key];}
 return out;
}
function checkCampaignBefore(v,baseline,m){
 if(v.id!==m.targets.campaignId||v.status!==0)throw Error('INACTIVE_SETUP_CAMPAIGN_NOT_EXACT_INACTIVE_TARGET');
 for(const k of ['id','name','status','email_list','sequences','custom_variables','open_tracking'])if(!same(v[k],baseline[k]))throw Error('INACTIVE_SETUP_CAMPAIGN_BASELINE_CHANGED');
 if(!same(v.campaign_schedule?.schedules,baseline.campaign_schedule.schedules))throw Error('INACTIVE_SETUP_CAMPAIGN_BASELINE_CHANGED');
 if(![undefined,null].includes(v.campaign_schedule.end_date)||![undefined,null,'2026-11-18'].includes(v.campaign_schedule.start_date))throw Error('INACTIVE_SETUP_CAMPAIGN_CALENDAR_CHANGED');
 // These settings are directly visible in the supplied, dated UI evidence.
 for(const [k,expected]of Object.entries({daily_limit:30,stop_on_reply:true,link_tracking:false,text_only:false}))if(Object.hasOwn(v,k)&&v[k]!==expected)throw Error('INACTIVE_SETUP_CAMPAIGN_BASELINE_CHANGED');
}
function sequenceProjection(value){
 if(!Array.isArray(value)||value.length!==1||!object(value[0])||Object.keys(value[0]).some(k=>k!=='steps'))throw Error('INACTIVE_SETUP_CAMPAIGN_READBACK_MISMATCH');
 const steps=value[0].steps;
 if(!Array.isArray(steps)||steps.length!==1||!object(steps[0]))throw Error('INACTIVE_SETUP_CAMPAIGN_READBACK_MISMATCH');
 const s=steps[0];
 if(Object.keys(s).some(k=>!['type','delay','variants','delay_unit','pre_delay_unit'].includes(k))||['delay_unit','pre_delay_unit'].some(k=>Object.hasOwn(s,k)&&s[k]!=='days')||!Array.isArray(s.variants)||s.variants.length!==1||!object(s.variants[0]))throw Error('INACTIVE_SETUP_CAMPAIGN_READBACK_MISMATCH');
 const v=s.variants[0];if(Object.keys(v).some(k=>!['subject','body','v_disabled'].includes(k))||Object.hasOwn(v,'v_disabled')&&v.v_disabled!==false)throw Error('INACTIVE_SETUP_CAMPAIGN_READBACK_MISMATCH');
 return [{steps:[{type:s.type,delay:s.delay,variants:[{subject:v.subject,body:v.body}]}]}];
}
function checkCampaignAfter(v,before,m){
 const expected=m.calls[2].arguments;
 try{
  if(v.id!==m.targets.campaignId||v.status!==0)throw Error();
  for(const k of Object.keys(expected).filter(k=>!['sequences','campaign_schedule'].includes(k)))if(!same(v[k],expected[k]))throw Error();
  if(!same(sequenceProjection(v.sequences),expected.sequences)||v.campaign_schedule?.end_date!==expected.campaign_schedule.end_date||!same(v.campaign_schedule.schedules,expected.campaign_schedule.schedules))throw Error();
  const oldCalendar=clone(before.campaign_schedule),newCalendar=clone(v.campaign_schedule);
  for(const k of ['schedules','end_date']){delete oldCalendar[k];delete newCalendar[k];}
  if(!same(oldCalendar,newCalendar))throw Error();
  const a=withoutTimestamp(before),b=withoutTimestamp(v);
  for(const k of Object.keys(expected)){delete a[k];delete b[k];}
  if(!same(a,b))throw Error();
 }catch{throw Error('INACTIVE_SETUP_CAMPAIGN_READBACK_MISMATCH');}
}
function checkLeadAfter(v,before,m){
 try{
  leadIdentity(v,m);
  for(const [k,expected]of Object.entries(m.calls.find(c=>c.tool==='instantly_ai.update_lead').arguments.custom_variables))if(v.payload[k]!==expected)throw Error();
  if(!same(preservedLead(v,m),preservedLead(before,m)))throw Error();
 }catch{throw Error('INACTIVE_SETUP_LEAD_READBACK_MISMATCH');}
}
function savedBaseline(root,source){
 const raw=readFileSync(join(root,source.path));
 if(digest(raw)!==source.sha256)throw Error('INACTIVE_SETUP_BASELINE_CHANGED');
 const values=decodeInstantlyAcceptanceResult(JSON.parse(raw.toString('utf8')),{outputSchemaPresent:false});
 if(values.some(v=>!same(v,values[0])))throw Error('INACTIVE_SETUP_RESULT_REPRESENTATIONS_CONFLICT');
 return values[0];
}

export function createInactiveSetupSession({db,manifest,root,invocationId,now=Date.now}){
 const leadCopy=isInactiveLeadCopyId(manifest?.id);
 (leadCopy?validateInactiveLeadCopyManifest:validateInactiveSetupManifest)(manifest);required(invocationId);required(root);
 // Copy the scope so a caller cannot mutate it while awaiting a response.
 const m=clone(manifest),id=m.id,callId=i=>`${id}:${i}`;
 let owned=false;
 const state=()=>getRecord(db,'inactive_setup_session',id);
 const authority=()=>{
  const grant=assertAcceptance(db,m,now());
  if(grant.claimInvocationId!==invocationId)throw Error('INACTIVE_SETUP_NOT_OWNER');
  verifyAcceptanceSources(root,grant);
  // File/DB checks consume wall time too; do not dispatch on a stale clock read.
  const checkedAt=now();
  if(!Number.isSafeInteger(checkedAt)||checkedAt<Date.parse(grant.startedAt)||checkedAt>=Date.parse(grant.deadlineAt))throw Error('ACCEPTANCE_DEADLINE');
  return grant;
 };
 function finish(code='INACTIVE_SETUP_COMPLETE'){
  return transaction(db,()=>{
   const grant=getRecord(db,'acceptance_authorization',id),s=state();
   if(!owned||grant?.claimInvocationId!==invocationId||s?.invocationId!==invocationId)throw Error('INACTIVE_SETUP_NOT_OWNER');
   if(grant.status==='CLOSED')return getRecord(db,'acceptance_result',id);
   if(grant.status!=='CLAIMED')throw Error('INACTIVE_SETUP_NOT_ACTIVE');
   if(code==='INACTIVE_SETUP_COMPLETE')try{authority();}catch(e){code=reason(e)==='ACCEPTANCE_DEADLINE'?'INACTIVE_SETUP_DEADLINE':reason(e);}
   if(s.pending!==null){const call=getRecord(db,'inactive_setup_call',callId(s.pending));putRecord(db,'inactive_setup_call',callId(s.pending),{...call,state:'UNRESOLVED',terminalReason:code},'unresolved');}
   const complete=code==='INACTIVE_SETUP_COMPLETE'&&s.nextIndex===m.calls.length&&s.pending===null&&s.campaignReadback==='VERIFIED'&&s.leadReadback==='VERIFIED';
   if(code==='INACTIVE_SETUP_COMPLETE'&&!complete)code='INACTIVE_SETUP_INCOMPLETE';
   const uncertain=s.pending!==null||s.counts.writes>0&&code!=='INSTANTLY_TOOL_ERROR';
   const result={id,claimInvocationId:invocationId,status:complete?'PASS':code==='INSTANTLY_TOOL_ERROR'?'FAILED':uncertain?'UNRESOLVED':'BLOCKED',reason:code,
    counts:s.counts,countsMeaning:'DURABLE_DISPATCH_INTENTS_UPPER_BOUND',toolResultsObserved:m.calls.map((_,i)=>getRecord(db,'inactive_setup_call',callId(i))).filter(c=>c?.response).length,
    ...(leadCopy?{writeSkipped:s.writeSkipped===true}:{}),
    campaignReadback:s.campaignReadback,leadReadback:s.leadReadback,startedAt:grant.startedAt,finishedAt:new Date(now()).toISOString(),
    elapsedMs:Math.max(0,now()-Date.parse(grant.startedAt)),authorizationStatus:'CLOSED',remoteCancellationConfirmed:false,
    usageUsd:'NOT_EXPOSED',underlyingNetworkAttempts:'UNOBSERVED',finalControls:controls(db),noAutomaticReplay:true};
   putRecord(db,'inactive_setup_session',id,{...s,status:'CLOSED',terminalReason:code},complete?'confirmed':'unresolved');
   closeAcceptance(db,result,now());return result;
  });
 }
 function start(){
  try{
   return transaction(db,()=>{
    if(state())throw Error('INACTIVE_SETUP_SESSION_ALREADY_EXISTS');
    const startedAt=now(),grant=claimAcceptance(db,m,startedAt,{root,now,invocationId});
    const s={id,invocationId,status:'ACTIVE',manifestHash:hash(m),nextIndex:0,pending:null,counts:{reads:0,writes:0},campaignReadback:'NOT_VERIFIED',leadReadback:'NOT_VERIFIED'};
    putRecord(db,'inactive_setup_session',id,s,'confirmed');journal(db,'INACTIVE_SETUP_STARTED',id,{invocationId,deadlineAt:grant.deadlineAt});
    owned=true;return s;
   });
  }catch(e){journal(db,'INACTIVE_SETUP_REFUSED',invocationId,{reason:reason(e)});throw e;}
 }
 function prepare(call){
  try{
   return transaction(db,()=>{
    if(!owned)throw Error('INACTIVE_SETUP_NOT_OWNER');
    const s=state();authority();
    if(s.status!=='ACTIVE'||s.pending!==null||s.nextIndex>=m.calls.length)throw Error('INACTIVE_SETUP_SLOT_UNAVAILABLE');
    if(!same(call,m.calls[s.nextIndex]))throw Error('INACTIVE_SETUP_CALL_MISMATCH');
    const category=isWrite(call)?'writes':'reads',counts={...s.counts,[category]:s.counts[category]+1};
    if(counts.writes>m.limits.maxWrites||counts.reads>m.limits.maxReads)throw Error('INACTIVE_SETUP_REQUEST_LIMIT');
    if(getRecord(db,'inactive_setup_call',callId(s.nextIndex)))throw Error('INACTIVE_SETUP_CALL_ALREADY_CLAIMED');
    const permit={index:s.nextIndex,call:clone(call),owner:invocationId,callHash:hash(call),state:'DISPATCH_INTENT',at:new Date(now()).toISOString()};
    putRecord(db,'inactive_setup_call',callId(s.nextIndex),permit,'unresolved');
    putRecord(db,'inactive_setup_session',id,{...s,counts,pending:s.nextIndex});
    journal(db,'INACTIVE_SETUP_CALL_INTENT',callId(s.nextIndex),{callHash:permit.callHash,tool:call.tool,category});return clone(permit);
   });
  }catch(e){if(owned)finish(reason(e)==='ACCEPTANCE_DEADLINE'?'INACTIVE_SETUP_DEADLINE':reason(e));throw e;}
 }
 function record(index,response){
  try{
   // Durably retain the actual selected tool result before application parsing.
   try{
    assertSafe(response);
    transaction(db,()=>{
     const grant=getRecord(db,'acceptance_authorization',id),s=state();
     if(!owned||grant?.status!=='CLAIMED'||grant.claimInvocationId!==invocationId||s?.invocationId!==invocationId||s.pending!==index)throw Error('INACTIVE_SETUP_RESULT_SLOT_MISMATCH');
     const call=getRecord(db,'inactive_setup_call',callId(index));
     putRecord(db,'inactive_setup_call',callId(index),{...call,state:'RESPONSE_RECEIVED',response:clone(response),responseHash:hash(response),receivedAt:new Date(now()).toISOString()},'provider_result');
     journal(db,'INACTIVE_SETUP_RESPONSE_SAVED',callId(index),{responseHash:hash(response)});
    });
   }catch(e){if(reason(e)==='ACCEPTANCE_DEADLINE')throw Error('INACTIVE_SETUP_DEADLINE');throw Error('INACTIVE_SETUP_EVIDENCE_PERSISTENCE_FAILED');}
   authority();const s=state(),call=m.calls[index];let snapshots,alreadyExact=false;
   if(isWrite(call)){
    if(response?.isError===true)throw Error('INSTANTLY_TOOL_ERROR');
    if(response?.isError!==false||!Array.isArray(response.content))throw Error('INACTIVE_SETUP_WRITE_ACK_UNCERTAIN');
    // No invented success field: this is acknowledgment only. Readback follows.
    if(response.content.length||Object.hasOwn(response,'structuredContent'))decodeInstantlyAcceptanceResult(response,{outputSchemaPresent:false});
   }else{
    snapshots=decodeInstantlyAcceptanceResult(response,{outputSchemaPresent:false});
    if(snapshots.some(v=>!same(v,snapshots[0])))throw Error('INACTIVE_SETUP_RESULT_REPRESENTATIONS_CONFLICT');
    for(const v of snapshots){
     if(leadCopy){
      if(index===0){
       if(v.id!==m.targets.campaignId||v.status!==0||!same(withoutTimestamp(v),withoutTimestamp(savedBaseline(root,m.baselines.campaign))))throw Error('INACTIVE_SETUP_CAMPAIGN_BASELINE_CHANGED');
      }
      if(index===1){
       leadIdentity(v,m);const baseline=savedBaseline(root,m.baselines.lead);
       alreadyExact=Object.entries(m.calls[2].arguments.custom_variables).every(([k,expected])=>v.payload[k]===expected);
       if(alreadyExact)checkLeadAfter(v,baseline,m);
       else if(!same(withoutTimestamp(v),withoutTimestamp(baseline)))throw Error('INACTIVE_SETUP_LEAD_BASELINE_CHANGED');
      }
      if(index===3)checkLeadAfter(v,s.leadBefore,m);
      continue;
     }
     if(index===0){const baseline=JSON.parse(readFileSync(join(root,'work/track-b-prerequisites-v1/inspection-result.json'),'utf8')).campaign.structuredContent;checkCampaignBefore(v,baseline,m);}
     if(index===1){leadIdentity(v,m);const baseline=JSON.parse(readFileSync(join(root,'work/track-b-prerequisites-v1/continuation/raw-internal-lead.json'),'utf8')).structuredContent;if(!same(withoutTimestamp(v),withoutTimestamp(baseline)))throw Error('INACTIVE_SETUP_LEAD_BASELINE_CHANGED');}
     if(index===3)checkCampaignAfter(v,s.campaignBefore,m);
     if(index===5)checkLeadAfter(v,s.leadBefore,m);
    }
   }
   return transaction(db,()=>{
    authority();const current=state();if(current.pending!==index)throw Error('INACTIVE_SETUP_RESULT_SLOT_MISMATCH');
    const slot=getRecord(db,'inactive_setup_call',callId(index));
    putRecord(db,'inactive_setup_call',callId(index),{...slot,state:isWrite(call)?'ACKNOWLEDGED_READBACK_REQUIRED':'VALIDATED'},'confirmed');
    const patch=leadCopy?(index===0?{campaignBefore:snapshots[0],campaignReadback:'VERIFIED'}:index===1?{leadBefore:snapshots[0],writeSkipped:alreadyExact}:index===3?{leadReadback:'VERIFIED'}:{}):index===0?{campaignBefore:snapshots[0]}:index===1?{leadBefore:snapshots[0]}:index===3?{campaignReadback:'VERIFIED'}:index===5?{leadReadback:'VERIFIED'}:{};
    if(alreadyExact){
     putRecord(db,'inactive_setup_call',callId(2),{index:2,call:clone(m.calls[2]),owner:invocationId,state:'SKIPPED_ALREADY_EXACT'},'confirmed');
     journal(db,'INACTIVE_SETUP_WRITE_SKIPPED',callId(2),{reason:'APPROVED_VALUES_ALREADY_EXACT'});
    }
    putRecord(db,'inactive_setup_session',id,{...current,...patch,nextIndex:alreadyExact?3:index+1,pending:null},'confirmed');
    journal(db,'INACTIVE_SETUP_CALL_VALIDATED',callId(index),{application:isWrite(call)?'READBACK_REQUIRED':'VALIDATED'});
    return state();
   });
  }catch(e){finish(reason(e)==='ACCEPTANCE_DEADLINE'?'INACTIVE_SETUP_DEADLINE':reason(e));throw e;}
 }
 function recover(){
  const grant=getRecord(db,'acceptance_authorization',id);
  if(grant?.claimInvocationId!==invocationId)throw Error('INACTIVE_SETUP_NOT_OWNER');
  owned=true;
  return finish('INACTIVE_SETUP_INTERRUPTED_REQUIRES_RECONCILIATION');
 }
 async function run(invoke){
  if(typeof invoke!=='function')throw Error('INACTIVE_SETUP_EXISTING_PLUGIN_INVOKER_REQUIRED');
  try{
   start();
   while(state().nextIndex<m.calls.length){
    const call=m.calls[state().nextIndex];
    const permit=prepare(call);let timer;
    try{
     const remaining=Date.parse(getRecord(db,'acceptance_authorization',id).deadlineAt)-now();
     if(remaining<=0)throw Error('INACTIVE_SETUP_DEADLINE');
     const response=await Promise.race([
      Promise.resolve().then(async()=>{
       const exactCall=clone(permit.call);
       // The microtask can run later than the durable intent was committed.
       try{authority();}catch(e){throw Error(reason(e)==='ACCEPTANCE_DEADLINE'?'INACTIVE_SETUP_DEADLINE':reason(e));}
       try{return await invoke(exactCall,{index:permit.index,deadlineAt:getRecord(db,'acceptance_authorization',id).deadlineAt});}catch{throw Error('INACTIVE_SETUP_TRANSPORT_UNCERTAIN');}
      }),
      new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error('INACTIVE_SETUP_DEADLINE')),remaining);}),
     ]);
     record(permit.index,response);
    }finally{clearTimeout(timer);}
   }
   return finish();
  }catch(e){
   if(owned)return finish(reason(e));
   return {id,status:'BLOCKED',reason:reason(e),authorizationStatus:getRecord(db,'acceptance_authorization',id)?.status??'MISSING',counts:{reads:0,writes:0}};
  }
 }
 return Object.freeze({start,prepare,record,finish,recover,run});
}
