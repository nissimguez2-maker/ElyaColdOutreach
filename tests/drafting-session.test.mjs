import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,readFileSync,writeFileSync,existsSync,symlinkSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {writingTelegramFixture} from './helpers/telegram-writing-fixture.mjs';
import {createDraftingPacket,createCriticalReviewPacket,createDraftProvenanceTemplate,WRITING_DIMENSIONS} from '../src/drafting-handoff.mjs';
import {canonical,digest} from '../src/values.mjs';
import {getRecord,putRecord} from '../src/store.mjs';
const hash=v=>digest(canonical(v)),at='2026-11-18T20:00:00Z';
async function api(){const a=await import('../src/drafting-session.mjs').catch(()=>null);assert.equal(typeof a?.receiveWritingResult,'function','local receive workflow required');return a;}
function setup(t){
 const root=mkdtempSync(join(tmpdir(),'elya-writing-session-'));mkdirSync(join(root,'work'));
 const f=writingTelegramFixture();t.after(()=>f.db.close());
 const packet=createDraftingPacket(f.db,{spec:f.spec,businessContext:{version:'fixture',offer:'Funding intermediary'},rubric:{version:'fixture',dimensions:WRITING_DIMENSIONS},createdAt:at});
 const result={schemaVersion:'assisted-draft-output-v1',packetHash:packet.hash,contextHash:packet.context.hash,draftVersion:packet.draftVersion,disposition:'NEEDS_REVIEW',drafts:[1,2,3].map(step=>({step,subject:'Synthetic '+step,body:'Hi QA team,\n\nSynthetic fixture only.\n\nDaniel Rosen\nHead of Operations and Underwriting\nElya Partners',factIds:['catering'],angle:'Synthetic',uncertainties:[],skepticalOwnerObjection:'Why engage?',responseToObjection:'Synthetic only.',ctaRationale:'Synthetic only.'})),critique:{method:'AUTHOR_SELF_CRITIQUE',findings:[],unresolved:[]}};
 const write=(path,value)=>writeFileSync(join(root,path),typeof value==='string'?value:JSON.stringify(value,null,2));
 write('work/packet.json',packet);write('work/raw.txt',result);
 return {...f,root,packet,result,write,input:{kind:'draft',packetPath:'work/packet.json',rawPath:'work/raw.txt',outputDirectory:'work/received'}};
}
const snapshot=db=>canonical(['records','operations','budgets','controls'].map(table=>db.prepare('SELECT * FROM '+table).all().map(r=>({...r}))));
test('receive preserves exact raw bytes, computes binding and unknown provenance without DB writes',async t=>{
 const a=await api(),f=setup(t),before=snapshot(f.db),raw=readFileSync(join(f.root,'work/raw.txt'));
 const out=a.receiveWritingResult(f.db,f.input,{root:f.root});
 assert.equal(out.status,'VALID_LOCAL_PROPOSAL_NOT_IMPORTED');assert.equal(out.contentApproval,false);assert.equal(out.releaseAuthorized,false);
 assert.deepEqual(readFileSync(join(f.root,out.artifacts.raw.path)),raw);assert.equal(out.artifacts.raw.sha256,digest(raw));
 const envelope=JSON.parse(readFileSync(join(f.root,out.artifacts.envelope.path)));assert.equal(envelope.provenance.generation.generatedAt,'UNKNOWN');assert.equal(envelope.provenance.generation.receipt,null);
 assert.deepEqual(JSON.parse(readFileSync(join(f.root,out.artifacts.provenance.path))),envelope.provenance);
 const binding=JSON.parse(readFileSync(join(f.root,out.artifacts.reviewBinding.path)));assert.equal(binding.reviewedDraftHash,hash(f.result.drafts));
 assert.match(readFileSync(join(f.root,out.artifacts.draftView.path),'utf8'),/Subject: Synthetic 1/);assert.equal(snapshot(f.db),before);
 assert.throws(()=>a.receiveWritingResult(f.db,f.input,{root:f.root}),/EEXIST/);assert.deepEqual(readFileSync(join(f.root,out.artifacts.raw.path)),raw);
});
test('malformed, missing, tampered packet, wrong result and stale context leave rejected evidence and no DB writes',async t=>{
 const a=await api();
 for(const kind of ['malformed','missing','packet','wrong','stale']){
  const f=setup(t);if(kind==='malformed')f.write('work/raw.txt','{ not JSON');
  if(kind==='missing')f.input.rawPath='work/absent.txt';
  if(kind==='packet'){f.packet.businessContext.offer='Tampered';f.write('work/packet.json',f.packet);}
  if(kind==='wrong'){f.result.contextHash='a'.repeat(64);f.write('work/raw.txt',f.result);}
  if(kind==='stale')putRecord(f.db,'contact',f.spec.email,{...getRecord(f.db,'contact',f.spec.email),suppressed:true});
  const before=snapshot(f.db),out=a.receiveWritingResult(f.db,f.input,{root:f.root});assert.equal(out.status,'REJECTED',kind);assert.equal(snapshot(f.db),before);
  assert.equal(JSON.parse(readFileSync(join(f.root,'work/received/receipt.json'))).status,'REJECTED');
  assert.equal(existsSync(join(f.root,'work/received/raw.txt')),kind!=='missing');
  assert.equal(existsSync(join(f.root,'work/received/envelope.json')),false);
 }
});
test('material edit computes chain from a checked prior receipt and refuses corrupted history',async t=>{
 const a=await api(),f=setup(t);a.receiveWritingResult(f.db,f.input,{root:f.root});
 f.result.drafts[0].subject='Edited synthetic';f.write('work/edit.txt',f.result);
 const input={...f.input,rawPath:'work/edit.txt',outputDirectory:'work/edited',materialEdit:{previousReceiptPath:'work/received/receipt.json',at,editor:'Fixture editor',reason:'Clarify subject'}};
 const out=a.receiveWritingResult(f.db,input,{root:f.root});assert.equal(out.status,'VALID_LOCAL_PROPOSAL_NOT_IMPORTED');
 const envelope=JSON.parse(readFileSync(join(f.root,out.artifacts.envelope.path)));assert.equal(envelope.provenance.materialEdits.length,1);assert.equal(envelope.provenance.materialEdits[0].afterDraftHash,hash(f.result.drafts));assert.equal(envelope.provenance.generation.generatedAt,'UNKNOWN');
 f.write('work/received/envelope.json','{}');const rejected=a.receiveWritingResult(f.db,{...input,outputDirectory:'work/bad-history'},{root:f.root});assert.equal(rejected.status,'REJECTED');assert.match(rejected.error,/HASH_MISMATCH/);
});
test('review receipt validates exact result binding, preserves limited scope and cannot approve',async t=>{
 const a=await api(),f=setup(t),binding=createCriticalReviewPacket(f.packet,f.result);f.write('work/binding.json',binding);
 const review={schemaVersion:'assisted-review-output-v1',packetHash:f.packet.hash,reviewedDraftHash:binding.reviewedDraftHash,reviewedResultHash:binding.reviewedResultHash,verdict:'NEEDS_HUMAN_REVIEW',dimensions:WRITING_DIMENSIONS.map(dimension=>({dimension,judgment:'PASS',reason:'Fixture judgment',evidenceRefs:[]})),skepticalOwnerObjection:'Why engage?',proposedChanges:[],unresolved:[]};f.write('work/review.txt',review);
 const input={kind:'review',bindingPath:'work/binding.json',rawPath:'work/review.txt',outputDirectory:'work/reviewed',reviewedSteps:[1],review:{method:'SEPARATE_CONTEXT',reviewerLabel:'Operator-reported fixture',reviewedAt:'UNKNOWN'}};
 const before=snapshot(f.db),out=a.receiveWritingResult(f.db,input,{root:f.root});assert.equal(out.status,'LOCAL_SCHEMA_VALIDATED_NOT_APPROVED');assert.deepEqual(out.reviewedSteps,[1]);assert.equal(out.contentApproval,false);assert.equal(out.independence,'NOT_ESTABLISHED');assert.equal(snapshot(f.db),before);
 f.result.drafts[0].subject='Edited after review';f.write('work/after-review.txt',f.result);
 const edited=a.receiveWritingResult(f.db,{...f.input,rawPath:'work/after-review.txt',outputDirectory:'work/after-review',materialEdit:{previousReceiptPath:'work/reviewed/receipt.json',at,editor:'Fixture',reason:'Clarify'}},{root:f.root});assert.equal(edited.status,'VALID_LOCAL_PROPOSAL_NOT_IMPORTED');assert.equal(JSON.parse(readFileSync(join(f.root,edited.artifacts.normalizedProvenance.path))).review.status,'STALE_AFTER_MATERIAL_EDIT');
 review.reviewedDraftHash='0'.repeat(64);f.write('work/review.txt',review);assert.equal(a.receiveWritingResult(f.db,{...input,outputDirectory:'work/wrong-review'},{root:f.root}).status,'REJECTED');
});
test('outputs cannot escape work, evidence-write failure is not success, and external raw attachments are readable',async t=>{
 const a=await api(),f=setup(t);assert.throws(()=>a.receiveWritingResult(f.db,{...f.input,outputDirectory:'../escaped'},{root:f.root}),/LOCAL_WORK_PATH_REQUIRED/);
 assert.throws(()=>a.receiveWritingResult(f.db,{...f.input,outputDirectory:'data/received'},{root:f.root}),/LOCAL_WORK_PATH_REQUIRED/);
 f.write('work/not-a-directory','occupied');assert.throws(()=>a.receiveWritingResult(f.db,{...f.input,outputDirectory:'work/not-a-directory/received'},{root:f.root}));
 const outside=join(mkdtempSync(join(tmpdir(),'elya-raw-')),'external.txt');writeFileSync(outside,JSON.stringify(f.result));
 assert.equal(a.receiveWritingResult(f.db,{...f.input,rawPath:outside},{root:f.root}).status,'VALID_LOCAL_PROPOSAL_NOT_IMPORTED');
});
test('junction output cannot redirect writes outside work',async t=>{
 const a=await api(),f=setup(t);mkdirSync(join(f.root,'protected'));
 try{symlinkSync(join(f.root,'protected'),join(f.root,'work','redirect'),'junction');}catch(e){if(e.code==='EPERM')return t.skip('OS sandbox denies creation of junction fixture');throw e;}
 assert.throws(()=>a.receiveWritingResult(f.db,{...f.input,outputDirectory:'work/redirect/received'},{root:f.root}),/LOCAL_WORK_PATH_REQUIRED/);
});
function indexed(f){
 const binding=createCriticalReviewPacket(f.packet,f.result),review={schemaVersion:'assisted-review-output-v1',packetHash:f.packet.hash,reviewedDraftHash:binding.reviewedDraftHash,reviewedResultHash:binding.reviewedResultHash,verdict:'NEEDS_HUMAN_REVIEW',dimensions:WRITING_DIMENSIONS.map(dimension=>({dimension,judgment:'PASS',reason:'Fixture judgment',evidenceRefs:[]})),skepticalOwnerObjection:'Why engage?',proposedChanges:[],unresolved:[]};
 const artifacts={},save=(key,name,value)=>{f.write('work/'+name,value);artifacts[key]={path:'work/'+name,sha256:digest(readFileSync(join(f.root,'work/'+name)))};};
 save('packet','packet.json',f.packet);save('result','raw.txt',f.result);save('reviewBinding','binding.json',binding);save('review','review.json',review);
 const provenance=createDraftProvenanceTemplate(f.result);provenance.review={method:'SEPARATE_CONTEXT',reviewerLabel:'Fixture report',reviewedAt:'UNKNOWN',reviewedDraftHash:binding.reviewedDraftHash,artifact:{sourceRef:artifacts.review.path,sha256:artifacts.review.sha256}};
 save('provenance','provenance.json',{operatorProvenance:provenance});save('caveats','caveats.json',{unchangedMetadata:[{status:'HISTORICAL'}]});
 const closeout={status:'MANUAL_DRAFTING_EVALUATION_CLOSED',contentState:'UNAPPROVED_NOT_SENDABLE',candidatePath:artifacts.result.path,candidateFileSha256:artifacts.result.sha256,packetHash:f.packet.hash,reviewBindingHash:binding.hash,reviewedDraftHash:binding.reviewedDraftHash,reviewedResultHash:binding.reviewedResultHash,exactFirstTouchHash:hash({subject:f.result.drafts[0].subject,body:f.result.drafts[0].body}),rawReviewSha256:artifacts.review.sha256,reviewResultHash:hash(review),verdict:review.verdict,editorialOutcome:{reviewedSteps:[1]},followUps:{steps:[2,3],newlyReviewed:false,acceptedFirstTouchEvaluationScope:false},historicalMetadata:{status:'HISTORICAL_NOT_CURRENT',caveatsPath:artifacts.caveats.path},humanContentApproval:false,batchApproval:false,sendingAuthority:false};
 save('closeout','closeout.json',closeout);
 const index={version:'elya-current-writing-v1',status:'UNAPPROVED_NOT_SENDABLE',artifacts};f.write('work/index.json',index);return {index,save,closeout};
}
test('current index exposes exact first touch and checked envelope without promoting all-slot hashes to editorial approval',async t=>{
 const a=await api();assert.equal(typeof a.readCurrentWriting,'function','validated current writing index required');const f=setup(t);indexed(f);const before=snapshot(f.db);
 const out=a.readCurrentWriting({root:f.root,indexPath:'work/index.json',db:f.db});assert.equal(out.currentContextChecked,true);assert.deepEqual(out.envelope.result,f.result);assert.match(out.readable,/Subject: Synthetic 1/);assert.match(out.readable,/Historical rationale/);assert.deepEqual(out.reviewedSteps,[1]);assert.equal(out.contentApproval,false);assert.equal(snapshot(f.db),before);
 f.write('work/raw.txt','{}');assert.throws(()=>a.readCurrentWriting({root:f.root,indexPath:'work/index.json',db:f.db}),/ARTIFACT_HASH_MISMATCH/);
});
test('current index rejects missing, escaped, mismatched closeout and stale context artifacts',async t=>{
 const a=await api();assert.equal(typeof a.readCurrentWriting,'function','validated current writing index required');
 for(const kind of ['missing','escape','closeout','stale']){
  const f=setup(t),v=indexed(f);
  if(kind==='missing')v.index.artifacts.result.path='work/missing.json';
  if(kind==='escape')v.index.artifacts.result.path='../escape.json';
  if(kind==='closeout'){v.closeout.exactFirstTouchHash='0'.repeat(64);v.save('closeout','closeout.json',v.closeout);}
  if(kind==='stale')putRecord(f.db,'contact',f.spec.email,{...getRecord(f.db,'contact',f.spec.email),suppressed:true});
  f.write('work/index.json',v.index);const before=snapshot(f.db);assert.throws(()=>a.readCurrentWriting({root:f.root,indexPath:'work/index.json',db:f.db}));assert.equal(snapshot(f.db),before);
 }
});
