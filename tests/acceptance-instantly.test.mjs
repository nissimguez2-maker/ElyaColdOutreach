import test from 'node:test';import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';import {readFileSync,mkdtempSync,writeFileSync,existsSync} from 'node:fs';import {tmpdir} from 'node:os';import {join} from 'node:path';
import {openStore,controls,getRecord,putRecord} from '../src/store.mjs';
const api=await import('../src/acceptance-instantly.mjs').catch(()=>null);
const manifest=JSON.parse(readFileSync('work/acceptance-manifest-v1/manifest.json','utf8'));
const saved=JSON.parse(readFileSync('work/synthetic-qa-created-record.json','utf8'));
const historicalSchemas=JSON.parse(readFileSync('work/instantly-capability-inspection.json','utf8'));
const campaign=structuredClone(saved.latestReadOnlyConfirmation.liveReadback.campaign.structuredContent),lead=structuredClone(saved.readbacks.lead.value.structuredContent);
const declarations=historicalSchemas.schemas;
const runtimeTools=()=>manifest.instantly.tools.map(name=>({name,description:name.endsWith('update_lead')?'Update lead; custom variables merge into the lead.':'Read exact record',inputSchema:{type:'object',properties:{id:{type:'string',format:'uuid'},...(name.endsWith('update_lead')?{custom_variables:{type:'object',description:'Custom variables to merge into the lead. Keys new to the campaign are registered on it automatically.',additionalProperties:{type:['string','number','boolean','null']}}}:{})},required:['id'],additionalProperties:false},outputSchema:{type:'object',additionalProperties:true}}));
function fakeRuntime({tools=runtimeTools(),mutate,failWrite=false,starting=false,minimalWrite=false,onBusinessCall,unrelatedTool}={}){
 const calls=[],methods=[];let current=structuredClone(lead),reads=0;
 return {calls,methods,spawn:()=>{
  const child=new EventEmitter();child.pid=123;child.stdout=new EventEmitter();child.stderr=new EventEmitter();child.stdin=new EventEmitter();
  child.stdin.write=(line,done)=>{const m=JSON.parse(line);methods.push(m.method);done?.();if(m.id===undefined)return;
   let result;
   if(m.method==='initialize')result={};
   else if(m.method==='thread/start')result={thread:{id:'fixture-thread'}};
   else if(m.method==='mcpServerStatus/list')result={data:[{name:'codex_apps',authStatus:'bearerToken',runtimeStatus:starting?'starting':'connected',tools:Object.fromEntries([...tools,...(unrelatedTool?[unrelatedTool]:[])].map(t=>[t.name,t]))}],nextCursor:null};
   else if(m.method==='mcpServer/tool/call'){
    onBusinessCall?.();
    calls.push(structuredClone(m.params));let value;
    if(m.params.tool==='instantly_ai.get_campaign')value=structuredClone(campaign);
    if(m.params.tool==='instantly_ai.get_lead'){reads++;value=structuredClone(current);}
    if(m.params.tool==='instantly_ai.update_lead'){
     current={...current,payload:{...current.payload,...m.params.arguments.custom_variables},timestamp_updated:'2026-11-16T23:00:01Z'};
     if(failWrite){queueMicrotask(()=>child.stdout.emit('data',Buffer.from(JSON.stringify({id:m.id,error:{code:-1,message:'provider failed'}})+'\n')));return;}
     value=minimalWrite?{}:structuredClone(current);
    }
    mutate?.({value,call:m.params,calls,reads});result={content:[],structuredContent:value,isError:false};
   }else throw Error('UNEXPECTED_METHOD');
   queueMicrotask(()=>child.stdout.emit('data',Buffer.from(JSON.stringify({id:m.id,result})+'\n')));
  };return child;
 }};
}
function fixture(t,options={}){
 const db=openStore(':memory:');t.after(()=>db.close());const directory=mkdtempSync(join(tmpdir(),'elya-acceptance-instantly-')),runtimes=[];let time=Date.now();
 const launch=async args=>{
  const runtime=fakeRuntime(options);runtimes.push(runtime);
  const workerArgs={...args,db,manifest,assertAuthority:()=>true,savedDeclarations:declarations,clock:()=>time,wallClock:()=>time,sleep:async ms=>{time+=ms;},startProcess:runtime.spawn};
  options.prepareDirectory?.(args.directory);
  const first=api.runInstantlyPhaseWorker(workerArgs);
  let duplicate,activeState;if(options.duplicateWorker){duplicate=await api.runInstantlyPhaseWorker(workerArgs);activeState=getRecord(db,'acceptance_instantly_phase',manifest.id+':instantly:'+args.phase).status;}
  const worker=await first;
  if(options.duplicateWorker){assert.equal(duplicate.workerOwnsSlot,false);assert.equal(activeState,'RUNNING');}
  return {worker,owner:{cleanupConfirmed:!options.badCleanup,noPostCleanupRpcWrites:true,remainingMembers:[],processChecks:[{pid:123,wait:0,exitCode:31027}],error:null,timedOut:false,cleanupCompletedAt:new Date(time).toISOString()},exit:{code:0},fixture:true};
 };
 return {db,directory,runtimes,args:{db,manifest,directory,assertAuthority:()=>true,fixtureLaunch:launch,emit:()=>{}}};
}
test('approved Instantly acceptance runner exists',()=>assert.ok(api));
if(api){
test('two contained phases execute the exact seven calls and preserve stopped business state',async t=>{
 const f=fixture(t),before=controls(f.db);
 const p1=await api.runAcceptanceInstantly({...f.args,phase:1});assert.equal(p1.status,'PASSED');
 const p2=await api.runAcceptanceInstantly({...f.args,phase:2});assert.equal(p2.status,'PASSED');
 const calls=f.runtimes.flatMap(r=>r.calls);assert.deepEqual(calls.map(c=>c.tool),['instantly_ai.get_campaign','instantly_ai.get_lead','instantly_ai.get_campaign','instantly_ai.get_lead','instantly_ai.update_lead','instantly_ai.get_lead','instantly_ai.get_campaign']);
 assert.deepEqual(calls[4].arguments,manifest.instantly.writeArguments);assert.ok(calls.every(c=>c.threadId==='fixture-thread'&&c.server==='codex_apps'));assert.deepEqual(controls(f.db),before);
 assert.equal(f.db.prepare('SELECT count(*) n FROM operations').get().n,0);assert.equal(f.db.prepare("SELECT count(*) n FROM records WHERE kind='acceptance_instantly_call'").get().n,7);
 await assert.rejects(()=>api.runAcceptanceInstantly({...f.args,phase:2}),/CONSUMED|REPLAY/);assert.equal(f.runtimes.length,2);
});
test('phase two is blocked before launch without a successful cleaned-up first phase',async t=>{
 const f=fixture(t);await assert.rejects(()=>api.runAcceptanceInstantly({...f.args,phase:2}),/PHASE_ONE/);assert.equal(f.runtimes.length,0);
});
test('inactive status, sending days, assigned mailboxes and missing registered variables block phase one',async t=>{
 for(const change of [v=>v.status=1,v=>v.campaign_schedule.schedules[0].days['1']=true,v=>v.email_list=['sender@example.invalid'],v=>delete v.custom_variables.pilot_body_3]){
  const f=fixture(t,{mutate:({value,call})=>{if(call.tool.endsWith('get_campaign'))change(value);}});assert.equal((await api.runAcceptanceInstantly({...f.args,phase:1})).status,'FAILED');assert.equal(f.runtimes[0].calls.length,1);
 }
});
test('changed prewrite lead state and unsupported merge semantics cause no write',async t=>{
 for(const type of ['lead','merge']){
  const f=fixture(t);assert.equal((await api.runAcceptanceInstantly({...f.args,phase:1})).status,'PASSED');
  const launch=f.args.fixtureLaunch;f.args.fixtureLaunch=async args=>{
   if(type==='lead'){const baseline=getRecord(f.db,'acceptance_instantly_phase',manifest.id+':instantly:1');baseline.snapshots.lead.hash='changed';putRecord(f.db,'acceptance_instantly_phase',manifest.id+':instantly:1',baseline);}
   if(type==='merge'){
    const tools=runtimeTools();tools[2].description='Updates lead';tools[2].inputSchema.properties.custom_variables.description='Replace all custom variables.';
    const runtime=fakeRuntime({tools});f.runtimes.push(runtime);
    return {worker:await api.runInstantlyPhaseWorker({...args,db:f.db,manifest,assertAuthority:()=>true,savedDeclarations:declarations,startProcess:runtime.spawn}),owner:{cleanupConfirmed:true,noPostCleanupRpcWrites:true,remainingMembers:[],processChecks:[{wait:0}],error:null,timedOut:false,cleanupCompletedAt:new Date().toISOString()},exit:{code:0},fixture:true};
   }
   return launch(args);
  };
  assert.equal((await api.runAcceptanceInstantly({...f.args,phase:2})).status,'FAILED');assert.ok(f.runtimes.flatMap(r=>r.calls).every(c=>!c.tool.endsWith('update_lead')));
 }
});
test('uncertain update stops immediately with no readback or replay',async t=>{
 const f=fixture(t,{failWrite:true});await api.runAcceptanceInstantly({...f.args,phase:1});
 const result=await api.runAcceptanceInstantly({...f.args,phase:2});assert.equal(result.status,'UNCERTAIN');assert.equal(f.runtimes[1].calls.length,3);
 const write=f.db.prepare("SELECT data_json FROM records WHERE kind='acceptance_instantly_call' AND id LIKE '%:4'").get();assert.equal(JSON.parse(write.data_json).state,'UNCERTAIN');
 await assert.rejects(()=>api.runAcceptanceInstantly({...f.args,phase:2}),/CONSUMED|REPLAY/);
});
test('postwrite loss of unrelated payload values stops before final campaign read',async t=>{
 const f=fixture(t,{mutate:({value,call,calls})=>{if(call.tool.endsWith('get_lead')&&calls.some(c=>c.tool.endsWith('update_lead')))delete value.payload.companyName;}});
 await api.runAcceptanceInstantly({...f.args,phase:1});const result=await api.runAcceptanceInstantly({...f.args,phase:2});assert.equal(result.status,'UNCERTAIN');assert.equal(f.runtimes[1].calls.length,4);
});
test('a declared generic update acknowledgment is followed by exact authoritative lead readback',async t=>{
 const f=fixture(t,{minimalWrite:true});await api.runAcceptanceInstantly({...f.args,phase:1});const result=await api.runAcceptanceInstantly({...f.args,phase:2});assert.equal(result.status,'PASSED');assert.equal(f.runtimes[1].calls.length,5);
 const write=getRecord(f.db,'acceptance_instantly_call',manifest.id+':instantly:call:4');assert.equal(write.validation.application,'READBACK_REQUIRED');
});
test('parent marks an unmatched write intent uncertain when the worker never supplies its result',async t=>{
 const f=fixture(t);await api.runAcceptanceInstantly({...f.args,phase:1});
 f.args.fixtureLaunch=async()=>{putRecord(f.db,'acceptance_instantly_call',manifest.id+':instantly:call:4',{manifestId:manifest.id,phase:2,index:4,tool:'instantly_ai.update_lead',state:'INTENT'});return {worker:null,owner:null,exit:{code:1}};};
 const result=await api.runAcceptanceInstantly({...f.args,phase:2});assert.equal(result.status,'UNCERTAIN');assert.equal(getRecord(f.db,'acceptance_instantly_call',manifest.id+':instantly:call:4').state,'UNCERTAIN');
});
test('unconfirmed cleanup fails phase one even when the two reads validated',async t=>{
 const f=fixture(t,{badCleanup:true});assert.equal((await api.runAcceptanceInstantly({...f.args,phase:1})).status,'FAILED');await assert.rejects(()=>api.runAcceptanceInstantly({...f.args,phase:2}),/PHASE_ONE/);
});
test('readiness polling stays within ten requests, twenty seconds and never dispatches while starting',async t=>{
 const f=fixture(t,{starting:true});const r=await api.runAcceptanceInstantly({...f.args,phase:1});assert.equal(r.status,'FAILED');assert.equal(f.runtimes[0].methods.filter(m=>m==='mcpServerStatus/list').length,10);assert.equal(f.runtimes[0].calls.length,0);
});
test('a duplicate worker is rejected without replacing the active worker state or dispatching',async t=>{
 const f=fixture(t,{duplicateWorker:true});const result=await api.runAcceptanceInstantly({...f.args,phase:1});assert.equal(result.status,'PASSED');assert.equal(f.runtimes[0].methods.filter(m=>m==='initialize').length,1);assert.equal(f.runtimes[0].calls.length,2);
});

// Constructed negative contracts, not the missing historical RPC payload.
for(const c of [
 {side:'input',category:'UNSUPPORTED',path:'/inputSchema/properties/id/$ref',keyword:'$ref',mutate:t=>t.inputSchema.properties.id.$ref='#/$defs/id'},
 {side:'input',category:'MALFORMED',path:'/inputSchema/properties',keyword:'properties',mutate:t=>t.inputSchema.properties=[]},
 {side:'input',category:'ABSENT',path:'/inputSchema',keyword:'inputSchema',mutate:t=>delete t.inputSchema},
 {side:'output',category:'UNSUPPORTED',path:'/outputSchema/properties/a~1b~0c/oneOf',keyword:'oneOf',mutate:t=>t.outputSchema.properties={'a/b~c':{oneOf:[{type:'string'}]}}},
 {side:'output',category:'MALFORMED',path:'/outputSchema',keyword:'outputSchema',mutate:t=>t.outputSchema=null},
 {side:'input',category:'UNSUPPORTED',path:'/inputSchema/properties/id/anyOf/0/minLength',keyword:'minLength',mutate:t=>t.inputSchema.properties.id={anyOf:[{type:'string',minLength:1},{type:'null'}]}},
 {side:'input',category:'MALFORMED',path:'/inputSchema/properties/id/anyOf/0/type',keyword:'type',mutate:t=>t.inputSchema.properties.id={anyOf:[{type:'invalid-type'},{type:'null'}]}},
 {side:'input',category:'UNSUPPORTED',path:'/inputSchema/anyOf',keyword:'anyOf',mutate:t=>t.inputSchema={anyOf:[{type:'object'}]}},
])test(`schema diagnostic captures before ${c.side} ${c.category} failure at ${c.path}`,async t=>{
 const tools=runtimeTools();c.mutate(tools[0]);const f=fixture(t,{tools});
 const r=await api.runAcceptanceInstantly({...f.args,phase:1});
 assert.equal(f.runtimes[0].calls.length,0);assert.equal(r.status,'FAILED');
 assert.equal(r.reason,`INSTANTLY_${c.side.toUpperCase()}_SCHEMA_${c.category}`);
 const d=r.schemaFailure;assert.equal(d.tool,'instantly_ai.get_campaign');assert.equal(d.side,c.side);assert.equal(d.path,c.path);assert.equal(d.keyword,c.keyword);assert.equal(d.category,c.category);assert.equal(d.businessToolExecutionBegun,false);assert.ok(d.rule&&d.reason&&d.observedType);
 const dir=join(f.directory,'instantly-phase-1'),capture=JSON.parse(readFileSync(join(dir,'selected-contracts.json'),'utf8'));
 assert.equal(capture.stage,'BEFORE_SCHEMA_VALIDATION');assert.equal(capture.tools.length,3);assert.equal(capture.businessToolExecutionBegun,false);
 for(const key of ['inputSchema','outputSchema'])assert.deepEqual(capture.tools[0][key],tools[0][key]);
 assert.deepEqual(JSON.parse(readFileSync(join(dir,'schema-validation-error.json'),'utf8')),d);
 assert.equal(f.runtimes[0].methods.filter(m=>m==='mcpServerStatus/list').length,1);
});

test('recovered contemporaneous cache contracts pass without dropping propertyNames constraints',async t=>{
 const tools=JSON.parse(readFileSync('work/instantly-contract-diagnostics-v1/recovered-contracts.json','utf8')).tools;
 let directory;const f=fixture(t,{tools,prepareDirectory:d=>{directory=d;},onBusinessCall:()=>{
  const captured=JSON.parse(readFileSync(join(directory,'selected-contracts.json'),'utf8'));
  assert.deepEqual(captured.tools.find(t=>t.name.endsWith('update_lead')).inputSchema,tools[2].inputSchema);
 }});
 const r=await api.runAcceptanceInstantly({...f.args,phase:1});assert.equal(r.status,'PASSED');assert.equal(f.runtimes[0].calls.length,2);
});

test('optional missing outputSchema remains admissible and unrelated discovery data is not captured',async t=>{
 const tools=runtimeTools();for(const tool of tools)delete tool.outputSchema;
 const f=fixture(t,{tools,unrelatedTool:{name:'unrelated.secret_tool',authorization:'Bearer fixture-private-value'}});
 assert.equal((await api.runAcceptanceInstantly({...f.args,phase:1})).status,'PASSED');
 const text=readFileSync(join(f.directory,'instantly-phase-1','selected-contracts.json'),'utf8'),capture=JSON.parse(text);
 assert.ok(capture.tools.every(t=>t.outputSchemaPresent===false&&!Object.hasOwn(t,'outputSchema')));assert.equal(text.includes('fixture-private-value'),false);assert.equal(text.includes('unrelated.secret_tool'),false);
});

test('unsafe selected contract evidence blocks before writing secrets or dispatching',async t=>{
 const tools=runtimeTools();tools[0].inputSchema.description='Bearer fixture-private-value';const f=fixture(t,{tools});
 const r=await api.runAcceptanceInstantly({...f.args,phase:1});assert.equal(r.reason,'INSTANTLY_CONTRACT_EVIDENCE_UNSAFE');assert.equal(f.runtimes[0].calls.length,0);assert.equal(existsSync(join(f.directory,'instantly-phase-1','selected-contracts.json')),false);assert.equal(JSON.stringify(r).includes('fixture-private-value'),false);
});

test('contract evidence persistence failure blocks all business calls and preserves existing bytes',async t=>{
 const f=fixture(t,{prepareDirectory:d=>writeFileSync(join(d,'selected-contracts.json'),'preserved',{flag:'wx'})});
 const r=await api.runAcceptanceInstantly({...f.args,phase:1});assert.equal(r.reason,'INSTANTLY_CONTRACT_EVIDENCE_PERSISTENCE_FAILED');assert.equal(f.runtimes[0].calls.length,0);assert.equal(readFileSync(join(f.directory,'instantly-phase-1','selected-contracts.json'),'utf8'),'preserved');
});

test('diagnostic-file persistence failure remains blocked and retains the specific error in durable result',async t=>{
 const tools=runtimeTools();tools[0].outputSchema.properties={status:{format:'email'}};
 const f=fixture(t,{tools,prepareDirectory:d=>writeFileSync(join(d,'schema-validation-error.json'),'preserved',{flag:'wx'})});
 const r=await api.runAcceptanceInstantly({...f.args,phase:1});assert.equal(r.reason,'INSTANTLY_SCHEMA_DIAGNOSTIC_PERSISTENCE_FAILED');assert.equal(r.schemaFailure.path,'/outputSchema/properties/status/format');assert.equal(r.schemaFailure.businessToolExecutionBegun,false);assert.equal(f.runtimes[0].calls.length,0);assert.equal(readFileSync(join(f.directory,'instantly-phase-1','schema-validation-error.json'),'utf8'),'preserved');
 assert.deepEqual(getRecord(f.db,'acceptance_instantly_phase',manifest.id+':instantly:1').result.schemaFailure,r.schemaFailure);
});
}
