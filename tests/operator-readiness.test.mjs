import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,existsSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve,relative} from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawnSync} from 'node:child_process';
import {writingTelegramFixture,at} from './helpers/telegram-writing-fixture.mjs';
import {createDraftingPacket,createDraftProvenanceTemplate,createCriticalReviewPacket,WRITING_DIMENSIONS} from '../src/drafting-handoff.mjs';
import {canonical} from '../src/values.mjs';
const root=fileURLToPath(new URL('../',import.meta.url));
const relativePath=path=>relative(root,path).replaceAll('\\','/');
function setup(t){
 const directory=mkdtempSync(join(tmpdir(),'elya-operator-readiness-')),path=join(directory,'fixture.sqlite');
 const f=writingTelegramFixture(path);t.after(()=>f.db.close());
 const work=resolve(root,'work/local-readiness-sprint-v1/test-fixtures');mkdirSync(work,{recursive:true});
 const files=mkdtempSync(join(work,'operator-'));
 const packet=createDraftingPacket(f.db,{spec:f.spec,businessContext:{version:'fixture',offer:'Funding intermediary'},rubric:{version:'fixture',dimensions:WRITING_DIMENSIONS},createdAt:at});
 const result={schemaVersion:'assisted-draft-output-v1',packetHash:packet.hash,contextHash:packet.context.hash,draftVersion:packet.draftVersion,disposition:'NEEDS_REVIEW',drafts:[1,2,3].map(step=>({step,subject:'Synthetic '+step,body:'Hi QA team,\n\nSynthetic fixture only.\n\nDaniel Rosen\nHead of Operations and Underwriting\nElya Partners',factIds:['catering'],angle:'Synthetic',uncertainties:[],skepticalOwnerObjection:'Why engage?',responseToObjection:'Synthetic only.',ctaRationale:'Synthetic only.'})),critique:{method:'AUTHOR_SELF_CRITIQUE',findings:[],unresolved:[]}};
 const write=(name,value)=>{const target=join(files,name);writeFileSync(target,typeof value==='string'?value:JSON.stringify(value));return target;};
 const packetPath=write('packet.json',packet),rawPath=write('raw.txt',result);
 const run=(...args)=>spawnSync(process.execPath,['--import=./tests/helpers/deny-network-preload.mjs',resolve(root,'src/operator.mjs'),...args,'--db',path],{encoding:'utf8',timeout:15000,windowsHide:true,cwd:root});
 return {...f,path,files,packet,result,write,run,request:{kind:'draft',packetPath:relativePath(packetPath),rawPath,outputDirectory:relativePath(join(files,'received'))}};
}
function snapshot(db){return canonical(db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all().map(({name})=>({name,rows:db.prepare('SELECT * FROM '+name+' ORDER BY rowid').all().map(r=>({...r}))})));}
test('actual writing-receive entry preserves valid raw result, refuses repeat and leaves all DB tables unchanged',t=>{
 const f=setup(t),before=snapshot(f.db),request=f.write('request.json',f.request),out=f.run('writing-receive',request);
 assert.equal(out.status,0,out.stderr);const receipt=JSON.parse(out.stdout);assert.equal(receipt.status,'VALID_LOCAL_PROPOSAL_NOT_IMPORTED');
 assert.deepEqual(readFileSync(resolve(root,receipt.artifacts.raw.path)),readFileSync(f.request.rawPath));
 assert.equal(f.run('writing-receive',request).status,1);assert.equal(snapshot(f.db),before);
});
test('actual receive entry reports rejection as failure and preserves malformed raw evidence',t=>{
 const f=setup(t);f.write('raw.txt','{ invalid');const before=snapshot(f.db),out=f.run('writing-receive',f.write('request.json',f.request));
 assert.equal(out.status,1);const receipt=JSON.parse(out.stdout);assert.equal(receipt.status,'REJECTED');assert.equal(receipt.error,'INVALID_JSON');
 assert.equal(readFileSync(resolve(root,receipt.artifacts.raw.path),'utf8'),'{ invalid');assert.equal(snapshot(f.db),before);
});
test('actual launch-preview entry prints one exact message and blocked reasons without DB mutations',t=>{
 const f=setup(t),reviewBinding=createCriticalReviewPacket(f.packet,f.result),review={schemaVersion:'assisted-review-output-v1',packetHash:f.packet.hash,reviewedDraftHash:reviewBinding.reviewedDraftHash,reviewedResultHash:reviewBinding.reviewedResultHash,verdict:'NEEDS_HUMAN_REVIEW',dimensions:WRITING_DIMENSIONS.map(dimension=>({dimension,judgment:'PASS',reason:'Synthetic judgment',evidenceRefs:[]})),skepticalOwnerObjection:'Why?',proposedChanges:[],unresolved:[]};
 const input={packet:f.packet,result:f.result,provenance:createDraftProvenanceTemplate(f.result),reviewBinding,review,reviewedSteps:[1],at,plan:{}};
 const before=snapshot(f.db),out=f.run('launch-preview',f.write('preview.json',input));assert.equal(out.status,0,out.stderr);assert.match(out.stdout,/PREVIEW.*NOT RELEASED/);assert.match(out.stdout,/Synthetic 1/);assert.doesNotMatch(out.stdout,/Synthetic 2|Synthetic 3/);assert.match(out.stdout,/CONTACT_VERIFICATION_HELD/);assert.equal(snapshot(f.db),before);
});
test('actual status entry remains read-only, rejects extra arguments and cannot create a missing database',t=>{
 const f=setup(t),before=snapshot(f.db),out=f.run('response-status',f.spec.email,f.spec.candidateId);assert.equal(out.status,0,out.stderr);assert.equal(JSON.parse(out.stdout).autonomousRepliesEnabled,false);
 assert.equal(f.run('response-status',f.spec.email,f.spec.candidateId,'extra').status,1);
 const missing=join(f.files,'missing.sqlite'),failed=spawnSync(process.execPath,[resolve(root,'src/operator.mjs'),'writing-current','--db',missing],{encoding:'utf8',windowsHide:true,timeout:15000});assert.equal(failed.status,1);assert.equal(existsSync(missing),false);assert.equal(snapshot(f.db),before);
});
test('actual current-writing entry refuses a missing index rather than falling back to a historical packet',t=>{
 const f=setup(t),out=f.run('writing-current','work/local-readiness-sprint-v1/no-such-index.json');assert.equal(out.status,1);assert.match(out.stderr,/ENOENT/);
});
