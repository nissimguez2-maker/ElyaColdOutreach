import test from 'node:test';import assert from 'node:assert/strict';
import {mkdtempSync,writeFileSync,readFileSync} from 'node:fs';import {join,resolve} from 'node:path';import {pathToFileURL} from 'node:url';import {spawnSync} from 'node:child_process';

test('contained readiness fixture workers are cleaned up after ready, cancellation, terminal error and timeout',{skip:process.platform!=='win32'},()=>{
 for(const mode of ['ready','cancel','error','deadline']){
  const directory=mkdtempSync(resolve('work/readiness/cleanup-')),worker=join(directory,'worker.mjs');
  writeFileSync(join(directory,'context.json'),JSON.stringify({deadlineAt:new Date(Date.now()+15000).toISOString()}));
  writeFileSync(worker,`import {waitForDiscoveryReady} from ${JSON.stringify(pathToFileURL(resolve('src/diagnostic-readiness.mjs')).href)};
import {spawn} from 'node:child_process';import {appendFileSync,writeFileSync} from 'node:fs';import {join} from 'node:path';
const directory=process.argv[3];setInterval(()=>appendFileSync(join(directory,'rpc.jsonl'),JSON.stringify({pid:process.pid})+'\\n'),40);
if(process.argv[2]==='parent'){
 spawn(process.execPath,[import.meta.filename,'child',directory],{stdio:'ignore',windowsHide:true});
 const controller=new AbortController();const mode=${JSON.stringify(mode)};let count=0,reason='READY';
 try{await waitForDiscoveryReady({call:{provider:'instantly',server:'codex_apps',tool:'instantly_ai.get_campaign'},
  read:async()=>{count++;return {data:[{name:'codex_apps',authStatus:'bearerToken',runtimeStatus:mode==='ready'&&count>1?'connected':mode==='error'?'failed':'starting',tools:{one:{name:'instantly_ai.get_campaign'}}}],nextCursor:null};},
  deadlineAt:new Date(Date.now()+(mode==='deadline'?250:6000)).toISOString(),signal:controller.signal,
  audit:e=>{if(mode==='cancel')controller.abort();appendFileSync(join(directory,'readiness.jsonl'),JSON.stringify(e)+'\\n');}});
 }catch(error){reason=error.message;}
 writeFileSync(join(directory,'worker-result.json'),JSON.stringify({reason,count}));
}`);
  const result=spawnSync('C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',['-NoProfile','-NonInteractive','-File',resolve('work/connector-compatibility/owner.ps1'),'-Directory',directory,'-Node',process.execPath,'-Native',resolve('work/containment-proof/Job.cs'),'-Worker',worker],{windowsHide:true,encoding:'utf8',timeout:20000});
  assert.equal(result.status,0,result.stderr);
  const outcome=JSON.parse(readFileSync(join(directory,'worker-result.json'),'utf8'));
  assert.equal(outcome.reason,{ready:'READY',cancel:'READINESS_CANCELLED',error:'DISCOVERY_RUNTIME_NOT_CONNECTED',deadline:'READINESS_DEADLINE'}[mode]);
  assert.equal(outcome.count,mode==='ready'?2:1);
  const owner=JSON.parse(readFileSync(join(directory,'owner-result.json'),'utf8').replace(/^\uFEFF/,''));
  assert.equal(owner.cleanupConfirmed,true);assert.deepEqual(owner.remainingMembers,[]);assert.equal(owner.noPostCleanupRpcWrites,true);
  assert.ok(owner.processChecks.length>=2);assert.ok(owner.processChecks.every(p=>p.wait===0&&p.exitCode===31027));
 }
});
