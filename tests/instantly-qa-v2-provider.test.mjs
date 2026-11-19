import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {readFileSync,mkdtempSync,writeFileSync,existsSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {openStore,controls,getRecord,putRecord} from '../src/store.mjs';
import {canonical,digest} from '../src/values.mjs';
import {instantlyAcceptanceCalls,runAcceptanceInstantly,runInstantlyPhaseWorker} from '../src/acceptance-instantly.mjs';
import {blockNetwork} from './helpers/network-block.mjs';

const read=path=>JSON.parse(readFileSync(path,'utf8'));
const manifest=()=>read('work/instantly-qa-acceptance-v2/manifest.json');
const original=read('work/acceptance-manifest-v1/manifest.json');
const captured=read('work/instantly-qa-acceptance-v1/live-once/instantly-phase-1/selected-contracts.json').tools;
const recovered=read('work/instantly-contract-diagnostics-v1/recovered-contracts.json').tools;
const saved=read('work/synthetic-qa-created-record.json');
const declarations=read('work/instantly-capability-inspection.json').schemas;
const campaign=saved.latestReadOnlyConfirmation.liveReadback.campaign.structuredContent,lead=saved.readbacks.lead.value.structuredContent;

function fixture(t,options={}){
 const network=blockNetwork(t),m=manifest(),db=openStore(':memory:');t.after(()=>db.close());
 const grant={id:m.id,status:'CLAIMED',deadlineAt:new Date(Date.now()+150000).toISOString()};
 const directory=mkdtempSync(join(tmpdir(),'elya-instantly-qa-v2-')),calls=[],contexts=[],methods=[];
 const historical={manifestId:'elya-instantly-qa-acceptance-v1',state:'UNCERTAIN',marker:'preserve closed v1 evidence'};
 putRecord(db,'acceptance_instantly_call',historical.manifestId+':instantly:call:4',historical);
 const launch=async args=>{
  contexts.push(args.context);let current=structuredClone(lead),time=args.context.launchStartedMs;
  const tools=structuredClone(captured);options.changeTools?.(tools,args.phase);
  options.prepareDirectory?.(args.directory,args.phase);
  const startProcess=()=>{
   const child=new EventEmitter();child.pid=321;child.stdout=new EventEmitter();child.stderr=new EventEmitter();child.stdin=new EventEmitter();
   child.stdin.write=(line,done)=>{
    const request=JSON.parse(line);methods.push({phase:args.phase,method:request.method});done?.();if(request.id===undefined)return;
    let result;
    if(request.method==='initialize')result={};
    else if(request.method==='thread/start')result={thread:{id:'qa-v2-fixture-'+args.phase}};
    else if(request.method==='mcpServerStatus/list')result={data:[{name:'codex_apps',authStatus:'bearerToken',runtimeStatus:options.starting?'starting':'connected',tools:Object.fromEntries([...tools,{name:'unrelated.fixture_tool',description:'UNRELATED_PRIVATE_SENTINEL'}].map(tool=>[tool.name,tool])),unknownMetadata:'UNRELATED_PRIVATE_SENTINEL'}],nextCursor:null};
    else if(request.method==='mcpServer/tool/call'){
     const call=request.params;calls.push({phase:args.phase,...structuredClone(call)});let value;
     if(call.tool==='instantly_ai.get_campaign')value=structuredClone(campaign);
     else if(call.tool==='instantly_ai.get_lead')value=structuredClone(current);
     else if(call.tool==='instantly_ai.update_lead'){
      if(options.uncertainWrite){queueMicrotask(()=>child.stdout.emit('data',Buffer.from(JSON.stringify({id:request.id,error:{code:-1,message:'fixture uncertain'}})+'\n')));return;}
      current={...current,payload:{...current.payload,...call.arguments.custom_variables},timestamp_updated:'2026-11-17T01:00:00Z'};value={};
     }else throw Error('UNAPPROVED_FIXTURE_TOOL');
     options.mutate?.({value,call,phase:args.phase,calls});
     if(options.providerDeadline)time=args.context.providerDeadlineMs;
     result={content:[],structuredContent:value,isError:false};
     options.mutateResponse?.(result,call);
    }else throw Error('UNAPPROVED_FIXTURE_METHOD');
    queueMicrotask(()=>child.stdout.emit('data',Buffer.from(JSON.stringify({id:request.id,result})+'\n')));
   };return child;
  };
  const workerArgs={...args,db,manifest:m,savedDeclarations:declarations,startProcess,clock:()=>time,wallClock:()=>time,sleep:async ms=>{time+=options.readinessDeadline?20000:ms;}};
  options.changeContext?.(workerArgs.context);
  const pending=runInstantlyPhaseWorker(workerArgs);
  if(options.duplicateWorker){const duplicate=await runInstantlyPhaseWorker(workerArgs);assert.equal(duplicate.status,'REJECTED');assert.equal(duplicate.workerOwnsSlot,false);}
  const worker=await pending;
  return {worker,owner:{cleanupConfirmed:!options.badCleanup,noPostCleanupRpcWrites:true,remainingMembers:[],processChecks:[{pid:321,wait:0,exitCode:31027}],error:null,timedOut:false,cleanupCompletedAt:new Date(time).toISOString()},exit:{code:0}};
 };
 return {db,m,directory,calls,contexts,methods,network,historical,args:{db,manifest:m,directory,assertAuthority:()=>grant,fixtureLaunch:launch}};
}

test('v2 keeps the approved manifest bytes and exact seven calls with the original write arguments',t=>{
 const network=blockNetwork(t),m=manifest();
 assert.equal(digest(readFileSync('work/instantly-qa-acceptance-v2/manifest.json')),'40e60fbb196417c308fef2778cf329df3fc1eac9e1026a3524e5e544bba1fee0');
 assert.equal(digest(canonical(m)),'17aba6391533f3052ebc0e996ebcf52d1829a3b802131ca0b1c4a3665d4a7767');
 const calls=[...instantlyAcceptanceCalls(m,1),...instantlyAcceptanceCalls(m,2)];
 assert.deepEqual(calls.map(c=>c.tool),['instantly_ai.get_campaign','instantly_ai.get_lead','instantly_ai.get_campaign','instantly_ai.get_lead','instantly_ai.update_lead','instantly_ai.get_lead','instantly_ai.get_campaign']);
 assert.deepEqual(calls,m.calls.map(({index,launch,...call})=>call));assert.deepEqual(calls[4].arguments,original.instantly.writeArguments);
 for(const change of [v=>v.id='arbitrary-id',v=>v.instantly.leadId='other',v=>v.instantly.writeArguments.custom_variables.pilot_body_1+=' changed',v=>v.limits.businessDataCallsAcrossBothLaunches=10,v=>delete v.contracts.approvedContracts,v=>v.contracts.approvedContracts[0].sha256='0'.repeat(64),v=>v.contracts.approvedContracts[0].contract.description='changed',v=>v.contracts.approvedContracts.reverse()]){
  const changed=structuredClone(m);change(changed);assert.throws(()=>instantlyAcceptanceCalls(changed,1));
 }
 assert.equal(network.attempts,0);
});

test('v2 fake launches pin the captured contracts and execute exactly two then five calls',async t=>{
 const f=fixture(t,{changeTools:tools=>{for(const tool of tools){tool.annotations.unknown='UNRELATED_PRIVATE_SENTINEL';tool.extra='UNRELATED_PRIVATE_SENTINEL';}}}),before=controls(f.db);
 assert.equal((await runAcceptanceInstantly({...f.args,phase:1})).status,'PASSED');
 assert.equal((await runAcceptanceInstantly({...f.args,phase:2})).status,'PASSED');
 assert.deepEqual(f.calls.map(c=>c.phase),[1,1,2,2,2,2,2]);
 assert.deepEqual(f.calls.map(({phase,threadId,...call})=>call),f.m.calls.map(({index,launch,...call})=>call));
 assert.equal(f.calls.filter(c=>c.tool==='instantly_ai.update_lead').length,1);assert.deepEqual(f.calls[4].arguments,original.instantly.writeArguments);
 for(const phase of [1,2]){
  const text=readFileSync(join(f.directory,`instantly-phase-${phase}`,'selected-contracts.json'),'utf8'),capture=JSON.parse(text);
  assert.deepEqual(capture.tools,captured);assert.deepEqual(capture.tools,f.m.contracts.approvedContracts.map(c=>c.contract));
  assert.deepEqual(capture.tools.map(c=>digest(canonical(c))),f.m.contracts.approvedContracts.map(c=>c.sha256));
  assert.equal(capture.stage,'BEFORE_SCHEMA_VALIDATION');assert.equal(capture.businessToolExecutionBegun,false);
  assert.equal(text.includes('UNRELATED_PRIVATE_SENTINEL'),false);assert.equal(text.includes('environment'),false);
  assert.ok(existsSync(join(f.directory,`instantly-phase-${phase}`,'runtime-schemas.json')));
 }
 assert.ok(f.contexts.every(c=>c.manifestId===f.m.id&&c.manifest.id===f.m.id&&c.readinessDeadlineMs-c.launchStartedMs===20000&&c.providerDeadlineMs-c.launchStartedMs===40000&&Date.parse(c.hardDeadlineAt)-c.launchStartedMs===60000));
 assert.deepEqual(controls(f.db),before);assert.equal(f.db.prepare('SELECT count(*) n FROM operations').get().n,0);
 assert.deepEqual(getRecord(f.db,'acceptance_instantly_call',f.historical.manifestId+':instantly:call:4'),f.historical);
 assert.equal(f.db.prepare("SELECT count(*) n FROM records WHERE kind='acceptance_instantly_call' AND id LIKE ?").get(f.m.id+':%').n,7);
 await assert.rejects(()=>runAcceptanceInstantly({...f.args,phase:2}),/CONSUMED|REPLAY/);assert.equal(f.calls.length,7);assert.equal(f.network.attempts,0);
});

for(const phase of [1,2])for(const [label,change] of [
 ['prior v1 description',tools=>{tools[0].description=recovered[0].description;}],
 ['input constraint',tools=>tools[1].inputSchema.properties.id.maxLength=36],
 ['missing input schema',tools=>delete tools[0].inputSchema],
 ['missing output schema',tools=>delete tools[1].outputSchema],
 ['unsupported output schema',tools=>tools[2].outputSchema.oneOf=[{type:'object'}]],
 ['merge semantics',tools=>tools[2].inputSchema.properties.custom_variables.description='Replace all variables.'],
 ['read annotation',tools=>tools[0].annotations.readOnlyHint=false],
])test(`v2 contract ${label} drift in phase ${phase} blocks all business calls in that phase`,async t=>{
 const f=fixture(t,{changeTools:(tools,currentPhase)=>{if(currentPhase===phase)change(tools);}});
 if(phase===2)assert.equal((await runAcceptanceInstantly({...f.args,phase:1})).status,'PASSED');
 const result=await runAcceptanceInstantly({...f.args,phase});
 assert.equal(result.status,'FAILED');assert.equal(result.reason,'INSTANTLY_QA_CONTRACT_DRIFT');assert.equal(f.calls.filter(c=>c.phase===phase).length,0);
 const capture=read(join(f.directory,`instantly-phase-${phase}`,'selected-contracts.json'));
 assert.equal(capture.tools.length,3);assert.equal(capture.businessToolExecutionBegun,false);assert.notDeepEqual(capture.tools,captured);
 assert.equal(existsSync(join(f.directory,`instantly-phase-${phase}`,'runtime-schemas.json')),false);
 await assert.rejects(()=>runAcceptanceInstantly({...f.args,phase}),/CONSUMED|REPLAY/);assert.equal(f.network.attempts,0);
});

for(const remaining of [70000,69999])test(`v2 requires its 70-second reserve with ${remaining} ms remaining`,async t=>{
 const time=Date.now();t.mock.method(Date,'now',()=>time);const f=fixture(t);
 const result=await runAcceptanceInstantly({...f.args,phase:1,assertAuthority:()=>({id:f.m.id,status:'CLAIMED',deadlineAt:new Date(time+remaining).toISOString()})});
 assert.equal(result.status,remaining===70000?'PASSED':'FAILED');assert.equal(f.contexts.length,remaining===70000?1:0);
 if(remaining<70000){assert.equal(result.reason,'INSUFFICIENT_SESSION_TIME_FOR_CONTAINED_LAUNCH');assert.equal(result.notLaunched,true);assert.equal(f.methods.length,0);}
 assert.equal(f.network.attempts,0);
});

test('v2 rechecks the launch reserve after output and authority checks',async t=>{
 for(const delay of ['output','authority']){
  const base=Date.now();let time=base,emitted=false;t.mock.method(Date,'now',()=>time);const f=fixture(t);
  const result=await runAcceptanceInstantly({...f.args,phase:1,emit:message=>{if(message.event==='INSTANTLY_CONTAINED_LAUNCH'){emitted=true;if(delay==='output')time=base+80001;}},assertAuthority:()=>{if(delay==='authority'&&emitted)time=base+80001;return {id:f.m.id,status:'CLAIMED',deadlineAt:new Date(base+150000).toISOString()};}});
  assert.equal(result.reason,'INSUFFICIENT_SESSION_TIME_FOR_CONTAINED_LAUNCH');assert.equal(result.notLaunched,true);assert.equal(f.contexts.length,0);assert.equal(f.methods.length,0);
  await assert.rejects(()=>runAcceptanceInstantly({...f.args,phase:1}),/CONSUMED|REPLAY/);assert.equal(f.network.attempts,0);
 }
});

test('v2 rejects a v1 grant or invalid deadline before the fake launch',async t=>{
 for(const authority of [true,{id:'elya-instantly-qa-acceptance-v1',status:'CLAIMED',deadlineAt:new Date(Date.now()+150000).toISOString()},{id:manifest().id,status:'CLOSED',deadlineAt:new Date(Date.now()+150000).toISOString()},{id:manifest().id,status:'CLAIMED',deadlineAt:'invalid'}]){
  const f=fixture(t),result=await runAcceptanceInstantly({...f.args,phase:1,assertAuthority:()=>authority});
  assert.equal(result.reason,'INSTANTLY_QA_LAUNCH_DEADLINE_REQUIRED');assert.equal(result.notLaunched,true);assert.equal(f.contexts.length,0);assert.equal(f.methods.length,0);assert.equal(f.network.attempts,0);
 }
});

for(const [options,reason,count] of [[{starting:true},'INSTANTLY_STATUS_REQUEST_CAP',0],[{starting:true,readinessDeadline:true},'INSTANTLY_READINESS_DEADLINE',0],[{providerDeadline:true},'INSTANTLY_PROVIDER_DEADLINE',1]])test(`v2 preserves ${reason} without replay`,async t=>{
 const f=fixture(t,options),result=await runAcceptanceInstantly({...f.args,phase:1});
 assert.equal(result.status,'FAILED');assert.equal(result.reason,reason);assert.equal(f.calls.length,count);
 if(reason==='INSTANTLY_STATUS_REQUEST_CAP')assert.equal(f.methods.filter(m=>m.method==='mcpServerStatus/list').length,10);
 await assert.rejects(()=>runAcceptanceInstantly({...f.args,phase:1}),/CONSUMED|REPLAY/);await assert.rejects(()=>runAcceptanceInstantly({...f.args,phase:2}),/PHASE_ONE/);assert.equal(f.network.attempts,0);
});

test('v2 uncertain write is consumed once with no readback or replay',async t=>{
 const f=fixture(t,{uncertainWrite:true});assert.equal((await runAcceptanceInstantly({...f.args,phase:1})).status,'PASSED');
 assert.equal((await runAcceptanceInstantly({...f.args,phase:2})).status,'UNCERTAIN');assert.equal(f.calls.length,5);
 assert.equal(getRecord(f.db,'acceptance_instantly_call',f.m.id+':instantly:call:4').state,'UNCERTAIN');
 assert.deepEqual(getRecord(f.db,'acceptance_instantly_call',f.historical.manifestId+':instantly:call:4'),f.historical);
 await assert.rejects(()=>runAcceptanceInstantly({...f.args,phase:2}),/CONSUMED|REPLAY/);assert.equal(f.calls.length,5);assert.equal(f.network.attempts,0);
});

for(const [file,calls] of [['selected-contracts.json',0],['runtime-schemas.json',0],['snapshot-0-campaign.json',1]])test(`v2 persistence collision at ${file} preserves evidence and blocks progress`,async t=>{
 const f=fixture(t,{prepareDirectory:directory=>writeFileSync(join(directory,file),'preserved',{flag:'wx'})});
 const result=await runAcceptanceInstantly({...f.args,phase:1});assert.equal(result.status,'FAILED');assert.equal(f.calls.length,calls);
 assert.equal(readFileSync(join(f.directory,'instantly-phase-1',file),'utf8'),'preserved');
 await assert.rejects(()=>runAcceptanceInstantly({...f.args,phase:2}),/PHASE_ONE/);await assert.rejects(()=>runAcceptanceInstantly({...f.args,phase:1}),/CONSUMED|REPLAY/);assert.equal(f.network.attempts,0);
});

for(const [label,mutate] of [
 ['active campaign',({value,call})=>{if(call.tool.endsWith('get_campaign'))value.status=1;}],
 ['coerced campaign status',({value,call})=>{if(call.tool.endsWith('get_campaign'))value.status='0';}],
 ['wrong campaign identity',({value,call})=>{if(call.tool.endsWith('get_campaign'))value.id='other';}],
 ['enabled sending day',({value,call})=>{if(call.tool.endsWith('get_campaign'))value.campaign_schedule.schedules[0].days['1']=true;}],
 ['assigned mailbox',({value,call})=>{if(call.tool.endsWith('get_campaign'))value.email_list=['fixture@example.invalid'];}],
 ['unregistered variable',({value,call})=>{if(call.tool.endsWith('get_campaign'))delete value.custom_variables.pilot_body_3;}],
 ['wrong lead association',({value,call})=>{if(call.tool.endsWith('get_lead'))value.campaign='other';}],
 ['wrong lead email',({value,call})=>{if(call.tool.endsWith('get_lead'))value.email='fixture@example.invalid';}],
])test(`v2 ${label} fails preflight with no write`,async t=>{
 const f=fixture(t,{mutate});assert.equal((await runAcceptanceInstantly({...f.args,phase:1})).status,'FAILED');
 await assert.rejects(()=>runAcceptanceInstantly({...f.args,phase:2}),/PHASE_ONE/);assert.ok(f.calls.every(c=>c.tool!=='instantly_ai.update_lead'));assert.equal(f.network.attempts,0);
});

for(const [label,mutateResponse,reason] of [
 ['malformed structured result',result=>{result.structuredContent=[];},'INSTANTLY_RESULT_STRUCTURE_INVALID'],
 ['conflicting result representations',result=>{result.content=[{type:'text',text:JSON.stringify({...result.structuredContent,status:1})}];},'INSTANTLY_RESULT_REPRESENTATIONS_CONFLICT'],
 ['tool error',result=>{result.isError=true;},'INSTANTLY_TOOL_ERROR'],
])test(`v2 ${label} is rejected without a second launch`,async t=>{
 const f=fixture(t,{mutateResponse}),result=await runAcceptanceInstantly({...f.args,phase:1});
 assert.equal(result.reason,reason);assert.equal(f.calls.length,1);await assert.rejects(()=>runAcceptanceInstantly({...f.args,phase:2}),/PHASE_ONE/);assert.equal(f.network.attempts,0);
});

for(const kind of ['campaign','lead'])test(`v2 changed ${kind} snapshot blocks its single write`,async t=>{
 const f=fixture(t,{mutate:({value,call,phase})=>{if(phase===2&&call.tool===`instantly_ai.get_${kind}`)value.timestamp_updated='changed';}});
 assert.equal((await runAcceptanceInstantly({...f.args,phase:1})).status,'PASSED');
 const result=await runAcceptanceInstantly({...f.args,phase:2});assert.equal(result.reason,'INSTANTLY_PREWRITE_STATE_CHANGED');assert.ok(f.calls.every(c=>c.tool!=='instantly_ai.update_lead'));assert.equal(f.network.attempts,0);
});

for(const [label,mutate,reason] of [
 ['unrelated lead data loss',({value,call,calls})=>{if(call.tool.endsWith('get_lead')&&calls.some(c=>c.tool.endsWith('update_lead')))delete value.payload.companyName;},'INSTANTLY_POSTWRITE_LEAD_MISMATCH'],
 ['incorrect requested value',({value,call,calls})=>{if(call.tool.endsWith('get_lead')&&calls.some(c=>c.tool.endsWith('update_lead')))value.payload.pilot_body_1='wrong';},'INSTANTLY_POSTWRITE_LEAD_MISMATCH'],
 ['final campaign change',({value,call,calls})=>{if(call.tool.endsWith('get_campaign')&&calls.some(c=>c.tool.endsWith('update_lead')))value.name='changed';},'INSTANTLY_CAMPAIGN_CHANGED'],
])test(`v2 ${label} makes the write uncertain without retry`,async t=>{
 const f=fixture(t,{mutate});assert.equal((await runAcceptanceInstantly({...f.args,phase:1})).status,'PASSED');
 const result=await runAcceptanceInstantly({...f.args,phase:2});assert.equal(result.status,'UNCERTAIN');assert.equal(result.reason,reason);assert.equal(f.calls.filter(c=>c.tool.endsWith('update_lead')).length,1);
 await assert.rejects(()=>runAcceptanceInstantly({...f.args,phase:2}),/CONSUMED|REPLAY/);assert.equal(f.network.attempts,0);
});

test('v2 unconfirmed write acknowledgment stops before readback with no retry',async t=>{
 const f=fixture(t,{mutateResponse:(result,call)=>{if(call.tool.endsWith('update_lead'))result.isError=null;}});
 assert.equal((await runAcceptanceInstantly({...f.args,phase:1})).status,'PASSED');
 const result=await runAcceptanceInstantly({...f.args,phase:2});assert.equal(result.reason,'INSTANTLY_WRITE_ACK_UNCONFIRMED');assert.equal(result.status,'UNCERTAIN');assert.equal(f.calls.length,5);
 await assert.rejects(()=>runAcceptanceInstantly({...f.args,phase:2}),/CONSUMED|REPLAY/);assert.equal(f.calls.length,5);assert.equal(f.network.attempts,0);
});

test('v2 duplicate worker cannot claim its active slot',async t=>{
 const f=fixture(t,{duplicateWorker:true});assert.equal((await runAcceptanceInstantly({...f.args,phase:1})).status,'PASSED');
 assert.equal(f.methods.filter(m=>m.method==='initialize').length,1);assert.equal(f.calls.length,2);assert.equal(f.network.attempts,0);
});

test('v2 refuses tampered context before fake AppServer initialization',async t=>{
 const f=fixture(t,{changeContext:context=>{context.manifestId='elya-instantly-qa-acceptance-v1';}});
 assert.equal((await runAcceptanceInstantly({...f.args,phase:1})).status,'FAILED');assert.equal(f.methods.length,0);assert.equal(f.calls.length,0);assert.equal(f.network.attempts,0);
});

test('v2 cleanup must pass before the second fake launch',async t=>{
 const f=fixture(t,{badCleanup:true});assert.equal((await runAcceptanceInstantly({...f.args,phase:1})).status,'FAILED');
 await assert.rejects(()=>runAcceptanceInstantly({...f.args,phase:2}),/PHASE_ONE/);assert.equal(f.calls.length,2);assert.equal(f.contexts.length,1);assert.equal(f.network.attempts,0);
});

for(const [version,contextVersion,reason] of [['v1','v1','INSTANTLY_QA_CONTEXT_REQUIRED'],['v2','v2','INSTANTLY_CONTEXT_MANIFEST_MISMATCH'],['v1','v2','INSTANTLY_QA_CONTEXT_REQUIRED']])test(`v2 worker rejects ${version} manifest and ${contextVersion} context before database work`,async t=>{
 const network=blockNetwork(t),directory=mkdtempSync(join(tmpdir(),'elya-instantly-v2-entry-')),argv=process.argv;
 t.after(()=>{process.argv=argv;});t.mock.method(globalThis,'setInterval',()=>0);
 const m=read(`work/instantly-qa-acceptance-${version}/manifest.json`);
 writeFileSync(join(directory,'context.json'),JSON.stringify({manifest:m,manifestId:`elya-instantly-qa-acceptance-${contextVersion}`,manifestHash:'invalid',database:':memory:'}),{flag:'wx'});
 process.argv=[process.execPath,'offline-test','parent',directory];
 await import(`../work/instantly-qa-acceptance-v2/instantly-worker.mjs?offline-entry=${version}-${contextVersion}`);
 assert.equal(read(join(directory,`worker-rejected-${process.pid}.json`)).reason,reason);assert.equal(existsSync(join(directory,'worker-result.json')),false);assert.equal(network.attempts,0);
});
