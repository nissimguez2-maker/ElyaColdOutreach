import test from 'node:test';
import './helpers/deny-network-preload.mjs';
import assert from 'node:assert/strict';
import {mkdirSync,mkdtempSync,readFileSync,writeFileSync,readdirSync,copyFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,dirname,resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {openStore,getRecord,putRecord} from '../src/store.mjs';
import {armAcceptance} from '../src/acceptance-authority.mjs';
import {digest} from '../src/values.mjs';
import {DISCOVERY_CAPTURE_ID,DISCOVERY_DIRECTORY,DISCOVERY_MANIFEST,DISCOVERY_MANIFEST_HASH} from '../src/instantly-discovery-profile.mjs';

const entry=()=>import('../src/instantly-discovery-entry.mjs');
const eligible=()=>({platform:'win32',stdinIsTTY:true,stdoutIsTTY:true,args:['--run-once'],agentContext:false,background:false});
function fixture(t,{file=false}={}){
 const root=mkdtempSync(join(file?resolve('work/instantly-contract-capture-v1'):tmpdir(),'entry-fixture-')),base=join(root,DISCOVERY_DIRECTORY);
 mkdirSync(base,{recursive:true});mkdirSync(join(root,'src'),{recursive:true});writeFileSync(join(base,'manifest.json'),JSON.stringify(DISCOVERY_MANIFEST));
 const db=openStore(file?join(root,'data/elya.sqlite'):':memory:');t.after(()=>{if(db.isOpen)db.close();});
 const at=Date.now(),sources=[{path:DISCOVERY_DIRECTORY+'/manifest.json',sha256:digest(readFileSync(join(base,'manifest.json')))}];
 armAcceptance(db,DISCOVERY_MANIFEST,sources,at,{executionApproval:{type:'EXPLICIT_LIVE_EXECUTION_APPROVAL',manifestHash:DISCOVERY_MANIFEST_HASH,reference:'offline discovery entry fixture',approvedAt:new Date(at).toISOString()}});
 const before=()=>Object.fromEntries(['controls','budgets','operations','sources','batches','approvals'].map(table=>[table,db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()]));
 return {root,base,db,at,before,args:{db,root,startedAtMs:at,runtime:eligible()}};
}

test('discovery entry logs refusal without consuming authorization or invoking transport',async t=>{
 const f=fixture(t),before=f.before(),{runDiscoveryEntry}=await entry();let launches=0;
 for(const runtime of [{...eligible(),agentContext:true},{...eligible(),args:['--run-once','--fixture']}]){
  const result=await runDiscoveryEntry({...f.args,runtime,fixtureLaunch:()=>{launches++;}});
  assert.equal(result.status,'BLOCKED');assert.equal(result.exitCode,2);assert.equal(result.authorizationStatus,'APPROVED');assert.equal(result.attemptExternalActivity,'NOT_STARTED');
 }
 assert.equal(launches,0);assert.equal(getRecord(f.db,'acceptance_authorization',DISCOVERY_CAPTURE_ID).startedAt,null);assert.deepEqual(f.before(),before);
 assert.equal(readdirSync(join(f.base,'attempts')).filter(n=>n.endsWith('.result.json')).length,2);
});

test('discovery entry closes a claimed failed launch and never replays it',async t=>{
 const f=fixture(t),before=f.before(),{runDiscoveryEntry}=await entry();let launches=0;
 const fixtureLaunch=async()=>{launches++;return {exit:{code:1},owner:{cleanupConfirmed:false},worker:null};};
 const result=await runDiscoveryEntry({...f.args,fixtureLaunch});assert.equal(result.status,'BLOCKED');assert.equal(result.reason,'DISCOVERY_CLEANUP_UNCONFIRMED');assert.equal(result.authorizationStatus,'CLOSED');
 const old=readFileSync(join(f.base,'live-once/result.json'),'utf8'),repeat=await runDiscoveryEntry({...f.args,fixtureLaunch});
 assert.equal(repeat.reason,'ACCEPTANCE_AUTHORIZATION_CLOSED');assert.equal(repeat.attemptExternalActivity,'NOT_STARTED');assert.equal(launches,1);assert.equal(readFileSync(join(f.base,'live-once/result.json'),'utf8'),old);assert.deepEqual(f.before(),before);
});

test('discovery attempt evidence failure refuses before claim or transport',async t=>{
 const f=fixture(t),{runDiscoveryEntry}=await entry();writeFileSync(join(f.base,'attempts'),'offline obstruction');let launches=0;
 const result=await runDiscoveryEntry({...f.args,fixtureLaunch:()=>{launches++;}});assert.equal(result.reason,'DISCOVERY_ATTEMPT_EVIDENCE_PERSISTENCE_FAILED');assert.equal(result.authorizationStatus,'APPROVED');assert.equal(launches,0);
});

for(const [label,offset,reason]of [['expired',86400000,'ACCEPTANCE_VALIDITY_EXPIRED'],['insufficient remaining',86400000-149999,'ACCEPTANCE_VALIDITY_INSUFFICIENT']])test(`discovery entry ${label} refusal leaves authorization unconsumed`,async t=>{
 const f=fixture(t),{runDiscoveryEntry}=await entry(),old=getRecord(f.db,'acceptance_authorization',DISCOVERY_CAPTURE_ID);let launches=0;
 const result=await runDiscoveryEntry({...f.args,now:()=>f.at+offset,startedAtMs:f.at+offset,fixtureLaunch:()=>{launches++;}});
 assert.equal(result.reason,reason);assert.equal(result.authorizationStatus,'APPROVED');assert.deepEqual(getRecord(f.db,'acceptance_authorization',DISCOVERY_CAPTURE_ID),old);assert.equal(launches,0);
});

test('discovery entry output delay cannot extend readiness or total deadline',async t=>{
 const f=fixture(t),{runDiscoveryEntry}=await entry();let time=f.at,launches=0;
 const result=await runDiscoveryEntry({...f.args,now:()=>time,emit:event=>{assert.deepEqual(event.selectedTools,DISCOVERY_MANIFEST.targets);time=f.at+20000;},fixtureLaunch:()=>{launches++;}});
 assert.equal(result.reason,'DISCOVERY_READINESS_DEADLINE_BEFORE_LAUNCH');assert.equal(result.authorizationStatus,'CLOSED');assert.equal(result.attemptExternalActivity,'NOT_STARTED');assert.equal(launches,0);
 const grant=getRecord(f.db,'acceptance_authorization',DISCOVERY_CAPTURE_ID);assert.equal(Date.parse(grant.deadlineAt)-Date.parse(grant.startedAt),60000);
});

test('discovery entry reports durable failed request counts and closes after launch exception',async t=>{
 const f=fixture(t),before=f.before(),{runDiscoveryEntry}=await entry();
 const result=await runDiscoveryEntry({...f.args,fixtureLaunch:async()=>{const slot=getRecord(f.db,'acceptance_discovery_run',DISCOVERY_CAPTURE_ID);putRecord(f.db,'acceptance_discovery_run',DISCOVERY_CAPTURE_ID,{...slot,statusRequests:1});throw Error('DISCOVERY_SIMULATED_LAUNCH_ERROR');}});
 assert.equal(result.reason,'DISCOVERY_SIMULATED_LAUNCH_ERROR');assert.equal(result.requestCounts.statusDiscovery,1);assert.equal(result.cleanup.confirmed,false);assert.equal(result.authorizationStatus,'CLOSED');assert.deepEqual(f.before(),before);
});

test('discovery entry cancellation before claim remains a durable nonconsuming refusal',async t=>{
 const f=fixture(t),{runDiscoveryEntry}=await entry(),old=getRecord(f.db,'acceptance_authorization',DISCOVERY_CAPTURE_ID);let launches=0;
 const result=await runDiscoveryEntry({...f.args,cancelled:()=>true,fixtureLaunch:()=>{launches++;}});
 assert.equal(result.reason,'LOCAL_CANCELLATION');assert.equal(result.authorizationStatus,'APPROVED');assert.deepEqual(getRecord(f.db,'acceptance_authorization',DISCOVERY_CAPTURE_ID),old);assert.equal(launches,0);
});

test('late command failure keeps invocation identity and reports external activity unresolved',async t=>{
 const f=fixture(t),{runDiscoveryEntry,recordDiscoveryOpenRefusal}=await entry();let invocationId,result;
 try{await runDiscoveryEntry({...f.args,onInvocation:id=>{invocationId=id;},fixtureLaunch:async()=>{f.db.close();throw Error('DISCOVERY_SIMULATED_DATABASE_FAILURE');}});assert.fail('closed database must interrupt finalization');}
 catch(error){result=recordDiscoveryOpenRefusal({root:f.root,error,startedAtMs:f.at,invocationId});}
 assert.ok(invocationId);assert.equal(result.attemptId,invocationId);assert.equal(result.firstFailingStage,'LOCAL_CLI_COMMAND');assert.equal(result.attemptExternalActivity,'UNRESOLVED_SEE_INVOCATION_EVIDENCE');assert.equal(result.authorizationStatus,'UNRESOLVED_SEE_INVOCATION_EVIDENCE');
 const evidence=JSON.parse(readFileSync(join(f.base,'attempts',invocationId+'.command-error.json')));assert.equal(evidence.firstFailingStage,'LOCAL_CLI_COMMAND');assert.equal(evidence.noAutomaticRetry,true);
});

test('actual discovery operator entry uses contained fake worker and confirms independent cleanup',{skip:process.platform!=='win32',timeout:25000},async t=>{
 const f=fixture(t,{file:true}),before=f.before(),{runDiscoveryEntry}=await entry();
 for(const path of ['work/connector-compatibility/owner.ps1','work/containment-proof/Job.cs']){mkdirSync(dirname(join(f.root,path)),{recursive:true});copyFileSync(path,join(f.root,path));}
 const moduleUrl=name=>JSON.stringify(pathToFileURL(resolve(name)).href);
 const source=`import ${moduleUrl('tests/helpers/deny-network-preload.mjs')};
import {EventEmitter} from 'node:events';import {readFileSync,writeFileSync,appendFileSync} from 'node:fs';import {join} from 'node:path';
import {openStore} from ${moduleUrl('src/store.mjs')};import {assertAcceptance,verifyAcceptanceSources} from ${moduleUrl('src/acceptance-authority.mjs')};
import {runDiscoveryCaptureWorker} from ${moduleUrl('src/instantly-contract-discovery-client.mjs')};
const directory=process.argv[3],context=JSON.parse(readFileSync(join(directory,'context.json'),'utf8')),db=openStore(context.database);
const startProcess=()=>{const c=new EventEmitter();c.pid=process.pid;c.stdout=new EventEmitter();c.stderr=new EventEmitter();c.stdin=new EventEmitter();c.kill=()=>true;
c.stdin.write=(line,done)=>{const q=JSON.parse(line);done?.();if(q.id===undefined)return;appendFileSync(join(directory,'fixture-requests.jsonl'),JSON.stringify({method:q.method})+'\\n');
let result;if(q.method==='initialize')result={};else if(q.method==='thread/start')result={thread:{id:'isolated-discovery-thread'}};else if(q.method==='mcpServerStatus/list')result={data:[{name:'codex_apps',authStatus:'bearerToken',runtimeStatus:'connected',tools:Object.fromEntries(['instantly_ai.create_lead','instantly_ai.list_emails'].map(name=>[name,{name,description:'Synthetic contract only',inputSchema:{type:'object',properties:{}},outputSchema:{type:'object'},annotations:{readOnlyHint:name.endsWith('list_emails')}}]))}],nextCursor:null};else throw Error('UNAUTHORIZED_FIXTURE_METHOD');queueMicrotask(()=>c.stdout.emit('data',Buffer.from(JSON.stringify({id:q.id,result})+'\\n')));};return c;};
const result=await runDiscoveryCaptureWorker({db,manifest:context.manifest,context,directory,startProcess,assertAuthority:()=>{const g=assertAcceptance(db,context.manifest);verifyAcceptanceSources(context.project,g);return g;}});db.close();writeFileSync(join(directory,'worker-result.json'),JSON.stringify(result),{flag:'wx'});setInterval(()=>{},1000);
`;
 writeFileSync(join(f.base,'discovery-worker.mjs'),source);
 const result=await runDiscoveryEntry(f.args);assert.equal(result.status,'PASS',JSON.stringify(result));assert.equal(result.exitCode,0);assert.equal(result.requestCounts.business,0);assert.equal(result.requestCounts.statusDiscovery,1);
 assert.equal(result.cleanup.confirmed,true);assert.deepEqual(result.cleanup.evidence.remainingMembers,[]);assert.ok(result.cleanup.evidence.processChecks.length);assert.ok(result.cleanup.evidence.processChecks.every(p=>p.wait===0));assert.equal(result.cleanup.evidence.noPostCleanupRpcWrites,true);
 assert.equal(result.authorizationStatus,'CLOSED');assert.equal(getRecord(f.db,'acceptance_authorization',DISCOVERY_CAPTURE_ID).status,'CLOSED');assert.deepEqual(f.before(),before);
 const requests=readFileSync(join(f.base,'live-once/fixture-requests.jsonl'),'utf8').trim().split('\n').map(JSON.parse);assert.deepEqual(requests.map(r=>r.method),['initialize','thread/start','mcpServerStatus/list']);
 assert.equal(getRecord(f.db,'acceptance_discovery_run',DISCOVERY_CAPTURE_ID).businessCalls,0);assert.equal(getRecord(f.db,'acceptance_result',DISCOVERY_CAPTURE_ID).status,'PASS');
});
