import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {readFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {getRecord,putRecord,openStore} from '../src/store.mjs';
import {canonical,digest} from '../src/values.mjs';
import {prepareHandoff,executeHandoff} from '../src/handoff.mjs';
import {productionFixture,productionTransport} from './helpers/handoff-production-fixture.mjs';
import {blockNetwork} from './helpers/network-block.mjs';
const captured=JSON.parse(readFileSync(new URL('../work/instantly-qa-acceptance-v2/captured-contracts.json',import.meta.url),'utf8'));
const discovered=JSON.parse(readFileSync(new URL('../work/instantly-contract-capture-v1/live-once/selected-contracts-03.json',import.meta.url),'utf8'));
const runtime=await import('../src/handoff-app-server.mjs').catch(()=>null);
test('contained handoff transport factory is inert and requires complete saved runtime contracts',()=>{
 assert.equal(typeof runtime?.createContainedHandoffTransport,'function');
 assert.throws(()=>runtime.createContainedHandoffTransport({}),/CONTRACT|CONFIGURATION/);
});
const at=Date.parse('2026-11-16T22:00:00Z');
test('historical saved create envelope satisfies strict identity parsing; conflicting representations halt before update',async t=>{
 blockNetwork(t);
 // Historical chat-connector result, attributed by its saved leadCreated context;
 // no original tool-name/RPC dispatch record or current contained-create proof.
 const saved=JSON.parse(readFileSync(new URL('../work/synthetic-qa-created-record.json',import.meta.url),'utf8')).leadCreated;
 assert.equal(saved.isError,false);assert.deepEqual(JSON.parse(saved.content[0].text),saved.structuredContent);
 assert.equal(saved.structuredContent.id,'01a1e4b0-51d4-799a-9249-e089d63d5fb0');
 assert.equal(saved.structuredContent.campaign,'e0b018cf-160f-454c-9891-e73b4204d7cd');assert.equal(saved.structuredContent.email,'drosen@elyapartners.com');
 for(const conflict of [false,true]){
  const f=productionFixture(),transport=productionTransport(f);t.after(()=>f.db.close());
  const response=JSON.parse(JSON.stringify(saved).replaceAll(saved.structuredContent.id,'fixture-created-1').replaceAll(saved.structuredContent.campaign,f.spec.campaignId).replaceAll(saved.structuredContent.email,f.spec.email));
  for(const value of [response.structuredContent,JSON.parse(response.content[0].text)]){
   for(const key of ['organization','uploaded_by_user','assigned_to'])delete value[key];
   if(value!==response.structuredContent){if(conflict)value.id='conflicting-fixture-id';response.content[0].text=JSON.stringify(value);}
  }
  const execute=transport.transport.execute;transport.transport.execute=async(call,options)=>{const result=await execute(call,options);return call.tool==='instantly_ai.create_lead'?response:result;};
  prepareHandoff(f.db,f.input,{productionAdapter:transport.adapter});const result=await executeHandoff(f.db,f.input.id,transport.adapter,'2026-11-16T22:00:00Z');
  assert.equal(result.status,conflict?'RECONCILIATION':'SUCCEEDED');
  assert.deepEqual(transport.calls.map(c=>c.tool),conflict?['instantly_ai.create_lead']:['instantly_ai.create_lead','instantly_ai.update_lead','instantly_ai.get_lead']);
 }
});
function contracts(){
 // The create advertisement is live-captured; responses remain synthetic. The
 // older get/update captures are projections, not complete current runtime pins.
 return {sourceRef:'ISOLATED FIXTURE: captured create advertisement plus historical get/update projections; no live runtime bundle approval',approvedBy:'Daniel Rosen',approvedAt:'2026-11-16T22:00:00Z',expiresAt:'2026-11-16T22:05:00Z',tools:[
  structuredClone(discovered.tools.find(t=>t.name==='instantly_ai.create_lead')),
  ...structuredClone(captured.tools.filter(t=>['instantly_ai.update_lead','instantly_ai.get_lead'].includes(t.name))),
 ]};
}
function protocol(mode='ok'){
 const requests=[],child=new EventEmitter();child.stdout=new EventEmitter();child.stderr=new EventEmitter();child.stdin=new EventEmitter();
 const context={codex:'local-fixture',project:'local-fixture',environment:{},runtimeContracts:contracts(),call:{server:'codex_apps',tool:'instantly_ai.create_lead',arguments:{campaign:'fixture-campaign',email:'fixture@example.invalid'}},deadlineAt:'2026-11-16T22:00:30Z'};
 const deliver=value=>queueMicrotask(()=>child.stdout.emit('data',Buffer.from(JSON.stringify(value)+'\n')));
 child.stdin.write=(line,callback)=>{
  const m=JSON.parse(line);requests.push(m);queueMicrotask(()=>callback?.());if(m.id===undefined||m.error)return;
  if(mode==='approval'&&m.method==='thread/start'){deliver({id:1000,method:'permissions/requestApproval'});return;}
  let result={};if(m.method==='thread/start')result={thread:{id:'fixture-thread'}};
  if(m.method==='mcpServerStatus/list'){
   const tool=structuredClone(context.runtimeContracts.tools[0]);if(mode==='changed')tool.inputSchema.required.push('unknown');if(mode==='metadata')tool.description='Changed provider contract';
   const statusCalls=requests.filter(x=>x.method==='mcpServerStatus/list').length;
   result={data:[{name:'codex_apps',runtimeStatus:mode==='starting'&&statusCalls===1?'starting':'connected',authStatus:mode==='auth'?'notLoggedIn':'bearerToken',tools:{selected:tool}}],nextCursor:null};
  }
  if(m.method==='mcpServer/tool/call')result={content:[],structuredContent:mode==='malformed'?null:{id:'fixture-lead',campaign:'fixture-campaign',email:'fixture@example.invalid'},isError:false};
  deliver({id:m.id,result});
 };
 let launches=0,permits=0;
 return {context,requests,launches:()=>launches,permits:()=>permits,run:options=>runtime.runHandoffAppServerCall({context,startProcess:()=>{launches++;return child;},permit:call=>{permits++;return call;},clock:()=>at,...options})};
}
if(runtime){
test('production protocol submits exact call through saved deterministic App Server route without a model turn',async()=>{
 const f=protocol(),response=await f.run();assert.equal(response.structuredContent.id,'fixture-lead');
 assert.deepEqual(f.requests.map(r=>r.method),['initialize','initialized','thread/start','mcpServerStatus/list','mcpServer/tool/call']);
 assert.equal(f.permits(),1);assert.deepEqual(f.requests.at(-1).params,{threadId:'fixture-thread',server:'codex_apps',tool:'instantly_ai.create_lead',arguments:{campaign:'fixture-campaign',email:'fixture@example.invalid'}});
});
test('known starting runtime is polled within bounded readiness before one provider submission',async()=>{
 const f=protocol('starting');await f.run({sleep:async()=>{}});
 assert.equal(f.requests.filter(r=>r.method==='mcpServerStatus/list').length,2);assert.equal(f.requests.filter(r=>r.method==='mcpServer/tool/call').length,1);
});
test('production runtime schema absence, drift, auth requests and changed permits never submit the provider call',async()=>{
 for(const mode of ['missing','changed','metadata','approval','auth','permit']){
  const f=protocol(mode);if(mode==='missing')f.context.runtimeContracts.tools.shift();
  await assert.rejects(()=>f.run(mode==='permit'?{permit:c=>({...c,arguments:{...c.arguments,email:'different@example.invalid'}})}:{}));
  assert.equal(f.requests.filter(r=>r.method==='mcpServer/tool/call').length,0,mode);if(mode==='missing')assert.equal(f.launches(),0);
 }
});
test('selected runtime contract is captured before rejecting metadata drift',async()=>{
 const f=protocol('metadata'),seen=[];await assert.rejects(()=>f.run({captureContract:tool=>seen.push(structuredClone(tool))}),/CONTRACT_CHANGED/);
 assert.equal(seen.length,1);assert.equal(seen[0].description,'Changed provider contract');assert.equal(f.requests.filter(r=>r.method==='mcpServer/tool/call').length,0);
});
test('production runtime rejects expired approved schemas before process launch',async()=>{
 const f=protocol();f.context.runtimeContracts.expiresAt='2026-11-16T22:00:00Z';f.context.runtimeContracts.approvedAt='2026-11-16T21:59:00Z';
 await assert.rejects(()=>f.run(),/CONTRACT.*EXPIRED/);assert.equal(f.launches(),0);
});
test('production runtime response schema mismatch stays unresolved',async()=>{
 const f=protocol('malformed');await assert.rejects(()=>f.run(),/RESULT_SCHEMA/);assert.equal(f.requests.filter(r=>r.method==='mcpServer/tool/call').length,1);
});
test('contained result needs observed process cleanup and a matched worker result',()=>{
 const good={exit:{code:0},owner:{cleanupConfirmed:true,noPostCleanupRpcWrites:true,timedOut:false,error:null,cleanupCompletedAt:'2026-11-16T22:00:01Z',remainingMembers:[],processChecks:[{wait:0}]},worker:{status:'RESULT_RECEIVED',response:{content:[],structuredContent:{accepted:true}}}};
 assert.deepEqual(runtime.assessContainedHandoffResult(good),good.worker.response);
 for(const bad of [{...good,exit:{code:1}},{...good,owner:{...good.owner,cleanupConfirmed:false}},{...good,owner:{...good.owner,remainingMembers:[1]}},{...good,owner:{...good.owner,noPostCleanupRpcWrites:false}},{...good,worker:{status:'UNCERTAIN'}}])assert.throws(()=>runtime.assessContainedHandoffResult(bad),/UNCERTAIN/);
});
test('contained worker claims are one use and bound to persisted context and runtime source fingerprints',()=>{
 assert.equal(typeof runtime.claimHandoffWorker,'function');
 const db=openStore(':memory:'),project=fileURLToPath(new URL('../',import.meta.url)),directory=fileURLToPath(new URL('./',import.meta.url));
 const context={operationId:'fixture',requestCount:1,project,sources:runtime.snapshotHandoffRuntimeSources(project)};
 const put=()=>putRecord(db,'handoff_call','fixture:1',{status:'LAUNCHING',contextHash:digest(canonical(context)),directory});
 put();runtime.claimHandoffWorker(db,context,directory);assert.equal(getRecord(db,'handoff_call','fixture:1').workerStarted,true);
 assert.throws(()=>runtime.claimHandoffWorker(db,context,directory),/CONTEXT|CLAIM/);
 context.workflowBinding={taskId:'bound',taskHash:'fixture-hash',jobId:'task:bound'};put();assert.throws(()=>runtime.claimHandoffWorker(db,context,directory),/CONTEXT|CLAIM/);
 context.sources[0].sha256='0'.repeat(64);put();assert.throws(()=>runtime.claimHandoffWorker(db,context,directory),/SOURCE/);db.close();
});
}
