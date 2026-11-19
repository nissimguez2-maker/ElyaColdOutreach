import test from 'node:test';import assert from 'node:assert/strict';import {mkdtempSync,writeFileSync,readFileSync} from 'node:fs';import {resolve,join} from 'node:path';import {spawnSync} from 'node:child_process';
test('diagnostic owner contains offline descendants on completion and timeout',{skip:process.platform!=='win32'},()=>{
 for(const timeout of [false,true]){
  const directory=mkdtempSync(resolve('work/connector-compatibility/owner-fixture-')),worker=join(directory,'worker.mjs');
  writeFileSync(join(directory,'context.json'),JSON.stringify({deadlineAt:new Date(Date.now()+(timeout?4000:12000)).toISOString()}));
  writeFileSync(worker,`import{spawn}from'node:child_process';import{appendFileSync,writeFileSync}from'node:fs';import{join}from'node:path';const d=process.argv[3];setInterval(()=>appendFileSync(join(d,'rpc.jsonl'),JSON.stringify({pid:process.pid})+'\\n'),50);if(process.argv[2]==='parent'){spawn(process.execPath,[import.meta.filename,'child',d],{windowsHide:true,stdio:'ignore'});${timeout?'':'setTimeout(()=>writeFileSync(join(d,\'worker-result.json\'),\'{}\'),700);'}}`);
  const result=spawnSync('C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',['-NoProfile','-NonInteractive','-File',resolve('work/connector-compatibility/owner.ps1'),'-Directory',directory,'-Node',process.execPath,'-Native',resolve('work/containment-proof/Job.cs'),'-Worker',worker],{windowsHide:true,encoding:'utf8',timeout:18000});
  assert.equal(result.status,0,result.stderr);const r=JSON.parse(readFileSync(join(directory,'owner-result.json'),'utf8').replace(/^\uFEFF/,''));assert.equal(r.cleanupConfirmed,true);assert.equal(r.timedOut,timeout);assert.equal(r.noPostCleanupRpcWrites,true);assert.ok(r.processChecks.length>=2);assert.ok(r.processChecks.every(p=>p.wait===0&&p.exitCode===31027));
  assert.ok(Date.parse(r.supervisorStartedAt)<Date.parse(r.cleanupStartedAt));assert.ok(Date.parse(r.cleanupStartedAt)<=Date.parse(r.terminationRequestedAt));assert.ok(Date.parse(r.terminationRequestedAt)<=Date.parse(r.cleanupCompletedAt));assert.equal(r.startedAt,undefined);
 }
});
