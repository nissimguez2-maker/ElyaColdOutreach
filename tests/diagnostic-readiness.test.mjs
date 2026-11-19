import test from 'node:test';import assert from 'node:assert/strict';
const api=await import('../src/diagnostic-readiness.mjs').catch(()=>null);
const call={provider:'instantly',server:'codex_apps',tool:'instantly_ai.get_campaign'};
const snapshot=(state='starting',patch={})=>({data:[{name:'codex_apps',authStatus:'bearerToken',runtimeStatus:state,toolsError:null,tools:{one:{name:call.tool,inputSchema:{type:'object'}}},...patch}],nextCursor:null});
function fixture(sequence,allowance=40000){let time=1000,count=0;const waits=[],audit=[];return {options:{call,read:async()=>{count++;return sequence[Math.min(count-1,sequence.length-1)];},deadlineAt:new Date(time+allowance).toISOString(),now:()=>time,sleep:async ms=>{waits.push(ms);time+=ms;},audit:r=>audit.push(r)},count:()=>count,waits,audit};}
test('bounded readiness implementation exists',()=>assert.ok(api));
test('starting transitions to connected using the same deadline and bounded interval',async()=>{const f=fixture([snapshot(),snapshot('connected')]);const r=await api.waitForDiscoveryReady(f.options);assert.equal(r.evidence.runtimeStatus.value,'connected');assert.equal(r.evidence.authStatus.value,'bearerToken');assert.equal(f.count(),2);assert.deepEqual(f.waits,[2000]);assert.deepEqual(f.audit.filter(e=>e.event==='DISCOVERY_STATUS_OBSERVED').map(e=>e.attempt),[1,2]);assert.equal(r.tool.name,call.tool);});
test('persistent starting reaches fixed deadline without another request',async()=>{const f=fixture([snapshot()],5000);await assert.rejects(api.waitForDiscoveryReady(f.options),/READINESS_DEADLINE/);assert.equal(f.count(),3);assert.deepEqual(f.waits,[2000,2000,1000]);});
test('readiness cannot exceed twenty requests even with a longer supplied deadline',async()=>{const f=fixture([snapshot()],90000);await assert.rejects(api.waitForDiscoveryReady(f.options),/READINESS_REQUEST_CAP/);assert.equal(f.count(),20);assert.equal(f.waits.length,19);});
const failures=[
 ['auth',snapshot('starting',{authStatus:'notLoggedIn'}),'DISCOVERY_AUTH_NOT_LOGGED_IN'],
 ['discovery error',snapshot('starting',{toolsError:'fixture'}),'DISCOVERY_TOOLS_ERROR'],
 ['missing server',{data:[]},'DISCOVERY_SERVER_MISSING'],
 ['duplicate server',{data:[snapshot().data[0],snapshot().data[0]]},'DISCOVERY_SERVER_DUPLICATE'],
 ['pagination',{...snapshot(),nextCursor:'fixture'},'DISCOVERY_PAGINATION_INCOMPLETE'],
 ['missing tool while starting',snapshot('starting',{tools:{}}),'EXACT_TOOL_UNAVAILABLE'],
 ['invalid tool while starting',snapshot('starting',{tools:{bad:null}}),'DISCOVERY_TOOL_ENTRY_INVALID'],
 ...['notStarted','authenticationRequired','failed','cancelled','disabled','unknown'].map(s=>[s,snapshot(s),'DISCOVERY_RUNTIME_NOT_CONNECTED']),
 ['missing state',snapshot(undefined,{runtimeStatus:undefined}),'READINESS_STATE_UNCONFIRMED'],
 ['null state',snapshot(null),'READINESS_STATE_UNCONFIRMED'],
];
for(const [name,response,error]of failures)test(`readiness stops immediately: ${name}`,async()=>{const f=fixture([response]);await assert.rejects(api.waitForDiscoveryReady(f.options),new RegExp(error));assert.equal(f.count(),1);assert.deepEqual(f.waits,[]);});
test('readiness stop check prevents further discovery without clearing business stop',async()=>{const f=fixture([snapshot()]);f.options.assertActive=()=>{if(f.waits.length)throw Error('READINESS_STOPPED');};await assert.rejects(api.waitForDiscoveryReady(f.options),/READINESS_STOPPED/);assert.equal(f.count(),1);});
test('cancellation interrupts sleep and no later discovery can occur',async()=>{const c=new AbortController(),f=fixture([snapshot()]);f.options.signal=c.signal;f.options.sleep=async()=>{c.abort();};await assert.rejects(api.waitForDiscoveryReady(f.options),/READINESS_CANCELLED/);assert.equal(f.count(),1);});
test('cancellation interrupts an unresolved discovery request',async()=>{const c=new AbortController();let count=0;const run=api.waitForDiscoveryReady({call,read:()=>{count++;queueMicrotask(()=>c.abort());return new Promise(()=>{});},deadlineAt:new Date(Date.now()+5000).toISOString(),audit:()=>{},signal:c.signal});await assert.rejects(run,/READINESS_CANCELLED/);assert.equal(count,1);});
test('hung discovery times out, and a late result cannot trigger another request',async()=>{let finish,count=0;const run=api.waitForDiscoveryReady({call,read:()=>{count++;return new Promise(resolve=>finish=resolve);},deadlineAt:new Date(Date.now()+25).toISOString(),audit:()=>{}});await assert.rejects(run,/READINESS_DEADLINE/);finish(snapshot());await new Promise(r=>setTimeout(r,5));assert.equal(count,1);});
test('cancelled or expired initialization never requests discovery',async()=>{for(const cancelled of [true,false]){const c=new AbortController();if(cancelled)c.abort();let count=0;await assert.rejects(api.waitForDiscoveryReady({call,read:async()=>{count++;return snapshot();},deadlineAt:new Date(cancelled?Date.now()+5000:0).toISOString(),signal:c.signal,audit:()=>{}}));assert.equal(count,0);}});
test('provider exceptions are not retried',async()=>{let count=0;await assert.rejects(api.waitForDiscoveryReady({call,read:async()=>{count++;throw Error('RPC_ERROR');},deadlineAt:new Date(Date.now()+5000).toISOString(),audit:()=>{}}),/RPC_ERROR/);assert.equal(count,1);});
test('cancellation during readiness reporting cannot be returned as ready',async()=>{const c=new AbortController(),f=fixture([snapshot('connected')]);f.options.signal=c.signal;f.options.audit=()=>c.abort();await assert.rejects(api.waitForDiscoveryReady(f.options),/READINESS_CANCELLED/);assert.equal(f.count(),1);});
