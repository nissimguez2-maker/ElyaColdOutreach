// One fixed supervised internal send. No transport, timer, reservation or automatic dispatch.
import {readFileSync} from 'node:fs';
import {join} from 'node:path';
import {canonical,digest,required,assertSafe} from './values.mjs';
import {getRecord,putRecord,journal,transaction,controls} from './store.mjs';
import {claimAcceptance,assertAcceptance,closeAcceptance,verifyAcceptanceSources} from './acceptance-authority.mjs';
import {decodeInstantlyAcceptanceResult,inputSchema} from './acceptance-instantly.mjs';
import {checkOutputSchema} from './diagnostic-output-schema.mjs';
import {INSTANTLY_REQUEST_CAPTURE} from './instantly-advertised-requests.mjs';

export const INTERNAL_PILOT_ID='elya-internal-send-pilot-v3';
const PREVIOUS_ID='elya-internal-send-pilot-v2';
const CAMPAIGN='e0b018cf-160f-454c-9891-e73b4204d7cd',LEAD='01a1e4b0-51d4-799a-9249-e089d63d5fb0';
const SENDER='daniel.rosen@elya-partners.com',RECIPIENT='drosen@elyapartners.com';
const priorCampaign={path:'work/inactive-lead-copy-v2/live-once/response-0.json',sha256:'2af93bf11a57acf58864fca4fe1eb09fb56f902956fbfe38360c3e89e6386fa4'};
const baseline={campaign:{path:'work/internal-pilot-live-v2/response-campaignBefore.json',sha256:'e6b773695c4063584d2876b737735ac868f30f8dd723e3797bb2e41c5a53ebab',envelope:'RAW_MCP'},lead:{path:'work/inactive-lead-copy-v2/live-once/response-3.json',sha256:'3d05f6f8f41ef0eab15a71e4e8a91d4c90c1a2e3f71ae42b7172e0caba167fca',envelope:'SAVED_RESPONSE_WRAPPER'}};
export const INTERNAL_PILOT_SOURCES=Object.freeze(['src/instantly-internal-pilot.mjs','src/acceptance-authority.mjs','src/store.mjs','src/values.mjs','src/acceptance-instantly.mjs','src/diagnostic-output-schema.mjs','src/instantly-advertised-requests.mjs',INSTANTLY_REQUEST_CAPTURE.path,priorCampaign.path,...Object.values(baseline).map(x=>x.path)]);
const same=(a,b)=>canonical(a)===canonical(b),copy=v=>JSON.parse(canonical(v)),hash=v=>digest(canonical(v));
const call=(tool,args)=>({server:'codex_apps',tool:'instantly_ai.'+tool,arguments:args});
export function internalPilotManifest(){
 const reply=call('list_emails',{campaign_id:CAMPAIGN,eaccount:SENDER,email_type:'received',limit:1});
 return {id:INTERNAL_PILOT_ID,version:3,route:'DIRECT_PLUGIN_SUPERVISED',targets:{campaignId:CAMPAIGN,leadId:LEAD,sender:SENDER,recipient:RECIPIENT},baseline:copy(baseline),
  limits:{maxTotal:15,maxExtraPreflight:4,maxMain:9,reservedSafety:2,maxReply:2,replyWindowMs:1800000,mainDurationMs:1500000,preparationActivationMs:300000,pauseMarginMs:60000,retry:false,fallback:false,pagination:false},
  schedulePolicy:{date:'2026-11-18',timezone:'America/Detroit',from:'CURRENT_NEW_YORK_MINUTE_AT_PREPARATION',to:'FLOOR_MAIN_DEADLINE_MINUS_60_SECONDS_TO_MINUTE',days:{'0':false,'1':false,'2':false,'3':true,'4':false,'5':false,'6':false},futureWaiting:false},
  calls:{blockEmail:call('blocklist_list',{search:RECIPIENT,limit:10}),blockDomain:call('blocklist_list',{search:'elyapartners.com',domains_only:true,limit:10}),subsequences:call('subsequences_list',{parent_campaign:CAMPAIGN,limit:10}),
   campaignBefore:call('get_campaign',{id:CAMPAIGN}),leadBefore:call('get_lead',{id:LEAD}),campaignScheduled:call('get_campaign',{id:CAMPAIGN}),activate:call('activate_campaign',{id:CAMPAIGN}),
   pause:call('pause_campaign',{id:CAMPAIGN}),campaignFinal:call('get_campaign',{id:CAMPAIGN}),reply1:reply,reply2:copy(reply)},
  browserInspectionAllowance:{target:CAMPAIGN,maxObservedInspections:1,readOnly:true,countsAgainstExtraPreflight:true,providerToolAttempt:false,underlyingNetworkRequests:'UNOBSERVED'},businessLaunchAuthorized:false,generalDispatchEnabled:false,monetaryReservationAllowed:false,optionalAnalyticsDefault:false};
}
export function validateInternalPilotManifest(m){if(!same(m,internalPilotManifest()))throw Error('INTERNAL_PILOT_MANIFEST_MISMATCH');return m;}
export function validateInternalPilotReplyContract(raw){
 if(typeof raw!=='string'||digest(raw)!==INSTANTLY_REQUEST_CAPTURE.sha256)throw Error('INTERNAL_PILOT_REPLY_CAPTURE_MISMATCH');
 const matches=JSON.parse(raw).tools.filter(t=>t.name==='instantly_ai.list_emails');
 if(matches.length!==1||!checkOutputSchema(inputSchema(matches[0].inputSchema,matches[0].name),internalPilotManifest().calls.reply1.arguments))throw Error('INTERNAL_PILOT_REPLY_CAPTURE_INVALID');
 return {requestValid:true,capture:copy(INSTANTLY_REQUEST_CAPTURE),liveResponseShapeEstablished:false,paginationEstablished:false};
}
const extra=new Set(['blockEmail','blockDomain','subsequences']),safety=new Set(['pause','campaignFinal']),reply=new Set(['reply1','reply2']),mutations=new Set(['schedule','activate','pause']);
function data(response){const values=decodeInstantlyAcceptanceResult(response,{outputSchemaPresent:false});if(values.some(x=>!same(x,values[0])))throw Error('INTERNAL_PILOT_RESULT_CONFLICT');return values[0];}
function stable(v){const n=copy(v);delete n.timestamp_updated;return n;}
function readBaseline(root,kind){const spec=baseline[kind],raw=readFileSync(join(root,spec.path));if(digest(raw)!==spec.sha256)throw Error('INTERNAL_PILOT_BASELINE_CHANGED');const parsed=JSON.parse(raw.toString('utf8')),value=data(spec.envelope==='RAW_MCP'?parsed:parsed.response);
 if(kind==='campaign'){const oldRaw=readFileSync(join(root,priorCampaign.path));if(digest(oldRaw)!==priorCampaign.sha256)throw Error('INTERNAL_PILOT_BASELINE_CHANGED');const expected=data(JSON.parse(oldRaw.toString('utf8')).response),variant=expected.sequences[0].steps[0].variants[0];variant.body='<div>{{pilot_body_1}}</div><div><br /></div>';variant.v_disabled=false;if(!same(stable(value),stable(expected)))throw Error('INTERNAL_PILOT_BASELINE_UNAPPROVED_DIFFERENCE');}return value;}
function localMinute(at){const p=Object.fromEntries(new Intl.DateTimeFormat('en-CA',{timeZone:'America/New_York',year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hourCycle:'h23'}).formatToParts(new Date(at)).map(x=>[x.type,x.value]));return {date:`${p.year}-${p.month}-${p.day}`,time:`${p.hour}:${p.minute}`};}

export function createInternalPilotSession({db,root,manifest,invocationId,now=Date.now}){
 validateInternalPilotManifest(manifest);required(root);required(invocationId);const m=copy(manifest),id=m.id;
 const state=()=>getRecord(db,'internal_pilot_session',id),slot=key=>getRecord(db,'internal_pilot_call',id+':'+key);
 const atomic=fn=>db.isTransaction?fn():transaction(db,fn);
 function authority(){const grant=assertAcceptance(db,m,now());if(grant.claimInvocationId!==invocationId||state()?.invocationId!==invocationId)throw Error('INTERNAL_PILOT_NOT_OWNER');verifyAcceptanceSources(root,grant);assertAcceptance(db,m,now());return grant;}
 function change(patch,event,details={}){putRecord(db,'internal_pilot_session',id,{...state(),...patch});journal(db,event,id,details);return state();}
 function start(){return atomic(()=>{
  if(state())throw Error('INTERNAL_PILOT_ALREADY_STARTED');
  const previous=getRecord(db,'internal_pilot_session',PREVIOUS_ID),oldGrant=getRecord(db,'acceptance_authorization',PREVIOUS_ID),oldResult=getRecord(db,'acceptance_result',PREVIOUS_ID);
  const expectedCounts={total:5,extra:4,main:1,safety:0,reply:0,mutations:0};
  if(getRecord(db,'acceptance_authorization','elya-internal-send-pilot-v1')?.status!=='CLOSED'||oldGrant?.status!=='CLOSED'||oldResult?.authorizationStatus!=='CLOSED'||previous?.status!=='CLOSED'||previous.pending!==null||previous.mutationAttempted!==false||previous.normalBlocked!=='INTERNAL_PILOT_CAMPAIGN_PRECONDITION'||previous.browserInspectionCount!==1||!same(previous.counts,expectedCounts)||!same(oldResult.counts,expectedCounts)||previous.checks?.recipientRestrictions!=='NO_OBSERVED_RESTRICTION'||previous.checks?.additionalPaths!=='NO_OBSERVED_ADDITIONAL_PATH'||!Array.isArray(previous.checks.evidence)||!previous.checks.evidence.length)throw Error('INTERNAL_PILOT_PRIOR_CLEAN_CLOSURE_REQUIRED');
  const inherited=['blockEmail','blockDomain','subsequences','browserQaView'].map(key=>{
   const r=getRecord(db,'internal_pilot_call',PREVIOUS_ID+':'+key);
   if(key==='browserQaView'){if(r?.state!=='OBSERVED'||r.campaignId!==CAMPAIGN||r.providerToolAttempt!==false)throw Error('INTERNAL_PILOT_PRIOR_PREFLIGHT_INVALID');}
   else if(r?.state!=='CAPTURED'||!same(r.call,m.calls[key])||r.callHash!==hash(m.calls[key])||!r.response||r.responseHash!==hash(r.response))throw Error('INTERNAL_PILOT_PRIOR_PREFLIGHT_INVALID');
   return {key,record:r};
  });
  const failed=getRecord(db,'internal_pilot_call',PREVIOUS_ID+':campaignBefore');
  if(failed?.state!=='UNRESOLVED'||failed.error!=='INTERNAL_PILOT_CAMPAIGN_PRECONDITION'||!same(failed.call,m.calls.campaignBefore)||failed.callHash!==hash(m.calls.campaignBefore)||!failed.response||failed.responseHash!==hash(failed.response)||!same(data(failed.response),readBaseline(root,'campaign')))throw Error('INTERNAL_PILOT_PRIOR_FAILED_READ_REQUIRED');
  inherited.push({key:'inheritedCampaignBefore',sourceKey:'campaignBefore',record:failed});
  if(db.prepare("SELECT count(*) n FROM records WHERE kind='internal_pilot_call' AND id LIKE ?").get(PREVIOUS_ID+':%').n!==5)throw Error('INTERNAL_PILOT_PRIOR_CLEAN_CLOSURE_REQUIRED');
  const at=now();if(localMinute(at).date!==m.schedulePolicy.date)throw Error('INTERNAL_PILOT_APPROVED_DATE_REQUIRED');
  const grant=claimAcceptance(db,m,at,{root,now,invocationId}),mainDeadline=at+m.limits.mainDurationMs,pauseAt=Math.floor((mainDeadline-m.limits.pauseMarginMs)/60000)*60000;
  if(localMinute(mainDeadline).date!==m.schedulePolicy.date||pauseAt<=at)throw Error('INTERNAL_PILOT_APPROVED_DATE_REQUIRED');
  const s={id,invocationId,status:'ACTIVE',counts:copy(expectedCounts),browserInspectionCount:1,inheritedFrom:PREVIOUS_ID,pending:null,normalBlocked:null,mutationAttempted:false,presence:null,checks:copy(previous.checks),received:null,manualPause:null,replySent:null,replyDeadlineAt:null,finalPause:'UNCONFIRMED',mainStartedAt:new Date(at).toISOString(),activationDeadlineAt:new Date(at+m.limits.preparationActivationMs).toISOString(),mainDeadlineAt:new Date(mainDeadline).toISOString(),pauseBy:new Date(pauseAt).toISOString(),scheduleCall:null};
  for(const {key,sourceKey,record}of inherited)putRecord(db,'internal_pilot_call',id+':'+key,{...copy(record),inheritedFrom:{profile:PREVIOUS_ID,recordId:PREVIOUS_ID+':'+(sourceKey??key),recordHash:hash(record)},inheritedAt:new Date(now()).toISOString()},'confirmed');
  putRecord(db,'internal_pilot_session',id,s);journal(db,'INTERNAL_PILOT_STARTED',id,{deadlineAt:grant.deadlineAt,inheritedFrom:PREVIOUS_ID,inheritedAttempts:5,mainDeadlineAt:s.mainDeadlineAt,activationDeadlineAt:s.activationDeadlineAt,pauseBy:s.pauseBy});return s;
 });}
 function plannedCall(key){return atomic(()=>{
  authority();if(key!=='schedule'){if(!Object.hasOwn(m.calls,key))throw Error('INTERNAL_PILOT_CALL_MISMATCH');return copy(m.calls[key]);}
  const s=state();if(s.scheduleCall)return copy(s.scheduleCall);
  if(!s.presence?.confirmed)throw Error('INTERNAL_PILOT_PRESENCE_REQUIRED');
  if(!s.checks||slot('leadBefore')?.state!=='VALIDATED')throw Error('INTERNAL_PILOT_SCHEDULE_PREREQUISITES');
  const at=now();if(at<Date.parse(s.mainStartedAt)||at>=Date.parse(s.activationDeadlineAt)||s.normalBlocked||slot('pause')||s.manualPause)throw Error('INTERNAL_PILOT_ACTIVATION_WINDOW');
  const from=localMinute(at),to=localMinute(Date.parse(s.pauseBy));if(from.date!==m.schedulePolicy.date||to.date!==from.date||from.time>=to.time)throw Error('INTERNAL_PILOT_SCHEDULE_WINDOW');
  const schedule={start_date:from.date,end_date:from.date,schedules:[{name:'QA ONE MESSAGE - '+from.date,timezone:m.schedulePolicy.timezone,timing:{from:from.time,to:to.time},days:copy(m.schedulePolicy.days)}]};
  const exact=call('update_campaign',{id:CAMPAIGN,campaign_schedule:schedule});change({scheduleCall:exact,schedulePlannedAt:new Date(at).toISOString()},'INTERNAL_PILOT_SCHEDULE_FROZEN',{callHash:hash(exact)});return copy(exact);
 });}
 function confirmChecks(value){return atomic(()=>{authority();if(!value||value.recipientRestrictions!=='NO_OBSERVED_RESTRICTION'||value.additionalPaths!=='NO_OBSERVED_ADDITIONAL_PATH'||!Array.isArray(value.evidence)||!value.evidence.length||value.evidence.some(x=>typeof x!=='string'||!x.trim()))throw Error('INTERNAL_PILOT_CHECKS_REQUIRED');assertSafe(value);return change({checks:{...copy(value),at:new Date(now()).toISOString()}},'INTERNAL_PILOT_CHECKS_RECORDED');});}
 function recordBrowserInspection({observedAt,evidence}){return atomic(()=>{
  authority();required(evidence);const s=state(),at=Date.parse(observedAt);
  if(slot('browserQaView'))throw Error('INTERNAL_PILOT_BROWSER_ALREADY_RECORDED');
  if(!Number.isFinite(at)||at>now()||at>=Date.parse(s.activationDeadlineAt)||s.mutationAttempted)throw Error('INTERNAL_PILOT_PREFLIGHT_WINDOW');
  const counts={...s.counts,total:s.counts.total+1,extra:s.counts.extra+1};if(counts.total>15||counts.extra>4)throw Error('INTERNAL_PILOT_ATTEMPT_LIMIT');
  putRecord(db,'internal_pilot_call',id+':browserQaView',{key:'browserQaView',state:'OBSERVED',campaignId:CAMPAIGN,observedAt,evidence,providerToolAttempt:false,underlyingNetworkRequests:'UNOBSERVED'},'assessment');
  return change({counts,browserInspectionCount:1},'INTERNAL_PILOT_BROWSER_INSPECTION_ACCOUNTED',{observedAt,conservativeBudgetSlots:1});
 });}
 function confirmPresence(value){return atomic(()=>{authority();if(value!==true)throw Error('INTERNAL_PILOT_PRESENCE_REQUIRED');const s=state();if(now()<Date.parse(s.mainStartedAt)||now()>=Date.parse(s.activationDeadlineAt))throw Error('INTERNAL_PILOT_PRESENCE_WINDOW');return change({presence:{confirmed:true,at:new Date(now()).toISOString()}},'INTERNAL_PILOT_PRESENCE_RECORDED');});}
 function prepare(key,requested){return atomic(()=>{
  authority();const s=state(),at=now();
  if(key!=='schedule'&&!Object.hasOwn(m.calls,key)||key==='schedule'&&!s.scheduleCall||!same(requested,key==='schedule'?s.scheduleCall:m.calls[key]))throw Error('INTERNAL_PILOT_CALL_MISMATCH');
  if(slot(key))throw Error('INTERNAL_PILOT_ALREADY_ATTEMPTED');
  if(s.pending!==null)throw Error('INTERNAL_PILOT_PENDING_RECONCILIATION');
  if(s.status!=='ACTIVE')throw Error('INTERNAL_PILOT_CLOSED');
  const category=extra.has(key)?'extra':reply.has(key)?'reply':safety.has(key)?'safety':'main';
  if(!['safety','reply'].includes(category)&&(slot('pause')||s.manualPause))throw Error('INTERNAL_PILOT_SAFETY_STARTED');
  if(!['safety','reply'].includes(category)&&s.normalBlocked)throw Error('INTERNAL_PILOT_NORMAL_WORK_STOPPED');
  if(category==='extra'){if(at>=Date.parse(s.activationDeadlineAt)||s.mutationAttempted)throw Error('INTERNAL_PILOT_PREFLIGHT_WINDOW');}
  else if(category==='reply'){
   validateInternalPilotReplyContract(readFileSync(join(root,INSTANTLY_REQUEST_CAPTURE.path),'utf8'));
   if(!s.received||!s.manualPause&&s.finalPause!=='CONFIRMED'||!s.replySent||!s.replyDeadlineAt)throw Error('INTERNAL_PILOT_REPLY_CONFIRMATION_REQUIRED');
   if(at>=Date.parse(s.replyDeadlineAt))throw Error('INTERNAL_PILOT_REPLY_DEADLINE');
   if(key==='reply2'&&slot('reply1')?.state!=='CAPTURED')throw Error('INTERNAL_PILOT_FIRST_REPLY_REQUIRED');
  }else{
   if(at<Date.parse(s.mainStartedAt)||at>=Date.parse(s.mainDeadlineAt))throw Error('INTERNAL_PILOT_MAIN_DEADLINE');
   if(category==='safety'){
    if(!s.mutationAttempted)throw Error('INTERNAL_PILOT_SAFETY_NOT_NEEDED');
    if(key==='campaignFinal'&&!slot('pause')&&!s.manualPause)throw Error('INTERNAL_PILOT_PAUSE_ATTEMPT_REQUIRED');
   }else{
    const previous={leadBefore:'campaignBefore',schedule:'leadBefore',campaignScheduled:'schedule',activate:'campaignScheduled'}[key];
    if(previous&&!['VALIDATED','ACKNOWLEDGED'].includes(slot(previous)?.state))throw Error('INTERNAL_PILOT_SEQUENCE');
    if(key==='schedule'||key==='activate'){
     if(!s.presence?.confirmed)throw Error('INTERNAL_PILOT_PRESENCE_REQUIRED');
     if(!s.checks)throw Error('INTERNAL_PILOT_CHECKS_REQUIRED');
     if(at>=Date.parse(s.activationDeadlineAt))throw Error('INTERNAL_PILOT_ACTIVATION_WINDOW');
     if(key==='schedule'&&s.scheduleCall.arguments.campaign_schedule.schedules[0].timing.from!==localMinute(at).time)throw Error('INTERNAL_PILOT_SCHEDULE_PLAN_STALE');
    }
   }
  }
  const counts={...s.counts,total:s.counts.total+1,[category]:s.counts[category]+1,mutations:s.counts.mutations+Number(mutations.has(key))};
  if(counts.total>15||counts.extra>4||counts.main>7||counts.safety>2||counts.reply>2)throw Error('INTERNAL_PILOT_ATTEMPT_LIMIT');
  const intent={key,call:copy(requested),callHash:hash(requested),state:'DISPATCH_INTENT',at:new Date(at).toISOString(),invocationId};
  putRecord(db,'internal_pilot_call',id+':'+key,intent,'unresolved');
  change({counts,pending:key,mutationAttempted:s.mutationAttempted||mutations.has(key)},'INTERNAL_PILOT_DISPATCH_INTENT',{key,tool:requested.tool,counts});return intent;
 });}
 function record(key,response){
  atomic(()=>{authority();if(state().pending!==key)throw Error('INTERNAL_PILOT_RESULT_SLOT');assertSafe(response);const old=slot(key);putRecord(db,'internal_pilot_call',id+':'+key,{...old,response:copy(response),responseHash:hash(response),returnedAt:new Date(now()).toISOString(),state:'RESPONSE_RECEIVED'},'provider_result');journal(db,'INTERNAL_PILOT_RESPONSE_SAVED',id,{key,responseHash:hash(response)});});
  let result,patch={},error=null;
  try{
   if(!response||!Array.isArray(response.content)||response.isError!==false)throw Error(response?.isError===true?'INTERNAL_PILOT_TOOL_ERROR':'INTERNAL_PILOT_PROTOCOL_INVALID');
   if(mutations.has(key)){
    if(response.content.length||Object.hasOwn(response,'structuredContent'))data(response);
    result='ACKNOWLEDGED';
   }else{
    const value=data(response);result=reply.has(key)||extra.has(key)?'CAPTURED':'VALIDATED';
    if(key==='campaignBefore'&&(!same(stable(value),stable(readBaseline(root,'campaign')))||value.status!==0))throw Error('INTERNAL_PILOT_CAMPAIGN_PRECONDITION');
    if(key==='leadBefore'&&!same(stable(value),stable(readBaseline(root,'lead'))))throw Error('INTERNAL_PILOT_LEAD_PRECONDITION');
    if(key==='campaignScheduled'){
     const before=copy(data(slot('campaignBefore').response));before.campaign_schedule=copy(slot('schedule').call.arguments.campaign_schedule);
     if(!same(stable(value),stable(before))||value.status!==0)throw Error('INTERNAL_PILOT_SCHEDULE_READBACK');
    }
    if(key==='campaignFinal'){
     if(value.id!==CAMPAIGN||value.status!==2)throw Error('INTERNAL_PILOT_REMOTE_PAUSE_UNCONFIRMED');
     patch.finalPause='CONFIRMED';
    }
   }
  }catch(e){error=/^[A-Z][A-Z0-9_]+$/.test(e.message)?e.message:'INTERNAL_PILOT_APPLICATION_VALIDATION_FAILED';result='UNRESOLVED';}
  return atomic(()=>{authority();const old=slot(key);putRecord(db,'internal_pilot_call',id+':'+key,{...old,state:result,error},error?'unresolved':'confirmed');const blocked=error&&!safety.has(key)?error:state().normalBlocked;change({pending:null,normalBlocked:blocked,...patch},'INTERNAL_PILOT_OUTCOME',{key,result,error});return {key,state:result,error};});
 }
 function uncertain(key,reason='INTERNAL_PILOT_OUTCOME_UNCERTAIN'){return atomic(()=>{authority();if(state().pending!==key)throw Error('INTERNAL_PILOT_RESULT_SLOT');if(!/^[A-Z][A-Z0-9_]+$/.test(reason))throw Error('INTERNAL_PILOT_REASON_INVALID');putRecord(db,'internal_pilot_call',id+':'+key,{...slot(key),state:'UNRESOLVED',error:reason,remoteCancellationConfirmed:false},'unresolved');return change({pending:null,normalBlocked:safety.has(key)?state().normalBlocked:reason},'INTERNAL_PILOT_UNCERTAIN',{key,reason});});}
 function confirmReceiptAndPause({received,paused,evidence}){return atomic(()=>{authority();required(evidence);if(!slot('activate'))throw Error('INTERNAL_PILOT_ACTIVATION_NOT_ATTEMPTED');if(received!==true&&received!==false||paused!==true&&paused!==false)throw Error('INTERNAL_PILOT_USER_REPORT_INVALID');return change({received:received?{at:new Date(now()).toISOString(),evidence}:state().received,manualPause:paused?{at:new Date(now()).toISOString(),evidence}:state().manualPause},'INTERNAL_PILOT_RECEIPT_PAUSE_REPORTED',{received,paused});});}
 function confirmReplySent({sentAt,evidence}){return atomic(()=>{const grant=authority(),s=state();required(evidence);const sent=Date.parse(sentAt);if(!s.received||!s.manualPause&&s.finalPause!=='CONFIRMED')throw Error('INTERNAL_PILOT_RECEIPT_PAUSE_REQUIRED');if(!Number.isFinite(sent)||sent>now()||sent<Date.parse(s.received.at))throw Error('INTERNAL_PILOT_REPLY_TIME_INVALID');if(s.replySent)throw Error('INTERNAL_PILOT_REPLY_ALREADY_RECORDED');return change({replySent:{sentAt,evidence},replyDeadlineAt:new Date(Math.min(sent+1800000,Date.parse(grant.expiresAt))).toISOString()},'INTERNAL_PILOT_REPLY_REPORTED');});}
 function finish(reason='INTERNAL_PILOT_CLOSED'){return atomic(()=>{const grant=getRecord(db,'acceptance_authorization',id),s=state();if(grant?.claimInvocationId!==invocationId||s?.invocationId!==invocationId)throw Error('INTERNAL_PILOT_NOT_OWNER');if(grant.status==='CLOSED')return getRecord(db,'acceptance_result',id);if(s.pending){const old=slot(s.pending);putRecord(db,'internal_pilot_call',id+':'+s.pending,{...old,state:'UNRESOLVED',error:'INTERNAL_PILOT_CLOSED_PENDING'},'unresolved');}const result={id,claimInvocationId:invocationId,status:s.normalBlocked||s.pending?'UNRESOLVED':'CLOSED',reason,counts:s.counts,authorizationStatus:'CLOSED',finalPause:s.finalPause,manualPauseReported:!!s.manualPause,receiptReported:!!s.received,replyReported:!!s.replySent,remoteCancellationConfirmed:false,usage:'NOT_EXPOSED',finishedAt:new Date(now()).toISOString(),controls:controls(db)};change({status:'CLOSED'},'INTERNAL_PILOT_FINISHED',{reason});closeAcceptance(db,result,now());return result;});}
 return Object.freeze({start,state,plannedCall,prepare,record,uncertain,recordBrowserInspection,confirmChecks,confirmPresence,confirmReceiptAndPause,confirmReplySent,finish});
}
