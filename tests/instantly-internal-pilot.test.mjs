import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync,mkdtempSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {Worker} from 'node:worker_threads';
import {resolve,join} from 'node:path';
import {openStore,putRecord,getRecord,controls} from '../src/store.mjs';
import {armAcceptance,assertFreshAcceptance} from '../src/acceptance-authority.mjs';
import {canonical,digest} from '../src/values.mjs';
import {blockNetwork} from './helpers/network-block.mjs';
const root=resolve('.'),time=Date.parse('2026-11-18T17:04:00Z');
const envelope=value=>({content:[{type:'text',text:JSON.stringify(value)}],structuredContent:structuredClone(value),isError:false});
async function fixture(t,{file=false}={}){
 const net=blockNetwork(t);t.after(()=>assert.equal(net.attempts,0));
 const api=await import('../src/instantly-internal-pilot.mjs').catch(()=>null);
 assert.equal(typeof api?.createInternalPilotSession,'function','fixed internal pilot controller required');
 const manifest=api.internalPilotManifest(),path=file?join(mkdtempSync(join(tmpdir(),'elya-pilot-once-')),'fixture.sqlite'):':memory:',db=openStore(path);t.after(()=>db.close());
 putRecord(db,'contact','held-fixture',{held:true});
 const campaignRaw=JSON.parse(readFileSync('work/internal-pilot-live-v2/response-campaignBefore.json','utf8'));
 const previous='elya-internal-send-pilot-v2',counts={total:5,extra:4,main:1,safety:0,reply:0,mutations:0};
 putRecord(db,'acceptance_authorization','elya-internal-send-pilot-v1',{status:'CLOSED'});
 putRecord(db,'acceptance_result','elya-internal-send-pilot-v1',{authorizationStatus:'CLOSED'});
 putRecord(db,'acceptance_authorization',previous,{id:previous,status:'CLOSED'});
 putRecord(db,'acceptance_result',previous,{id:previous,authorizationStatus:'CLOSED',counts});
 putRecord(db,'internal_pilot_session',previous,{id:previous,status:'CLOSED',pending:null,mutationAttempted:false,normalBlocked:'INTERNAL_PILOT_CAMPAIGN_PRECONDITION',browserInspectionCount:1,counts,checks:{recipientRestrictions:'NO_OBSERVED_RESTRICTION',additionalPaths:'NO_OBSERVED_ADDITIONAL_PATH',evidence:['closed v2 fixture preflight']}});
 for(const key of ['blockEmail','blockDomain','subsequences']){const response=envelope({items:[]});putRecord(db,'internal_pilot_call',previous+':'+key,{key,state:'CAPTURED',call:manifest.calls[key],callHash:digest(canonical(manifest.calls[key])),response,responseHash:digest(canonical(response))});}
 putRecord(db,'internal_pilot_call',previous+':browserQaView',{key:'browserQaView',state:'OBSERVED',campaignId:manifest.targets.campaignId,providerToolAttempt:false,underlyingNetworkRequests:'UNOBSERVED'});
 putRecord(db,'internal_pilot_call',previous+':campaignBefore',{key:'campaignBefore',state:'UNRESOLVED',error:'INTERNAL_PILOT_CAMPAIGN_PRECONDITION',call:manifest.calls.campaignBefore,callHash:digest(canonical(manifest.calls.campaignBefore)),response:campaignRaw,responseHash:digest(canonical(campaignRaw))});
 const sources=api.INTERNAL_PILOT_SOURCES.map(path=>({path,sha256:digest(readFileSync(join(root,path)))}));
 armAcceptance(db,manifest,sources,time-60000,{executionApproval:{type:'EXPLICIT_LIVE_EXECUTION_APPROVAL',manifestHash:digest(canonical(manifest)),reference:'OFFLINE FIXTURE ONLY',approvedAt:new Date(time-60000).toISOString()}});
 let clock=time;
 const session=api.createInternalPilotSession({db,root,manifest,invocationId:'fixture-owner',now:()=>clock});
 const saved=path=>{const r=JSON.parse(readFileSync(path,'utf8')).response;return r.structuredContent??JSON.parse(r.content[0].text);};
 const campaign=campaignRaw.structuredContent??JSON.parse(campaignRaw.content[0].text);
 const lead=saved('work/inactive-lead-copy-v2/live-once/response-3.json');
 const run=(key,value)=>{session.prepare(key,session.plannedCall(key));return session.record(key,envelope(value));};
 return {api,manifest,db,path,sources,session,campaign,lead,run,setClock:v=>{clock=typeof v==='string'?Date.parse(v):v;}};
}
test('presence is required before any schedule write while preflight remains read only',async t=>{
 const f=await fixture(t);f.session.start();
 f.run('campaignBefore',f.campaign);f.run('leadBefore',f.lead);
 f.session.confirmChecks({recipientRestrictions:'NO_OBSERVED_RESTRICTION',additionalPaths:'NO_OBSERVED_ADDITIONAL_PATH',evidence:['fixture checks']});
 assert.throws(()=>f.session.plannedCall('schedule'),/PRESENCE_REQUIRED/);
 assert.equal(f.session.state().counts.mutations,0);assert.equal(controls(f.db).stopped,true);
});
function ready(f){f.session.start();f.run('campaignBefore',f.campaign);f.run('leadBefore',f.lead);f.session.confirmChecks({recipientRestrictions:'NO_OBSERVED_RESTRICTION',additionalPaths:'NO_OBSERVED_ADDITIONAL_PATH',evidence:['offline fixture']});f.session.confirmPresence(true);}
function scheduled(f){ready(f);const planned=f.session.plannedCall('schedule');f.session.prepare('schedule',planned);f.session.record('schedule',{content:[],isError:false});f.campaign.campaign_schedule=structuredClone(planned.arguments.campaign_schedule);f.run('campaignScheduled',f.campaign);f.setClock('2026-11-18T17:05:00Z');}
test('single send path captures exact scope and reserves independent pause/readback while preserving stopped state',async t=>{
 const f=await fixture(t),before=controls(f.db);scheduled(f);
 assert.deepEqual(f.manifest.calls.activate.arguments,{id:'e0b018cf-160f-454c-9891-e73b4204d7cd'});
 f.session.prepare('activate',f.manifest.calls.activate);f.session.record('activate',{content:[],isError:false});
 assert.throws(()=>f.session.prepare('activate',f.manifest.calls.activate),/ALREADY_ATTEMPTED/);
 f.session.confirmReceiptAndPause({received:true,paused:true,evidence:'user confirms exact marked internal message and native pause'});
 f.session.prepare('pause',f.manifest.calls.pause);f.session.record('pause',{content:[],isError:false});f.campaign.status=2;f.run('campaignFinal',f.campaign);
 assert.equal(f.session.state().finalPause,'CONFIRMED');assert.deepEqual(f.session.state().counts,{total:12,extra:4,main:6,safety:2,reply:0,mutations:3});
 assert.deepEqual(controls(f.db),before);assert.equal(f.db.prepare('SELECT count(*) n FROM budgets').get().n,0);assert.equal(f.db.prepare('SELECT count(*) n FROM operations').get().n,0);
 const result=f.session.finish();assert.equal(result.authorizationStatus,'CLOSED');assert.equal(getRecord(f.db,'acceptance_authorization',f.manifest.id).status,'CLOSED');
});
for(const key of ['schedule','activate'])test(`uncertain ${key} cannot replay and does not consume reserved safety capacity`,async t=>{
 const f=await fixture(t);if(key==='schedule')ready(f);else scheduled(f);
 const planned=f.session.plannedCall(key);f.session.prepare(key,planned);f.session.uncertain(key,'INTERNAL_PILOT_TRANSPORT_UNCERTAIN');
 assert.throws(()=>f.session.prepare(key,planned),/ALREADY_ATTEMPTED/);
 if(key==='schedule')assert.throws(()=>f.session.prepare('activate',f.manifest.calls.activate),/NORMAL_WORK_STOPPED/);
 assert.throws(()=>f.session.prepare('observe1',{}),/CALL_MISMATCH/);
 f.session.prepare('pause',f.manifest.calls.pause);f.session.record('pause',{content:[{type:'text',text:'{}'}],isError:true});
 f.campaign.status=2;f.run('campaignFinal',f.campaign);assert.equal(f.session.state().finalPause,'CONFIRMED');assert.equal(f.session.state().counts.safety,2);
 assert.equal(getRecord(f.db,'internal_pilot_call',`${f.manifest.id}:${key}`).state,'UNRESOLVED');
});
test('deadline before activation blocks activation but retains safety within closure window',async t=>{
 const f=await fixture(t);scheduled(f);f.setClock('2026-11-18T17:09:00.001Z');
 assert.throws(()=>f.session.prepare('activate',f.manifest.calls.activate),/ACTIVATION_WINDOW/);
 f.setClock('2026-11-18T17:25:30Z');f.session.prepare('pause',f.manifest.calls.pause);f.session.record('pause',{content:[],isError:false});
 f.campaign.status=2;f.run('campaignFinal',f.campaign);f.setClock('2026-11-18T17:29:00Z');assert.throws(()=>f.session.prepare('activate',f.manifest.calls.activate),/SAFETY_STARTED/);
});
test('changed targets/payloads and unknown extra calls cannot obtain a dispatch intent',async t=>{
 const f=await fixture(t);f.session.start();
 for(const altered of [{...f.manifest.calls.campaignBefore,arguments:{id:'other'}},{...f.manifest.calls.campaignBefore,arguments:{id:f.manifest.targets.campaignId,extra:true}}])assert.throws(()=>f.session.prepare('campaignBefore',altered),/CALL_MISMATCH/);
 assert.throws(()=>f.session.prepare('resetLead',{server:'codex_apps',tool:'instantly_ai.update_lead',arguments:{id:f.manifest.targets.leadId,status:1}}),/CALL_MISMATCH/);
 assert.equal(f.session.state().counts.total,5);assert.equal(f.db.prepare("SELECT count(*) n FROM records WHERE kind='internal_pilot_call' AND id LIKE 'elya-internal-send-pilot-v3:%'").get().n,5);
});
test('readback disagreement stops normal work without blocking pause',async t=>{
 const f=await fixture(t);ready(f);const planned=f.session.plannedCall('schedule');f.session.prepare('schedule',planned);f.session.record('schedule',{content:[],isError:false});
 f.campaign.campaign_schedule=structuredClone(planned.arguments.campaign_schedule);f.campaign.daily_limit=30;
 assert.equal(f.run('campaignScheduled',f.campaign).error,'INTERNAL_PILOT_SCHEDULE_READBACK');
 f.setClock('2026-11-18T17:05:00Z');assert.throws(()=>f.session.prepare('activate',f.manifest.calls.activate),/NORMAL_WORK_STOPPED/);
 f.session.prepare('pause',f.manifest.calls.pause);assert.equal(f.session.state().counts.safety,1);
});
test('separate controller instances resume only the claimed owner and cannot claim a second invocation',async t=>{
 const f=await fixture(t);f.session.start();
 const other=f.api.createInternalPilotSession({db:f.db,root,manifest:f.manifest,invocationId:'other',now:()=>time});
 assert.throws(()=>other.start(),/ALREADY_STARTED/);assert.throws(()=>other.prepare('campaignBefore',f.manifest.calls.campaignBefore),/NOT_OWNER/);
 const resumed=f.api.createInternalPilotSession({db:f.db,root,manifest:f.manifest,invocationId:'fixture-owner',now:()=>time});
 resumed.prepare('campaignBefore',f.manifest.calls.campaignBefore);resumed.record('campaignBefore',envelope(f.campaign));
 assert.equal(resumed.state().counts.total,6);resumed.finish();assert.throws(()=>f.session.prepare('leadBefore',f.manifest.calls.leadBefore),/NOT_ACTIVE/);
});
test('reply read requires receipt, pause and explicit reply report; only two limit-one campaign/account reads are possible',async t=>{
 const f=await fixture(t);scheduled(f);f.session.prepare('activate',f.manifest.calls.activate);f.session.record('activate',{content:[],isError:false});
 assert.throws(()=>f.session.prepare('reply1',f.manifest.calls.reply1),/REPLY_CONFIRMATION_REQUIRED/);
 f.session.confirmReceiptAndPause({received:true,paused:true,evidence:'user receipt/pause report'});
 f.setClock('2026-11-18T17:26:30Z');f.session.confirmReplySent({sentAt:'2026-11-18T17:26:00Z',evidence:'user manual reply report'});
 assert.deepEqual(f.manifest.calls.reply1.arguments,{campaign_id:'e0b018cf-160f-454c-9891-e73b4204d7cd',eaccount:'daniel.rosen@elya-partners.com',email_type:'received',limit:1});
 const raw={items:[],opaque:'fixture envelope; absent cursor is not end proof'};assert.equal(f.run('reply1',raw).state,'CAPTURED');assert.equal(f.run('reply2',raw).state,'CAPTURED');
 assert.throws(()=>f.session.prepare('reply2',f.manifest.calls.reply2),/ALREADY_ATTEMPTED/);
 assert.equal(f.session.state().counts.reply,2);assert.equal(f.session.state().replyDeadlineAt,'2026-11-18T17:56:00.000Z');
 assert.equal(Object.hasOwn(getRecord(f.db,'internal_pilot_call',`${f.manifest.id}:reply1`).response.structuredContent,'nextCursor'),false);
});
test('thirty-minute reply deadline does not extend on restart or repeated confirmation',async t=>{
 const f=await fixture(t);scheduled(f);f.session.prepare('activate',f.manifest.calls.activate);f.session.record('activate',{content:[],isError:false});f.session.confirmReceiptAndPause({received:true,paused:true,evidence:'fixture user report'});
 f.setClock('2026-11-18T17:27:00Z');f.session.confirmReplySent({sentAt:'2026-11-18T17:27:00Z',evidence:'reply sent once'});
 assert.throws(()=>f.session.confirmReplySent({sentAt:'2026-11-18T17:27:00Z',evidence:'same reply'}),/ALREADY_RECORDED/);
 f.setClock('2026-11-18T17:57:00Z');assert.throws(()=>f.session.prepare('reply1',f.manifest.calls.reply1),/REPLY_DEADLINE/);assert.equal(f.session.state().counts.reply,0);
});
test('expired and closed grants remain ineligible with no operations or reservations created',async t=>{
 const f=await fixture(t);assert.throws(()=>assertFreshAcceptance(f.db,f.manifest,time+86400000),/VALIDITY_EXPIRED/);
 f.session.start();f.session.finish('FIXTURE_FINISHED');assert.throws(()=>assertFreshAcceptance(f.db,f.manifest,time+1000),/AUTHORIZATION_CLOSED/);
 assert.equal(f.db.prepare('SELECT count(*) n FROM operations').get().n,0);assert.equal(f.db.prepare('SELECT count(*) n FROM budgets').get().n,0);
});
test('evidence-save failure leaves an unresolved pending slot and prevents ordinary progression',async t=>{
 const f=await fixture(t);f.session.start();f.session.prepare('campaignBefore',f.manifest.calls.campaignBefore);
 f.db.exec("CREATE TRIGGER fixture_fail_evidence BEFORE INSERT ON journal WHEN NEW.event='INTERNAL_PILOT_RESPONSE_SAVED' BEGIN SELECT RAISE(ABORT,'fixture evidence failure'); END;");
 assert.throws(()=>f.session.record('campaignBefore',envelope(f.campaign)),/fixture evidence failure/);assert.throws(()=>f.session.prepare('leadBefore',f.manifest.calls.leadBefore),/PENDING_RECONCILIATION/);
 assert.equal(getRecord(f.db,'internal_pilot_call',`${f.manifest.id}:campaignBefore`).state,'DISPATCH_INTENT');
 f.session.finish('EVIDENCE_SAVE_FAILURE');assert.equal(getRecord(f.db,'internal_pilot_call',`${f.manifest.id}:campaignBefore`).state,'UNRESOLVED');
});
test('captured list-emails contract validates the exact internal account filter without inventing response fields',async t=>{
 const f=await fixture(t);assert.equal(typeof f.api.validateInternalPilotReplyContract,'function');
 const evidence=f.api.validateInternalPilotReplyContract(readFileSync('work/instantly-contract-capture-v1/live-once/selected-contracts-03.json','utf8'));
 assert.equal(evidence.requestValid,true);assert.equal(evidence.liveResponseShapeEstablished,false);assert.throws(()=>f.api.validateInternalPilotReplyContract('{}'),/CAPTURE/);
});
test('analytics are unavailable and cannot consume either safety attempt',async t=>{
 const f=await fixture(t);scheduled(f);f.session.prepare('activate',f.manifest.calls.activate);f.session.record('activate',{content:[],isError:false});
 for(const key of ['observe1','observe2']){assert.equal(Object.hasOwn(f.manifest.calls,key),false);assert.throws(()=>f.session.plannedCall(key),/CALL_MISMATCH/);assert.throws(()=>f.session.prepare(key,{}),/CALL_MISMATCH/);}
 assert.equal(f.session.state().counts.main,6);assert.equal(f.session.state().counts.safety,0);
 f.setClock('2026-11-18T17:28:00Z');f.session.prepare('pause',f.manifest.calls.pause);f.session.record('pause',{content:[],isError:false});f.campaign.status=2;f.run('campaignFinal',f.campaign);
 assert.equal(f.session.state().counts.safety,2);assert.equal(f.session.state().counts.total,12);
});
test('simultaneous independent SQLite sessions produce one claimant without a second dispatch owner',async t=>{
 const f=await fixture(t,{file:true}),barrier=new SharedArrayBuffer(4),workers=[];
 const source=`const {parentPort,workerData}=require('node:worker_threads');(async()=>{const {DatabaseSync}=await import('node:sqlite');const {createInternalPilotSession}=await import(workerData.module);const db=new DatabaseSync(workerData.path);db.exec('PRAGMA busy_timeout=5000;');parentPort.postMessage({ready:true});Atomics.wait(new Int32Array(workerData.barrier),0,0,10000);try{const s=createInternalPilotSession({db,root:workerData.root,manifest:workerData.manifest,invocationId:workerData.owner,now:()=>workerData.time});s.start();parentPort.postMessage({claimed:true,owner:workerData.owner});}catch(e){parentPort.postMessage({claimed:false,reason:e.message});}finally{db.close();}})().catch(e=>parentPort.postMessage({error:e.message}));`;
 const attempts=['one','two'].map(owner=>{let readyResolve,doneResolve,fail;const ready=new Promise(r=>{readyResolve=r;}),done=new Promise((r,j)=>{doneResolve=r;fail=j;});const w=new Worker(source,{eval:true,workerData:{module:new URL('../src/instantly-internal-pilot.mjs',import.meta.url).href,path:f.path,root,manifest:f.manifest,owner,barrier,time}});workers.push(w);w.on('error',fail);w.on('message',m=>{if(m.ready)readyResolve();else if(m.error)fail(Error(m.error));else doneResolve(m);});return {ready,done};});
 t.after(async()=>{await Promise.all(workers.map(w=>w.terminate()));});await Promise.all(attempts.map(x=>x.ready));Atomics.store(new Int32Array(barrier),0,1);Atomics.notify(new Int32Array(barrier),0);
 const results=await Promise.all(attempts.map(x=>x.done));assert.equal(results.filter(x=>x.claimed).length,1);assert.equal(results.filter(x=>x.reason==='INTERNAL_PILOT_ALREADY_STARTED').length,1);
 assert.equal(f.db.prepare("SELECT count(*) n FROM journal WHERE event='ACCEPTANCE_LAUNCHED_ONCE'").get().n,1);assert.equal(f.db.prepare("SELECT count(*) n FROM records WHERE kind='internal_pilot_call' AND id LIKE 'elya-internal-send-pilot-v3:%'").get().n,5);
});
for(const outcome of ['success','error','uncertain'])test(`safety ${outcome} permanently blocks subsequent activation while retaining final status read`,async t=>{
 const f=await fixture(t);scheduled(f);f.session.prepare('pause',f.manifest.calls.pause);
 if(outcome==='uncertain')f.session.uncertain('pause');else f.session.record('pause',{content:[],isError:outcome==='error'});
 assert.throws(()=>f.session.prepare('activate',f.manifest.calls.activate),/SAFETY_STARTED/);
 f.campaign.status=2;f.run('campaignFinal',f.campaign);assert.equal(f.session.state().finalPause,'CONFIRMED');
 assert.throws(()=>f.session.prepare('activate',f.manifest.calls.activate),/SAFETY_STARTED/);
});
test('main-window expiry blocks new provider calls even when no earlier safety action exists',async t=>{
 const f=await fixture(t);scheduled(f);f.setClock('2026-11-18T17:29:00Z');
 assert.throws(()=>f.session.prepare('activate',f.manifest.calls.activate),/MAIN_DEADLINE/);assert.throws(()=>f.session.prepare('pause',f.manifest.calls.pause),/MAIN_DEADLINE/);
 assert.equal(f.session.state().counts.total,9);assert.equal(f.session.state().finalPause,'UNCONFIRMED');
});
test('reported manual pause prevents ordinary observations but keeps reserved pause/readback available',async t=>{
 const f=await fixture(t);scheduled(f);f.session.prepare('activate',f.manifest.calls.activate);f.session.record('activate',{content:[],isError:false});
 f.session.confirmReceiptAndPause({received:true,paused:true,evidence:'user observes marked receipt and native pause'});f.setClock('2026-11-18T17:20:00Z');
 assert.throws(()=>f.session.prepare('observe1',{}),/CALL_MISMATCH/);f.session.prepare('pause',f.manifest.calls.pause);assert.equal(f.session.state().counts.safety,1);
});
test('inherited read-only QA browser inspection preserves fourth preflight allowance and cannot be repeated',async t=>{
 const f=await fixture(t);f.session.start();assert.equal(typeof f.session.recordBrowserInspection,'function');
 assert.equal(f.session.state().counts.extra,4);assert.equal(f.session.state().counts.total,5);assert.equal(f.session.state().browserInspectionCount,1);
 assert.throws(()=>f.session.recordBrowserInspection({observedAt:'2026-11-18T17:00:00Z',evidence:'same view'}),/ALREADY_RECORDED/);
 const record=getRecord(f.db,'internal_pilot_call',`${f.manifest.id}:browserQaView`);assert.equal(record.providerToolAttempt,false);assert.equal(record.underlyingNetworkRequests,'UNOBSERVED');
});
test('fresh immediate profile requires closed prior attempts and carries all five consumed slots',async t=>{
 const f=await fixture(t);assert.equal(f.manifest.id,'elya-internal-send-pilot-v3');
 f.session.start();assert.equal(f.session.state().counts.total,5);assert.equal(f.session.state().counts.extra,4);
 const inherited=getRecord(f.db,'internal_pilot_call',f.manifest.id+':inheritedCampaignBefore');assert.equal(inherited.inheritedFrom.recordId,'elya-internal-send-pilot-v2:campaignBefore');assert.equal(inherited.state,'UNRESOLVED');
 assert.throws(()=>f.session.prepare('blockEmail',f.manifest.calls.blockEmail),/ALREADY_ATTEMPTED/);
});
test('v3 cannot arm while a prior authorization remains active',async t=>{
 const f=await fixture(t),db=openStore(':memory:');t.after(()=>db.close());
 putRecord(db,'acceptance_authorization','elya-internal-send-pilot-v1',{status:'CLAIMED'});putRecord(db,'acceptance_result','elya-internal-send-pilot-v1',{authorizationStatus:'CLOSED'});
 assert.throws(()=>armAcceptance(db,f.manifest,f.sources,time,{executionApproval:{type:'EXPLICIT_LIVE_EXECUTION_APPROVAL',manifestHash:digest(canonical(f.manifest)),reference:'offline',approvedAt:new Date(time).toISOString()}}),/PRIOR_CLOSED_AUTHORIZATION_REQUIRED/);
 assert.equal(getRecord(db,'acceptance_authorization',f.manifest.id),null);
});
for(const patch of [{status:'ACTIVE'},{pending:'activate'},{mutationAttempted:true},{counts:{total:6,extra:4,main:2,safety:0,reply:0,mutations:0}}])test(`v3 refuses nonclean prior session ${Object.keys(patch)[0]} without consuming new authorization`,async t=>{
 const f=await fixture(t),old=getRecord(f.db,'internal_pilot_session','elya-internal-send-pilot-v2');putRecord(f.db,'internal_pilot_session','elya-internal-send-pilot-v2',{...old,...patch});
 assert.throws(()=>f.session.start(),/PRIOR_CLEAN_CLOSURE_REQUIRED/);assert.equal(getRecord(f.db,'acceptance_authorization',f.manifest.id).status,'APPROVED');
});
test('claim fixes 25-minute deadline and five-minute preparation gate; actual schedule is frozen once at current minute',async t=>{
 const f=await fixture(t);ready(f);assert.equal(f.session.state().mainStartedAt,'2026-11-18T17:04:00.000Z');assert.equal(f.session.state().activationDeadlineAt,'2026-11-18T17:09:00.000Z');assert.equal(f.session.state().mainDeadlineAt,'2026-11-18T17:29:00.000Z');assert.equal(f.session.state().pauseBy,'2026-11-18T17:28:00.000Z');
 f.setClock('2026-11-18T17:04:34Z');const first=f.session.plannedCall('schedule');assert.deepEqual(first.arguments.campaign_schedule.schedules[0].timing,{from:'12:04',to:'12:28'});
 const resumed=f.api.createInternalPilotSession({db:f.db,root,manifest:f.manifest,invocationId:'fixture-owner',now:()=>Date.parse('2026-11-18T17:05:10Z')});assert.deepEqual(resumed.plannedCall('schedule'),first);assert.throws(()=>resumed.prepare('schedule',first),/SCHEDULE_PLAN_STALE/);assert.equal(f.session.state().counts.mutations,0);assert.equal(f.session.state().mainDeadlineAt,'2026-11-18T17:29:00.000Z');
});
test('same-minute schedule plan dispatches immediately and changed schedule is rejected',async t=>{
 const f=await fixture(t);ready(f);f.setClock('2026-11-18T17:04:10Z');const first=f.session.plannedCall('schedule'),changed=structuredClone(first);changed.arguments.campaign_schedule.schedules[0].timing.from='12:05';assert.throws(()=>f.session.prepare('schedule',changed),/CALL_MISMATCH/);f.setClock('2026-11-18T17:04:20Z');f.session.prepare('schedule',first);assert.equal(f.session.state().counts.mutations,1);
});
test('the exact approved renderer differences are accepted and any other configuration difference blocks mutation',async t=>{
 const f=await fixture(t);f.session.start();const variant=f.campaign.sequences[0].steps[0].variants[0];assert.equal(variant.body,'<div>{{pilot_body_1}}</div><div><br /></div>');assert.equal(variant.v_disabled,false);variant.v_disabled=true;assert.equal(f.run('campaignBefore',f.campaign).error,'INTERNAL_PILOT_CAMPAIGN_PRECONDITION');assert.equal(f.session.state().counts.mutations,0);
});
test('outer validity cannot roll immediate authorization onto another New York date',async t=>{
 const f=await fixture(t);f.setClock('2026-11-19T05:00:00Z');assert.throws(()=>f.session.start(),/APPROVED_DATE_REQUIRED/);assert.equal(getRecord(f.db,'acceptance_authorization',f.manifest.id).status,'APPROVED');
});
