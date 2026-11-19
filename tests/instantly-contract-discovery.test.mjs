import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {readFileSync,mkdtempSync,existsSync,mkdirSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {openStore,putRecord,getRecord,controls} from '../src/store.mjs';
import {canonical,digest} from '../src/values.mjs';
const api=await import('../src/instantly-contract-discovery-client.mjs').catch(()=>null);
const profile=await import('../src/instantly-discovery-profile.mjs').catch(()=>null);
test('discovery-only worker and capture validator are available',()=>{
 assert.equal(typeof api?.runDiscoveryCaptureWorker,'function');
 assert.equal(typeof api?.captureDiscoveryContracts,'function');
});
const names=['instantly_ai.create_lead','instantly_ai.list_emails'];
const tools=()=>names.map(name=>({name,description:'Synthetic advertised contract',inputSchema:{type:'object',properties:{id:{anyOf:[{type:'string'},{type:'null'}]}},additionalProperties:false},outputSchema:{type:'object',additionalProperties:true},annotations:{readOnlyHint:name.endsWith('list_emails')},_meta:{fixture:'complete metadata retained'},title:'Synthetic contract'}));
function runtime({contracts=tools(),state='connected',error=false,writeError=false,modify}={}){
 const requests=[];let count=0;
 return {requests,startProcess:()=>{
  const c=new EventEmitter();c.pid=123;c.stdin=new EventEmitter();c.stdout=new EventEmitter();c.stderr=new EventEmitter();
  c.stdin.write=(line,done)=>{
   const m=JSON.parse(line);requests.push(m);done?.(writeError&&m.method==='mcpServerStatus/list'?Error('synthetic'):null);if(m.id===undefined)return;
   let result=m.method==='thread/start'?{thread:{id:'fake-thread'}}:{};
   if(m.method==='mcpServerStatus/list'){count++;result={data:[{name:'codex_apps',authStatus:'bearerToken',runtimeStatus:typeof state==='function'?state(count):state,tools:Object.fromEntries(contracts.map((v,i)=>[String(i),v]))}],nextCursor:null};modify?.(result,count);}
   queueMicrotask(()=>c.stdout.emit('data',Buffer.from(JSON.stringify({id:m.id,...(error&&m.method==='mcpServerStatus/list'?{error:{code:1,message:'synthetic'}}:{result})})+'\n')));
  };return c;
 }};
}
function fixture(t,options={}){
 const db=openStore(':memory:');t.after(()=>db.close());let now=Date.now();
 const manifest=structuredClone(profile.DISCOVERY_MANIFEST),directory=mkdtempSync(join(tmpdir(),'elya-discovery-'));
 const context={manifestId:manifest.id,manifestHash:digest(canonical(manifest)),manifest,project:process.cwd(),database:'',codex:'fake',environment:{},launchStartedMs:now,readinessDeadlineMs:now+20000,providerDeadlineMs:now+40000,deadlineAt:new Date(now+40000).toISOString(),hardDeadlineAt:new Date(now+60000).toISOString()};
 putRecord(db,'acceptance_discovery_run',manifest.id,{manifestHash:context.manifestHash,contextHash:digest(canonical(context)),status:'LAUNCH_INTENT',workerStarted:false,statusRequests:0,businessCalls:0,directory});
 const fake=runtime(options),args={db,manifest,context,directory,assertAuthority:()=>true,startProcess:fake.startProcess,clock:()=>now,wallClock:()=>now,sleep:async ms=>{now+=ms;}};
 return {db,manifest,context,directory,fake,args,get now(){return now;},advance:ms=>{now+=ms;}};
}
if(api&&profile){
 test('complete exact selected advertisements are retained and unrelated tools excluded',async t=>{
  const f=fixture(t,{contracts:[...tools(),{name:'other.tool',authorization:'Bearer unrelated-secret'}]}),before=controls(f.db);
  const r=await api.runDiscoveryCaptureWorker(f.args);assert.equal(r.status,'PASSED');assert.deepEqual(r.requestCounts,{statusDiscovery:1,business:0});
  const capture=JSON.parse(readFileSync(join(f.directory,'selected-contracts-01.json'),'utf8'));
  assert.deepEqual(capture.tools,tools());assert.equal(capture.stage,'BEFORE_SCHEMA_VALIDATION');assert.equal(capture.businessToolExecutionBegun,false);
  assert.equal(f.db.prepare('SELECT count(*) n FROM operations').get().n,0);assert.equal(f.db.prepare('SELECT count(*) n FROM budgets').get().n,0);assert.deepEqual(controls(f.db),before);
  assert.equal(f.fake.requests.some(r=>r.method==='mcpServer/tool/call'),false);
 });
 for(const c of [
  {name:'missing input',mutate:t=>delete t.inputSchema,reason:'DISCOVERY_CONTRACT_SCHEMA_ABSENT',category:'ABSENT',path:'/inputSchema'},
  {name:'malformed input',mutate:t=>t.inputSchema=null,reason:'DISCOVERY_CONTRACT_MALFORMED',category:'MALFORMED',path:'/inputSchema'},
  {name:'unsupported output',mutate:t=>t.outputSchema.properties={x:{$ref:'#/x'}},reason:'DISCOVERY_SCHEMA_UNSUPPORTED',category:'UNSUPPORTED',path:'/outputSchema/properties/x/$ref'},
 ])test(`both contracts saved before rejecting ${c.name}`,async t=>{
  const ts=tools();c.mutate(ts[0]);const f=fixture(t,{contracts:ts}),r=await api.runDiscoveryCaptureWorker(f.args);
  assert.equal(r.reason,c.reason);assert.equal(r.schemaFailure.category,c.category);assert.equal(r.schemaFailure.path,c.path);
  assert.deepEqual(JSON.parse(readFileSync(join(f.directory,'selected-contracts-01.json'),'utf8')).tools,ts);assert.equal(f.fake.requests.some(r=>r.method==='mcpServer/tool/call'),false);
 });
 test('optional output schema absence is explicit and permitted',async t=>{
  const ts=tools();delete ts[1].outputSchema;const f=fixture(t,{contracts:ts});assert.equal((await api.runDiscoveryCaptureWorker(f.args)).status,'PASSED');
  assert.equal(JSON.parse(readFileSync(join(f.directory,'selected-contracts-01.json'),'utf8')).presence[1].outputSchemaPresent,false);
 });
 test('evidence persistence failure halts before schema validation and any business call',async t=>{
  const f=fixture(t);mkdirSync(join(f.directory,'selected-contracts-01.json'));const r=await api.runDiscoveryCaptureWorker(f.args);assert.equal(r.reason,'DISCOVERY_EVIDENCE_PERSISTENCE_FAILED');assert.equal(r.requestCounts.statusDiscovery,1);assert.equal(r.schemaFailure,undefined);
 });
 test('missing target and duplicate contracts stop with retained selection',async t=>{
  for(const contracts of [[tools()[0]],[...tools(),tools()[0]]]){const f=fixture(t,{contracts}),r=await api.runDiscoveryCaptureWorker(f.args);assert.match(r.reason,/DISCOVERY_TARGET_(MISSING|CONFLICT)/);assert.ok(existsSync(join(f.directory,'selected-contracts-01.json')));assert.equal(r.requestCounts.statusDiscovery,1);}
 });
 test('starting is the sole wait state; requests spaced two seconds and capped at ten',async t=>{
  const f=fixture(t,{state:'starting'}),r=await api.runDiscoveryCaptureWorker(f.args);assert.equal(r.reason,'INSTANTLY_STATUS_REQUEST_CAP');assert.equal(r.requestCounts.statusDiscovery,10);assert.equal(f.now-f.context.launchStartedMs,18000);
  const trace=readFileSync(join(f.directory,'rpc.jsonl'),'utf8').trim().split('\n').map(JSON.parse).filter(x=>x.event==='RPC_REQUEST'&&x.method==='mcpServerStatus/list');
  for(let i=1;i<trace.length;i++)assert.equal(Date.parse(trace[i].at)-Date.parse(trace[i-1].at),2000);
 });
 test('starting transitions to connected without a new session',async t=>{
  const f=fixture(t,{state:n=>n===1?'starting':'connected'}),r=await api.runDiscoveryCaptureWorker(f.args);assert.equal(r.status,'PASSED');assert.equal(r.requestCounts.statusDiscovery,2);assert.equal(f.fake.requests.filter(r=>r.method==='thread/start').length,1);
 });
 test('errors and terminal states do not retry; failed requests count',async t=>{
  for(const options of [{error:true},{writeError:true},{state:'authenticationRequired'},{modify:i=>{i.data[0].authStatus='notLoggedIn';}}]){const f=fixture(t,options),r=await api.runDiscoveryCaptureWorker(f.args);assert.equal(r.status,'FAILED');assert.equal(r.requestCounts.statusDiscovery,1);assert.equal(f.fake.requests.filter(x=>x.method==='mcpServerStatus/list').length,1);}
 });
 test('readiness expiry, changed context and alternate target fail before discovery',async t=>{
  const late=fixture(t);late.advance(20000);const r=await api.runDiscoveryCaptureWorker(late.args);assert.equal(r.status,'FAILED');assert.equal(late.fake.requests.length,0);
  const bad=fixture(t);bad.context.manifest.targets=['instantly_ai.get_campaign'];assert.equal((await api.runDiscoveryCaptureWorker(bad.args)).status,'REJECTED');assert.equal(bad.fake.requests.length,0);
 });
 test('duplicate worker cannot claim or dispatch',async t=>{
  const f=fixture(t),first=await api.runDiscoveryCaptureWorker(f.args),second=await api.runDiscoveryCaptureWorker(f.args);assert.equal(first.status,'PASSED');assert.equal(second.workerOwnsSlot,false);assert.equal(f.fake.requests.filter(x=>x.method==='initialize').length,1);
 });
 test('business RPC unavailable even with a permissive permit callback',async t=>{
  const {acceptanceClient}=await import('../src/acceptance-instantly.mjs');const f=fixture(t),client=acceptanceClient({context:f.context,startProcess:f.fake.startProcess,audit:()=>{},permit:()=>{},clock:()=>f.now,sleep:f.args.sleep,discoveryOnly:true,captureInventory:()=>{}});
  await client.initialize();await assert.rejects(()=>client.call({server:'codex_apps',tool:names[0],arguments:{}}),/DISCOVERY_BUSINESS_RPC_UNAVAILABLE/);assert.equal(f.fake.requests.some(x=>x.method==='mcpServer/tool/call'),false);client.stop();
 });
 test('connected response arriving after readiness deadline cannot pass',async t=>{
  let f;f=fixture(t,{modify:()=>f.advance(20001)});const r=await api.runDiscoveryCaptureWorker(f.args);assert.equal(r.status,'FAILED');assert.equal(r.reason,'INSTANTLY_READINESS_DEADLINE');assert.ok(existsSync(join(f.directory,'selected-contracts-01.json')));
 });
 test('same discovery client cannot initialize a second process',async t=>{
  const {acceptanceClient}=await import('../src/acceptance-instantly.mjs');const f=fixture(t),client=acceptanceClient({context:f.context,startProcess:f.fake.startProcess,audit:()=>{},permit:()=>{},clock:()=>f.now,sleep:f.args.sleep,discoveryOnly:true,captureInventory:()=>{}});
  await client.initialize();await assert.rejects(()=>client.initialize(),/DISCOVERY_INITIALIZATION_ALREADY_ATTEMPTED/);assert.equal(f.fake.requests.filter(x=>x.method==='initialize').length,1);client.stop();
 });
 test('accelerated polling is refused rather than spending the next attempt',async t=>{
  const f=fixture(t,{state:'starting'});const r=await api.runDiscoveryCaptureWorker({...f.args,sleep:async()=>{}});assert.equal(r.reason,'DISCOVERY_REQUEST_SPACING');assert.equal(r.requestCounts.statusDiscovery,1);
 });
 test('unsafe selected metadata is never written and discovery stops',async t=>{
  const ts=tools();ts[0]._meta={authorization:'Bearer fixture-secret'};const f=fixture(t,{contracts:ts}),r=await api.runDiscoveryCaptureWorker(f.args);assert.equal(r.reason,'DISCOVERY_EVIDENCE_UNSAFE');assert.equal(existsSync(join(f.directory,'selected-contracts-01.json')),false);assert.equal(r.requestCounts.statusDiscovery,1);
 });
}
