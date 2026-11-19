import test from 'node:test';import assert from 'node:assert/strict';
import {readFileSync,writeFileSync,mkdtempSync,mkdirSync} from 'node:fs';import {tmpdir} from 'node:os';import {join,dirname} from 'node:path';
import {openStore,putRecord,getRecord} from '../src/store.mjs';import {digest} from '../src/values.mjs';import {blockNetwork} from './helpers/network-block.mjs';
const binding=await import('../src/instantly-qa-v2-binding.mjs').catch(()=>null);
const id='elya-instantly-qa-acceptance-v2',hash='17aba6391533f3052ebc0e996ebcf52d1829a3b802131ca0b1c4a3665d4a7767',at=Date.parse('2026-11-18T00:00:00Z');
const tables=['records','record_history','sources','controls','batches','approvals','budgets','operations','journal'];
function fixture(t){
 blockNetwork(t);assert.ok(binding?.bindInstantlyQaV2,'binding function must exist without top-level arming');
 const db=openStore(':memory:');t.after(()=>db.close());const root=mkdtempSync(join(tmpdir(),'elya-v2-bind-'));
 for(const f of binding.collectInstantlyQaV2Sources(process.cwd())){mkdirSync(dirname(join(root,f.path)),{recursive:true});writeFileSync(join(root,f.path),readFileSync(f.path));}
 putRecord(db,'acceptance_authorization','elya-instantly-qa-acceptance-v1',{status:'CLOSED'});putRecord(db,'acceptance_authorization','elya-acceptance-continuation-v1',{status:'CLOSED'});
 putRecord(db,'acceptance_result','elya-acceptance-continuation-v1',{authorizationStatus:'CLOSED',telegram:{status:'PASSED',cleanup:{confirmed:true},scenarios:{staleVersion:{status:'PASS'},requestChanges:{status:'PASS'}}}});
 const preparation=JSON.parse(readFileSync(join(root,'work/instantly-qa-acceptance-v2/preparation.json')));
 preparation.tableHashes=Object.fromEntries(tables.map(t=>[t,digest(JSON.stringify(db.prepare(`SELECT * FROM ${t} ORDER BY rowid`).all()))]));
 writeFileSync(join(root,'work/instantly-qa-acceptance-v2/preparation.json'),JSON.stringify(preparation));
 const evidenceDir=join(root,'work/instantly-qa-v2-offline');mkdirSync(evidenceDir,{recursive:true});
 writeFileSync(join(evidenceDir,'fixture-tests.txt'),'OFFLINE FIXTURE VALIDATION');
 const validation={status:'OFFLINE_VALIDATED',manifestHash:hash,passed:1,failed:0,cancelled:0,liveCalls:0,sourceFingerprints:binding.collectInstantlyQaV2Sources(root),logPath:'work/instantly-qa-v2-offline/fixture-tests.txt',logSha256:digest('OFFLINE FIXTURE VALIDATION')};
 writeFileSync(join(evidenceDir,'offline-validation.json'),JSON.stringify(validation));
 const executionApproval={type:'EXPLICIT_LIVE_EXECUTION_APPROVAL',manifestHash:hash,reference:'offline fixture only',approvedAt:new Date(at).toISOString()};
 return {db,root,executionApproval,atMs:at,now:()=>at,validation,evidenceDir};
}
test('v2 binding requires separate explicit execution approval and matching passed tested sources',t=>{
 const f=fixture(t);assert.throws(()=>binding.bindInstantlyQaV2({...f,executionApproval:null}),/EXPLICIT_EXECUTION_APPROVAL_REQUIRED/);assert.equal(getRecord(f.db,'acceptance_authorization',id),null);
 const result=binding.bindInstantlyQaV2(f);assert.equal(result.authorizationStatus,'APPROVED');assert.equal(result.startedAt,null);assert.equal(result.expiresAt,'2026-11-19T00:00:00.000Z');assert.equal(result.manifestHash,hash);
 assert.equal(result.readiness.authorizationState.status,'APPROVED');assert.throws(()=>binding.bindInstantlyQaV2(f),/ALREADY|BASELINE/);
});
test('binding readiness uses current time and rolls back a grant that expired during preparation',t=>{
 const f=fixture(t);assert.throws(()=>binding.bindInstantlyQaV2({...f,now:()=>at+86400000}),/VALIDITY_EXPIRED/);assert.equal(getRecord(f.db,'acceptance_authorization',id),null);
});
for(const mode of ['source','log','baseline','manifest','validation'])test(`binding rejects changed ${mode} without creating authority`,t=>{
 const f=fixture(t);
 if(mode==='source')writeFileSync(join(f.root,'src/instantly-qa-command.mjs'),'changed');
 if(mode==='log')writeFileSync(join(f.evidenceDir,'fixture-tests.txt'),'changed');
 if(mode==='baseline')putRecord(f.db,'unrelated','changed',{changed:true});
 if(mode==='manifest'){const path=join(f.root,'work/instantly-qa-acceptance-v2/manifest.json');const m=JSON.parse(readFileSync(path));m.limits.sessionTotalMs++;writeFileSync(path,JSON.stringify(m));}
 if(mode==='validation')writeFileSync(join(f.evidenceDir,'offline-validation.json'),JSON.stringify({...f.validation,failed:1}));
 assert.throws(()=>binding.bindInstantlyQaV2(f));assert.equal(getRecord(f.db,'acceptance_authorization',id),null);
});
