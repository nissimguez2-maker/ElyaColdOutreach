import './helpers/deny-network-preload.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {formatOutreachCsv,CSV_COLUMNS} from '../src/outreach-csv.mjs';
import {importDraftProposal} from '../src/workflow.mjs';
import {prepareWritingReview,decideWritingReview} from '../src/writing.mjs';
import {createBatch,decideApproval} from '../src/batches.mjs';
import {getRecord,putRecord,controls} from '../src/store.mjs';
import {buildApprovedOutreachCsv,previewOutreach} from '../src/outreach-preview.mjs';
import {outreachPreviewFixture,tableSnapshot} from './helpers/outreach-preview-fixture.mjs';
import {createDraftingPacket,WRITING_DIMENSIONS} from '../src/drafting-handoff.mjs';
import {mkdtempSync,writeFileSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {tmpdir} from 'node:os';
import {spawnSync} from 'node:child_process';
import {DatabaseSync} from 'node:sqlite';
import {pathToFileURL} from 'node:url';

const mode='first-touch-only-v1';
const row={email:'reader@example.invalid',pilot_subject_1:'A, "single" subject',pilot_body_1:'Hi café team,\n\nOne message only.'};
const columns=[...CSV_COLUMNS.slice(0,6),'pilot_subject_1','pilot_body_1'];
function fixture(t,{approved=true,contact={},path=':memory:'}={}){
 const f=outreachPreviewFixture(path,{approved:false,contact});t.after(()=>{if(f.db.isOpen)f.db.close();});
 const old=getRecord(f.db,'writing_policy',f.spec.campaignId);
 const policy={...old,revision:'fixture-first-touch',sequence:{steps:1,endpoint:'END_AFTER_FIRST_TOUCH',endpointApproved:true},approvalExpiry:{approved:true,approvedBy:old.approver,approvedAt:f.at,revision:'fixture-seven-calendar-days',maxCalendarDays:7,timeZone:'America/New_York'}};
 putRecord(f.db,'writing_policy',f.spec.campaignId,policy);
 f.spec={...f.spec,contractVersion:mode,draftIds:f.spec.draftIds.slice(0,1),steps:f.spec.steps.slice(0,1)};
 f.packet=prepareWritingReview(f.db,f.spec);
 const expiresAt='2026-11-25T15:00:00Z';
 const codes=f.packet.findings.filter(x=>x.severity==='REVIEW').map(x=>x.code);
 assert.deepEqual([...new Set(codes)].sort(),['SEMANTIC_REVIEW_REQUIRED','SPARSE_EVIDENCE']);
 const d=approved?decideWritingReview(f.db,{actionId:'first-touch-content',reviewId:f.spec.reviewId,packetHash:f.packet.hash,decision:'APPROVED',actor:policy.approver,at:f.at,expiresAt,acknowledgedFindings:codes}):null;
 f.content={...f.content,sequence:policy.sequence,recipients:[{...f.content.recipients[0],messages:f.packet.messages,writing:{reviewId:f.spec.reviewId,packetHash:f.packet.hash,decisionId:d?.id??null}}]};
 f.batch=createBatch(f.db,'fixture-first-touch-batch',f.content);
 f.approval=approved?decideApproval(f.db,'fixture-first-touch-batch',f.batch.version,f.batch.hash,'APPROVED',policy.approver,expiresAt,f.at):null;
 f.input={batchId:'fixture-first-touch-batch',approvalId:f.approval?.id??null,at:f.at};
 return f;
}

test('explicit first-touch formatting emits two copy columns without dummy followups or changing copy',()=>{
 const result=formatOutreachCsv([Object.freeze(row)],{contractVersion:mode});
 assert.deepEqual(result.columns,columns);assert.equal(result.formattingOnly,true);
 assert.match(result.csv,/A, ""single"" subject/);assert.match(result.csv,/Hi café team,\n\nOne message only\./);
 assert.doesNotMatch(result.csv,/pilot_(?:subject|body)_[23]/);
 assert.deepEqual(formatOutreachCsv([], {contractVersion:mode}).columns,columns);
});
test('first-touch formatter rejects extra slots, unknown modes/options and missing exact copy',()=>{
 assert.throws(()=>formatOutreachCsv([{...row,pilot_body_2:'Dummy'}],{contractVersion:mode}),/unknown field/i);
 assert.throws(()=>formatOutreachCsv([row],{contractVersion:'unknown'}),/CONTRACT/);
 assert.throws(()=>formatOutreachCsv([row],{contractVersion:mode,approved:true}),/OPTION/);
 assert.throws(()=>formatOutreachCsv([{...row,pilot_body_1:''}],{contractVersion:mode}),/nonempty string/);
 assert.throws(()=>formatOutreachCsv([row]),/pilot_subject_2/);
});
test('existing import path accepts one explicitly selected unapproved draft and preserves other drafts',t=>{
 const f=fixture(t,{approved:false}),second=getRecord(f.db,'draft','fixture-draft-2'),third=getRecord(f.db,'draft','fixture-draft-3');
 const drafts=f.spec.draftIds.map(id=>({id,data:getRecord(f.db,'draft',id)}));
 const packet=importDraftProposal(f.db,{drafts,spec:f.spec});assert.equal(packet.hash,f.packet.hash);assert.equal(packet.messages.length,1);
 assert.deepEqual(getRecord(f.db,'draft','fixture-draft-2'),second);assert.deepEqual(getRecord(f.db,'draft','fixture-draft-3'),third);
 assert.throws(()=>importDraftProposal(f.db,{drafts:[...drafts,{id:'fixture-draft-2',data:second}],spec:f.spec}),/ONE_DRAFT_REQUIRED/);
 assert.equal(controls(f.db).stopped,true);assert.equal(controls(f.db).launchAuthorized,false);
});
test('single-message approved CSV and preview use existing gates without changing state or reservations',t=>{
 const f=fixture(t),before=tableSnapshot(f.db);
 const preview=previewOutreach(f.db,f.input);assert.equal(preview.recipients[0].messages.length,1);assert.equal(preview.exportEligible,true);assert.equal(preview.releaseAllowed,false);
 const result=buildApprovedOutreachCsv(f.db,f.input);assert.equal(result.status,'APPROVED_EXPORT_NOT_RELEASED');assert.deepEqual(result.columns,columns);assert.equal(result.dispatchEnabled,false);assert.ok(result.releaseReasons.includes('System stopped'));
 assert.deepEqual(tableSnapshot(f.db),before);assert.equal(f.db.prepare('SELECT count(*) n FROM operations').get().n,0);
});
test('legacy assisted-generation envelope cannot silently issue a three-slot packet for the new mode',t=>{
 const f=fixture(t,{approved:false});
 assert.throws(()=>createDraftingPacket(f.db,{spec:f.spec,businessContext:{version:'fixture'},rubric:{version:'fixture',dimensions:WRITING_DIMENSIONS},createdAt:f.at}),/ASSISTED_THREE_SLOT_CONTRACT_REQUIRED/);
});
test('existing operator import entry accepts the isolated first-touch proposal without approvals or operations',t=>{
 const directory=mkdtempSync(join(tmpdir(),'elya-first-touch-')),path=join(directory,'fixture.sqlite'),file=join(directory,'proposal.json');
 const f=fixture(t,{approved:false,path}),drafts=f.spec.draftIds.map(id=>({id,data:getRecord(f.db,'draft',id)})),expected=f.packet.hash;
 writeFileSync(file,JSON.stringify({drafts,spec:f.spec}),'utf8');f.db.close();
 const process=spawnSync(globalThis.process.execPath,['--import',pathToFileURL(resolve('tests/helpers/deny-network-preload.mjs')).href,resolve('src/operator.mjs'),'import-drafts',file,'--db',path],{encoding:'utf8',timeout:5000,windowsHide:true});
 assert.equal(process.status,0,process.stderr);const output=JSON.parse(process.stdout);assert.equal(output.packetHash,expected);assert.equal(output.contentApproved,false);assert.equal(output.liveCalls,0);
 const db=new DatabaseSync(path,{readOnly:true});t.after(()=>db.close());
 assert.equal(getRecord(db,'writing_packet',expected).messages.length,1);
 assert.equal(db.prepare("SELECT count(*) n FROM records WHERE kind='writing_decision'").get().n,0);
 assert.equal(db.prepare('SELECT count(*) n FROM operations').get().n,0);assert.equal(db.prepare('SELECT count(*) n FROM approvals').get().n,0);
 assert.equal(controls(db).stopped,true);assert.equal(controls(db).launchAuthorized,false);
});
for(const [name,options]of [['held',{contact:{verification:'CATCH_ALL'}}],['suppressed',{contact:{suppressed:true}}],['suppression unknown',{contact:{suppressed:null}}],['approval missing',{approved:false}]])test(`single-message export blocks ${name} with no state change`,t=>{
 const f=fixture(t,options),before=tableSnapshot(f.db),result=buildApprovedOutreachCsv(f.db,f.input);
 assert.equal(result.status,'BLOCKED');assert.equal(Object.hasOwn(result,'csv'),false);assert.deepEqual(tableSnapshot(f.db),before);
});
