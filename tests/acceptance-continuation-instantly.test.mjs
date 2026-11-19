import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {readFileSync,mkdtempSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {openStore,controls,getRecord,putRecord} from '../src/store.mjs';
import {instantlyAcceptanceCalls,runAcceptanceInstantly,runInstantlyPhaseWorker} from '../src/acceptance-instantly.mjs';
import {blockNetwork} from './helpers/network-block.mjs';

const original=JSON.parse(readFileSync('work/acceptance-manifest-v1/manifest.json','utf8'));
const manifest=()=>JSON.parse(readFileSync('work/acceptance-continuation-v1/manifest.json','utf8'));
const saved=JSON.parse(readFileSync('work/synthetic-qa-created-record.json','utf8'));
const declarations=JSON.parse(readFileSync('work/instantly-capability-inspection.json','utf8')).schemas;
const campaign=saved.latestReadOnlyConfirmation.liveReadback.campaign.structuredContent,lead=saved.readbacks.lead.value.structuredContent;

test('fresh continuation selects exactly the original seven calls and unchanged single write',t=>{
 const network=blockNetwork(t),m=manifest();
 const calls=[...instantlyAcceptanceCalls(m,1),...instantlyAcceptanceCalls(m,2)];
 assert.deepEqual(calls,[...instantlyAcceptanceCalls(original,1),...instantlyAcceptanceCalls(original,2)]);
 assert.equal(calls.length,7);assert.deepEqual(calls[4].arguments,original.instantly.writeArguments);
 for(const change of [v=>v.id='arbitrary-id',v=>v.instantly.leadId='other',v=>v.instantly.writeArguments.custom_variables.pilot_body_1+=' changed',v=>v.limits.businessDataCallsAcrossBothLaunches=10]){
  const altered=structuredClone(m);change(altered);assert.throws(()=>instantlyAcceptanceCalls(altered,1));
 }
 assert.equal(network.attempts,0);
});

function fixture(t,options={}){
 const m=manifest(),db=openStore(':memory:');t.after(()=>db.close());
 const directory=mkdtempSync(join(tmpdir(),'elya-continuation-instantly-')),calls=[],contexts=[];
 const oldPhase={status:'PASSED',marker:'preserve prior closed evidence'},oldCall={manifestId:original.id,state:'INTENT',marker:'must not reconcile in new session'};
 putRecord(db,'acceptance_instantly_phase',original.id+':instantly:1',oldPhase);
 putRecord(db,'acceptance_instantly_call',original.id+':instantly:call:4',oldCall);
 const launch=async args=>{
  contexts.push(args.context);let current=structuredClone(lead);
  const tools=m.instantly.tools.map(name=>({name,inputSchema:{type:'object',properties:{id:{type:'string',format:'uuid'},...(name.endsWith('update_lead')?{custom_variables:{type:'object',description:options.noMerge?'Replace all variables':'Custom variables to merge into the lead.',additionalProperties:{type:['string','number','boolean','null']}}}:{})},required:['id'],additionalProperties:false},outputSchema:{type:'object',additionalProperties:true}}));
  const startProcess=()=>{
   const child=new EventEmitter();child.pid=321;child.stdout=new EventEmitter();child.stderr=new EventEmitter();child.stdin=new EventEmitter();
   child.stdin.write=(line,done)=>{
    const request=JSON.parse(line);done?.();if(request.id===undefined)return;
    let result;
    if(request.method==='initialize')result={};
    else if(request.method==='thread/start')result={thread:{id:'continuation-fixture'}};
    else if(request.method==='mcpServerStatus/list')result={data:[{name:'codex_apps',authStatus:'bearerToken',runtimeStatus:'connected',tools:Object.fromEntries(tools.map(tool=>[tool.name,tool]))}],nextCursor:null};
    else if(request.method==='mcpServer/tool/call'){
     const call=request.params;calls.push(structuredClone(call));let value;
     if(call.tool.endsWith('get_campaign')){value=structuredClone(campaign);if(options.activeCampaign)value.status=1;}
     else if(call.tool.endsWith('get_lead'))value=structuredClone(current);
     else if(call.tool.endsWith('update_lead')){
      if(options.uncertainWrite){queueMicrotask(()=>child.stdout.emit('data',Buffer.from(JSON.stringify({id:request.id,error:{code:-1,message:'fixture uncertain'}})+'\n')));return;}
      current={...current,payload:{...current.payload,...call.arguments.custom_variables},timestamp_updated:'2026-11-17T01:00:00Z'};value={};
     }else throw Error('UNAPPROVED_FIXTURE_TOOL');
     result={content:[],structuredContent:value,isError:false};
    }else throw Error('UNAPPROVED_FIXTURE_METHOD');
    queueMicrotask(()=>child.stdout.emit('data',Buffer.from(JSON.stringify({id:request.id,result})+'\n')));
   };return child;
  };
  const worker=await runInstantlyPhaseWorker({...args,db,manifest:m,assertAuthority:()=>true,savedDeclarations:declarations,startProcess});
  return {worker,owner:{cleanupConfirmed:!options.badCleanup,noPostCleanupRpcWrites:true,remainingMembers:[],processChecks:[{pid:321,wait:0,exitCode:31027}],error:null,timedOut:false,cleanupCompletedAt:new Date().toISOString()},exit:{code:0},fixture:true};
 };
 return {db,m,calls,contexts,oldPhase,oldCall,args:{db,manifest:m,directory,assertAuthority:()=>true,fixtureLaunch:launch}};
}

test('new phase/call/context records stay isolated from the closed historical namespace',async t=>{
 const network=blockNetwork(t),f=fixture(t),before=controls(f.db);
 assert.equal((await runAcceptanceInstantly({...f.args,phase:1})).status,'PASSED');
 assert.equal((await runAcceptanceInstantly({...f.args,phase:2})).status,'PASSED');
 assert.equal(f.calls.length,7);assert.equal(f.calls.filter(c=>c.tool==='instantly_ai.update_lead').length,1);
 assert.deepEqual(f.calls[4].arguments,original.instantly.writeArguments);
 assert.ok(f.contexts.every(c=>c.manifestId===f.m.id&&c.manifest.id===f.m.id));
 const rows=f.db.prepare("SELECT id,data_json FROM records WHERE kind='acceptance_instantly_call'").all();
 assert.equal(rows.filter(r=>r.id.startsWith(f.m.id+':')).length,7);
 assert.deepEqual(getRecord(f.db,'acceptance_instantly_phase',original.id+':instantly:1'),f.oldPhase);
 assert.deepEqual(getRecord(f.db,'acceptance_instantly_call',original.id+':instantly:call:4'),f.oldCall);
 assert.deepEqual(controls(f.db),before);
 await assert.rejects(()=>runAcceptanceInstantly({...f.args,phase:2}),/CONSUMED|REPLAY/);assert.equal(f.calls.length,7);
 assert.equal(network.attempts,0);
});

test('continuation still rejects unestablished merge, active campaign and unconfirmed cleanup',async t=>{
 const network=blockNetwork(t);
 for(const options of [{noMerge:true},{activeCampaign:true},{badCleanup:true}]){
  const f=fixture(t,options),result=await runAcceptanceInstantly({...f.args,phase:1});assert.equal(result.status,'FAILED');
  assert.ok(f.calls.every(c=>c.tool!=='instantly_ai.update_lead'));
  await assert.rejects(()=>runAcceptanceInstantly({...f.args,phase:2}),/PHASE_ONE/);
  assert.deepEqual(getRecord(f.db,'acceptance_instantly_call',original.id+':instantly:call:4'),f.oldCall);
 }
 assert.equal(network.attempts,0);
});

test('uncertain continuation write is journaled only under the new ID and never replayed',async t=>{
 const network=blockNetwork(t),f=fixture(t,{uncertainWrite:true});
 assert.equal((await runAcceptanceInstantly({...f.args,phase:1})).status,'PASSED');
 const result=await runAcceptanceInstantly({...f.args,phase:2});assert.equal(result.status,'UNCERTAIN');assert.equal(f.calls.length,5);
 assert.equal(getRecord(f.db,'acceptance_instantly_call',f.m.id+':instantly:call:4').state,'UNCERTAIN');
 assert.deepEqual(getRecord(f.db,'acceptance_instantly_call',original.id+':instantly:call:4'),f.oldCall);
 await assert.rejects(()=>runAcceptanceInstantly({...f.args,phase:2}),/CONSUMED|REPLAY/);assert.equal(f.calls.length,5);
 assert.equal(network.attempts,0);
});
