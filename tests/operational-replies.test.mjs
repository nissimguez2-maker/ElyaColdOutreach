import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync,mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {openStore,putRecord,getRecord,setStopped,controls} from '../src/store.mjs';
import {createBudget} from '../src/operations.mjs';
import {canonical,digest} from '../src/values.mjs';
import {pollProviderReplies} from '../src/monitoring-provider.mjs';
import {monitoringReport} from '../src/monitoring.mjs';
import {previewReplyDelivery,prepareMonitoringReportDelivery,deliverReplyNotification} from '../src/monitoring-delivery.mjs';
import {fixtureReplyContract} from './fixtures/monitoring-provider-fixture.mjs';

const at='2026-11-19T15:00:00.000Z',expiresAt='2026-11-19T16:00:00.000Z';
const campaignId='aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',leadId='bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb',organizationId='cccccccc-cccc-cccc-cccc-cccccccccccc';
const rawCapture=readFileSync('work/instantly-contract-capture-v1/live-once/selected-contracts-03.json','utf8');
const sample=()=>{
 const p=JSON.parse(readFileSync('work/internal-pilot-live-v3/response-reply1.json','utf8')).structuredContent;
 const i=p.items[0];Object.assign(i,{campaign_id:campaignId,organization_id:organizationId,from_address_email:'reply@example.invalid',lead:'reply@example.invalid',eaccount:'sender@example.invalid',to_address_email_list:'sender@example.invalid'});
 i.from_address_json=[{name:'Fixture recipient',address:'reply@example.invalid'}];i.to_address_json=[{name:'Fixture sender',address:'sender@example.invalid'}];
 return p;
};
const envelope=page=>({content:[{type:'text',text:JSON.stringify(page)}],structuredContent:page,isError:false});
async function fixture(t){
 const module=await import('../src/instantly-reply-bridge.mjs').catch(()=>null);
 assert.equal(typeof module?.createInstantlyReplyServices,'function','captured reply bridge required');
 const dir=mkdtempSync(join(tmpdir(),'elya-replies-')),path=join(dir,'state.sqlite');let db=openStore(path);
 t.after(()=>{db.close();rmSync(dir,{recursive:true,force:true});});setStopped(db,false,'isolated fixture');createBudget(db,'fixture','1','0','0');
 putRecord(db,'telegram_binding','primary',{confirmed:true,testOnly:true,userId:42,chatId:42,botId:777});
 putRecord(db,'candidate','fixture-candidate',{synthetic:true});putRecord(db,'campaign',campaignId,{synthetic:true});putRecord(db,'contact','reply@example.invalid',{candidateId:'fixture-candidate'});
 putRecord(db,'provider_lead_mapping',digest(canonical({provider:'instantly',campaignId,leadId})),{provider:'instantly',campaignId,leadId,email:'reply@example.invalid',candidateId:'fixture-candidate',evidenceRef:'fixture:confirmed-mapping'});
 const configuration={enabled:true,contract:fixtureReplyContract,scope:{campaignId,senderEmail:'sender@example.invalid',organizationId},pagination:{continuation:'NEXT_STARTING_AFTER',termination:'MISSING_NEXT_STARTING_AFTER',evidenceRef:'fixture:opaque-cursor'}};
 function services(pages,mutate={},config=configuration){let read=0;return module.createInstantlyReplyServices(db,{rawCapture,configuration:config,executor:{mode:'offline',async execute(call,options){assert.equal(call.server,'codex_apps');assert.equal(call.tool,'instantly_ai.list_emails');assert.equal(call.arguments.campaign_id,campaignId);assert.equal(call.arguments.eaccount,'sender@example.invalid');assert.equal(call.arguments.email_type,'received');assert.equal(call.arguments.limit,10);if(read>0)assert.equal(call.arguments.starting_after,pages[read-1].next_starting_after);options.signal.throwIfAborted();const payload=envelope(structuredClone(pages[Math.min(read++,pages.length-1)]));return {payload,evidenceRef:`fixture:read-${read}`,actualUsd:'0'};},...mutate}});}
 function options(s,extra={}){putRecord(db,'monitor_poll_authorization','fixture-grant',{id:'fixture-grant',status:'APPROVED',enabled:true,streamId:'fixture-stream',campaignId,contractHash:s.replyDecoder.contractHash,budgetId:'fixture',reservationUsd:'0',approvedAt:at,expiresAt,maxPages:10,pageSize:10,timeoutMs:1000,transportMode:'offline',evidenceRef:'fixture:scoped-authority'});return {runId:'fixture-run',streamId:'fixture-stream',campaignId,authorizationId:'fixture-grant',decoder:s.replyDecoder,transport:s.replyTransport,enabled:true,maxPages:10,pageSize:10,timeoutMs:1000,clock:()=>at,...extra};}
 return {module,get db(){return db;},configuration,services,options,reopen(){db.close();db=openStore(path);}};
}
const records=(db,kind)=>db.prepare('SELECT id,data_json FROM records WHERE kind=?').all(kind).map(r=>({id:r.id,...JSON.parse(r.data_json)}));

test('captured reply flows through generic polling to durable searchable notification without a fabricated URL',async t=>{
 const f=await fixture(t),p=sample(),s=f.services([p,{items:[]}]);const before=controls(f.db);
 assert.equal((await pollProviderReplies(f.db,f.options(s))).status,'COMPLETE');
 const events=records(f.db,'provider_event'),notifications=records(f.db,'reply_notification');assert.equal(events.length,1);assert.equal(notifications.length,1);
 assert.equal(events[0].event.conversation.threadId,'e0-fLNQuDa7NQh2qdOa9T-0RwI');assert.equal(events[0].event.conversation.url,null);assert.equal(events[0].event.conversation.bodyTruncated,true);
 const preview=previewReplyDelivery(f.db,notifications[0].id);assert.match(preview.pages[0].text,/Thread: e0-fLNQuDa7NQh2qdOa9T-0RwI/);assert.match(preview.pages[0].text,/Native search: reply@example.invalid/);assert.match(preview.pages[0].text,/truncated/i);assert.match(preview.pages[0].text,/refusal scope/i);assert.doesNotMatch(preview.pages[0].text,/app\.instantly/);
 assert.deepEqual(controls(f.db),before);assert.equal(records(f.db,'contact')[0].suppressed,undefined);
 await assert.rejects(deliverReplyNotification(f.db,notifications[0].id,{mode:'OFFLINE_FIXTURE',sendPage(){throw Error('must not dispatch');}},{enabled:false}),/DISABLED/);
});
test('disabled adapter cannot call executor or reserve an operation',async t=>{
 const f=await fixture(t);let calls=0;const s=f.services([sample()],{execute(){calls++;throw Error();}},{...f.configuration,enabled:false});
 await assert.rejects(pollProviderReplies(f.db,f.options(s)),/MONITOR_INSTANTLY_ADAPTER_DISABLED/);assert.equal(calls,0);assert.equal(f.db.prepare('SELECT count(*) n FROM operations').get().n,0);
});
test('pagination requires explicit reviewed continuation and termination instead of guessing from an empty page',async t=>{
 const f=await fixture(t);
 for(const pagination of [null,{...f.configuration.pagination,termination:'UNKNOWN'},{...f.configuration.pagination,continuation:'UNKNOWN'}])assert.throws(()=>f.services([],{},{...f.configuration,pagination}),/MONITOR_INSTANTLY_PAGINATION_CONTRACT_REQUIRED/);
 assert.equal(f.db.prepare('SELECT count(*) n FROM operations').get().n,0);
});
test('repeated delayed event after restart is deduplicated despite a new evidence pointer',async t=>{
 const f=await fixture(t),p=sample(),s=f.services([p]);await pollProviderReplies(f.db,f.options(s,{maxPages:1}));f.reopen();
 const duplicate=sample();delete duplicate.next_starting_after;
 const s2=f.services([duplicate]);await pollProviderReplies(f.db,f.options(s2,{runId:'resume'}));
 assert.equal(records(f.db,'provider_event').length,1);assert.equal(records(f.db,'reply_notification').length,1);assert.equal(getRecord(f.db,'monitor_checkpoint','fixture-stream').complete,true);
});
for(const [label,change,reason]of [
 ['unknown direction',i=>{i.ue_type=9;},'OBSERVED_REPLY_VARIANT_UNSUPPORTED'],
 ['ambiguous association',i=>{i.lead='someone@example.invalid';},'OBSERVED_REPLY_ASSOCIATION_MISMATCH'],
 ['wrong organization',i=>{i.organization_id='dddddddd-dddd-dddd-dddd-dddddddddddd';},'OBSERVED_REPLY_ASSOCIATION_MISMATCH'],
 ['malformed timestamp',i=>{i.timestamp_email='invalid';},'OBSERVED_REPLY_TIMESTAMP_INVALID'],
])test(`${label} remains visible for operator review without advancing or suppressing`,async t=>{
 const f=await fixture(t),p=sample();change(p.items[0]);const s=f.services([p]);
 await assert.rejects(pollProviderReplies(f.db,f.options(s)),new RegExp(reason));
 assert.equal(getRecord(f.db,'monitor_checkpoint','fixture-stream'),null);assert.equal(records(f.db,'provider_event').length,0);
 const report=monitoringReport(f.db,{campaignId,includeSynthetic:true},at);assert.equal(report.escalations.length,1);assert.equal(report.escalations[0].code,reason);assert.equal(report.escalations[0].status,'OPEN');
 const preview=prepareMonitoringReportDelivery(f.db,{reportId:'errors',campaignId,includeSynthetic:true},at);assert.match(preview.pages[0].text,new RegExp(reason));assert.equal(records(f.db,'contact')[0].suppressed,undefined);
});
test('conflicting envelope variants are rejected with visible evidence rather than choosing the convenient form',async t=>{
 const f=await fixture(t),s=f.services([],{async execute(){const payload=envelope(sample());payload.content[0].text='{"items":[]}';return {payload,evidenceRef:'fixture:conflicting-envelope',actualUsd:'0'};}});
 await assert.rejects(pollProviderReplies(f.db,f.options(s)),/REPRESENTATIONS_CONFLICT/);assert.equal(records(f.db,'monitor_escalation')[0].evidenceRef,'fixture:conflicting-envelope');
});
test('same reply id with a changed RFC or thread identity fails atomically after restart',async t=>{
 const f=await fixture(t),s=f.services([sample()]);await pollProviderReplies(f.db,f.options(s,{maxPages:1}));f.reopen();
 const p=sample();p.items[0].thread_id='conflicting-thread';delete p.next_starting_after;const second=f.services([p]);
 await assert.rejects(pollProviderReplies(f.db,f.options(second,{runId:'second'})),/IDENTITY_MISMATCH/);
 assert.equal(records(f.db,'reply_notification').length,1);assert.equal(getRecord(f.db,'monitor_checkpoint','fixture-stream').complete,false);
});
test('cursor cycles across separate runs fail before consuming the looping page',async t=>{
 const f=await fixture(t),p=sample();p.next_starting_after='cursor-a';await pollProviderReplies(f.db,f.options(f.services([p]),{maxPages:1}));f.reopen();
 await pollProviderReplies(f.db,f.options(f.services([{items:[],next_starting_after:'cursor-b'}]),{runId:'second',maxPages:1}));
 await assert.rejects(pollProviderReplies(f.db,f.options(f.services([{items:[],next_starting_after:'cursor-a'}]),{runId:'third',maxPages:1})),/CURSOR_LOOP/);
 assert.equal(getRecord(f.db,'monitor_checkpoint','fixture-stream').cursor,'cursor-b');
});
test('received page survives an atomic persistence failure and restarts locally without another read',async t=>{
 const f=await fixture(t),p=sample();delete p.next_starting_after;let calls=0;const s=f.services([p],{async execute(){calls++;return {payload:envelope(p),evidenceRef:'fixture:received',actualUsd:'0'};}}),o=f.options(s);
 f.db.exec("CREATE TEMP TRIGGER fail_reply_commit BEFORE INSERT ON records WHEN NEW.kind='reply_notification' BEGIN SELECT RAISE(ABORT,'fixture persistence fault'); END;");
 await assert.rejects(pollProviderReplies(f.db,o),/fixture persistence fault/);assert.equal(records(f.db,'provider_event').length,0);assert.equal(getRecord(f.db,'monitor_checkpoint','fixture-stream'),null);f.reopen();
 assert.equal((await pollProviderReplies(f.db,o)).status,'COMPLETE');assert.equal(calls,1);assert.equal(records(f.db,'reply_notification').length,1);
});
