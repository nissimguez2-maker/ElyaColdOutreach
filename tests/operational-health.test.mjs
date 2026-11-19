import test from 'node:test';import assert from 'node:assert/strict';import {mkdtempSync,readFileSync,readdirSync} from 'node:fs';import {tmpdir} from 'node:os';import {join} from 'node:path';
import {openStore,putRecord,controls} from '../src/store.mjs';import {blockNetwork} from './helpers/network-block.mjs';
const load=()=>import('../src/operational-health.mjs').catch(()=>null);
async function fixture(t){blockNetwork(t);const api=await load();assert.equal(typeof api?.createOperationalHealth,'function');const db=openStore(':memory:');t.after(()=>db.close());const root=mkdtempSync(join(tmpdir(),'elya-health-'));let clock=0,calls=0;const options={db,root,clock:()=>clock,timeoutMs:20,loadPingUrl:async()=> 'https://hc-ping.com/11111111-1111-4111-8111-111111111111',transport:async()=>{calls++;return {statusCode:200,body:'OK'};}};return {api,db,root,options,enable:()=>putRecord(db,'settings','operational-health',{healthchecksEnabled:true,approvedBy:'Offline fixture only',approvedAt:'2026-11-18T00:00:00Z'}),advance:ms=>clock+=ms,calls:()=>calls};}
test('missing monitoring configuration disables cleanly without credential load, network or state writes',async t=>{
 const f=await fixture(t),before=f.db.prepare('SELECT * FROM records').all();let loads=0;const h=f.api.createOperationalHealth({...f.options,loadPingUrl:()=>{loads++;throw Error('must not load');}});
 assert.equal((await h.workerAlive()).status,'DISABLED');assert.equal((await h.backupSucceeded({status:'BACKUP_VERIFIED'})).status,'DISABLED');assert.equal(loads,0);assert.equal(f.calls(),0);assert.deepEqual(f.db.prepare('SELECT * FROM records').all(),before);
});
test('intentional business stop reports worker liveness only and cannot change controls',async t=>{
 const f=await fixture(t);f.enable();let body;const before=controls(f.db),h=f.api.createOperationalHealth({...f.options,transport:async r=>{body=r.body;return {statusCode:200,body:'OK'};}});
 const result=await h.workerAlive();assert.equal(result.status,'ACCEPTED');assert.match(body,/BUSINESS_STOPPED/);assert.match(body,/LIVENESS_ONLY/);assert.deepEqual(controls(f.db),before);
});
test('timeout and exceptions are sanitized, bounded, no retry, and leave paid operations untouched',async t=>{
 const f=await fixture(t);f.enable();let calls=0;const h=f.api.createOperationalHealth({...f.options,transport:()=>{calls++;return new Promise(()=>{});}});const start=Date.now();const result=await h.workerAlive();assert.equal(result.status,'TIMEOUT');assert.ok(Date.now()-start<500);assert.equal(calls,1);assert.equal(f.db.prepare('SELECT count(*) n FROM operations').get().n,0);
 f.advance(60000);const bad=f.api.createOperationalHealth({...f.options,transport:async()=>{throw Error('Bearer fixture-private-token https://hc-ping.com/11111111-1111-4111-8111-111111111111');}});assert.equal((await bad.workerAlive()).status,'FAILED');
 const files=readdirSync(join(f.root,'data/operational-logs'));const text=files.map(p=>readFileSync(join(f.root,'data/operational-logs',p),'utf8')).join('');assert.doesNotMatch(text,/Bearer|fixture-private|hc-ping|11111111/);
});
test('backup heartbeat requires a verified creation, separate from restore testing',async t=>{
 const f=await fixture(t);f.enable();const h=f.api.createOperationalHealth(f.options);assert.equal((await h.backupSucceeded({status:'CREATED'})).status,'NOT_VERIFIED');assert.equal(f.calls(),0);assert.equal((await h.backupSucceeded({status:'BACKUP_VERIFIED'})).status,'ACCEPTED');assert.equal(f.calls(),1);
});
test('actual managed snapshot result permits only one backup-success observation',async t=>{
 const f=await fixture(t);f.enable();const {createManagedSnapshot}=await import('../src/local-maintenance.mjs');const h=f.api.createOperationalHealth(f.options);
 const snapshot=await createManagedSnapshot(f.db,{root:f.root,at:'2026-11-18T14:00:00Z'});assert.equal(snapshot.restoreTest,'NOT_TESTED');assert.equal((await h.backupSucceeded(snapshot)).status,'ACCEPTED');
 const sameDay=await createManagedSnapshot(f.db,{root:f.root,at:'2026-11-18T15:00:00Z'});assert.equal((await h.backupSucceeded(sameDay)).status,'NOT_VERIFIED');assert.equal(f.calls(),1);
});
test('minimal error deduplication and buffering remain bounded without raw errors or arbitrary payloads',async t=>{
 const f=await fixture(t);const h=f.api.createOperationalHealth(f.options),e={release:'fixture',jobId:'job-1',stage:'READ',provider:'instantly',category:'TIMEOUT',elapsedMs:20};
 assert.equal(h.recordError(e).status,'RECORDED');assert.equal(h.recordError(e).status,'DEDUPLICATED');assert.equal(h.recordError({...e,raw:'Bearer private'}).status,'REJECTED');
 for(let i=0;i<300;i++)h.recordError({...e,jobId:'job-'+i});assert.ok(h.localStatus().dedupEntries<=128);f.advance(900001);assert.equal(h.recordError(e).status,'RECORDED');
});
test('worker wrapper returns success/failure without awaiting monitoring or replaying business logic',async t=>{
 const f=await fixture(t);f.enable();let businessCalls=0;const h=f.api.createOperationalHealth({...f.options,transport:()=>new Promise(()=>{})});
 assert.equal(await h.observeWorkerCycle(async()=>{businessCalls++;return 42;}),42);assert.equal(businessCalls,1);
 await assert.rejects(()=>h.observeWorkerCycle(async()=>{businessCalls++;throw Error('business failure');}),/business failure/);assert.equal(businessCalls,2);await new Promise(r=>setTimeout(r,30));
});
test('heartbeat refuses redirects and unapproved endpoints and treats ignored 200 results as failed',async t=>{
 const f=await fixture(t);f.enable();for(const url of ['http://hc-ping.com/11111111-1111-4111-8111-111111111111','https://example.com/x','https://hc-ping.com/11111111-1111-4111-8111-111111111111?create=1']){
  const h=f.api.createOperationalHealth({...f.options,loadPingUrl:async()=>url});assert.equal((await h.workerAlive()).status,'FAILED');
 }assert.equal(f.calls(),0);
 const h=f.api.createOperationalHealth({...f.options,transport:async()=>({statusCode:200,body:'OK (rate limited)'})});assert.equal((await h.workerAlive()).status,'FAILED');
});
