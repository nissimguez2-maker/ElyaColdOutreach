import test from 'node:test';
import assert from 'node:assert/strict';
import {openStore,putRecord,getRecord} from '../src/store.mjs';
import {createBudget,reserveOperation,beginOperation,recordOutcome,reconcileOperation} from '../src/operations.mjs';
import {startOperationalObservation,operationalObservationReport} from '../src/workflow-observation.mjs';
import {canonical,digest} from '../src/values.mjs';
import {ingestReplyPage} from '../src/monitoring.mjs';
import {recordManualResponseEvent} from '../src/manual-response.mjs';

// A mutable reconciliation timestamp must neither remove the original cohort nor admit older work.
test('observation keeps its operation cohort when cost reconciliation occurs after the week ends',t=>{
 const db=openStore(':memory:');t.after(()=>db.close());const at='2026-11-19T15:00:00.000Z';
 startOperationalObservation(db,{id:'week',startedAt:at,approvedBy:'Daniel Rosen',approvalRef:'fixture:approval',cadence:'Manual approved first touch',startEvidenceRef:'fixture:start',realOperationConfirmed:true},at);
 createBudget(db,'fixture','1','0','0');
 for(const id of ['in-week','before-week','after-week'])reserveOperation(db,{id,kind:'READ',budgetId:'fixture',reservation:'0.15',authorizationRef:'fixture',payload:{id}});
 const during='2026-11-20T15:00:00.000Z',later='2026-11-28T15:00:00.000Z';
 db.prepare('UPDATE operations SET created_at=?,updated_at=? WHERE id=?').run(during,during,'in-week');
 db.prepare('UPDATE operations SET created_at=?,updated_at=? WHERE id=?').run('2026-11-18T15:00:00.000Z',during,'before-week');
 db.prepare('UPDATE operations SET created_at=?,updated_at=? WHERE id=?').run(later,later,'after-week');
 beginOperation(db,'in-week',during);recordOutcome(db,'in-week',{status:'AMBIGUOUS',actual:null,evidence:'fixture:unknown-charge'});
 db.prepare('UPDATE operations SET updated_at=? WHERE id=?').run(later,'in-week');
 const unresolved=operationalObservationReport(db,'week',later);
 assert.deepEqual(unresolved.costs.operations.map(row=>row.id),['in-week']);
 assert.equal(unresolved.costs.knownActualUsd,'0');assert.equal(unresolved.costs.unknownActualOperations,1);assert.equal(unresolved.costs.operations[0].reservation_usd,'0.15');
 reconcileOperation(db,'in-week',{status:'SUCCEEDED',actual:'0.125',remoteId:'fixture:run',evidence:'fixture:final-charge'});
 db.prepare('UPDATE operations SET updated_at=? WHERE id=?').run(later,'in-week');
 const settled=operationalObservationReport(db,'week',later);
 assert.deepEqual(settled.costs.operations.map(row=>row.id),['in-week']);assert.equal(settled.costs.knownActualUsd,'0.125');assert.equal(settled.costs.unknownActualOperations,0);assert.equal(settled.costs.operations[0].status,'SUCCEEDED');
 assert.equal(settled.costs.cohort,'OPERATIONS_CREATED_DURING_OBSERVATION');assert.equal(settled.costs.settlementBasis,'CURRENT_RECORDED_SETTLEMENTS_AT_REPORT_TIME');assert.ok(Number.isFinite(Date.parse(settled.costs.settlementObservedAt)));
});

test('late conversation metadata preserves counts by original reply ingestion and manual-response receipt times',t=>{
 const db=openStore(':memory:');t.after(()=>db.close());const at='2026-11-19T15:00:00.000Z',during='2026-11-20T15:00:00.000Z',later='2026-11-28T15:00:00.000Z';
 startOperationalObservation(db,{id:'week',startedAt:at,approvedBy:'Daniel Rosen',approvalRef:'fixture:approval',cadence:'Manual approved first touch',startEvidenceRef:'fixture:start',realOperationConfirmed:true},at);
 putRecord(db,'settings','manual-response-fixture-isolation',{isolated:true,fixtureId:'observation'});
 putRecord(db,'candidate','synthetic',{synthetic:true});putRecord(db,'contact','qa@example.test',{candidateId:'synthetic'});
 putRecord(db,'telegram_binding','primary',{confirmed:true,testOnly:true,chatId:1,userId:1,botId:2});
 putRecord(db,'provider_lead_mapping',digest(canonical({provider:'instantly',campaignId:'fixture-campaign',leadId:'fixture-lead'})),{provider:'instantly',campaignId:'fixture-campaign',leadId:'fixture-lead',candidateId:'synthetic',email:'qa@example.test',importOperationId:'fixture:import',evidenceRef:'fixture:mapping'});
 const event={version:1,provider:'instantly',eventId:'fixture-reply',type:'REPLIED',campaignId:'fixture-campaign',leadId:'fixture-lead',email:'qa@example.test',occurredAt:during,evidenceRef:'fixture:reply'},page={streamId:'fixture-stream',campaignId:'fixture-campaign',expectedCursor:null,nextCursor:'second-page',events:[event],evidenceRef:'fixture:first-page'};
 const replyId=ingestReplyPage(db,page,during).notificationIds[0];
 for(const type of ['REFUSAL','OPT_OUT'])recordManualResponseEvent(db,{version:1,eventId:'fixture:'+type,type,candidateId:'synthetic',email:'qa@example.test',occurredAt:during,actor:'Fixture operator',evidenceRef:'fixture:response',scope:'MAILBOX',scopeEvidenceRef:'fixture:explicit-scope'},during);
 db.prepare("UPDATE records SET updated_at=? WHERE kind IN ('provider_event','manual_response_event')").run(during);
 assert.equal(operationalObservationReport(db,'week',during).replies,1);assert.equal(operationalObservationReport(db,'week',during).refusals,2);
 const conversation={recordId:'fixture-reply',rfcMessageId:'<fixture@example.test>',threadId:'fixture-thread',organizationId:'fixture-organization',senderEmail:'sender@example.test',subject:'Fixture reply',url:null,bodyTruncated:false};
 const enriched=ingestReplyPage(db,{...page,expectedCursor:'second-page',nextCursor:null,events:[{...event,conversation,evidenceRef:'fixture:enriched-reply'}],evidenceRef:'fixture:second-page'},later);
 assert.equal(enriched.inserted,0);assert.equal(getRecord(db,'provider_event',replyId).ingestedAt,during);assert.deepEqual(getRecord(db,'provider_event',replyId).event.conversation,conversation);
 db.prepare("UPDATE records SET updated_at=? WHERE kind IN ('provider_event','manual_response_event')").run(later);
 const report=operationalObservationReport(db,'week',later);assert.equal(report.replies,1);assert.equal(report.refusals,2);
 putRecord(db,'provider_event','fixture:older-reply',{event:{...event,eventId:'older'},candidateId:'synthetic',ingestedAt:'2026-11-18T15:00:00.000Z'});
 putRecord(db,'manual_response_event','fixture:older-response',{event:{type:'REFUSAL'},recordedAt:'2026-11-18T15:00:00.000Z'});
 db.prepare('UPDATE records SET updated_at=? WHERE id IN (?,?)').run(during,'fixture:older-reply','fixture:older-response');
 const stable=operationalObservationReport(db,'week',later);assert.equal(stable.replies,1);assert.equal(stable.refusals,2);
});
