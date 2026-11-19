import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {openStore,putRecord,getRecord,setStopped} from '../src/store.mjs';
import {createBudget} from '../src/operations.mjs';
import {digest,canonical} from '../src/values.mjs';
import {ingestReplyPage,reconcileReplyNotification} from '../src/monitoring.mjs';
import {createTelegramConsumerFixtureApi} from '../src/telegram-api.mjs';
import * as delivery from '../src/monitoring-delivery.mjs';
const at='2026-11-16T17:01:00Z',expiresAt='2026-11-16T18:00:00Z';
function fixture(t){
 const dir=mkdtempSync(join(tmpdir(),'elya-delivery-')),path=join(dir,'state.sqlite');let db=openStore(path);
 t.after(()=>{db.close();rmSync(dir,{recursive:true,force:true});});setStopped(db,false,'temporary offline fixture');createBudget(db,'fixture','1','0','0');
 putRecord(db,'telegram_binding','primary',{confirmed:true,testOnly:true,userId:42,chatId:42,botId:777});
 putRecord(db,'candidate','fixture-candidate',{synthetic:true});putRecord(db,'campaign','fixture-campaign',{synthetic:true});putRecord(db,'contact','qa@example.invalid',{candidateId:'fixture-candidate'});
 const event={version:1,provider:'instantly',eventId:'fixture-reply',type:'REPLIED',campaignId:'fixture-campaign',leadId:'fixture-lead',email:'qa@example.invalid',occurredAt:at,evidenceRef:'fixture:reply',excerpt:'Synthetic local reply.'};
 putRecord(db,'provider_lead_mapping',digest(canonical({provider:'instantly',campaignId:'fixture-campaign',leadId:'fixture-lead'})),{provider:'instantly',campaignId:'fixture-campaign',leadId:'fixture-lead',email:event.email,candidateId:'fixture-candidate'});
 const id=ingestReplyPage(db,{streamId:'fixture',campaignId:'fixture-campaign',expectedCursor:null,nextCursor:null,events:[event],evidenceRef:'fixture:page'},at).notificationIds[0];
 const options={enabled:true,authorizationId:'fixture-delivery-grant',clock:()=>at};
 function approve(preview,extra={}){const grant={id:options.authorizationId,status:'APPROVED',enabled:true,kind:preview.kind,subjectId:preview.subjectId,contentHash:preview.contentHash,destination:preview.destination,budgetId:'fixture',approvedAt:at,expiresAt,transportMode:'OFFLINE_FIXTURE',timeoutMs:1000,evidenceRef:'fixture:exact-content-approval',...extra};putRecord(db,'monitor_delivery_authorization',grant.id,grant,'configuration');return grant;}
 return {get db(){return db;},id,options,approve,reopen(){db.close();db=openStore(path);}};
}
function api(exchange){return createTelegramConsumerFixtureApi(async(method,body,ms)=>{
 if(exchange)return exchange(method,body,ms);
 assert.equal(method,'sendMessage');assert.equal(body.allow_paid_broadcast,false);assert.equal(body.chat_id,42);assert.equal(body.link_preview_options.is_disabled,true);
 return {status:200,body:JSON.stringify({ok:true,result:{message_id:9,chat:{id:42,type:'private'},from:{id:777,is_bot:true},text:body.text}})};
});}
test('reply preview is local and missing or disabled exact authority cannot dispatch',async t=>{
 const f=fixture(t),preview=delivery.previewReplyDelivery(f.db,f.id);assert.match(preview.pages[0].text,/Synthetic local reply/);assert.equal(preview.destination.chatId,42);
 await assert.rejects(delivery.deliverReplyNotification(f.db,f.id,api(),{...f.options,enabled:false}),/DISABLED/);
 await assert.rejects(delivery.deliverReplyNotification(f.db,f.id,api(),f.options),/AUTHORIZATION_REQUIRED/);
 assert.equal(f.db.prepare('SELECT count(*) n FROM operations').get().n,0);assert.equal(getRecord(f.db,'reply_notification',f.id).status,'PENDING');
});
test('reply binding delegates to existing Telegram transport and persists exact content and acceptance once',async t=>{
 const f=fixture(t),preview=delivery.previewReplyDelivery(f.db,f.id);f.approve(preview);let calls=0;
 const tx=api((method,body)=>{calls++;assert.equal(method,'sendMessage');assert.equal(body.chat_id,42);assert.equal(body.text,preview.pages[0].text);return {status:200,body:JSON.stringify({ok:true,result:{message_id:9,chat:{id:42,type:'private'},from:{id:777,is_bot:true}}})};});
 assert.equal((await delivery.deliverReplyNotification(f.db,f.id,tx,f.options)).status,'DELIVERED');f.reopen();assert.equal((await delivery.deliverReplyNotification(f.db,f.id,tx,f.options)).status,'DELIVERED');assert.equal(calls,1);
 const evidence=getRecord(f.db,'monitor_delivery_receipt',`REPLY_NOTIFICATION:${f.id}:1`);assert.equal(evidence.contentHash,preview.contentHash);assert.equal(evidence.messageId,9);assert.equal(evidence.acceptance,'TELEGRAM_API_ACCEPTED');
});
test('stopped business, stale content, changed private pairing, expired authority and budget block before Telegram call',async t=>{
 const f=fixture(t),preview=delivery.previewReplyDelivery(f.db,f.id);f.approve(preview);let calls=0;const tx=api(()=>{calls++;throw Error();});
 setStopped(f.db,true,'fixture stop');await assert.rejects(delivery.deliverReplyNotification(f.db,f.id,tx,f.options),/STOPPED/);setStopped(f.db,false,'fixture restart');
 f.approve(preview,{contentHash:'changed'});await assert.rejects(delivery.deliverReplyNotification(f.db,f.id,tx,f.options),/CONTENT/);
 f.approve(preview,{expiresAt:at});await assert.rejects(delivery.deliverReplyNotification(f.db,f.id,tx,f.options),/EXPIRED/);f.approve(preview);
 f.db.prepare("UPDATE budgets SET blocked=1 WHERE id='fixture'").run();await assert.rejects(delivery.deliverReplyNotification(f.db,f.id,tx,f.options),/Budget/);f.db.prepare("UPDATE budgets SET blocked=0 WHERE id='fixture'").run();
 putRecord(f.db,'telegram_binding','primary',{confirmed:true,userId:42,chatId:43,botId:777});await assert.rejects(delivery.deliverReplyNotification(f.db,f.id,tx,f.options),/PAIRING/);assert.equal(calls,0);
});
test('operational mode alone never authorizes send and per-request authority is required',async t=>{
 const f=fixture(t),preview=delivery.previewReplyDelivery(f.db,f.id);f.approve(preview,{transportMode:'AUTHORIZED_TELEGRAM_OPERATIONAL'});let calls=0;
 const tx={mode:'AUTHORIZED_TELEGRAM_OPERATIONAL',sendPage:async()=>{calls++;throw Error();}};
 await assert.rejects(delivery.deliverReplyNotification(f.db,f.id,tx,f.options),/REQUEST_AUTHORITY/);assert.equal(calls,0);
});
test('unknown acceptance and mismatched Telegram identity remain uncertain through restart without replay',async t=>{
 const f=fixture(t);f.approve(delivery.previewReplyDelivery(f.db,f.id));let calls=0;const tx=api(()=>{calls++;return {status:200,body:JSON.stringify({ok:true,result:{message_id:9,chat:{id:43,type:'private'},from:{id:777,is_bot:true}}})};});
 assert.equal((await delivery.deliverReplyNotification(f.db,f.id,tx,f.options)).status,'RECONCILIATION');f.reopen();delivery.recoverMonitoringDeliveries(f.db,at);
 await assert.rejects(delivery.deliverReplyNotification(f.db,f.id,tx,f.options),/RECONCILIATION/);assert.equal(calls,1);
 assert.equal(reconcileReplyNotification(f.db,f.id,{status:'DELIVERED',remoteId:'9',actualUsd:'0',evidenceRef:'fixture:manual-message-check'},at).status,'DELIVERED');
});
test('report preview is immutable, distinguishes observed remote counts and is never sent by preparing it',async t=>{
 const f=fixture(t);const report=delivery.prepareMonitoringReportDelivery(f.db,{reportId:'report-1',campaignId:'fixture-campaign',includeSynthetic:true},at);
 assert.equal(report.status,'PREVIEW');assert.match(report.pages[0].text,/Remote totals: unknown/);assert.match(report.pages[0].text,/Replied: 1 observed/);assert.equal(report.report.replied.total,null);
 assert.equal(f.db.prepare('SELECT count(*) n FROM operations').get().n,0);
 assert.equal(delivery.prepareMonitoringReportDelivery(f.db,{reportId:'report-1',campaignId:'fixture-campaign',includeSynthetic:true},expiresAt).contentHash,report.contentHash);
 assert.throws(()=>delivery.prepareMonitoringReportDelivery(f.db,{reportId:'report-1',campaignId:'other'},at),/SCOPE/);
});
test('report dispatch uses exact preview approval and one shared budget operation',async t=>{
 const f=fixture(t),report=delivery.prepareMonitoringReportDelivery(f.db,{reportId:'report-1',campaignId:'fixture-campaign'},at);f.approve(report);
 assert.equal((await delivery.deliverMonitoringReport(f.db,'report-1',api(),f.options)).status,'DELIVERED');f.reopen();assert.equal((await delivery.deliverMonitoringReport(f.db,'report-1',api(),f.options)).status,'DELIVERED');
 assert.equal(f.db.prepare('SELECT count(*) n FROM operations').get().n,1);assert.equal(f.db.prepare('SELECT status FROM operations').get().status,'SUCCEEDED');
});
test('uncertain report acceptance blocks resend and explicit reconciliation closes its operation',async t=>{
 const f=fixture(t),report=delivery.prepareMonitoringReportDelivery(f.db,{reportId:'report-1'},at);f.approve(report);let calls=0;
 const tx=api(()=>{calls++;throw Error('fixture timeout');});assert.equal((await delivery.deliverMonitoringReport(f.db,'report-1',tx,f.options)).status,'RECONCILIATION');f.reopen();
 await assert.rejects(delivery.deliverMonitoringReport(f.db,'report-1',tx,f.options),/RECONCILIATION/);assert.equal(calls,1);
 assert.equal(delivery.reconcileMonitoringReport(f.db,'report-1',{status:'DELIVERED',actualUsd:'0',remoteId:'9',evidenceRef:'fixture:manual-acceptance-check'},at).status,'DELIVERED');
});
test('production Telegram composition never loads credentials while disabled, stopped or reconciliation-blocked',async t=>{
 const f=fixture(t),preview=delivery.previewReplyDelivery(f.db,f.id);f.approve(preview,{transportMode:'AUTHORIZED_TELEGRAM_OPERATIONAL',requestCostUsd:'0',costEvidenceRef:'fixture:explicit-no-fee-test-contract'});let loads=0;
 const opts={...f.options,loadToken:async()=>{loads++;throw Error('must not load');}};
 await assert.rejects(delivery.createMonitoringTelegramApi(f.db,preview,{...opts,enabled:false}),/DISABLED/);
 setStopped(f.db,true,'fixture stop');await assert.rejects(delivery.createMonitoringTelegramApi(f.db,preview,opts),/STOPPED/);setStopped(f.db,false,'fixture restart');
 // A prior interrupted delivery must be resolved before touching credentials.
 putRecord(f.db,'reply_notification',f.id,{...getRecord(f.db,'reply_notification',f.id),status:'RECONCILIATION'});
 await assert.rejects(delivery.createMonitoringTelegramApi(f.db,preview,opts),/RECONCILIATION/);assert.equal(loads,0);
});
test('report outcome commit failure recovers without claiming delivery or replaying Telegram',async t=>{
 const f=fixture(t),report=delivery.prepareMonitoringReportDelivery(f.db,{reportId:'report-1'},at);f.approve(report);
 f.db.exec("CREATE TEMP TRIGGER fail_report_outcome BEFORE UPDATE ON records WHEN NEW.kind='monitor_report_delivery' AND json_extract(NEW.data_json,'$.status')='DELIVERED' BEGIN SELECT RAISE(ABORT,'fixture report outcome failure'); END;");
 await assert.rejects(delivery.deliverMonitoringReport(f.db,'report-1',api(),f.options),/fixture report outcome failure/);
 assert.equal(f.db.prepare('SELECT status FROM operations').get().status,'DISPATCHING');f.reopen();
 assert.equal(delivery.recoverMonitoringDeliveries(f.db,at).reports[0].status,'RECONCILIATION');assert.equal(f.db.prepare('SELECT status FROM operations').get().status,'RECONCILIATION');
 await assert.rejects(delivery.deliverMonitoringReport(f.db,'report-1',api(),f.options),/RECONCILIATION/);
});
test('outer job cancellation records uncertain delivery and ignores late Telegram acceptance',async t=>{
 const f=fixture(t),controller=new AbortController();f.approve(delivery.previewReplyDelivery(f.db,f.id));
 const tx=api(()=>{controller.abort();return new Promise(resolve=>setTimeout(()=>resolve({status:200,body:JSON.stringify({ok:true,result:{message_id:9,chat:{id:42,type:'private'},from:{id:777,is_bot:true}}})}),5));});
 assert.equal((await delivery.deliverReplyNotification(f.db,f.id,tx,{...f.options,signal:controller.signal})).status,'RECONCILIATION');await new Promise(resolve=>setTimeout(resolve,10));
 assert.equal(getRecord(f.db,'reply_notification',f.id).status,'RECONCILIATION');
});
test('production factory scopes its existing transport to one durable dispatch intent and cleans up',async t=>{
 const f=fixture(t),preview=delivery.previewReplyDelivery(f.db,f.id);f.approve(preview,{transportMode:'AUTHORIZED_TELEGRAM_OPERATIONAL',requestCostUsd:'0',costEvidenceRef:'fixture:approved-cost-contract'});
 let created=0,calls=0,closed=0;
 const createApi=(_fixtureToken,beforeRequest)=>{created++;return {mode:'AUTHORIZED_TELEGRAM_OPERATIONAL',async sendPage(chatId,page,ms){beforeRequest('sendMessage',{chat_id:chatId,...page,allow_paid_broadcast:false,link_preview_options:{is_disabled:true}},ms);calls++;return {message_id:9,chat:{id:42,type:'private'},from:{id:777,is_bot:true}};},async close(){closed++;return {closed:true,remainingRequests:0};}};};
 // Fabricated token and injected fixture transport; no protected storage or HTTP.
 const tx=await delivery.createMonitoringTelegramApi(f.db,preview,{...f.options,loadToken:async()=>`123456:${'a'.repeat(35)}`},{createApi});
 assert.equal(created,1);
 await assert.rejects(tx.sendPage(42,preview.pages[0],1000),/DISPATCH_INTENT/);assert.equal(calls,0);
 assert.equal((await delivery.deliverReplyNotification(f.db,f.id,tx,f.options)).status,'DELIVERED');assert.equal(calls,1);
 await assert.rejects(tx.sendPage(42,preview.pages[0],1000),/DISPATCH_INTENT/);assert.equal(calls,1);
 assert.deepEqual(await tx.close(),{closed:true,remainingRequests:0});assert.equal(closed,1);
});
test('operational Telegram sends require explicit cost evidence instead of inferring zero fees',async t=>{
 const f=fixture(t),preview=delivery.previewReplyDelivery(f.db,f.id);f.approve(preview,{transportMode:'AUTHORIZED_TELEGRAM_OPERATIONAL'});let loads=0;
 await assert.rejects(delivery.createMonitoringTelegramApi(f.db,preview,{...f.options,loadToken:async()=>{loads++;return 'unused';}}),/COST_EVIDENCE/);assert.equal(loads,0);
});
test('runtime dispatch assertion blocks a notification before reservation or Telegram request',async t=>{
 const f=fixture(t);f.approve(delivery.previewReplyDelivery(f.db,f.id));let calls=0;
 await assert.rejects(delivery.deliverReplyNotification(f.db,f.id,api(()=>{calls++;throw Error();}),{...f.options,assertDispatch(){throw Error('FIXTURE_RUNTIME_DISPATCH_DISABLED');}}),/RUNTIME_DISPATCH_DISABLED/);
 assert.equal(calls,0);assert.equal(f.db.prepare('SELECT count(*) n FROM operations').get().n,0);
});
test('fixture delivery rejects a non-test private pairing before recording a delivery or reservation',async t=>{
 const f=fixture(t);f.approve(delivery.previewReplyDelivery(f.db,f.id));putRecord(f.db,'telegram_binding','primary',{confirmed:true,userId:42,chatId:42,botId:777});
 await assert.rejects(delivery.deliverReplyNotification(f.db,f.id,api(),f.options),/FIXTURE_ISOLATION/);assert.equal(getRecord(f.db,'reply_notification',f.id).status,'PENDING');assert.equal(f.db.prepare('SELECT count(*) n FROM operations').get().n,0);
});
test('fixture delivery rejects real-like contact records even with matching exact fixture approval',async t=>{
 const f=fixture(t);f.approve(delivery.previewReplyDelivery(f.db,f.id));putRecord(f.db,'contact','real-person@real-company.com',{candidateId:'fixture-candidate'});
 await assert.rejects(delivery.deliverReplyNotification(f.db,f.id,api(),f.options),/FIXTURE_ISOLATION/);assert.equal(getRecord(f.db,'reply_notification',f.id).status,'PENDING');assert.equal(f.db.prepare('SELECT count(*) n FROM operations').get().n,0);
});
