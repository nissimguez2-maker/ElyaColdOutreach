import test from 'node:test';import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync} from 'node:fs';import {join,dirname} from 'node:path';import {tmpdir} from 'node:os';
import {openStore,getRecord} from '../src/store.mjs';import {digest,canonical} from '../src/values.mjs';
import {DISCOVERY_DIRECTORY,DISCOVERY_MANIFEST,DISCOVERY_MANIFEST_HASH,DISCOVERY_CAPTURE_ID} from '../src/instantly-discovery-profile.mjs';
import {blockNetwork} from './helpers/network-block.mjs';
const time=Date.parse('2026-11-18T15:00:00Z');
async function fixture(t){
 blockNetwork(t);const code=await import('../src/instantly-discovery-binding.mjs').catch(()=>null);assert.equal(typeof code?.bindDiscoveryCapture,'function');
 const root=mkdtempSync(join(tmpdir(),'elya-discovery-binding-'));const db=openStore(':memory:');t.after(()=>db.close());
 const save=(p,v)=>{mkdirSync(dirname(join(root,p)),{recursive:true});writeFileSync(join(root,p),typeof v==='string'?v:JSON.stringify(v));};
 for(const p of ['src/marker.mjs','tests/marker.test.mjs','package.json',`${DISCOVERY_DIRECTORY}/discovery-worker.mjs`,'work/connector-compatibility/owner.ps1','work/containment-proof/Job.cs'])save(p,'fixture');
 save(`${DISCOVERY_DIRECTORY}/manifest.json`,DISCOVERY_MANIFEST);
 const tables=['records','record_history','sources','controls','batches','approvals','budgets','operations','journal'];
 save(`${DISCOVERY_DIRECTORY}/preparation.json`,{manifestHash:DISCOVERY_MANIFEST_HASH,tableHashes:Object.fromEntries(tables.map(x=>[x,digest(JSON.stringify(db.prepare(`SELECT * FROM ${x} ORDER BY rowid`).all()))]))});
 const logPath=`${DISCOVERY_DIRECTORY}/offline/full-suite.log`,reviewPath=`${DISCOVERY_DIRECTORY}/offline/independent-review.md`;save(logPath,'offline fixture passed');save(reviewPath,'review fixture passed');
 const validation={status:'OFFLINE_VALIDATED',manifestHash:DISCOVERY_MANIFEST_HASH,passed:12,failed:0,cancelled:0,liveCalls:0,sourceFingerprints:code.collectDiscoverySources(root),logPath,logSha256:digest(readFileSync(join(root,logPath))),reviews:[{path:reviewPath,sha256:digest(readFileSync(join(root,reviewPath))),status:'APPROVED'}]};
 save(`${DISCOVERY_DIRECTORY}/offline/validation.json`,validation);
 const args={db,root,now:()=>time,executionApproval:{type:'EXPLICIT_LIVE_EXECUTION_APPROVAL',manifestHash:DISCOVERY_MANIFEST_HASH,reference:'offline fixture',approvedAt:new Date(time).toISOString()}};
 return {code,root,db,save,validation,args};
}
test('discovery binder requires tested sources and explicit approval, returns current readiness without starting',async t=>{
 const f=await fixture(t);assert.throws(()=>f.code.bindDiscoveryCapture({...f.args,executionApproval:null}),/EXPLICIT_EXECUTION/);
 const r=f.code.bindDiscoveryCapture(f.args);assert.equal(r.authorizationStatus,'APPROVED');assert.equal(r.startedAt,null);assert.equal(r.deadlineAt,null);assert.equal(r.expiresAt,new Date(time+86400000).toISOString());assert.equal(r.readiness.authorizationState.status,'APPROVED');
 assert.equal(f.db.prepare('SELECT count(*) n FROM budgets').get().n,0);assert.equal(f.db.prepare('SELECT count(*) n FROM operations').get().n,0);
 assert.throws(()=>f.code.bindDiscoveryCapture(f.args));assert.equal(getRecord(f.db,'acceptance_authorization',DISCOVERY_CAPTURE_ID).status,'APPROVED');
});
for(const mode of ['source','log','review','baseline','manifest'])test(`discovery binding rejects changed ${mode} before grant insertion`,async t=>{
 const f=await fixture(t);
 const paths={source:'src/marker.mjs',log:f.validation.logPath,review:f.validation.reviews[0].path,baseline:`${DISCOVERY_DIRECTORY}/preparation.json`,manifest:`${DISCOVERY_DIRECTORY}/manifest.json`};f.save(paths[mode],'changed');
 assert.throws(()=>f.code.bindDiscoveryCapture(f.args));assert.equal(getRecord(f.db,'acceptance_authorization',DISCOVERY_CAPTURE_ID),null);
});
test('shared readiness detects postbinding source drift and expiry without consuming',async t=>{
 const f=await fixture(t);f.code.bindDiscoveryCapture(f.args);
 assert.throws(()=>f.code.checkDiscoveryReadiness({...f.args,now:()=>time+86400000}),/EXPIRED/);
 f.save('src/marker.mjs','changed');assert.throws(()=>f.code.checkDiscoveryReadiness(f.args),/SOURCE_CHANGED/);
 assert.equal(getRecord(f.db,'acceptance_authorization',DISCOVERY_CAPTURE_ID).status,'APPROVED');
});
