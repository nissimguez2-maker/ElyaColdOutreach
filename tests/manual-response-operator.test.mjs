import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,writeFileSync,readFileSync,existsSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {spawnSync,spawn} from 'node:child_process';
import {openStore,putRecord,getRecord} from '../src/store.mjs';
import {canonical,digest} from '../src/values.mjs';
import {tableSnapshot} from './helpers/outreach-preview-fixture.mjs';
import * as responses from '../src/manual-response.mjs';

const root=resolve('.'),at='2026-11-17T15:00:00Z',later='2026-11-17T15:05:00Z';
const event=(extra={})=>({version:1,eventId:'fixture-response-1',type:'REPLY_RECEIVED',candidateId:'fixture-business',email:'owner@response.invalid',occurredAt:at,actor:'Daniel Rosen',evidenceRef:'fixture:message-1',...extra});
function setup(t){
 const directory=mkdtempSync(join(tmpdir(),'elya-manual-response-operator-')),path=join(directory,'fixture.sqlite'),db=openStore(path);
 t.after(()=>db.close());
 for(const id of ['fixture-business','other-fixture'])putRecord(db,'candidate',id,{name:id,synthetic:true,qualification:'HOLD'});
 for(const [address,candidateId] of [['owner@response.invalid','fixture-business'],['staff@response.invalid','fixture-business'],['other@response.invalid','other-fixture']])putRecord(db,'contact',address,{candidateId,email:address,verification:'HELD',suppressed:null});
 const write=(name,value)=>{const file=join(directory,name);writeFileSync(file,JSON.stringify(value,null,2));return file;};
 const argv=(...args)=>['--import=./tests/helpers/deny-network-preload.mjs',resolve(root,'src/operator.mjs'),...args,'--db',path];
 const run=(...args)=>spawnSync(process.execPath,argv(...args),{cwd:root,encoding:'utf8',windowsHide:true,timeout:15000});
 const runAsync=(...args)=>new Promise((resolve,reject)=>{const child=spawn(process.execPath,argv(...args),{cwd:root,windowsHide:true});let stdout='',stderr='';child.stdout.on('data',b=>stdout+=b);child.stderr.on('data',b=>stderr+=b);child.on('error',reject);child.on('close',status=>resolve({status,stdout,stderr}));});
 const prepare=input=>{const request=write(input.eventId+'.json',input),out=run('response-preview',request);assert.equal(out.status,0,out.stderr);const preview=JSON.parse(out.stdout);return {request,preview,previewPath:write(input.eventId+'.preview.json',preview)};};
 const record=p=>run('response-record',p.request,p.previewPath,'--confirm-preview',p.preview.hash);
 return {db,path,directory,write,run,runAsync,prepare,record};
}
function saveReadback(db,{scope='MAILBOX',sourceRef='fixture:independent-native-readback'}={}){
 const evidence={version:1,provider:'instantly',scope,email:'owner@response.invalid',candidateId:'fixture-business',status:'SUPPRESSED',observedAt:'2026-11-17T15:01:00Z',sourceRef,sourceSha256:'a'.repeat(64)};
 putRecord(db,'native_suppression_readback','fixture-native-1',{...evidence,hash:digest(canonical(evidence))},'provider_result');
}

test('actual response entry previews without writes and records exact attributed event with a persistent local hold',t=>{
 const f=setup(t),before=tableSnapshot(f.db),p=f.prepare(event());
 assert.deepEqual(tableSnapshot(f.db),before);assert.equal(p.preview.status,'PREVIEW_ONLY_NOT_RECORDED');
 assert.deepEqual(p.preview.affectedContacts,['owner@response.invalid']);assert.equal(p.preview.event.actor,'Daniel Rosen');
 const out=f.record(p);assert.equal(out.status,0,out.stderr);const receipt=JSON.parse(out.stdout);
 assert.equal(receipt.status,'RECORDED_LOCAL_HOLD');assert.equal(receipt.gate.allowed,false);assert.equal(receipt.gate.replyReceived,true);
 assert.equal(receipt.event.event.occurredAt,at);assert.equal(receipt.event.event.evidenceRef,'fixture:message-1');assert.equal(receipt.event.operatorEntry.previewHash,p.preview.hash);
 const after=tableSnapshot(f.db);for(const table of Object.keys(before).filter(k=>!['records','record_history','journal'].includes(k)))assert.deepEqual(after[table],before[table]);
 assert.deepEqual(after.records.filter(r=>r.kind!=='manual_response_event'),before.records);
 const status=f.run('response-status',event().email,event().candidateId);assert.equal(status.status,0,status.stderr);assert.equal(JSON.parse(status.stdout).allowed,false);
 assert.equal(f.db.prepare("SELECT count(*) n FROM records WHERE kind='manual_response_event'").get().n,1);
 const journal=JSON.parse(f.db.prepare("SELECT details_json FROM journal WHERE event='MANUAL_RESPONSE_RECORDED'").get().details_json);
 assert.equal(journal.actor,'Daniel Rosen');assert.equal(journal.provenanceBasis,'user_reported');assert.equal(journal.previewHash,p.preview.hash);
});
test('actual record requires explicit database, exact preview confirmation and unchanged input',t=>{
 const f=setup(t),p=f.prepare(event()),before=tableSnapshot(f.db);
 for(const args of [['response-record',p.request,p.previewPath],['response-record',p.request,p.previewPath,'--confirm-preview','0'.repeat(64)]])assert.equal(f.run(...args).status,1);
 const missingDb=spawnSync(process.execPath,['--import=./tests/helpers/deny-network-preload.mjs','src/operator.mjs','response-record',p.request,p.previewPath,'--confirm-preview',p.preview.hash],{cwd:root,encoding:'utf8',windowsHide:true});
 assert.equal(missingDb.status,1);assert.match(missingDb.stderr,/EXPLICIT_DATABASE/);
 f.write('fixture-response-1.json',event({type:'MANUAL_TAKEOVER'}));assert.equal(f.record(p).status,1);
 assert.deepEqual(tableSnapshot(f.db),before);
});
test('actual record refuses a changed relevant state or a preview for another database',t=>{
 const f=setup(t),p=f.prepare(event());putRecord(f.db,'contact','owner@response.invalid',{...getRecord(f.db,'contact','owner@response.invalid'),verification:'CHANGED'});
 const before=tableSnapshot(f.db),out=f.record(p);assert.equal(out.status,1);assert.match(out.stderr,/PREVIEW_STALE/);assert.deepEqual(tableSnapshot(f.db),before);
 const second=setup(t),wrong=second.run('response-record',p.request,p.previewPath,'--confirm-preview',p.preview.hash);assert.equal(wrong.status,1);assert.match(wrong.stderr,/DATABASE_MISMATCH/);
});
test('actual response commands never create a missing database and reject modified previews',t=>{
 const f=setup(t),p=f.prepare(event()),missing=join(f.directory,'does-not-exist.sqlite'),before=tableSnapshot(f.db);
 for(const args of [['response-preview',p.request],['response-record',p.request,p.previewPath,'--confirm-preview',p.preview.hash]]){
  const out=spawnSync(process.execPath,['--import=./tests/helpers/deny-network-preload.mjs','src/operator.mjs',...args,'--db',missing],{cwd:root,encoding:'utf8',windowsHide:true});
  assert.equal(out.status,1);assert.equal(existsSync(missing),false);
 }
 f.write('fixture-response-1.preview.json',{...p.preview,affectedContacts:['other@response.invalid']});
 const tampered=f.record(p);assert.equal(tampered.status,1);assert.match(tampered.stderr,/PREVIEW_BINDING/);assert.deepEqual(tableSnapshot(f.db),before);
});
test('actual commands reject ambiguous identity, unsupported scope and incomplete attribution',t=>{
 const f=setup(t),before=tableSnapshot(f.db);
 for(const input of [event({candidateId:'other-fixture'}),event({email:'Owner@response.invalid'}),event({actor:''}),event({evidenceRef:''}),event({type:'CLEAR_HOLD'}),event({type:'REFUSAL',scope:'DOMAIN',scopeEvidenceRef:'fixture:scope'}),event({type:'OPT_OUT',scope:'MAILBOX'}),event({extra:true}),event({occurredAt:'2099-01-01T00:00:00Z'})])assert.equal(f.run('response-preview',f.write('bad.json',input)).status,1);
 putRecord(f.db,'contact','Owner@response.invalid',{candidateId:'other-fixture',email:'owner@response.invalid'});
 const out=f.run('response-preview',f.write('ambiguous.json',event()));assert.equal(out.status,1);assert.match(out.stderr,/IDENTITY/);
 assert.equal(f.db.prepare("SELECT count(*) n FROM records WHERE kind='manual_response_event'").get().n,0);assert.deepEqual(tableSnapshot(f.db).journal,before.journal);
});
test('actual mailbox, business and unresolved refusals keep their distinct scopes and conservative holds',t=>{
 for(const [scope,type,staffHeld,nativeStatus] of [['MAILBOX','OPT_OUT',false,'PENDING'],['BUSINESS','REFUSAL',true,'PENDING'],['UNRESOLVED','OPT_OUT',true,'UNRESOLVED']]){
  const f=setup(t),p=f.prepare(event({type,scope,scopeEvidenceRef:'fixture:explicit-scope'}));
  assert.equal(p.preview.affectedContacts.length,staffHeld?2:1);assert.equal(f.record(p).status,0);
  const gate=address=>JSON.parse(f.run('response-status',address,'fixture-business').stdout);
  assert.equal(gate('staff@response.invalid').allowed,!staffHeld);assert.equal(gate('owner@response.invalid').nativeSuppressionStatus,nativeStatus);
  assert.equal(JSON.parse(f.run('response-status','other@response.invalid','other-fixture').stdout).allowed,true);
 }
});
test('actual native verification requires independent saved evidence and never clears the original hold',t=>{
 const f=setup(t),p=f.prepare(event({type:'OPT_OUT',scope:'MAILBOX',scopeEvidenceRef:'fixture:scope'}));assert.equal(f.record(p).status,0);
 const input=event({eventId:'fixture-native-check',type:'NATIVE_SUPPRESSION_VERIFIED',occurredAt:'2026-11-17T15:02:00Z',suppressionEventId:'fixture-response-1',nativeEvidenceId:'fixture-native-1',evidenceRef:'fixture:operator-check'});
 assert.equal(f.run('response-preview',f.write('native.json',input)).status,1);saveReadback(f.db,{sourceRef:'fixture:message-1'});assert.equal(f.run('response-preview',f.write('native.json',input)).status,1);
 saveReadback(f.db);const native=f.prepare(input);assert.equal(native.preview.nativeEvidence.sourceRef,'fixture:independent-native-readback');
 const out=f.record(native);assert.equal(out.status,0,out.stderr);const receipt=JSON.parse(out.stdout);
 assert.equal(receipt.gate.nativeSuppressionStatus,'VERIFIED_FROM_SAVED_EVIDENCE');assert.equal(receipt.gate.allowed,false);assert.equal(receipt.remoteActions,0);
});
test('actual concurrent identical replay appends once and conflicting event identity never overwrites',async t=>{
 const f=setup(t),p=f.prepare(event());
 const args=['response-record',p.request,p.previewPath,'--confirm-preview',p.preview.hash];
 const results=await Promise.all([f.runAsync(...args),f.runAsync(...args)]);
 for(const out of results)assert.equal(out.status,0,out.stderr);
 assert.deepEqual(results.map(out=>JSON.parse(out.stdout).status).sort(),['ALREADY_RECORDED','RECORDED_LOCAL_HOLD']);
 const before=tableSnapshot(f.db);assert.equal(f.record(p).status,0);assert.deepEqual(tableSnapshot(f.db),before);
 const conflict=f.run('response-preview',f.write('conflict.json',event({type:'MANUAL_TAKEOVER'})));assert.equal(conflict.status,1);assert.match(conflict.stderr,/IDENTITY_CONFLICT/);
 assert.deepEqual(tableSnapshot(f.db),before);
});
test('actual concurrent different events require a fresh preview after the first state change',async t=>{
 const f=setup(t),a=f.prepare(event()),b=f.prepare(event({eventId:'fixture-response-2',type:'MANUAL_TAKEOVER'}));
 const results=await Promise.all([a,b].map(p=>f.runAsync('response-record',p.request,p.previewPath,'--confirm-preview',p.preview.hash)));
 assert.deepEqual(results.map(r=>r.status).sort(),[0,1]);assert.match(results.find(r=>r.status===1).stderr,/PREVIEW_STALE/);
 assert.equal(f.db.prepare("SELECT count(*) n FROM records WHERE kind='manual_response_event'").get().n,1);
});
test('actual concurrent conflicting event IDs append one immutable event and reject the other',async t=>{
 const f=setup(t),a=f.prepare(event());
 a.request=f.write('first-input.json',event());a.previewPath=f.write('first-preview.json',a.preview);
 const b=f.prepare(event({type:'MANUAL_TAKEOVER'}));
 const results=await Promise.all([a,b].map(p=>f.runAsync('response-record',p.request,p.previewPath,'--confirm-preview',p.preview.hash)));
 assert.deepEqual(results.map(r=>r.status).sort(),[0,1]);assert.match(results.find(r=>r.status===1).stderr,/IDENTITY_CONFLICT/);
 assert.equal(f.db.prepare("SELECT count(*) n FROM records WHERE kind='manual_response_event'").get().n,1);
 assert.equal(f.db.prepare("SELECT count(*) n FROM journal WHERE event='MANUAL_RESPONSE_RECORDED'").get().n,1);
});
test('actual takeover is a separate explicit event and native evidence changes invalidate its preview',t=>{
 const f=setup(t);assert.equal(f.record(f.prepare(event())).status,0);
 const takeover=f.prepare(event({eventId:'fixture-takeover',type:'MANUAL_TAKEOVER'})),out=f.record(takeover);assert.equal(out.status,0,out.stderr);
 assert.equal(JSON.parse(out.stdout).gate.replyReceived,true);assert.equal(JSON.parse(out.stdout).gate.manualTakeover,true);
 const request=f.prepare(event({eventId:'fixture-opt-out',type:'OPT_OUT',scope:'BUSINESS',scopeEvidenceRef:'fixture:scope'}));assert.equal(f.record(request).status,0);saveReadback(f.db,{scope:'BUSINESS'});
 const input=event({eventId:'fixture-native',type:'NATIVE_SUPPRESSION_VERIFIED',occurredAt:'2026-11-17T15:02:00Z',suppressionEventId:'fixture-opt-out',nativeEvidenceId:'fixture-native-1',evidenceRef:'fixture:operator-check'}),native=f.prepare(input);
 saveReadback(f.db,{scope:'BUSINESS',sourceRef:'fixture:changed-native-readback'});const before=tableSnapshot(f.db),stale=f.record(native);assert.equal(stale.status,1);assert.match(stale.stderr,/PREVIEW_STALE/);assert.deepEqual(tableSnapshot(f.db),before);
});
test('new production-capable service rolls back event/history/audit together on audit failure',t=>{
 const f=setup(t),input=event(),preview=responses.previewManualResponseEvent(f.db,input,later),before=tableSnapshot(f.db);
 f.db.exec("CREATE TEMP TRIGGER fail_response_audit BEFORE INSERT ON journal WHEN NEW.event='MANUAL_RESPONSE_RECORDED' BEGIN SELECT RAISE(ABORT,'fixture audit failure'); END;");
 assert.throws(()=>responses.recordPreviewedManualResponseEvent(f.db,input,preview,{confirmedPreviewHash:preview.hash,at:later}),/fixture audit failure/);
 assert.deepEqual(tableSnapshot(f.db),before);
});
