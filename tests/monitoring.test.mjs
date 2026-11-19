import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {openStore,putRecord,getRecord,setStopped,setLaunch} from '../src/store.mjs';
import {createBatch} from '../src/batches.mjs';
import {createBudget,reserveOperation} from '../src/operations.mjs';
import {writingTelegramFixture} from './helpers/telegram-writing-fixture.mjs';
import {decideWritingReview} from '../src/writing.mjs';
import {canonical,digest} from '../src/values.mjs';
import {registerLeadMapping,ingestReplyPage,dispatchReplyNotification,reconcileReplyNotification,recoverMonitoring,monitoringReport,recordMonitoringFailure} from '../src/monitoring.mjs';

const at='2026-11-16T17:00:00Z',expiresAt='2026-11-16T18:00:00Z';
function fixture(t){
 const dir=mkdtempSync(join(tmpdir(),'elya-monitor-')),path=join(dir,'state.sqlite');let db=openStore(path);
 t.after(()=>{db.close();rmSync(dir,{recursive:true,force:true});});
 setStopped(db,false,'isolated fixture');setLaunch(db,true,'isolated fixture');createBudget(db,'fixture','1','0','0');
 putRecord(db,'telegram_binding','primary',{confirmed:true,testOnly:true,userId:42,chatId:42,botId:777});
 putRecord(db,'candidate','candidate',{qualification:'QUALIFIED',synthetic:true});
 putRecord(db,'contact','qa@example.invalid',{candidateId:'candidate',attribution:'fixture',verification:'PASSED',suppressed:false});
 createBatch(db,'batch',{campaignId:'fixture-campaign',recipients:[{candidateId:'candidate',email:'qa@example.invalid',messages:[{subject:'Fixture',body:'Fixture only'}]}],sequence:{},settings:{}});
 reserveOperation(db,{id:'fixture-import',kind:'RELEASE',budgetId:'fixture',reservation:'0',authorizationRef:'offline-fixture',payload:{batchId:'batch',approvalId:'fixture-approval'}});
 // Unit seed models the completed handoff receipt; E2E exercises the actual import adapter.
 db.prepare("UPDATE operations SET status='SUCCEEDED',actual_usd='0',remote_id='lead-1',evidence='fixture-only import' WHERE id='fixture-import'").run();
 const mapping={provider:'instantly',campaignId:'fixture-campaign',leadId:'lead-1',candidateId:'candidate',email:'qa@example.invalid',importOperationId:'fixture-import',evidenceRef:'fixture:import'};
 putRecord(db,'handoff_import',digest(canonical({campaignId:mapping.campaignId,email:mapping.email})),{...mapping,status:'IMPORTED',variablesHash:'fixture'});
 registerLeadMapping(db,mapping);
 return {get db(){return db;},mapping,reopen(){db.close();db=openStore(path);}};
}
const event=(extra={})=>({version:1,provider:'instantly',eventId:'reply-1',type:'REPLIED',campaignId:'fixture-campaign',leadId:'lead-1',email:'qa@example.invalid',occurredAt:at,evidenceRef:'fixture:reply',excerpt:'Please send details.',...extra});
const page=(events=[event()],extra={})=>({streamId:'fixture-stream',campaignId:'fixture-campaign',expectedCursor:null,nextCursor:'page-2',events,evidenceRef:'fixture:page',...extra});
const options=(extra={})=>({budgetId:'fixture',authorizationRef:'fixture-notification',expiresAt,allowWhileStopped:false,at,...extra});

test('legacy reply receives attributable conversation metadata once without a second notification',t=>{
 const f=fixture(t),first=ingestReplyPage(f.db,page(),at),id=first.notificationIds[0];
 const conversation={recordId:'reply-1',rfcMessageId:'<fixture@example.invalid>',threadId:'thread-1',organizationId:'fixture-org',senderEmail:'sender@example.invalid',subject:'Synthetic',url:null,bodyTruncated:true};
 const enriched=event({conversation,evidenceRef:'fixture:enriched'});
 assert.equal(ingestReplyPage(f.db,page([enriched],{expectedCursor:'page-2',nextCursor:'page-3'}),at).inserted,0);
 const saved=getRecord(f.db,'provider_event',id);assert.deepEqual(saved.event.conversation,conversation);
 assert.equal(saved.event.evidenceRef,'fixture:reply');assert.equal(saved.conversationEvidenceRef,'fixture:enriched');
 assert.equal(f.db.prepare("SELECT count(*) n FROM records WHERE kind='reply_notification'").get().n,1);
 assert.equal(ingestReplyPage(f.db,page([event()],{expectedCursor:'page-3',nextCursor:'page-4'}),at).inserted,0);
 assert.throws(()=>ingestReplyPage(f.db,page([event({conversation:{...conversation,threadId:'conflicting'}})],{expectedCursor:'page-4',nextCursor:null}),at),/IDENTITY/);
 assert.equal(getRecord(f.db,'monitor_checkpoint','fixture-stream').cursor,'page-4');
 assert.deepEqual(getRecord(f.db,'provider_event',id).event.conversation,conversation);
});

test('validated page atomically deduplicates replies, creates one notification and advances its checkpoint',t=>{
 const f=fixture(t),result=ingestReplyPage(f.db,page(),at);
 assert.equal(result.inserted,1);assert.equal(result.notificationIds.length,1);
 const duplicate=ingestReplyPage(f.db,page(),at);assert.equal(duplicate.duplicate,true);
 assert.equal(f.db.prepare("SELECT count(*) n FROM records WHERE kind='reply_notification'").get().n,1);
 assert.equal(getRecord(f.db,'monitor_checkpoint','fixture-stream').cursor,'page-2');
 const report=monitoringReport(f.db,{campaignId:'fixture-campaign',includeSynthetic:true},at);
 assert.equal(report.replied.observedCount,1);assert.equal(report.sent.observedCount,0);assert.equal(report.sent.total,null);assert.equal(report.scheduled.total,null);
 assert.equal(report.prepared.observedCount,1);assert.equal(report.imported.observedCount,1);
});
test('wrong mapping, reused event identity, or one malformed page member cannot consume a cursor',t=>{
 const f=fixture(t);
 assert.throws(()=>ingestReplyPage(f.db,page([event(),event({eventId:'wrong',leadId:'unknown'})]),at),/MAPPING/);
 assert.equal(getRecord(f.db,'monitor_checkpoint','fixture-stream'),null);
 assert.equal(f.db.prepare("SELECT count(*) n FROM records WHERE kind='provider_event'").get().n,0);
 ingestReplyPage(f.db,page(),at);
 assert.throws(()=>ingestReplyPage(f.db,page([event({excerpt:'changed'})],{expectedCursor:'page-2',nextCursor:'page-3'}),at),/IDENTITY/);
 assert.equal(getRecord(f.db,'monitor_checkpoint','fixture-stream').cursor,'page-2');
 assert.equal(getRecord(f.db,'monitor_health','fixture-stream').state,'FAILED');
});
test('out-of-order pages cannot replace a checkpoint and exact evidence duplicates do not notify twice',t=>{
 const f=fixture(t);ingestReplyPage(f.db,page(),at);
 assert.throws(()=>ingestReplyPage(f.db,page([event({eventId:'reply-2'})],{nextCursor:'wrong'}),at),/CHECKPOINT/);
 const r=ingestReplyPage(f.db,page([event()],{expectedCursor:'page-2',nextCursor:'page-3'}),at);
 assert.equal(r.inserted,0);assert.equal(r.notificationIds.length,0);
});
test('repeated event evidence from another page remains idempotent and a completed backfill cannot restart silently',t=>{
 const f=fixture(t);ingestReplyPage(f.db,page(),at);
 const r=ingestReplyPage(f.db,page([event({evidenceRef:'fixture:backfill-copy'})],{expectedCursor:'page-2',nextCursor:null}),at);
 assert.equal(r.inserted,0);assert.equal(getRecord(f.db,'monitor_checkpoint','fixture-stream').complete,true);
 assert.throws(()=>ingestReplyPage(f.db,page([event({eventId:'another'})],{expectedCursor:null,nextCursor:'again'}),at),/BACKFILL_COMPLETE/);
});
test('lead mapping is bound to the imported immutable batch rather than a later batch version',t=>{
 const f=fixture(t);createBatch(f.db,'batch',{campaignId:'changed-campaign',recipients:[{candidateId:'candidate',email:'qa@example.invalid',messages:[{subject:'Later',body:'Later'}]}],sequence:{},settings:{}});
 assert.deepEqual(registerLeadMapping(f.db,f.mapping),f.mapping);
 assert.throws(()=>registerLeadMapping(f.db,{...f.mapping,campaignId:'changed-campaign',leadId:'wrong-lead'}),/RECIPIENT/);
});
test('a successful batch import cannot authorize an unrelated provider lead ID',t=>{
 const f=fixture(t);
 f.db.prepare("DELETE FROM records WHERE kind='provider_lead_mapping'").run();
 assert.throws(()=>registerLeadMapping(f.db,{...f.mapping,leadId:'unrelated-lead'}),/MAPPING_IMPORT_EVIDENCE/);
 assert.equal(f.db.prepare("SELECT count(*) n FROM records WHERE kind='provider_lead_mapping'").get().n,0);
});
test('notification delivery commits once and survives restart without resend',async t=>{
 const f=fixture(t),id=ingestReplyPage(f.db,page(),at).notificationIds[0];let sends=0;
 const transport={mode:'offline',async send(payload){sends++;assert.equal(payload.chatId,42);assert.match(payload.text,/qa@example.invalid/);return {status:'DELIVERED',remoteId:'message-1',actualUsd:'0',evidenceRef:'fixture:sent'};}};
 assert.equal((await dispatchReplyNotification(f.db,id,transport,options())).status,'DELIVERED');
 f.reopen();assert.equal((await dispatchReplyNotification(f.db,id,transport,options())).status,'DELIVERED');assert.equal(sends,1);
});
test('outbox commit failure cannot record a successful operation without its notification outcome',async t=>{
 const f=fixture(t),id=ingestReplyPage(f.db,page(),at).notificationIds[0];
 f.db.exec("CREATE TEMP TRIGGER fail_notification_commit BEFORE UPDATE ON records WHEN NEW.kind='reply_notification' AND json_extract(NEW.data_json,'$.status')='DELIVERED' BEGIN SELECT RAISE(ABORT,'fixture commit failure'); END;");
 await assert.rejects(dispatchReplyNotification(f.db,id,{mode:'offline',async send(){return {status:'DELIVERED',remoteId:'message-1',actualUsd:'0',evidenceRef:'fixture:delivered'};}},options()),/fixture commit failure/);
 const n=getRecord(f.db,'reply_notification',id);
 assert.equal(n.status,'DISPATCHING');assert.equal(f.db.prepare('SELECT status FROM operations WHERE id=?').get(n.operationId).status,'DISPATCHING');
 assert.equal(recoverMonitoring(f.db,at)[0].status,'RECONCILIATION');
});
test('uncertain notification is held through restart until explicit reconciliation',async t=>{
 const f=fixture(t),id=ingestReplyPage(f.db,page(),at).notificationIds[0];let sends=0;
 const transport={mode:'offline',async send(){sends++;throw Error('fixture timeout');}};
 assert.equal((await dispatchReplyNotification(f.db,id,transport,options())).status,'RECONCILIATION');
 f.reopen();recoverMonitoring(f.db);
 await assert.rejects(dispatchReplyNotification(f.db,id,transport,options()),/RECONCILIATION/);assert.equal(sends,1);
 assert.equal(reconcileReplyNotification(f.db,id,{status:'DELIVERED',remoteId:'message-1',actualUsd:'0',evidenceRef:'fixture:checked'},at).status,'DELIVERED');
});
test('only definitive no-dispatch evidence allows bounded notification retry',async t=>{
 const f=fixture(t),id=ingestReplyPage(f.db,page(),at).notificationIds[0];let sends=0;
 const transport={mode:'offline',async send(){sends++;return {status:'NOT_DISPATCHED',actualUsd:'0',evidenceRef:'fixture:predispatch'};}};
 assert.equal((await dispatchReplyNotification(f.db,id,transport,options())).status,'PENDING');
 assert.equal((await dispatchReplyNotification(f.db,id,transport,options())).status,'FAILED');
 await assert.rejects(dispatchReplyNotification(f.db,id,transport,options()),/ATTEMPTS/);assert.equal(sends,2);
});
test('stop, changed Telegram binding, invalid transport and exhausted budget block notification dispatch',async t=>{
 const f=fixture(t),id=ingestReplyPage(f.db,page(),at).notificationIds[0];let sends=0;
 const transport={mode:'offline',async send(){sends++;return {status:'DELIVERED',remoteId:'m',actualUsd:'0',evidenceRef:'fixture:sent'};}};
 setStopped(f.db,true,'fixture');await assert.rejects(dispatchReplyNotification(f.db,id,transport,options()),/STOPPED/);
 setStopped(f.db,false,'fixture');await assert.rejects(dispatchReplyNotification(f.db,id,{...transport,mode:'live'},options()),/OFFLINE/);
 f.db.prepare("UPDATE budgets SET blocked=1 WHERE id='fixture'").run();await assert.rejects(dispatchReplyNotification(f.db,id,transport,options()),/Budget/);
 f.db.prepare("UPDATE budgets SET blocked=0 WHERE id='fixture'").run();putRecord(f.db,'telegram_binding','primary',{confirmed:true,userId:42,chatId:99,botId:777});
 await assert.rejects(dispatchReplyNotification(f.db,id,transport,options()),/BINDING/);assert.equal(sends,0);
});
test('monitoring failures and remote unknowns stay visible without deriving sends from imports',t=>{
 const f=fixture(t);recordMonitoringFailure(f.db,'fixture-stream','SCHEMA_UNSUPPORTED','fixture:error',at);
 const r=monitoringReport(f.db,{campaignId:'fixture-campaign',includeSynthetic:true},at);assert.equal(r.health[0].state,'FAILED');assert.equal(r.sent.total,null);assert.equal(r.sent.observedCount,0);assert.equal(r.autonomousRepliesEnabled,false);
 assert.throws(()=>registerLeadMapping(f.db,{...f.mapping,email:'wrong@example.invalid'}),/MAPPING|RECIPIENT/);
});
test('prepared and content-approved reviews are reported before a handoff batch exists',t=>{
 const f=writingTelegramFixture();t.after(()=>f.db.close());
 const before=monitoringReport(f.db,{campaignId:f.packet.campaignId,includeSynthetic:true},'2026-11-16T22:00:00Z');
 assert.equal(before.prepared.observedCount,1);assert.equal(before.approved.observedCount,0);
 decideWritingReview(f.db,{actionId:'fixture-content-approval',reviewId:f.packet.reviewId,packetHash:f.packet.hash,actor:'Daniel Rosen',at:'2026-11-16T22:00:00Z',expiresAt:'2026-11-16T23:00:00Z',decision:'APPROVED',acknowledgedFindings:f.packet.findings.map(x=>x.code)});
 const after=monitoringReport(f.db,{campaignId:f.packet.campaignId,includeSynthetic:true},'2026-11-16T22:01:00Z');
 assert.equal(after.approved.observedCount,1);assert.equal(after.handoffApproved.observedCount,0);assert.equal(after.imported.observedCount,0);
});
test('default prospect reporting excludes known synthetic preparation, imports and observed delivery events',t=>{
 const f=fixture(t);ingestReplyPage(f.db,page([event(),event({eventId:'sent-1',type:'SENT'})]),at);
 const normal=monitoringReport(f.db,{},at);
 assert.equal(normal.population,'PROSPECTS_ONLY');
 for(const field of ['prepared','approved','handoffApproved','imported','scheduled','sent','bounced','replied'])assert.equal(normal[field].observedCount,0,field);
 assert.equal(normal.notifications.length,0);
 const included=monitoringReport(f.db,{includeSynthetic:true},at);
 assert.equal(included.population,'PROSPECTS_AND_SYNTHETIC');assert.equal(included.prepared.observedCount,1);assert.equal(included.imported.observedCount,1);assert.equal(included.sent.observedCount,1);assert.equal(included.replied.observedCount,1);
});
test('synthetic QA packets are excluded before batching while ordinary prospect batches remain visible',t=>{
 const f=writingTelegramFixture();t.after(()=>f.db.close());
 putRecord(f.db,'candidate','real-prospect',{qualification:'HELD'});
 putRecord(f.db,'contact','prospect@example.invalid',{candidateId:'real-prospect',attribution:'Unit fixture representing ordinary prospect metadata',verification:'NOT_RUN',suppressed:null});
 putRecord(f.db,'campaign','prospect-campaign',{purpose:'prospect'});
 createBatch(f.db,'prospect-batch',{campaignId:'prospect-campaign',recipients:[{candidateId:'real-prospect',email:'prospect@example.invalid',messages:[{subject:'Unit fixture',body:'Unapproved unit fixture'}]}],sequence:{},settings:{}});
 const report=monitoringReport(f.db,{},'2026-11-16T22:00:00Z');assert.equal(report.prepared.observedCount,1);assert.equal(report.imported.observedCount,0);
 assert.equal(monitoringReport(f.db,{includeSynthetic:true},'2026-11-16T22:00:00Z').prepared.observedCount,2);
});
