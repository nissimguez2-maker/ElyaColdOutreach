import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {openStore,putRecord,getRecord,setStopped,setLaunch} from '../src/store.mjs';
import {canonical,digest} from '../src/values.mjs';
import {createBatch,decideApproval,evaluateRelease} from '../src/batches.mjs';
import {previewOutreach,buildApprovedOutreachCsv} from '../src/outreach-preview.mjs';
import {outreachPreviewFixture,tableSnapshot} from './helpers/outreach-preview-fixture.mjs';
import {evaluateManualContactGate,recordManualResponseEvent} from '../src/manual-response.mjs';

const at='2026-11-18T15:00:00Z',later='2026-11-18T15:05:00Z';
const selector={candidateId:'business',email:'owner@example.invalid',at:later};
const input=(extra={})=>({version:1,eventId:'response-1',type:'REPLY_RECEIVED',candidateId:'business',email:'owner@example.invalid',occurredAt:at,actor:'Daniel Rosen',evidenceRef:'fixture:received-message',...extra});
function fixture(t,path=':memory:'){
 const db=openStore(path);t.after(()=>db.close());
 putRecord(db,'settings','manual-response-fixture-isolation',{isolated:true,fixtureId:'manual-response-tests'});
 for(const id of ['business','other-business'])putRecord(db,'candidate',id,{qualification:'QUALIFIED',synthetic:true});
 for(const [email,candidateId]of [['owner@example.invalid','business'],['staff@example.invalid','business'],['other@example.invalid','other-business']])putRecord(db,'contact',email,{candidateId,attribution:'Fixture',verification:'PASSED',suppressed:false});
 return db;
}
function suppression(db,extra={}){
 return recordManualResponseEvent(db,input({type:'OPT_OUT',scope:'MAILBOX',scopeEvidenceRef:'fixture:exact-request-scope',...extra}),later);
}
function readback(db,{scope='MAILBOX',email='owner@example.invalid',candidateId='business',sourceRef='fixture:native-status-readback',observedAt='2026-11-18T15:02:00Z',status='SUPPRESSED'}={}){
 const evidence={version:1,provider:'instantly',scope,email,candidateId,status,observedAt,sourceRef,sourceSha256:'a'.repeat(64)};
 putRecord(db,'native_suppression_readback','native-1',{...evidence,hash:digest(canonical(evidence))},'provider_result');
}
const verification=(extra={})=>input({eventId:'native-verification-1',type:'NATIVE_SUPPRESSION_VERIFIED',occurredAt:'2026-11-18T15:03:00Z',evidenceRef:'fixture:operator-native-review',suppressionEventId:'response-1',nativeEvidenceId:'native-1',...extra});

test('an existing normalized reply blocks later release without mutating local evidence',t=>{
 const db=fixture(t);assert.equal(evaluateManualContactGate(db,selector).allowed,true);
 putRecord(db,'provider_event','reply',{candidateId:'business',ingestedAt:at,event:{version:1,provider:'instantly',eventId:'reply',type:'REPLIED',campaignId:'fixture-campaign',leadId:'fixture-lead',email:selector.email,occurredAt:at,evidenceRef:'fixture:provider-reply'}});
 const before=tableSnapshot(db),gate=evaluateManualContactGate(db,selector);
 assert.equal(gate.allowed,false);assert.equal(gate.replyReceived,true);assert.ok(gate.reasons.includes('MANUAL_REPLY_RECEIVED'));
 assert.equal(gate.autonomousRepliesEnabled,false);assert.deepEqual(tableSnapshot(db),before);
});
test('manual response event IDs are idempotent and conflicting reuse preserves the first evidence',t=>{
 const db=fixture(t),first=recordManualResponseEvent(db,input(),later),before=tableSnapshot(db);
 const duplicate=recordManualResponseEvent(db,input(),later);
 assert.equal(duplicate.id,first.id);assert.equal(duplicate.duplicate,true);assert.deepEqual(tableSnapshot(db),before);
 assert.throws(()=>recordManualResponseEvent(db,input({type:'MANUAL_TAKEOVER'}),later),/IDENTITY_CONFLICT/);
 assert.deepEqual(tableSnapshot(db),before);assert.equal(evaluateManualContactGate(db,selector).replyReceived,true);
});
test('takeover is an explicit human event and never generates a reply or clears a hold',t=>{
 const db=fixture(t);recordManualResponseEvent(db,input({type:'MANUAL_TAKEOVER'}),later);
 const gate=evaluateManualContactGate(db,selector);
 assert.equal(gate.allowed,false);assert.equal(gate.manualTakeover,true);assert.equal(gate.replyReceived,false);
 assert.equal(db.prepare('SELECT count(*) n FROM operations').get().n,0);
 assert.throws(()=>recordManualResponseEvent(db,input({eventId:'text-only',type:'INFER_FROM_TEXT',text:'STOP'}),later),/FIELDS|TYPE/);
});
test('mailbox opt-out blocks that mailbox and preserves actual scope and time',t=>{
 const db=fixture(t),before=getRecord(db,'contact',selector.email);suppression(db);
 const gate=evaluateManualContactGate(db,selector);
 assert.equal(gate.allowed,false);assert.equal(gate.nativeSuppressionStatus,'PENDING');
 assert.equal(gate.suppressionRequests[0].scope,'MAILBOX');assert.equal(gate.suppressionRequests[0].occurredAt,at);
 assert.equal(evaluateManualContactGate(db,{...selector,email:'staff@example.invalid'}).allowed,true);
 assert.deepEqual(getRecord(db,'contact',selector.email),before);
});
test('business refusal holds all known business mailboxes without affecting another business',t=>{
 const db=fixture(t);suppression(db,{type:'REFUSAL',scope:'BUSINESS'});
 assert.equal(evaluateManualContactGate(db,{...selector,email:'staff@example.invalid'}).allowed,false);
 assert.equal(evaluateManualContactGate(db,{...selector,candidateId:'other-business',email:'other@example.invalid'}).allowed,true);
});
test('unresolved suppression scope holds the business and cannot be declared verified',t=>{
 const db=fixture(t);suppression(db,{scope:'UNRESOLVED'});readback(db);
 const gate=evaluateManualContactGate(db,{...selector,email:'staff@example.invalid'});
 assert.equal(gate.allowed,false);assert.equal(gate.nativeSuppressionStatus,'UNRESOLVED');assert.ok(gate.reasons.includes('MANUAL_SUPPRESSION_SCOPE_UNRESOLVED'));
 assert.throws(()=>recordManualResponseEvent(db,verification(),later),/SCOPE_UNRESOLVED/);
});
test('native verification requires separate bound saved provider evidence and never permits later contact',t=>{
 const db=fixture(t);suppression(db);
 assert.throws(()=>recordManualResponseEvent(db,verification(),later),/NATIVE_EVIDENCE/);
 readback(db,{sourceRef:'fixture:received-message'});
 assert.throws(()=>recordManualResponseEvent(db,verification(),later),/NATIVE_EVIDENCE/);
 readback(db,{email:'staff@example.invalid'});
 assert.throws(()=>recordManualResponseEvent(db,verification(),later),/NATIVE_EVIDENCE/);
 readback(db);recordManualResponseEvent(db,verification(),later);
 const gate=evaluateManualContactGate(db,selector);
 assert.equal(gate.nativeSuppressionStatus,'VERIFIED_FROM_SAVED_EVIDENCE');assert.equal(gate.allowed,false);
 assert.ok(gate.reasons.includes('MANUAL_OPT_OUT'));assert.ok(!gate.reasons.includes('MANUAL_NATIVE_SUPPRESSION_PENDING'));
});
test('changed native evidence is unresolved and cannot silently preserve a verification claim',t=>{
 const db=fixture(t);suppression(db);readback(db);recordManualResponseEvent(db,verification(),later);
 readback(db,{status:'CLEAR'});
 const gate=evaluateManualContactGate(db,selector);
 assert.equal(gate.allowed,false);assert.equal(gate.nativeSuppressionStatus,'UNRESOLVED');assert.ok(gate.reasons.includes('MANUAL_NATIVE_SUPPRESSION_EVIDENCE_INVALID'));
});
test('business suppression cannot be verified by evidence for only one mailbox',t=>{
 const db=fixture(t);suppression(db,{scope:'BUSINESS'});readback(db);
 assert.throws(()=>recordManualResponseEvent(db,verification(),later),/NATIVE_EVIDENCE/);
 readback(db,{scope:'BUSINESS'});recordManualResponseEvent(db,verification(),later);
 const gate=evaluateManualContactGate(db,{...selector,email:'staff@example.invalid'});
 assert.equal(gate.allowed,false);assert.equal(gate.nativeSuppressionStatus,'VERIFIED_FROM_SAVED_EVIDENCE');
});
test('a missing original suppression request cannot make a remaining verification look clear',t=>{
 const db=fixture(t);suppression(db);readback(db);recordManualResponseEvent(db,verification(),later);
 db.prepare("DELETE FROM records WHERE kind='manual_response_event' AND json_extract(data_json,'$.event.eventId')='response-1'").run();
 const gate=evaluateManualContactGate(db,selector);
 assert.equal(gate.allowed,false);assert.equal(gate.nativeSuppressionStatus,'UNRESOLVED');
 assert.ok(gate.reasons.includes('MANUAL_NATIVE_SUPPRESSION_EVIDENCE_INVALID'));
});
test('unknown identity, future events and ambiguous normalized replies stay held',t=>{
 const db=fixture(t);
 assert.equal(evaluateManualContactGate(db,{...selector,candidateId:'other-business'}).allowed,false);
 assert.throws(()=>recordManualResponseEvent(db,input({occurredAt:'2026-11-18T16:00:00Z'}),later),/FUTURE/);
 putRecord(db,'provider_event','ambiguous',{candidateId:'business',event:{type:'REPLIED',email:'not-known@example.invalid',occurredAt:at}});
 assert.ok(evaluateManualContactGate(db,selector).reasons.includes('MANUAL_PROVIDER_EVENT_IDENTITY_UNRESOLVED'));
});
test('malformed mailbox identifiers cannot be recorded or evaluated as contact identities',t=>{
 const db=fixture(t);
 for(const address of ['a@b@example.invalid','one,two@example.invalid','owner@example.invalid;']){
  assert.throws(()=>evaluateManualContactGate(db,{...selector,email:address}),/EMAIL_INVALID/);
  assert.throws(()=>recordManualResponseEvent(db,input({email:address}),later),/EMAIL_INVALID/);
 }
});
test('writers reject unmarked, mixed and non-temporary databases before adding any records',t=>{
 const db=fixture(t);putRecord(db,'settings','manual-response-fixture-isolation',{isolated:false});
 assert.throws(()=>recordManualResponseEvent(db,input(),later),/FIXTURE_ISOLATION/);
 putRecord(db,'settings','manual-response-fixture-isolation',{isolated:true,fixtureId:'fixture'});
 putRecord(db,'candidate','real-business',{qualification:'HELD'});
 assert.throws(()=>recordManualResponseEvent(db,input(),later),/FIXTURE_ISOLATION/);
 const path=resolve('work/local-readiness-sprint-v1/manual-response-path-fixture.sqlite'),disk=fixture(t,path);
 t.after(()=>{for(const suffix of ['','-wal','-shm'])rmSync(path+suffix,{force:true});});
 assert.throws(()=>recordManualResponseEvent(disk,input(),later),/FIXTURE_ISOLATION/);
 assert.equal(db.prepare("SELECT count(*) n FROM records WHERE kind='manual_response_event'").get().n,0);
});
test('a marked temporary fixture persists events across reopen and journal failure rolls back',t=>{
 const dir=mkdtempSync(join(tmpdir(),'elya-manual-response-')),path=join(dir,'state.sqlite');let db=fixture(t,path);
 // Close/reopen separately; fixture cleanup will close the original connection.
 recordManualResponseEvent(db,input(),later);
 const reopened=openStore(path);t.after(()=>{reopened.close();rmSync(dir,{recursive:true,force:true});});
 assert.equal(evaluateManualContactGate(reopened,selector).allowed,false);
 const before=tableSnapshot(reopened);
 reopened.exec("CREATE TEMP TRIGGER fail_manual_journal BEFORE INSERT ON journal WHEN NEW.event='MANUAL_RESPONSE_RECORDED' BEGIN SELECT RAISE(ABORT,'fixture journal failure'); END;");
 assert.throws(()=>recordManualResponseEvent(reopened,input({eventId:'second',type:'MANUAL_TAKEOVER'}),later),/fixture journal failure/);
 assert.deepEqual(tableSnapshot(reopened),before);
});
test('shared release gate blocks a reply even when original approval and contact flags still pass',t=>{
 const db=fixture(t);setStopped(db,false,'fixture');setLaunch(db,true,'fixture');
 const b=createBatch(db,'batch',{campaignId:'fixture-campaign',recipients:[{candidateId:selector.candidateId,email:selector.email,messages:[{subject:'Fixture',body:'Fixture'}]}],sequence:{},settings:{}});
 const a=decideApproval(db,'batch',b.version,b.hash,'APPROVED','Fixture','2026-11-18T16:00:00Z',at);
 assert.equal(evaluateRelease(db,'batch',a.id,later).allowed,true);
 recordManualResponseEvent(db,input(),later);
 assert.equal(evaluateRelease(db,'batch',a.id,later).allowed,false);
});
test('preview visibly holds an existing reply and approved CSV export fails closed',t=>{
 const f=outreachPreviewFixture();t.after(()=>f.db.close());
 assert.equal(buildApprovedOutreachCsv(f.db,f.input).status,'APPROVED_EXPORT_NOT_RELEASED');
 putRecord(f.db,'provider_event','reply',{candidateId:f.spec.candidateId,event:{version:1,provider:'instantly',eventId:'reply',type:'REPLIED',campaignId:f.spec.campaignId,leadId:'lead',email:f.spec.email,occurredAt:at,evidenceRef:'fixture:reply'}});
 const row=previewOutreach(f.db,f.input).recipients[0];
 assert.ok(row.flags.includes('HELD'));assert.ok(row.reasons.includes('MANUAL_REPLY_RECEIVED'));
 assert.equal(buildApprovedOutreachCsv(f.db,f.input).status,'BLOCKED');
});
