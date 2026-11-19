import test from 'node:test';import assert from 'node:assert/strict';
import {Worker} from 'node:worker_threads';import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,readdirSync} from 'node:fs';import {tmpdir} from 'node:os';import {join} from 'node:path';
import {openStore,getRecord,controls} from '../src/store.mjs';import {armAcceptance,closeAcceptance} from '../src/acceptance-authority.mjs';import {canonical,digest} from '../src/values.mjs';
import {DISCOVERY_CAPTURE_ID,DISCOVERY_DIRECTORY,DISCOVERY_MANIFEST} from '../src/instantly-discovery-profile.mjs';import {blockNetwork} from './helpers/network-block.mjs';

test('concurrent discovery claim has one owner; duplicate entries log refusals without consumption or launch',{timeout:20000},async t=>{
 const network=blockNetwork(t),root=mkdtempSync(join(tmpdir(),'elya-discovery-race-')),db=openStore(join(root,'data/elya.sqlite'));t.after(()=>db.close());
 const base=join(root,DISCOVERY_DIRECTORY);mkdirSync(base,{recursive:true});writeFileSync(join(base,'manifest.json'),JSON.stringify(DISCOVERY_MANIFEST));
 const at=Date.parse('2026-11-18T16:00:00Z'),path=DISCOVERY_DIRECTORY+'/manifest.json';
 armAcceptance(db,DISCOVERY_MANIFEST,[{path,sha256:digest(readFileSync(join(root,path)))}],at-1000,{executionApproval:{type:'EXPLICIT_LIVE_EXECUTION_APPROVAL',manifestHash:digest(canonical(DISCOVERY_MANIFEST)),reference:'offline-only',approvedAt:new Date(at-1000).toISOString()}});
 const before=controls(db),barrier=new SharedArrayBuffer(4),signal=new Int32Array(barrier),workers=[];
 const authority=new URL('../src/acceptance-authority.mjs',import.meta.url).href,entry=new URL('../src/instantly-discovery-entry.mjs',import.meta.url).href;
 const code=`const {parentPort,workerData}=require('node:worker_threads'); (async()=>{const {DatabaseSync}=await import('node:sqlite'); const {claimAcceptance,cancelAcceptance,closeAcceptance}=await import(workerData.authority);const {runDiscoveryEntry}=await import(workerData.entry);const db=new DatabaseSync(workerData.database);db.exec('PRAGMA busy_timeout=5000;');parentPort.postMessage({ready:true});Atomics.wait(new Int32Array(workerData.barrier),0,0,10000);let claim;try{const g=claimAcceptance(db,workerData.manifest,workerData.at,{root:workerData.root,now:()=>workerData.at,entryCheck:()=>true,invocationId:workerData.id});claim={status:'CLAIMED',owner:g.claimInvocationId};}catch(e){claim={status:'DENIED',reason:e.message};}const refusal=await runDiscoveryEntry({db,root:workerData.root,now:()=>workerData.at,startedAtMs:workerData.at,runtime:{platform:'win32',stdinIsTTY:true,stdoutIsTTY:true,args:['--run-once'],agentContext:false,background:false}});db.close();parentPort.postMessage({done:true,claim,refusal});})().catch(e=>{parentPort.postMessage({error:e.message});process.exitCode=1;});`;
 const pending=['one','two'].map(id=>{
  const w=new Worker(code,{eval:true,workerData:{authority,entry,database:join(root,'data/elya.sqlite'),root,manifest:DISCOVERY_MANIFEST,at,barrier,id}});workers.push(w);
  let readyResolve,readyReject,doneResolve,doneReject;const ready=new Promise((r,j)=>{readyResolve=r;readyReject=j;}),done=new Promise((r,j)=>{doneResolve=r;doneReject=j;});done.catch(()=>{});
  w.on('message',m=>{if(m.ready)readyResolve();else if(m.done)doneResolve(m);else if(m.error){readyReject(Error(m.error));doneReject(Error(m.error));}});w.on('error',e=>{readyReject(e);doneReject(e);});return {ready,done};
 });
 t.after(async()=>{await Promise.all(workers.map(w=>w.terminate()));});await Promise.all(pending.map(p=>p.ready));Atomics.store(signal,0,1);Atomics.notify(signal,0);
 const outcomes=await Promise.all(pending.map(p=>p.done));assert.equal(outcomes.filter(o=>o.claim.status==='CLAIMED').length,1);assert.equal(outcomes.filter(o=>o.claim.reason==='ACCEPTANCE_AUTHORIZATION_CLAIMED').length,1);
 for(const o of outcomes){assert.equal(o.refusal.reason,'ACCEPTANCE_AUTHORIZATION_CLAIMED');assert.equal(o.refusal.attemptExternalActivity,'NOT_STARTED');assert.equal(o.refusal.authorizationStatus,'CLAIMED');}
 assert.equal(readdirSync(join(base,'attempts')).filter(n=>n.endsWith('.result.json')).length,2);
 const grant=getRecord(db,'acceptance_authorization',DISCOVERY_CAPTURE_ID);assert.equal(grant.status,'CLAIMED');assert.equal(getRecord(db,'acceptance_discovery_run',DISCOVERY_CAPTURE_ID),null);
 assert.equal(db.prepare('SELECT count(*) n FROM budgets').get().n,0);assert.equal(db.prepare('SELECT count(*) n FROM operations').get().n,0);assert.deepEqual(controls(db),before);assert.equal(network.attempts,0);
 closeAcceptance(db,{id:DISCOVERY_CAPTURE_ID,status:'BLOCKED',reason:'OFFLINE_FIXTURE_CLOSED',claimInvocationId:grant.claimInvocationId},at+1);
});
