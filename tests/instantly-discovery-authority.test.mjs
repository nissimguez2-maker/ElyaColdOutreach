import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {openStore,getRecord,putRecord,controls} from '../src/store.mjs';
import {armAcceptance,claimAcceptance,assertFreshAcceptance,assertAcceptance,closeAcceptance,cancelAcceptance} from '../src/acceptance-authority.mjs';
import {digest,canonical} from '../src/values.mjs';
import {blockNetwork} from './helpers/network-block.mjs';

const at=Date.parse('2026-11-18T15:00:00Z');
async function fixture(t){
 blockNetwork(t);const profile=await import('../src/instantly-discovery-profile.mjs').catch(()=>null);
 assert.equal(typeof profile?.validateDiscoveryManifest,'function','explicit discovery-only profile required');
 const m=structuredClone(profile.DISCOVERY_MANIFEST),db=openStore(':memory:');t.after(()=>db.close());
 const root=mkdtempSync(join(tmpdir(),'elya-discovery-authority-')),base=join(root,profile.DISCOVERY_DIRECTORY);mkdirSync(base,{recursive:true});
 writeFileSync(join(base,'manifest.json'),JSON.stringify(m));
 const sources=[{path:profile.DISCOVERY_DIRECTORY+'/manifest.json',sha256:digest(readFileSync(join(base,'manifest.json')))}];
 const approval={type:'EXPLICIT_LIVE_EXECUTION_APPROVAL',manifestHash:digest(canonical(m)),reference:'offline-fixture',approvedAt:new Date(at).toISOString()};
 return {profile,m,db,root,sources,approval,options:{root,now:()=>at+1000,entryCheck:()=>true,invocationId:'fixture-claim'}};
}
test('explicit exact discovery profile binds no business calls or budget/reservation',async t=>{
 const f=await fixture(t),before=controls(f.db);const g=armAcceptance(f.db,f.m,f.sources,at,{executionApproval:f.approval});
 assert.equal(g.status,'APPROVED');assert.equal(g.startedAt,null);assert.equal(Date.parse(g.expiresAt)-at,86400000);
 assert.equal(g.authorizationBinding.selectedContractsHash,digest(canonical(['instantly_ai.create_lead','instantly_ai.list_emails'])));
 assert.equal(f.db.prepare('SELECT count(*) n FROM budgets').get().n,0);assert.equal(f.db.prepare('SELECT count(*) n FROM operations').get().n,0);assert.deepEqual(controls(f.db),before);
 for(const mutate of [m=>m.targets.push('instantly_ai.get_campaign'),m=>m.targets.reverse(),m=>m.server='codex_app',m=>m.limits.totalMs++,m=>m.limits.maxBusinessCalls=1,m=>m.limits.maxStatusRequests=11]){const bad=structuredClone(f.m);mutate(bad);assert.throws(()=>f.profile.validateDiscoveryManifest(bad),/DISCOVERY_MANIFEST_MISMATCH/);}
});
test('discovery needs explicit execution approval and permits only one claim',async t=>{
 const f=await fixture(t);assert.throws(()=>armAcceptance(f.db,f.m,f.sources,at),/EXPLICIT_EXECUTION_APPROVAL_REQUIRED/);
 armAcceptance(f.db,f.m,f.sources,at,{executionApproval:f.approval});const g=claimAcceptance(f.db,f.m,at+500,f.options);
 assert.equal(Date.parse(g.deadlineAt)-Date.parse(g.startedAt),60000);assert.equal(g.claimInvocationId,'fixture-claim');
 assert.throws(()=>claimAcceptance(f.db,f.m,at+500,{...f.options,invocationId:'second'}),/CLAIMED|USED/);
 assertAcceptance(f.db,f.m,at+1000);assert.throws(()=>assertAcceptance(f.db,f.m,at+60500),/DEADLINE/);
 assert.throws(()=>closeAcceptance(f.db,{id:f.m.id,status:'BLOCKED',reason:'FIXTURE',claimInvocationId:'wrong'},at+1500),/NOT_OWNER/);
 closeAcceptance(f.db,{id:f.m.id,status:'PASS',reason:'FIXTURE',claimInvocationId:g.claimInvocationId},at+1500);
 assert.throws(()=>assertFreshAcceptance(f.db,f.m,at+2000),/CLOSED/);assert.throws(()=>armAcceptance(f.db,f.m,f.sources,at+2000,{executionApproval:f.approval}),/ALREADY_EXISTS/);
});
for(const [label,offset,expected]of [['expired',86400000,'ACCEPTANCE_VALIDITY_EXPIRED'],['insufficient',86400000-149999,'ACCEPTANCE_VALIDITY_INSUFFICIENT'],['before-bind',-1,'ACCEPTANCE_VALIDITY_TIME_INVALID']])test(`discovery ${label} eligibility is fail-closed and nonconsuming`,async t=>{
 const f=await fixture(t);armAcceptance(f.db,f.m,f.sources,at,{executionApproval:f.approval});
 assert.throws(()=>assertFreshAcceptance(f.db,f.m,at+offset),e=>e.message===expected);
 assert.throws(()=>claimAcceptance(f.db,f.m,at+offset,{...f.options,now:()=>at+offset}),e=>e.message===expected);
 assert.equal(getRecord(f.db,'acceptance_authorization',f.m.id).status,'APPROVED');
});
test('150-second eligibility does not extend the 60-second execution timer',async t=>{
 const f=await fixture(t);armAcceptance(f.db,f.m,f.sources,at,{executionApproval:f.approval});const start=at+86400000-150000;
 const g=claimAcceptance(f.db,f.m,start,{...f.options,now:()=>start});assert.equal(Date.parse(g.deadlineAt),start+60000);
 assert.throws(()=>assertAcceptance(f.db,f.m,start+60000),/DEADLINE/);
});
for(const mode of ['source','binding','manifest','entry','stop','cancel'])test(`discovery rejects ${mode} changes without relaxing authority`,async t=>{
 const f=await fixture(t);armAcceptance(f.db,f.m,f.sources,at,{executionApproval:f.approval});const g=getRecord(f.db,'acceptance_authorization',f.m.id);
 if(mode==='source')writeFileSync(join(f.root,f.sources[0].path),'drift');
 if(mode==='binding')putRecord(f.db,'acceptance_authorization',f.m.id,{...g,authorizationBinding:{...g.authorizationBinding,selectedContractsHash:'changed'}});
 if(mode==='manifest')putRecord(f.db,'acceptance_authorization',f.m.id,{...g,manifestHash:'changed'});
 if(mode==='entry')f.options.entryCheck=()=>false;
 if(mode==='stop')f.db.exec('UPDATE controls SET stopped=0');
 if(mode==='cancel'){
  claimAcceptance(f.db,f.m,at+500,f.options);assert.throws(()=>cancelAcceptance(f.db,at+1000,f.m.id,'other'),/NOT_OWNER/);cancelAcceptance(f.db,at+1000,f.m.id,'fixture-claim');assert.throws(()=>assertAcceptance(f.db,f.m,at+1100),/CANCELLED/);return;
 }
 assert.throws(()=>claimAcceptance(f.db,f.m,at+500,f.options));assert.equal(getRecord(f.db,'acceptance_authorization',f.m.id).status,'APPROVED');
});
