import test from 'node:test';import assert from 'node:assert/strict';import {EventEmitter} from 'node:events';
import {diagnosticClient} from '../src/diagnostic-client.mjs';import {CALLS} from '../src/diagnostic-policy.mjs';
import {readFileSync} from 'node:fs';
const captured=JSON.parse(readFileSync(new URL('./fixtures/instantly-get-campaign-schema-captured.json',import.meta.url)));
function fixture(mode='ok',testId,changeInventory,permitDiscovery,options={}){
 const requests=[],audit=[],child=new EventEmitter();child.pid=123;child.stdout=new EventEmitter();child.stderr=new EventEmitter();child.stdin=new EventEmitter();
 const deliver=m=>queueMicrotask(()=>child.stdout.emit('data',Buffer.from(JSON.stringify(m)+'\n')));
 child.stdin.write=(line,callback)=>{const m=JSON.parse(line);if(m.id===undefined)return;requests.push(m);queueMicrotask(()=>callback?.());
  if(mode==='hang-initialize'&&m.method==='initialize'||mode==='hang-thread'&&m.method==='thread/start')return;
  if(mode==='approval'&&m.method==='thread/start'){deliver({id:'server-request',method:'permissions/requestApproval',params:{}});return;}
  let result={};if(m.method==='thread/start')result={thread:{id:'fixture-thread'}};
  if(m.method==='mcpServerStatus/list'){const c=CALLS.find(c=>c.server===m.params.serverName);result={data:[{name:c.server,authStatus:mode==='auth'?'notLoggedIn':'oAuth',runtimeStatus:'connected',tools:{selected:{name:c.tool,inputSchema:{type:'object',properties:Object.fromEntries(Object.entries(c.arguments).map(([k,v])=>[k,{type:typeof v}])),required:Object.keys(c.arguments)}}}}],nextCursor:null};if(c.provider==='instantly'&&['captured','bad-format'].includes(mode)){result.data[0].tools.selected=structuredClone(captured);if(mode==='bad-format')result.data[0].tools.selected.inputSchema.properties.id.format='unsupported';}}
  if(m.method==='mcpServer/tool/call')result=mode==='error'?{isError:true}:{content:[],isError:false,structuredContent:m.params.server==='apify'?{runId:CALLS[0].arguments.runId,status:'SUCCEEDED'}:{id:CALLS[1].arguments.id,status:mode==='bad-status'?[0]:0}};
  if(m.method==='mcpServerStatus/list'&&changeInventory)result=changeInventory(result);
  if(!m.error)deliver({id:m.id,result});
 };
 const client=diagnosticClient({executable:'offline',cwd:'offline',env:{},testId,permitDiscovery,deadlineAt:new Date(Date.now()+(testId==='M1G-functional-read-v5'?40000:10000)).toISOString(),audit:r=>audit.push(r),startProcess:()=>child,...options});return {client,requests,audit};
}
test('deterministic diagnostic submits only exact two calls and no model turn',async()=>{const f=fixture();const schemas=await f.client.initialize();assert.equal(schemas.length,2);for(const c of CALLS)await f.client.read(c.provider,x=>structuredClone(x));const reads=f.requests.filter(r=>r.method==='mcpServer/tool/call');assert.deepEqual(reads.map(r=>({server:r.params.server,tool:r.params.tool,arguments:r.params.arguments})),CALLS.map(({provider,...c})=>c));assert.ok(!f.requests.some(r=>r.method==='turn/start'));await assert.rejects(f.client.read('apify',x=>x));assert.equal(f.requests.filter(r=>r.method==='mcpServer/tool/call').length,2);});
test('auth or additional-action request stops before business reads',async()=>{for(const mode of ['auth','approval']){const f=fixture(mode);await assert.rejects(f.client.initialize());assert.equal(f.requests.filter(r=>r.method==='mcpServer/tool/call').length,0);}});
test('changed permit is blocked before protocol submission and provider error is not success',async()=>{const f=fixture();await f.client.initialize();await assert.rejects(f.client.read('apify',c=>({...c,arguments:{runId:'wrong',waitSecs:0}})));assert.equal(f.requests.filter(r=>r.method==='mcpServer/tool/call').length,0);const bad=fixture('error');await bad.client.initialize();await assert.rejects(bad.client.read('apify',c=>c));});
test('captured runtime contract works offline and rejected schema is preserved before any call',async()=>{const good=fixture('captured');await good.client.initialize();await good.client.read('instantly',c=>c);const bad=fixture('bad-format');await assert.rejects(bad.client.initialize(),/INSTANTLY_UNSUPPORTED_SCHEMA_FORMAT/);const observed=bad.audit.find(e=>e.event==='RUNTIME_SCHEMA_OBSERVED'&&e.provider==='instantly');assert.equal(observed.inputSchema.properties.id.format,'unsupported');assert.equal(bad.requests.filter(r=>r.method==='mcpServer/tool/call').length,0);});
test('fresh Instantly profile neither discovers nor dispatches Apify and captures schema first',async()=>{const f=fixture('captured','M1G-instantly-read-v2');assert.equal((await f.client.initialize()).length,1);await assert.rejects(f.client.read('apify',c=>c));await f.client.read('instantly',c=>c);await assert.rejects(f.client.read('instantly',c=>c));assert.deepEqual(f.requests.filter(r=>r.method==='mcpServerStatus/list').map(r=>r.params.serverName),['codex_apps']);const reads=f.requests.filter(r=>r.method==='mcpServer/tool/call');assert.equal(reads.length,1);assert.equal(reads[0].params.tool,'instantly_ai.get_campaign');assert.equal(reads[0].params.arguments.id,CALLS[1].arguments.id);assert.ok(f.audit.findIndex(e=>e.event==='RUNTIME_SCHEMA_OBSERVED')<f.audit.findIndex(e=>e.event==='RPC_REQUEST'&&e.method==='mcpServer/tool/call'));});

const scope='M1G-instantly-read-v2';
test('functional profile retains one live thread from readiness through validated exact read',async()=>{
 const f=fixture('captured','M1G-functional-read-v5',undefined,c=>c);
 assert.equal((await f.client.initialize()).length,1);
 await assert.rejects(f.client.read('apify',c=>c),/CALL_NOT_ALLOWED/);
 await f.client.read('instantly',c=>c);await assert.rejects(f.client.read('instantly',c=>c),/CALL_NOT_ALLOWED/);
 await assert.rejects(f.client.initialize(),/INITIALIZATION_ALREADY_ATTEMPTED/);
 assert.equal(f.requests.filter(r=>r.method==='thread/start').length,1);
 const status=f.requests.filter(r=>r.method==='mcpServerStatus/list'),reads=f.requests.filter(r=>r.method==='mcpServer/tool/call');
 assert.equal(status.length,1);assert.equal(reads.length,1);assert.equal(reads[0].params.threadId,status[0].params.threadId);
 assert.deepEqual(reads[0].params.arguments,CALLS[1].arguments);
 assert.deepEqual(f.audit.find(e=>e.event==='TOOL_RESULT_VALIDATION').observedCampaign,{id:CALLS[1].arguments.id,status:0});
});
test('functional profile keeps schema and discovery permission failures before dispatch',async()=>{
 for(const [mode,permit]of [['bad-format',c=>c],['captured',undefined]]){
  const f=fixture(mode,'M1G-functional-read-v5',undefined,permit);await assert.rejects(f.client.initialize());assert.equal(f.requests.filter(r=>r.method==='mcpServer/tool/call').length,0);
 }
});
const serverPatch=patch=>r=>{Object.assign(r.data[0],patch);return r;};
const cases=[
 ['missing server',r=>({...r,data:[]}),'DISCOVERY_SERVER_MISSING'],
 ['duplicate server',r=>({...r,data:[r.data[0],r.data[0]]}),'DISCOVERY_SERVER_DUPLICATE'],
 ['pagination',r=>({...r,nextCursor:'opaque-fixture-cursor'}),'DISCOVERY_PAGINATION_INCOMPLETE'],
 ['tool discovery error',serverPatch({toolsError:'fixture error'}),'DISCOVERY_TOOLS_ERROR'],
 ['explicit notLoggedIn',serverPatch({authStatus:'notLoggedIn'}),'DISCOVERY_AUTH_NOT_LOGGED_IN'],
 ['starting',serverPatch({runtimeStatus:'starting'}),'DISCOVERY_RUNTIME_STARTING'],
 ...['notStarted','authenticationRequired','failed','cancelled','disabled'].map(s=>[s,serverPatch({runtimeStatus:s}),'DISCOVERY_RUNTIME_NOT_CONNECTED']),
 ['unknown runtime',serverPatch({runtimeStatus:'future-fixture-state'}),'DISCOVERY_RUNTIME_NOT_CONNECTED'],
 ['missing response',()=>undefined,'DISCOVERY_RESPONSE_MISSING'],
 ['wrong response type',()=>[],'DISCOVERY_RESPONSE_INVALID'],
 ['missing data',()=>({}),'DISCOVERY_DATA_MISSING'],
 ['wrong data type',()=>({data:'fixture'}),'DISCOVERY_DATA_INVALID'],
 ['bad server entry',()=>({data:[null]}),'DISCOVERY_SERVER_ENTRY_INVALID'],
 ['missing tool',serverPatch({tools:{}}),'EXACT_TOOL_UNAVAILABLE'],
 ['bad tool entry',serverPatch({tools:{selected:null}}),'DISCOVERY_TOOL_ENTRY_INVALID'],
];
for(const [label,change,reason]of cases)test(`discovery logs precise stop: ${label}`,async()=>{
 const f=fixture('captured',scope,change);await assert.rejects(f.client.initialize(),{message:`INSTANTLY_${reason}`});
 const e=f.audit.find(e=>e.event==='DISCOVERY_STATUS_OBSERVED');assert.ok(e);assert.equal(e.stopReason,reason);
 assert.equal(f.requests.filter(r=>r.method==='mcpServerStatus/list').length,1);
 assert.equal(f.requests.filter(r=>r.method==='mcpServer/tool/call').length,0);
 assert.ok(!f.audit.some(e=>e.event==='RUNTIME_SCHEMA_OBSERVED'));
});
test('connected discovery evidence precedes schema validation and retains only selected metadata',async()=>{
 const f=fixture('captured',scope);await f.client.initialize();const e=f.audit.find(e=>e.event==='DISCOVERY_STATUS_OBSERVED');
 assert.equal(e.stopReason,null);assert.equal(e.matchingServerCount,1);assert.equal(e.matchingToolCount,1);
 assert.deepEqual(e.runtimeStatus,{type:'string',value:'connected'});assert.equal(e.authStatus.value,'oAuth');
 assert.ok(f.audit.indexOf(e)<f.audit.findIndex(e=>e.event==='RUNTIME_SCHEMA_OBSERVED'));
});
test('discovery redacts secrets, arbitrary statuses, cursor, error text, extra field names and unrelated data',async()=>{
 const poison='fixture-private-marker';
 const f=fixture('captured',scope,r=>{r[poison]={authorization:'Bearer fixture-secret'};r.nextCursor=`https://fixture.invalid/?token=${poison}`;r.data.push({name:poison,tools:{},business:poison});Object.assign(r.data[0],{authStatus:poison,runtimeStatus:poison,toolsError:`Authorization: Bearer ${poison}`,resources:[{name:poison}],authorization:poison,[poison]:poison});return r;});
 await assert.rejects(f.client.initialize(),/DISCOVERY_PAGINATION_INCOMPLETE/);const e=f.audit.find(e=>e.event==='DISCOVERY_STATUS_OBSERVED');
 assert.equal(e.authStatus.value,'UNRECOGNIZED');assert.equal(e.runtimeStatus.value,'UNRECOGNIZED');assert.equal(e.toolsError.present,true);
 assert.equal(e.paginationIncomplete,true);assert.equal(e.unexpectedResponseFieldCount,1);assert.equal(e.unexpectedServerFieldCount,2);
 assert.ok(!JSON.stringify(f.audit).includes(poison));assert.ok(!JSON.stringify(f.audit).includes('fixture-secret'));
});
test('missing and unexpected optional status fields are evidenced without changing existing admission',async()=>{
 for(const patch of [{runtimeStatus:undefined,authStatus:undefined},{runtimeStatus:null,authStatus:'unknown'},{runtimeStatus:false,authStatus:5}]){
  const f=fixture('captured',scope,serverPatch(patch));await f.client.initialize();const e=f.audit.find(e=>e.event==='DISCOVERY_STATUS_OBSERVED');
  assert.equal(e.stopReason,null);assert.equal(e.runtimeStatus.type,patch.runtimeStatus===undefined?'missing':patch.runtimeStatus===null?'null':'boolean');
  assert.equal(e.fields.nextCursor,'null');assert.equal(e.fields.toolsError,'missing');
 }
});
test('multiple discovery failures preserve original guard precedence and retain other conditions',async()=>{
 const f=fixture('captured',scope,serverPatch({toolsError:'fixture',authStatus:'notLoggedIn',runtimeStatus:'starting'}));
 await assert.rejects(f.client.initialize(),/DISCOVERY_TOOLS_ERROR/);const e=f.audit.find(e=>e.event==='DISCOVERY_STATUS_OBSERVED');assert.equal(e.authStatus.value,'notLoggedIn');assert.equal(e.runtimeStatus.value,'starting');
});
test('malformed unrelated entries are observed without changing prior selection behavior',async()=>{
 const f=fixture('captured',scope,r=>{r.data.push('fixture-unrelated',{},false);return r;});await f.client.initialize();
 const e=f.audit.find(e=>e.event==='DISCOVERY_STATUS_OBSERVED');assert.equal(e.invalidServerEntryCount,2);assert.equal(e.invalidServerNameCount,3);assert.equal(e.stopReason,null);
});
test('tool-discovery error text and malformed field values cannot leak through the stop log',async()=>{
 const marker='private-fixture';
 for(const patch of [{toolsError:`https://fixture.invalid/?token=${marker}`},{toolsError:{authorization:`Bearer ${marker}`}},{runtimeStatus:{token:marker}}]){
  const f=fixture('captured',scope,serverPatch(patch));await assert.rejects(f.client.initialize());
  assert.ok(!JSON.stringify(f.audit).includes(marker));assert.ok(f.audit.some(e=>e.event==='DISCOVERY_STATUS_OBSERVED'));
 }
});
test('discovery-only profile submits once, never validates schemas or executes tools, and cannot restart',async()=>{
 let claimed=0;const f=fixture('captured','M1G-discovery-only-v3',undefined,c=>{claimed++;return c;});
 const result=await f.client.initialize();assert.equal(result.stopReason,null);assert.equal(claimed,1);
 await assert.rejects(f.client.read('instantly',c=>c),/CALL_NOT_ALLOWED/);
 await assert.rejects(f.client.read('apify',c=>c),/CALL_NOT_ALLOWED/);
 await assert.rejects(f.client.initialize(),/INITIALIZATION_ALREADY_ATTEMPTED/);
 assert.deepEqual(f.requests.map(r=>r.method),['initialize','thread/start','mcpServerStatus/list']);
 const request=f.requests[2];assert.deepEqual(request.params,{threadId:'fixture-thread',serverName:'codex_apps',detail:'toolsAndAuthOnly'});
 assert.ok(!f.audit.some(e=>e.event.startsWith('RUNTIME_SCHEMA')));
});
test('discovery-only starting state stops after one observation without polling',async()=>{
 const f=fixture('captured','M1G-discovery-only-v3',serverPatch({runtimeStatus:'starting'}),c=>c);
 await assert.rejects(f.client.initialize(),/INSTANTLY_DISCOVERY_RUNTIME_STARTING/);
 await assert.rejects(f.client.initialize(),/INITIALIZATION_ALREADY_ATTEMPTED/);
 assert.equal(f.requests.filter(r=>r.method==='mcpServerStatus/list').length,1);
 assert.equal(f.audit.find(e=>e.event==='DISCOVERY_STATUS_OBSERVED').runtimeStatus.value,'starting');
 assert.equal(f.requests.filter(r=>r.method==='mcpServer/tool/call').length,0);
});
test('discovery-only missing or changed permit blocks discovery submission',async()=>{
 for(const permit of [undefined,()=>({server:'other'}),()=>{throw Error('DENIED');}]){
  const f=fixture('captured','M1G-discovery-only-v3',undefined,permit);await assert.rejects(f.client.initialize());
  assert.equal(f.requests.filter(r=>r.method==='mcpServerStatus/list').length,0);
 }
});
test('readiness-enabled initialization polls only the exact server then preserves schema and resource validation',async()=>{
 let calls=0;const f=fixture('captured',scope,r=>{r.data[0].runtimeStatus=++calls===1?'starting':'connected';return r;},undefined,{waitForReadiness:true});
 await f.client.initialize();const requests=f.requests.filter(r=>r.method==='mcpServerStatus/list');assert.equal(requests.length,2);
 assert.ok(requests.every(r=>r.params.serverName==='codex_apps'&&r.params.threadId==='fixture-thread'&&r.params.detail==='toolsAndAuthOnly'));
 assert.equal(f.audit.filter(e=>e.event==='RUNTIME_SCHEMA_CONFIRMED').length,1);
 await assert.rejects(f.client.read('instantly',c=>({...c,arguments:{id:'wrong'}})),/PERMIT_MISMATCH/);
 assert.equal(f.requests.filter(r=>r.method==='mcpServer/tool/call').length,0);
 await assert.rejects(f.client.initialize(),/INITIALIZATION_ALREADY_ATTEMPTED/);
});
test('readiness does not bypass schema errors or broaden the completed one-request scope',async()=>{
 const f=fixture('bad-format',scope,undefined,undefined,{waitForReadiness:true});await assert.rejects(f.client.initialize(),/SCHEMA_FORMAT/);
 assert.equal(f.requests.filter(r=>r.method==='mcpServer/tool/call').length,0);
 assert.throws(()=>fixture('captured','M1G-discovery-only-v3',undefined,c=>c,{waitForReadiness:true}),/READINESS_NOT_AUTHORIZED_FOR_PROFILE/);
});
test('fresh readiness-only profile discovers twice then stops without schema or tool execution',async()=>{
 let calls=0,claims=0;const f=fixture('captured','M1G-readiness-only-v4',r=>{r.data[0].runtimeStatus=++calls===1?'starting':'connected';return r;},c=>{claims++;return c;});
 const evidence=await f.client.initialize();assert.equal(evidence.runtimeStatus.value,'connected');assert.equal(claims,2);
 assert.equal(f.requests.filter(r=>r.method==='mcpServerStatus/list').length,2);assert.ok(f.requests.every(r=>r.method!=='mcpServerStatus/list'||r.params.serverName==='codex_apps'));
 assert.ok(!f.audit.some(e=>e.event.startsWith('RUNTIME_SCHEMA')));await assert.rejects(f.client.read('instantly',c=>c));await assert.rejects(f.client.initialize());
 assert.equal(f.requests.filter(r=>r.method==='mcpServer/tool/call').length,0);
});
test('dispatched Instantly tool retains output-schema presence and per-layer result evidence',async()=>{
 const f=fixture('captured',scope);await f.client.initialize();await f.client.read('instantly',c=>c);
 assert.equal(f.audit.find(e=>e.event==='TOOL_OUTPUT_CONTRACT_OBSERVED').outputSchemaPresent,false);
 assert.equal(f.audit.find(e=>e.event==='TOOL_RESULT_VALIDATION').validation.application,'PASSED');
 assert.ok(f.audit.some(e=>e.event==='RPC_RESPONSE'&&e.method==='mcpServer/tool/call'&&e.matchingRequest));
 const bad=fixture('bad-status',scope);await bad.client.initialize();await assert.rejects(bad.client.read('instantly',c=>c),/CAMPAIGN_STATUS_WRONG_TYPE/);
 assert.equal(bad.audit.find(e=>e.event==='TOOL_RESULT_VALIDATION').validation.application,'FAILED');
});
test('advertised unsupported output schema prevents tool dispatch',async()=>{
 const f=fixture('captured',scope,r=>{r.data[0].tools.selected.outputSchema={type:'object',$ref:'unsupported'};return r;});await assert.rejects(f.client.initialize(),/OUTPUT_SCHEMA_UNSUPPORTED/);
 assert.equal(f.requests.filter(r=>r.method==='mcpServer/tool/call').length,0);
});
test('prepared functional boundaries keep status and tool limits independent',async()=>{
 const {functionalReadPlan}=await import('../src/functional-read-plan.mjs');const start=Date.now(),plan=functionalReadPlan(start);
 assert.equal(Date.parse(plan.readinessDeadlineAt)-start,20000);assert.equal(Date.parse(plan.deadlineAt)-start,40000);assert.equal(Date.parse(plan.hardDeadlineAt)-start,60000);assert.equal(plan.statusRequestLimit,10);assert.equal(plan.toolRequestLimit,1);assert.equal(plan.executionAuthorized,false);
 const bounded=fixture('ok',undefined,undefined,undefined,{statusRequestLimit:1});await assert.rejects(bounded.client.initialize(),/STATUS_REQUEST_CAP/);assert.equal(bounded.requests.filter(r=>r.method==='mcpServerStatus/list').length,1);assert.equal(bounded.requests.filter(r=>r.method==='mcpServer/tool/call').length,0);
 const expired=fixture('ok',scope,undefined,undefined,{readinessDeadlineAt:new Date(0).toISOString()});await assert.rejects(expired.client.initialize(),/READINESS_DEADLINE/);assert.equal(expired.requests.filter(r=>r.method==='mcpServerStatus/list').length,0);
 assert.throws(()=>fixture('ok',scope,undefined,undefined,{statusRequestLimit:21}),/INVALID_DISCOVERY_BOUNDS/);
});
for(const mode of ['hang-initialize','hang-thread'])test(`readiness deadline includes ${mode}`,async()=>{
 const f=fixture(mode,scope,undefined,undefined,{waitForReadiness:true,readinessDeadlineAt:new Date(Date.now()+80).toISOString()});let fallback;
 try{await assert.rejects(Promise.race([f.client.initialize(),new Promise((_,reject)=>fallback=setTimeout(()=>reject(Error('TEST_DEADLINE_EXCEEDED')),300))]),/READINESS_DEADLINE/);}finally{clearTimeout(fallback);}
 assert.equal(f.requests.filter(r=>r.method==='mcpServerStatus/list').length,0);
 assert.equal(f.requests.filter(r=>r.method==='mcpServer/tool/call').length,0);
});
test('cancellation ends a stalled initialization RPC without discovery',async()=>{
 const controller=new AbortController(),f=fixture('hang-initialize',scope,undefined,undefined,{waitForReadiness:true,signal:controller.signal});
 const result=f.client.initialize();controller.abort();await assert.rejects(result,/DIAGNOSTIC_CANCELLED/);
 assert.equal(f.requests.filter(r=>r.method==='mcpServerStatus/list').length,0);
});
