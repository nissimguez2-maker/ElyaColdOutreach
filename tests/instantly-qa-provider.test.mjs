import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {readFileSync,mkdtempSync,writeFileSync,existsSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {openStore,controls,getRecord,putRecord,journal} from '../src/store.mjs';
import {digest} from '../src/values.mjs';
import {armAcceptance,claimAcceptance} from '../src/acceptance-authority.mjs';
import {runAcceptanceSequence} from '../src/acceptance-controller.mjs';
import {runInstantlyQaCommand} from '../src/instantly-qa-command.mjs';
import {instantlyAcceptanceCalls,runAcceptanceInstantly,runInstantlyPhaseWorker} from '../src/acceptance-instantly.mjs';
import {blockNetwork} from './helpers/network-block.mjs';

const read=path=>JSON.parse(readFileSync(path,'utf8'));
const manifest=()=>read('work/instantly-qa-acceptance-v1/manifest.json');
const original=read('work/acceptance-manifest-v1/manifest.json');
const recovered=read('work/instantly-contract-diagnostics-v1/recovered-contracts.json').tools;
const saved=read('work/synthetic-qa-created-record.json');
const declarations=read('work/instantly-capability-inspection.json').schemas;
const campaign=saved.latestReadOnlyConfirmation.liveReadback.campaign.structuredContent,lead=saved.readbacks.lead.value.structuredContent;

function fixture(t,options={}){
 const network=blockNetwork(t),m=manifest(),db=openStore(':memory:');t.after(()=>db.close());
 const grant={id:m.id,status:'CLAIMED',deadlineAt:new Date(Date.now()+150000).toISOString()};
 const directory=mkdtempSync(join(tmpdir(),'elya-instantly-qa-')),calls=[],contexts=[],methods=[];
 const historical={manifestId:original.id,state:'INTENT',marker:'preserve closed historical evidence'};
 putRecord(db,'acceptance_instantly_call',original.id+':instantly:call:4',historical);
 const launch=async args=>{
  contexts.push(args.context);let current=structuredClone(lead),time=args.context.launchStartedMs;
  const tools=structuredClone(recovered);options.changeTools?.(tools,args.phase);
  options.prepareDirectory?.(args.directory,args.phase);
  const startProcess=()=>{
   const child=new EventEmitter();child.pid=321;child.stdout=new EventEmitter();child.stderr=new EventEmitter();child.stdin=new EventEmitter();
   child.stdin.write=(line,done)=>{
    const request=JSON.parse(line);methods.push({phase:args.phase,method:request.method});done?.();if(request.id===undefined)return;
    let result;
    if(request.method==='initialize')result={};
    else if(request.method==='thread/start')result={thread:{id:'qa-fixture-'+args.phase}};
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
     result={content:[],structuredContent:value,isError:false};
    }else throw Error('UNAPPROVED_FIXTURE_METHOD');
    queueMicrotask(()=>child.stdout.emit('data',Buffer.from(JSON.stringify({id:request.id,result})+'\n')));
   };return child;
  };
  const workerArgs={...args,db,manifest:m,savedDeclarations:options.declarations??declarations,startProcess,clock:()=>time,wallClock:()=>time,sleep:async ms=>{time+=ms;}};
  options.changeContext?.(workerArgs.context);
  const pending=runInstantlyPhaseWorker(workerArgs);
  if(options.duplicateWorker){const duplicate=await runInstantlyPhaseWorker(workerArgs);assert.equal(duplicate.status,'REJECTED');assert.equal(duplicate.workerOwnsSlot,false);}
  const worker=await pending;
  return {worker,owner:{cleanupConfirmed:!options.badCleanup,noPostCleanupRpcWrites:true,remainingMembers:[],processChecks:[{pid:321,wait:0,exitCode:31027}],error:null,timedOut:false,cleanupCompletedAt:new Date(time).toISOString()},exit:{code:0}};
 };
 return {db,m,directory,calls,contexts,methods,network,historical,args:{db,manifest:m,directory,assertAuthority:()=>grant,fixtureLaunch:launch}};
}

test('Instantly-only manifest emits the original exact seven calls and rejects any altered approval',t=>{
 const network=blockNetwork(t),m=manifest();
 const calls=[...instantlyAcceptanceCalls(m,1),...instantlyAcceptanceCalls(m,2)];
 assert.deepEqual(calls.map(c=>c.tool),['instantly_ai.get_campaign','instantly_ai.get_lead','instantly_ai.get_campaign','instantly_ai.get_lead','instantly_ai.update_lead','instantly_ai.get_lead','instantly_ai.get_campaign']);
 assert.deepEqual(calls[4].arguments,original.instantly.writeArguments);
 for(const change of [v=>v.id='arbitrary-id',v=>v.instantly.leadId='other',v=>v.instantly.writeArguments.custom_variables.pilot_body_1+=' changed',v=>v.limits.businessDataCallsAcrossBothLaunches=10,v=>delete v.contracts.approvedContracts,v=>v.contracts.approvedContracts[0].sha256='0'.repeat(64),v=>v.contracts.approvedContracts[0].contract.description='changed',v=>v.contracts.approvedContracts.reverse()]){
  const changed=structuredClone(m);change(changed);assert.throws(()=>instantlyAcceptanceCalls(changed,1));
 }
 assert.equal(network.attempts,0);
});

test('two fake launches pin selected contracts, execute two then five calls and preserve state',async t=>{
 const f=fixture(t,{changeTools:tools=>{for(const tool of tools){tool.annotations.unknown='UNRELATED_PRIVATE_SENTINEL';tool.extra='UNRELATED_PRIVATE_SENTINEL';}}}),before=controls(f.db);
 assert.equal((await runAcceptanceInstantly({...f.args,phase:1})).status,'PASSED');
 assert.equal((await runAcceptanceInstantly({...f.args,phase:2})).status,'PASSED');
 assert.deepEqual(f.calls.map(c=>c.phase),[1,1,2,2,2,2,2]);
 assert.deepEqual(f.calls.map(({phase,threadId,...call})=>call),f.m.calls.map(({index,launch,...call})=>call));
 assert.equal(f.calls.filter(c=>c.tool==='instantly_ai.update_lead').length,1);
 assert.deepEqual(f.calls[4].arguments,original.instantly.writeArguments);
 for(const phase of [1,2]){
  const text=readFileSync(join(f.directory,`instantly-phase-${phase}`,'selected-contracts.json'),'utf8'),capture=JSON.parse(text);
  assert.deepEqual(capture.tools,f.m.contracts.approvedContracts.map(c=>c.contract));
  assert.equal(capture.stage,'BEFORE_SCHEMA_VALIDATION');assert.equal(capture.businessToolExecutionBegun,false);
  assert.equal(text.includes('UNRELATED_PRIVATE_SENTINEL'),false);assert.equal(text.includes('environment'),false);
  assert.ok(existsSync(join(f.directory,`instantly-phase-${phase}`,'runtime-schemas.json')));
 }
 assert.ok(f.contexts.every(c=>c.manifestId===f.m.id&&c.manifest.id===f.m.id&&c.readinessDeadlineMs-c.launchStartedMs===20000&&c.providerDeadlineMs-c.launchStartedMs===40000&&Date.parse(c.hardDeadlineAt)-c.launchStartedMs===60000));
 assert.deepEqual(controls(f.db),before);assert.equal(f.db.prepare('SELECT count(*) n FROM operations').get().n,0);
 assert.deepEqual(getRecord(f.db,'acceptance_instantly_call',original.id+':instantly:call:4'),f.historical);
 assert.equal(f.db.prepare("SELECT count(*) n FROM records WHERE kind='acceptance_instantly_call' AND id LIKE ?").get(f.m.id+':%').n,7);
 await assert.rejects(()=>runAcceptanceInstantly({...f.args,phase:2}),/CONSUMED|REPLAY/);assert.equal(f.calls.length,7);assert.equal(f.network.attempts,0);
});

test('real one-use authority and controller complete both fake provider phases without Telegram or preserved-state changes',async t=>{
 const f=fixture(t),priorId='elya-acceptance-continuation-v1';
 putRecord(f.db,'acceptance_authorization',priorId,{status:'CLOSED'});
 putRecord(f.db,'acceptance_result',priorId,{authorizationStatus:'CLOSED',telegram:{status:'PASSED',cleanup:{confirmed:true},scenarios:{staleVersion:{status:'PASS'},requestChanges:{status:'PASS'}}}});
 putRecord(f.db,'telegram_writing_cursor','primary',{nextOffset:64381648});
 putRecord(f.db,'telegram_consumer_owner','primary',{status:'RELEASED'});
 f.db.prepare('INSERT INTO budgets VALUES(?,?,?,?,?,?)').run('historical-budget','1','0',null,'offline fixture',0);
 f.db.prepare('INSERT INTO operations(id,kind,budget_id,intent_hash,intent_json,status,reservation_usd,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?)').run('historical-reservation','READ','historical-budget','fixture-intent','{}','PREPARED','0.15','2026-11-16T00:00:00Z','2026-11-16T00:00:00Z');
 journal(f.db,'HISTORICAL_MARKER',priorId,{preserve:true});
 const preserved=()=>({
  controls:controls(f.db),
  records:f.db.prepare('SELECT * FROM records WHERE id NOT LIKE ? ORDER BY kind,id').all(f.m.id+'%'),
  history:f.db.prepare('SELECT * FROM record_history WHERE id NOT LIKE ? ORDER BY kind,id,hash').all(f.m.id+'%'),
  journal:f.db.prepare('SELECT * FROM journal WHERE subject NOT LIKE ? ORDER BY id').all(f.m.id+'%'),
  tables:Object.fromEntries(['sources','batches','approvals','budgets','operations'].map(table=>[table,f.db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()])),
 });
 const before=preserved(),fingerprints=['src/acceptance-authority.mjs','src/acceptance-controller.mjs','src/acceptance-instantly.mjs','src/instantly-qa-contract.mjs','work/instantly-qa-acceptance-v1/instantly-worker.mjs'].map(path=>({path,sha256:digest(readFileSync(path))}));
 armAcceptance(f.db,f.m,fingerprints);
 let telegramCalls=0;const order=[];
 const options={db:f.db,manifest:f.m,root:process.cwd(),telegram:async()=>{telegramCalls++;throw Error('TELEGRAM_MUST_NOT_RUN');},instantly:async bound=>{
  if(bound.phase===2){const first=getRecord(f.db,'acceptance_instantly_phase',f.m.id+':instantly:1');assert.equal(first.status,'PASSED');assert.equal(first.result.cleanup.confirmed,true);order.push('phase-1-cleaned');}
  order.push(bound.phase);return runAcceptanceInstantly({...f.args,...bound});
 }};
 const result=await runAcceptanceSequence(options);
 assert.equal(result.status,'PASS');assert.deepEqual(order,[1,'phase-1-cleaned',2]);assert.equal(telegramCalls,0);assert.equal(result.telegram.status,'NOT_APPLICABLE');
 assert.deepEqual(f.calls.map(({phase,threadId,...call})=>call),f.m.calls.map(({index,launch,...call})=>call));
 assert.equal(f.calls.length,7);assert.equal(f.calls.filter(c=>c.tool==='instantly_ai.update_lead').length,1);assert.deepEqual(f.calls[4].arguments,original.instantly.writeArguments);
 assert.equal(getRecord(f.db,'acceptance_authorization',f.m.id).status,'CLOSED');assert.deepEqual(getRecord(f.db,'acceptance_result',f.m.id),result);assert.deepEqual(preserved(),before);
 const methodCount=f.methods.length;
 await assert.rejects(()=>runAcceptanceSequence(options),/AUTHORIZATION_CLOSED/);assert.throws(()=>claimAcceptance(f.db,f.m),/AUTHORIZATION_CLOSED/);
 const duplicate=await runInstantlyQaCommand({db:f.db,root:f.directory,phaseRunner:options.instantly});
 assert.equal(duplicate.reason,'ACCEPTANCE_AUTHORIZATION_CLOSED');assert.equal(duplicate.authorizationStatus,'CLOSED');
 assert.equal(f.methods.length,methodCount);assert.equal(f.calls.length,7);assert.equal(telegramCalls,0);assert.deepEqual(preserved(),before);assert.equal(f.network.attempts,0);
});

for(const delay of ['controller output','provider output','source verification'])test(`${delay} cannot consume the 70-second reserve before the actual contained launch`,async t=>{
 const base=Date.now();let time=base,launchMessageEmitted=false;t.mock.method(Date,'now',()=>time);
 const f=fixture(t),priorId='elya-acceptance-continuation-v1';
 putRecord(f.db,'acceptance_authorization',priorId,{status:'CLOSED'});
 putRecord(f.db,'acceptance_result',priorId,{authorizationStatus:'CLOSED',telegram:{status:'PASSED',cleanup:{confirmed:true},scenarios:{staleVersion:{status:'PASS'},requestChanges:{status:'PASS'}}}});
 armAcceptance(f.db,f.m,[{path:'src/instantly-qa-contract.mjs',sha256:digest(readFileSync('src/instantly-qa-contract.mjs'))}],time);
 const result=await runAcceptanceSequence({db:f.db,manifest:f.m,root:process.cwd(),now:()=>time,emit:message=>{
  if(delay==='controller output'&&typeof message==='string')time=base+80001;
  if(message?.event==='INSTANTLY_CONTAINED_LAUNCH'){launchMessageEmitted=true;if(delay==='provider output')time=base+80001;}
 },instantly:bound=>runAcceptanceInstantly({...f.args,...bound,assertAuthority:()=>{
  const active=bound.assertAuthority();if(delay==='source verification'&&launchMessageEmitted)time=base+80001;return active;
 }})});
 assert.equal(result.status,'BLOCKED');assert.equal(result.instantly[0].reason,'INSUFFICIENT_SESSION_TIME_FOR_CONTAINED_LAUNCH');assert.equal(result.instantly[0].notLaunched,true);
 assert.equal(result.instantly[0].cleanup.confirmed,false);assert.equal(f.contexts.length,0);assert.equal(f.methods.length,0);assert.equal(f.calls.length,0);
 assert.equal(getRecord(f.db,'acceptance_authorization',f.m.id).status,'CLOSED');
 await assert.rejects(()=>runAcceptanceInstantly({...f.args,phase:1}),/CONSUMED|REPLAY/);assert.equal(f.network.attempts,0);
});

for(const remaining of [70000,69999])test(`actual launch reserve boundary with ${remaining} milliseconds remaining`,async t=>{
 const time=Date.now();t.mock.method(Date,'now',()=>time);const f=fixture(t);
 const result=await runAcceptanceInstantly({...f.args,phase:1,assertAuthority:()=>({id:f.m.id,status:'CLAIMED',deadlineAt:new Date(time+remaining).toISOString()})});
 assert.equal(result.status,remaining===70000?'PASSED':'FAILED');assert.equal(f.contexts.length,remaining===70000?1:0);
 if(remaining<70000){assert.equal(result.reason,'INSUFFICIENT_SESSION_TIME_FOR_CONTAINED_LAUNCH');assert.equal(result.notLaunched,true);}
 assert.equal(f.network.attempts,0);
});

test('actual launch requires a matching claimed grant with a valid deadline',async t=>{
 for(const authority of [true,{id:'other',status:'CLAIMED',deadlineAt:new Date(Date.now()+150000).toISOString()},{id:manifest().id,status:'CLOSED',deadlineAt:new Date(Date.now()+150000).toISOString()},{id:manifest().id,status:'CLAIMED',deadlineAt:'invalid'}]){
  const f=fixture(t),result=await runAcceptanceInstantly({...f.args,phase:1,assertAuthority:()=>authority});
  assert.equal(result.status,'FAILED');assert.equal(result.reason,'INSTANTLY_QA_LAUNCH_DEADLINE_REQUIRED');assert.equal(result.notLaunched,true);assert.equal(f.contexts.length,0);assert.equal(f.methods.length,0);assert.equal(f.network.attempts,0);
 }
});

for(const phase of [1,2])for(const [label,change] of [
 ['description',tools=>tools[0].description+=' changed'],
 ['input constraint',tools=>tools[1].inputSchema.properties.id.maxLength=36],
 ['missing input schema',tools=>delete tools[0].inputSchema],
 ['missing output schema',tools=>delete tools[1].outputSchema],
 ['unsupported output schema',tools=>tools[2].outputSchema.oneOf=[{type:'object'}]],
 ['merge semantics',tools=>tools[2].inputSchema.properties.custom_variables.description='Replace all variables.'],
 ['read annotation',tools=>tools[0].annotations.readOnlyHint=false],
])test(`contract ${label} drift in launch ${phase} retains capture and blocks all its business reads`,async t=>{
 const f=fixture(t,{changeTools:(tools,currentPhase)=>{if(currentPhase===phase)change(tools);}});
 if(phase===2)assert.equal((await runAcceptanceInstantly({...f.args,phase:1})).status,'PASSED');
 const result=await runAcceptanceInstantly({...f.args,phase});
 assert.equal(result.status,'FAILED');assert.equal(result.reason,'INSTANTLY_QA_CONTRACT_DRIFT');assert.equal(f.calls.filter(c=>c.phase===phase).length,0);
 const capture=read(join(f.directory,`instantly-phase-${phase}`,'selected-contracts.json'));
 assert.equal(capture.tools.length,3);assert.equal(capture.businessToolExecutionBegun,false);
 assert.notDeepEqual(capture.tools,f.m.contracts.approvedContracts.map(c=>c.contract));
 assert.equal(existsSync(join(f.directory,`instantly-phase-${phase}`,'runtime-schemas.json')),false);
 await assert.rejects(()=>runAcceptanceInstantly({...f.args,phase}),/CONSUMED|REPLAY/);assert.equal(f.network.attempts,0);
});

test('missing retained merge declaration fails after capture and before business calls',async t=>{
 const f=fixture(t,{declarations:[]}),result=await runAcceptanceInstantly({...f.args,phase:1});
 assert.equal(result.reason,'INSTANTLY_MERGE_SEMANTICS_UNESTABLISHED');assert.equal(f.calls.length,0);assert.ok(existsSync(join(f.directory,'instantly-phase-1','selected-contracts.json')));assert.equal(f.network.attempts,0);
});

for(const [label,mutate] of [
 ['active campaign',({value,call})=>{if(call.tool.endsWith('get_campaign'))value.status=1;}],
 ['enabled sending day',({value,call})=>{if(call.tool.endsWith('get_campaign'))value.campaign_schedule.schedules[0].days['1']=true;}],
 ['assigned mailbox',({value,call})=>{if(call.tool.endsWith('get_campaign'))value.email_list=['fixture@example.invalid'];}],
 ['unregistered variable',({value,call})=>{if(call.tool.endsWith('get_campaign'))delete value.custom_variables.pilot_body_3;}],
 ['wrong lead association',({value,call})=>{if(call.tool.endsWith('get_lead'))value.campaign='other';}],
])test(`${label} blocks the first launch and prevents any second launch`,async t=>{
 const f=fixture(t,{mutate});assert.equal((await runAcceptanceInstantly({...f.args,phase:1})).status,'FAILED');
 await assert.rejects(()=>runAcceptanceInstantly({...f.args,phase:2}),/PHASE_ONE/);assert.ok(f.calls.every(c=>c.tool!=='instantly_ai.update_lead'));assert.equal(f.network.attempts,0);
});

for(const kind of ['campaign','lead'])test(`changed ${kind} prewrite snapshot blocks the single write`,async t=>{
 const f=fixture(t,{mutate:({value,call,phase})=>{if(phase===2&&call.tool===`instantly_ai.get_${kind}`)value.timestamp_updated='changed';}});
 assert.equal((await runAcceptanceInstantly({...f.args,phase:1})).status,'PASSED');
 const result=await runAcceptanceInstantly({...f.args,phase:2});assert.equal(result.reason,'INSTANTLY_PREWRITE_STATE_CHANGED');assert.ok(f.calls.every(c=>c.tool!=='instantly_ai.update_lead'));assert.equal(f.network.attempts,0);
});

for(const [label,mutate,reason] of [
 ['unrelated lead data loss',({value,call,calls})=>{if(call.tool.endsWith('get_lead')&&calls.some(c=>c.tool.endsWith('update_lead')))delete value.payload.companyName;},'INSTANTLY_POSTWRITE_LEAD_MISMATCH'],
 ['incorrect requested value',({value,call,calls})=>{if(call.tool.endsWith('get_lead')&&calls.some(c=>c.tool.endsWith('update_lead')))value.payload.pilot_body_1='wrong';},'INSTANTLY_POSTWRITE_LEAD_MISMATCH'],
 ['final campaign change',({value,call,calls})=>{if(call.tool.endsWith('get_campaign')&&calls.some(c=>c.tool.endsWith('update_lead')))value.name='changed';},'INSTANTLY_CAMPAIGN_CHANGED'],
])test(`${label} makes the write uncertain with no second attempt`,async t=>{
 const f=fixture(t,{mutate});assert.equal((await runAcceptanceInstantly({...f.args,phase:1})).status,'PASSED');
 const result=await runAcceptanceInstantly({...f.args,phase:2});assert.equal(result.status,'UNCERTAIN');assert.equal(result.reason,reason);assert.equal(f.calls.filter(c=>c.tool.endsWith('update_lead')).length,1);
 await assert.rejects(()=>runAcceptanceInstantly({...f.args,phase:2}),/CONSUMED|REPLAY/);assert.equal(f.network.attempts,0);
});

test('uncertain update never reads back, retries or reuses historical call evidence',async t=>{
 const f=fixture(t,{uncertainWrite:true});assert.equal((await runAcceptanceInstantly({...f.args,phase:1})).status,'PASSED');
 assert.equal((await runAcceptanceInstantly({...f.args,phase:2})).status,'UNCERTAIN');assert.equal(f.calls.length,5);
 assert.equal(getRecord(f.db,'acceptance_instantly_call',f.m.id+':instantly:call:4').state,'UNCERTAIN');
 assert.deepEqual(getRecord(f.db,'acceptance_instantly_call',original.id+':instantly:call:4'),f.historical);
 await assert.rejects(()=>runAcceptanceInstantly({...f.args,phase:2}),/CONSUMED|REPLAY/);assert.equal(f.calls.length,5);assert.equal(f.network.attempts,0);
});

for(const file of ['selected-contracts.json','snapshot-0-campaign.json'])test(`existing ${file} blocks progress without overwriting evidence`,async t=>{
 const f=fixture(t,{prepareDirectory:directory=>writeFileSync(join(directory,file),'preserved',{flag:'wx'})});
 assert.equal((await runAcceptanceInstantly({...f.args,phase:1})).status,'FAILED');assert.equal(readFileSync(join(f.directory,'instantly-phase-1',file),'utf8'),'preserved');
 await assert.rejects(()=>runAcceptanceInstantly({...f.args,phase:2}),/PHASE_ONE/);assert.ok(f.calls.every(c=>c.tool!=='instantly_ai.update_lead'));assert.equal(f.network.attempts,0);
});

test('readiness is capped at ten status requests with zero business calls',async t=>{
 const f=fixture(t,{starting:true});assert.equal((await runAcceptanceInstantly({...f.args,phase:1})).status,'FAILED');
 assert.equal(f.methods.filter(m=>m.method==='mcpServerStatus/list').length,10);assert.equal(f.calls.length,0);assert.equal(f.network.attempts,0);
});

test('duplicate worker cannot claim or publish the active new-ID slot',async t=>{
 const f=fixture(t,{duplicateWorker:true});assert.equal((await runAcceptanceInstantly({...f.args,phase:1})).status,'PASSED');
 assert.equal(f.methods.filter(m=>m.method==='initialize').length,1);assert.equal(f.calls.length,2);assert.equal(f.network.attempts,0);
});

test('context manifest ID tampering is rejected before fake AppServer initialization',async t=>{
 const f=fixture(t,{changeContext:context=>{context.manifestId=original.id;}});
 assert.equal((await runAcceptanceInstantly({...f.args,phase:1})).status,'FAILED');assert.equal(f.methods.length,0);assert.equal(f.calls.length,0);assert.equal(f.network.attempts,0);
});

test('unconfirmed cleanup prevents the second launch after validated preflight',async t=>{
 const f=fixture(t,{badCleanup:true});assert.equal((await runAcceptanceInstantly({...f.args,phase:1})).status,'FAILED');
 await assert.rejects(()=>runAcceptanceInstantly({...f.args,phase:2}),/PHASE_ONE/);assert.equal(f.calls.length,2);assert.equal(f.contexts.length,1);assert.equal(f.network.attempts,0);
});
