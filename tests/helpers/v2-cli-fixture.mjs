import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {copyFileSync,mkdirSync,mkdtempSync,readFileSync,readdirSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {dirname,join} from 'node:path';
import {openStore,putRecord,getRecord,controls,journal} from '../../src/store.mjs';
import {armAcceptance} from '../../src/acceptance-authority.mjs';
import {runAcceptanceInstantly,runInstantlyPhaseWorker} from '../../src/acceptance-instantly.mjs';
import {digest} from '../../src/values.mjs';
import {blockNetwork} from './network-block.mjs';

export const V2_ID='elya-instantly-qa-acceptance-v2';
export const V2_HASH='17aba6391533f3052ebc0e996ebcf52d1829a3b802131ca0b1c4a3665d4a7767';
export const BOUND_AT=Date.parse('2026-11-18T00:00:00.000Z');
export const eligibleRuntime=()=>({platform:'win32',stdinIsTTY:true,stdoutIsTTY:true,args:['--run-once'],agentContext:false,background:false});
const read=path=>JSON.parse(readFileSync(path,'utf8'));

// Only the process/transport and independent cleanup evidence are simulated.
// Entry, command, authority, controller, provider and worker code are production code.
export function v2CliFixture(t,options={}){
 const network=blockNetwork(t),db=openStore(':memory:');t.after(()=>db.close());t.after(()=>assert.equal(network.attempts,0,'fixture attempted external I/O or a native subprocess'));
 let time=BOUND_AT+2000;t.mock.method(Date,'now',()=>time);
 const root=mkdtempSync(join(tmpdir(),'elya-v2-cli-')),base=join(root,'work/instantly-qa-acceptance-v2');
 const manifestPath='work/instantly-qa-acceptance-v2/manifest.json',manifest=read(manifestPath);
 const paths=[manifestPath,manifest.contracts.baselineSource,'src/instantly-qa-v2-entry.mjs','src/instantly-qa-command.mjs','src/acceptance-authority.mjs','src/acceptance-controller.mjs','src/acceptance-instantly.mjs'];
 for(const path of paths){mkdirSync(dirname(join(root,path)),{recursive:true});copyFileSync(path,join(root,path));}
 const fingerprints=paths.map(path=>({path,sha256:digest(readFileSync(join(root,path)))}));
 const previous='elya-acceptance-continuation-v1',v1='elya-instantly-qa-acceptance-v1';
 putRecord(db,'acceptance_authorization',previous,{status:'CLOSED'});
 putRecord(db,'acceptance_result',previous,{authorizationStatus:'CLOSED',telegram:{status:'PASSED',cleanup:{confirmed:true},scenarios:{staleVersion:{status:'PASS'},requestChanges:{status:'PASS'}}}});
 putRecord(db,'acceptance_authorization',v1,{status:'CLOSED',reason:'OFFLINE_HISTORICAL_MARKER'});
 putRecord(db,'acceptance_instantly_call',v1+':instantly:call:4',{state:'UNCERTAIN',marker:'preserve historical evidence'});
 putRecord(db,'telegram_writing_cursor','primary',{nextOffset:64381648});
 putRecord(db,'telegram_consumer_owner','primary',{status:'RELEASED'});
 for(const id of ['one','two'])putRecord(db,'contact',id,{verification:'HELD_USER',email:`${id}@fixture.invalid`});
 for(let i=1;i<=6;i++)putRecord(db,'draft',`fixture-${i}`,{status:'UNAPPROVED',body:`Offline retained draft ${i}`});
 db.prepare('INSERT INTO budgets VALUES(?,?,?,?,?,?)').run('historical-budget','1','0',null,'offline fixture',0);
 db.prepare('INSERT INTO operations(id,kind,budget_id,intent_hash,intent_json,status,reservation_usd,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?)').run('historical-reservation','READ','historical-budget','fixture-intent','{}','PREPARED','0.15','2026-11-16T00:00:00Z','2026-11-16T00:00:00Z');
 journal(db,'HISTORICAL_MARKER',previous,{preserve:true});
 armAcceptance(db,manifest,fingerprints,BOUND_AT,{executionApproval:{type:'EXPLICIT_LIVE_EXECUTION_APPROVAL',manifestHash:V2_HASH,reference:'offline fixture',approvedAt:new Date(BOUND_AT).toISOString()}});
 const captured=read(join(root,manifest.contracts.baselineSource)).tools;
 const saved=read('work/synthetic-qa-created-record.json'),declarations=read('work/instantly-capability-inspection.json').schemas;
 const campaign=saved.latestReadOnlyConfirmation.liveReadback.campaign.structuredContent,lead=saved.readbacks.lead.value.structuredContent;
 const calls=[],contexts=[],methods=[],events=[],phaseOrder=[];
 const launch=async args=>{
  contexts.push(structuredClone(args.context));let current=structuredClone(lead),workerTime=args.context.launchStartedMs;
  const tools=structuredClone(captured);options.changeTools?.(tools,args.phase);
  const startProcess=()=>{
   const child=new EventEmitter();child.pid=321;child.stdout=new EventEmitter();child.stderr=new EventEmitter();child.stdin=new EventEmitter();
   child.stdin.write=(line,done)=>{
    const request=JSON.parse(line);methods.push({phase:args.phase,method:request.method});done?.();if(request.id===undefined)return;
    let result;
    if(request.method==='initialize')result={};
    else if(request.method==='thread/start')result={thread:{id:'v2-cli-fixture-'+args.phase}};
    else if(request.method==='mcpServerStatus/list')result={data:[{name:'codex_apps',authStatus:'bearerToken',runtimeStatus:'connected',tools:Object.fromEntries([...tools,{name:'unrelated.fixture_tool',description:'UNRELATED_PRIVATE_SENTINEL'}].map(tool=>[tool.name,tool])),unknownMetadata:'UNRELATED_PRIVATE_SENTINEL'}],nextCursor:null};
    else if(request.method==='mcpServer/tool/call'){
     const call=request.params;calls.push({phase:args.phase,...structuredClone(call)});let value;
     if(call.tool==='instantly_ai.get_campaign')value=structuredClone(campaign);
     else if(call.tool==='instantly_ai.get_lead')value=structuredClone(current);
     else if(call.tool==='instantly_ai.update_lead'){
      if(options.uncertainWrite){queueMicrotask(()=>child.stdout.emit('data',Buffer.from(JSON.stringify({id:request.id,error:{code:-1,message:'Bearer CLI_PRIVATE_SENTINEL'}})+'\n')));return;}
      current={...current,payload:{...current.payload,...call.arguments.custom_variables},timestamp_updated:'2026-11-18T00:00:02Z'};value={};
     }else throw Error('UNAPPROVED_FIXTURE_TOOL');
     options.mutate?.({value,call,phase:args.phase,calls});result={content:[],structuredContent:value,isError:false};
    }else throw Error('UNAPPROVED_FIXTURE_METHOD');
    queueMicrotask(()=>child.stdout.emit('data',Buffer.from(JSON.stringify({id:request.id,result})+'\n')));
   };return child;
  };
  const worker=await runInstantlyPhaseWorker({...args,db,manifest,savedDeclarations:declarations,startProcess,clock:()=>workerTime,wallClock:()=>workerTime,sleep:async ms=>{workerTime+=ms;}});
  return {worker,owner:{cleanupConfirmed:!options.badCleanup,noPostCleanupRpcWrites:true,remainingMembers:[],processChecks:[{pid:321,wait:0,exitCode:31027}],error:null,timedOut:false,cleanupCompletedAt:new Date(workerTime).toISOString()},exit:{code:0}};
 };
 const phaseRunner=async bound=>{
  if(bound.phase===2){const first=getRecord(db,'acceptance_instantly_phase',V2_ID+':instantly:1');assert.equal(first.status,'PASSED');assert.equal(first.result.cleanup.confirmed,true);phaseOrder.push('phase-1-cleaned');}
  phaseOrder.push(bound.phase);return runAcceptanceInstantly({...bound,fixtureLaunch:launch});
 };
 const stored=()=>({records:db.prepare('SELECT * FROM records ORDER BY kind,id').all(),history:db.prepare('SELECT * FROM record_history ORDER BY rowid').all(),journal:db.prepare('SELECT * FROM journal ORDER BY id').all()});
 const preserved=()=>({controls:controls(db),records:db.prepare('SELECT * FROM records WHERE id NOT LIKE ? ORDER BY kind,id').all(V2_ID+'%'),history:db.prepare('SELECT * FROM record_history WHERE id NOT LIKE ? ORDER BY rowid').all(V2_ID+'%'),journal:db.prepare('SELECT * FROM journal WHERE subject NOT LIKE ? ORDER BY id').all(V2_ID+'%'),tables:Object.fromEntries(['sources','batches','approvals','budgets','operations'].map(table=>[table,db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()]))});
 const attempts=()=>readdirSync(join(base,'attempts')).filter(name=>name.endsWith('.result.json')).map(name=>({name,value:read(join(base,'attempts',name))}));
 return {db,root,base,manifest,fingerprints,network,calls,contexts,methods,events,phaseOrder,stored,preserved,attempts,setTime:value=>{time=value;},args:{db,root,runtime:eligibleRuntime(),now:()=>time,startedAtMs:BOUND_AT+1000,startedMono:0,phaseRunner,emit:event=>events.push(event)}};
}

export function savedText(directory){
 return readdirSync(directory,{withFileTypes:true}).flatMap(entry=>entry.isDirectory()?savedText(join(directory,entry.name)):[readFileSync(join(directory,entry.name),'utf8')]).join('\n');
}
