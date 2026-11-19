import test from 'node:test';import assert from 'node:assert/strict';
import {outreachPreviewFixture,tableSnapshot,previewAt} from './helpers/outreach-preview-fixture.mjs';
import {putRecord,getRecord,controls} from '../src/store.mjs';
import {createBatch,revokeApproval} from '../src/batches.mjs';
import {blockNetwork} from './helpers/network-block.mjs';
import {mkdtempSync} from 'node:fs';import {tmpdir} from 'node:os';import {join} from 'node:path';import {DatabaseSync} from 'node:sqlite';
const load=()=>import('../src/outreach-preview.mjs').catch(()=>null);
test('preview shows bound recipient copy evidence and reasons while stopped without state writes',async t=>{
 blockNetwork(t);const api=await load();assert.equal(typeof api?.previewOutreach,'function');
 const f=outreachPreviewFixture(':memory:',{contact:{verification:'CATCH_ALL',suppressed:null},approved:false});t.after(()=>f.db.close());const before=tableSnapshot(f.db);
 const preview=api.previewOutreach(f.db,f.input);assert.equal(preview.label,'PREVIEW — NOT RELEASED');assert.equal(preview.exportEligible,false);assert.equal(preview.recipients[0].email,'team@example.org');assert.match(preview.recipients[0].messages[0].body,/Synthetic step 1/);assert.equal(preview.recipients[0].evidence[0].source.id,'fixture-source');
 for(const flag of ['HELD','UNVERIFIED','APPROVAL_MISSING','SUPPRESSION_UNKNOWN'])assert.ok(preview.recipients[0].flags.includes(flag),flag);
 assert.deepEqual(tableSnapshot(f.db),before);assert.deepEqual(controls(f.db).stopped,true);assert.equal(preview.releaseAllowed,false);
});
test('approved local export is distinct from stopped release and creates no reservations or approvals',async t=>{
 blockNetwork(t);const api=await load();assert.equal(typeof api?.buildApprovedOutreachCsv,'function');const f=outreachPreviewFixture();t.after(()=>f.db.close());const before=tableSnapshot(f.db);
 const result=api.buildApprovedOutreachCsv(f.db,f.input);assert.equal(result.status,'APPROVED_EXPORT_NOT_RELEASED');assert.equal(result.releaseAllowed,false);assert.ok(result.releaseReasons.includes('System stopped'));assert.ok(result.releaseReasons.includes('System launch not authorized'));assert.match(result.csv,/team@example.org/);assert.match(result.csv,/Fixture Café/);assert.match(result.csv,/equipment &amp; catering/);assert.equal(result.batchHash,f.batch.hash);assert.equal(result.dispatchEnabled,false);assert.deepEqual(tableSnapshot(f.db),before);
});
for(const [name,options,change]of [
 ['missing approvals',{approved:false},()=>{}],
 ['revoked batch approval',{},f=>revokeApproval(f.db,f.approval.id,'Fixture revoke')],
 ['expired approval',{},f=>{f.input.at='2026-11-19T14:01:00Z';}],
 ['future approval',{},f=>f.db.prepare('UPDATE approvals SET created_at=? WHERE id=?').run('2026-11-18T15:01:00Z',f.approval.id)],
 ['revoked content approval',{},f=>putRecord(f.db,'writing_decision','fixture-content-decision',{...getRecord(f.db,'writing_decision','fixture-content-decision'),decision:'REVOKED'})],
 ['suppression added after approval',{},f=>putRecord(f.db,'contact',f.spec.email,{...getRecord(f.db,'contact',f.spec.email),suppressed:true})],
 ['verification invalid',{contact:{verification:'INVALID'}},()=>{}],
 ['verification stale',{contact:{verifiedAt:'2026-10-01T12:00:00Z'}},()=>{}],
 ['suppression unknown',{contact:{suppressed:null}},()=>{}],
 ['business held',{candidate:{qualification:'HOLD'}},()=>{}],
 ['evidence changed',{},f=>putRecord(f.db,'writing_evidence','fixture-source',{text:'Changed fixture evidence'})],
 ['sequence revised',{},f=>createBatch(f.db,'fixture-batch',{...f.content,sequence:{...f.content.sequence,delayDays:4}})],
 ['recipient fields revised',{},f=>createBatch(f.db,'fixture-batch',{...f.content,recipients:[{...f.content.recipients[0],standardFields:{company_name:'Different fixture'}}]})],
 ['copy revised',{},f=>createBatch(f.db,'fixture-batch',{...f.content,recipients:[{...f.content.recipients[0],messages:f.packet.messages.map((m,i)=>i?m:{...m,body:m.body+' Changed.'})}]})],
 ])test(`approved export fails closed for ${name} without returning CSV or mutating records`,async t=>{
 blockNetwork(t);const api=await load(),f=outreachPreviewFixture(':memory:',options);t.after(()=>f.db.close());change(f);const before=tableSnapshot(f.db);
 const result=api.buildApprovedOutreachCsv(f.db,f.input);assert.equal(result.status,'BLOCKED');assert.equal(Object.hasOwn(result,'csv'),false);assert.ok(result.reasons.length);assert.deepEqual(tableSnapshot(f.db),before);
});
test('suppressed state is explicit in preview rather than hidden behind approval failure',async t=>{
 const api=await load(),f=outreachPreviewFixture(':memory:',{contact:{suppressed:true}});t.after(()=>f.db.close());const row=api.previewOutreach(f.db,f.input).recipients[0];assert.ok(row.flags.includes('SUPPRESSED'));assert.ok(row.flags.includes('HELD'));assert.equal(row.flags.includes('ELIGIBLE'),false);
});
test('formula conflict blocks export without rewriting approved subject or state',async t=>{
 const api=await load(),f=outreachPreviewFixture(':memory:',{subject:'=HYPERLINK("https://example.org")'});t.after(()=>f.db.close());const before=tableSnapshot(f.db),result=api.buildApprovedOutreachCsv(f.db,f.input);
 assert.equal(result.status,'BLOCKED');assert.equal(Object.hasOwn(result,'csv'),false);assert.deepEqual(result.spreadsheetConflicts.map(x=>x.column),['pilot_subject_1','pilot_subject_2','pilot_subject_3']);assert.deepEqual(tableSnapshot(f.db),before);assert.equal(getRecord(f.db,'draft',f.spec.draftIds[0]).subject,'=HYPERLINK("https://example.org")');
});
test('no recipient subset is exported when a second approved row lacks a matching writing binding',async t=>{
 const api=await load(),f=outreachPreviewFixture();t.after(()=>f.db.close());const {decideApproval}=await import('../src/batches.mjs');
 const b=createBatch(f.db,'fixture-batch',{...f.content,recipients:[...f.content.recipients,{...f.content.recipients[0],email:'other@example.org'}]});const a=decideApproval(f.db,'fixture-batch',b.version,b.hash,'APPROVED','Fixture approver','2026-11-19T14:00:00Z',previewAt);
 const result=api.buildApprovedOutreachCsv(f.db,{...f.input,approvalId:a.id});assert.equal(result.status,'BLOCKED');assert.equal(Object.hasOwn(result,'csv'),false);
});
test('explicit recipient preview ignores no supplied copy or fake eligibility override',async t=>{
 const api=await load(),f=outreachPreviewFixture();t.after(()=>f.db.close());const selectors={recipients:[{candidateId:f.spec.candidateId,email:f.spec.email,reviewId:f.spec.reviewId,decisionId:'fixture-content-decision'}],at:previewAt};
 const p=api.previewOutreach(f.db,selectors);assert.equal(p.exportEligible,false);assert.ok(p.recipients[0].flags.includes('APPROVAL_MISSING'));assert.equal(p.recipients[0].messages[0].subject,'Fixture review 1');
 assert.throws(()=>api.previewOutreach(f.db,{...selectors,recipients:[{...selectors.recipients[0],messages:[{subject:'Injected',body:'Injected'}]}]}),/SELECTOR/);
 assert.throws(()=>api.buildApprovedOutreachCsv(f.db,{...f.input,allowed:true}),/UNKNOWN_OPTION/);
});
test('preview is deterministic, detached and visibly diagnostic with read-only database access',async t=>{
 blockNetwork(t);const api=await load(),path=join(mkdtempSync(join(tmpdir(),'elya-preview-')),'fixture.sqlite'),f=outreachPreviewFixture(path);const request=Object.freeze({...f.input});f.db.close();const db=new DatabaseSync(path,{readOnly:true});t.after(()=>db.close());const before=tableSnapshot(db);
 const p=api.previewOutreach(db,request);assert.deepEqual(api.previewOutreach(db,request),p);const text=api.renderOutreachPreview(p);assert.match(text,/^PREVIEW — NOT RELEASED/);assert.match(text,/Not a campaign-import CSV/);assert.match(text,/fixture-source/);assert.match(text,/Step 3 body/);p.recipients[0].messages[0].subject='Changed returned copy';assert.equal(api.previewOutreach(db,request).recipients[0].messages[0].subject,'Fixture review 1');assert.deepEqual(tableSnapshot(db),before);
});
test('snapshot ownership is explicit and formatting errors close only the owned transaction',async t=>{
 const api=await load(),f=outreachPreviewFixture(':memory:',{standardFields:{company_name:12}});t.after(()=>f.db.close());assert.throws(()=>api.buildApprovedOutreachCsv(f.db,f.input),/string/);assert.equal(f.db.isTransaction,false);
 f.db.exec('BEGIN');assert.throws(()=>api.previewOutreach(f.db,f.input),/SEPARATE_READ_SNAPSHOT/);assert.equal(f.db.isTransaction,true);f.db.exec('ROLLBACK');
});
test('synthetic-marked records cannot enter a production export or appear eligible',async t=>{
 const api=await load(),f=outreachPreviewFixture(':memory:',{candidate:{synthetic:true}});t.after(()=>f.db.close());const before=tableSnapshot(f.db);
 const result=api.buildApprovedOutreachCsv(f.db,f.input);assert.equal(result.status,'BLOCKED');assert.ok(result.reasons.includes('Synthetic writing records cannot reach handoff'));assert.equal(Object.hasOwn(result,'csv'),false);
 const row=api.previewOutreach(f.db,f.input).recipients[0];assert.ok(row.flags.includes('HELD'));assert.equal(row.flags.includes('ELIGIBLE'),false);assert.deepEqual(tableSnapshot(f.db),before);
});
test('eligibility and CSV share one snapshot; a later suppression blocks the next export',async t=>{
 const api=await load(),path=join(mkdtempSync(join(tmpdir(),'elya-preview-snapshot-')),'fixture.sqlite'),f=outreachPreviewFixture(path),writer=new DatabaseSync(path);t.after(()=>{writer.close();f.db.close();});
 const original=f.db.prepare.bind(f.db);let changed=false;
 f.db.prepare=sql=>{
  const statement=original(sql);
  if(!changed&&sql.includes('FROM batches'))return {get(...args){
   const row=statement.get(...args);changed=true;
   putRecord(writer,'contact',f.spec.email,{...getRecord(writer,'contact',f.spec.email),suppressed:true});return row;
  }};
  return statement;
 };
 const result=api.buildApprovedOutreachCsv(f.db,f.input);assert.equal(changed,true);assert.equal(result.status,'APPROVED_EXPORT_NOT_RELEASED');
 assert.equal(getRecord(f.db,'contact',f.spec.email).suppressed,true);assert.equal(api.buildApprovedOutreachCsv(f.db,f.input).status,'BLOCKED');
});
test('preview never labels changed displayed copy as approved even with a newly approved batch',async t=>{
 const api=await load(),f=outreachPreviewFixture();t.after(()=>f.db.close());const {decideApproval}=await import('../src/batches.mjs');
 const changed={...f.content,recipients:[{...f.content.recipients[0],messages:f.packet.messages.map((m,i)=>i?m:{...m,body:'Unapproved changed fixture copy'})}]};
 const b=createBatch(f.db,'fixture-batch',changed),a=decideApproval(f.db,'fixture-batch',b.version,b.hash,'APPROVED','Fixture approver','2026-11-19T14:00:00Z',previewAt);
 const p=api.previewOutreach(f.db,{...f.input,approvalId:a.id}),row=p.recipients[0];assert.equal(p.exportEligible,false);assert.equal(row.contentApproved,false);assert.equal(row.flags.includes('ELIGIBLE'),false);assert.ok(row.flags.includes('APPROVAL_MISSING'));assert.ok(row.reasons.includes('PREVIEW_DISPLAYED_COPY_OR_PACKET_BINDING_MISMATCH'));assert.equal(row.messages[0].body,'Unapproved changed fixture copy');
});
test('batch approver mismatch cannot appear approved or eligible in preview',async t=>{
 const api=await load(),f=outreachPreviewFixture();t.after(()=>f.db.close());f.db.prepare('UPDATE approvals SET actor=? WHERE id=?').run('Different fixture actor',f.approval.id);
 const p=api.previewOutreach(f.db,f.input);assert.equal(p.exportEligible,false);assert.equal(p.recipients[0].batchApproved,false);assert.equal(p.recipients[0].flags.includes('ELIGIBLE'),false);assert.ok(p.recipients[0].flags.includes('APPROVAL_MISSING'));
});
