import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,readFileSync,writeFileSync,existsSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {spawn} from 'node:child_process';
import {pathToFileURL} from 'node:url';
import {setTimeout as sleep} from 'node:timers/promises';

async function start(t,mode){
 const directory=mkdtempSync(join(tmpdir(),'elya-file-handoff-'));
 const child=spawn(process.execPath,['--import',pathToFileURL(resolve('tests/helpers/deny-network-preload.mjs')).href,resolve('tests/helpers/pilot-host-child.mjs'),directory,mode],{stdio:['pipe','pipe','pipe'],windowsHide:true});
 let out='',err='';child.stdout.on('data',b=>out+=b);child.stderr.on('data',b=>err+=b);
 const exit=new Promise(r=>child.once('exit',(code,signal)=>r({code,signal})));
 t.after(()=>{if(child.exitCode===null)child.kill();child.stdin.destroy();});
 const deadline=Date.now()+5000;
 while(!existsSync(join(directory,'request-2.json.ready'))&&child.exitCode===null&&Date.now()<deadline)await sleep(10);
 assert.equal(existsSync(join(directory,'request-2.json.ready')),true,err+' '+(existsSync(join(directory,'child-result.json'))?readFileSync(join(directory,'child-result.json'),'utf8'):directory));
 return {directory,child,exit,output:()=>out};
}
test('file handoff preserves long Unicode payload without parsing terminal output and exits with stdin open',async t=>{
 const f=await start(t,'response');
 const request=JSON.parse(readFileSync(join(f.directory,'request-2.json'),'utf8'));
 assert.equal(request.call.arguments.custom_variables.pilot_body_1,'café & owner\'s\n'.repeat(2000));
 writeFileSync(join(f.directory,'response-2.json'),JSON.stringify({index:2,callHash:request.callHash,response:{content:[],isError:false}}));
 writeFileSync(join(f.directory,'response-2.json.ready'),'');
 const ended=await Promise.race([f.exit,sleep(5000).then(()=>null)]);
 assert.deepEqual(ended,{code:0,signal:null});
 assert.equal(f.output().includes('café'),false);
 assert.equal(JSON.parse(readFileSync(join(f.directory,'child-result.json'),'utf8')).isError,false);
});
test('aborted pending handoff clears its local wait and child exits without stdin EOF',async t=>{
 const f=await start(t,'abort');
 assert.deepEqual(await Promise.race([f.exit,sleep(5000).then(()=>null)]),{code:0,signal:null});
 assert.equal(JSON.parse(readFileSync(join(f.directory,'child-result.json'),'utf8')).reason,'LOCAL_HANDOFF_CLOSED');
});
test('mismatched response binding is rejected without publishing another request',async t=>{
 const f=await start(t,'response');
 writeFileSync(join(f.directory,'response-2.json'),JSON.stringify({index:2,callHash:'wrong',response:{content:[],isError:false}}));
 writeFileSync(join(f.directory,'response-2.json.ready'),'');
 assert.deepEqual(await Promise.race([f.exit,sleep(5000).then(()=>null)]),{code:0,signal:null});
 assert.equal(JSON.parse(readFileSync(join(f.directory,'child-result.json'),'utf8')).reason,'LOCAL_RESULT_BINDING_MISMATCH');
 assert.equal(existsSync(join(f.directory,'request-3.json')),false);
});

test('actual remaining-step host claims, validates four file-delivered results, closes and exits without stdin EOF',async t=>{
 const directory=mkdtempSync(join(tmpdir(),'elya-complete-handoff-'));
 const child=spawn(process.execPath,['--import',pathToFileURL(resolve('tests/helpers/deny-network-preload.mjs')).href,resolve('tests/helpers/pilot-resume-child.mjs'),directory],{stdio:['pipe','pipe','pipe'],windowsHide:true});
 let stderr='';child.stderr.on('data',b=>stderr+=b);child.stdout.resume();
 const exit=new Promise(r=>child.once('exit',(code,signal)=>r({code,signal})));
 t.after(()=>{if(child.exitCode===null)child.kill();child.stdin.destroy();});
 const run=join(directory,'run'),lead=JSON.parse(readFileSync('work/inactive-setup-authority-v1/live-once/response-1.json','utf8')).structuredContent;
 const campaign=JSON.parse(readFileSync('work/inactive-setup-authority-v1/live-once/response-3.json','utf8')).structuredContent;
 const expected=['instantly_ai.get_campaign','instantly_ai.get_lead','instantly_ai.update_lead','instantly_ai.get_lead'];
 for(let i=0;i<4;i++){
  const until=Date.now()+5000,path=join(run,`request-${i}.json`);
  while(!existsSync(path+'.ready')&&child.exitCode===null&&Date.now()<until)await sleep(10);
  assert.equal(existsSync(path+'.ready'),true,stderr);
  const request=JSON.parse(readFileSync(path,'utf8'));assert.equal(request.call.tool,expected[i]);
  if(i===2){assert.deepEqual(Object.keys(request.call.arguments.custom_variables).sort(),['pilot_body_1','pilot_subject_1']);Object.assign(lead.payload,request.call.arguments.custom_variables);}
  const value=i===0?campaign:lead,response=i===2?{content:[],isError:false}:{content:[{type:'text',text:JSON.stringify(value)}],structuredContent:value,isError:false};
  writeFileSync(join(run,`response-${i}.json`),JSON.stringify({index:i,callHash:request.callHash,response}));
  writeFileSync(join(run,`response-${i}.json.ready`),'');
 }
 assert.deepEqual(await Promise.race([exit,sleep(5000,undefined,{ref:false}).then(()=>null)]),{code:0,signal:null},stderr);
 const result=JSON.parse(readFileSync(join(directory,'child-result.json'),'utf8'));
 assert.equal(result.result.status,'PASS');assert.equal(result.result.authorizationStatus,'CLOSED');
 assert.deepEqual(result.result.counts,{reads:3,writes:1});assert.deepEqual(result.changedProtectedRecords,[]);
 assert.equal(result.result.finalControls.stopped,true);assert.equal(result.result.finalControls.launchAuthorized,false);
 assert.equal(existsSync(join(run,'request-4.json')),false);
});

test('host closes its fresh unclaimed authorization when the atomic claim rolls back',async t=>{
 const directory=mkdtempSync(join(tmpdir(),'elya-refused-handoff-'));
 const child=spawn(process.execPath,['--import',pathToFileURL(resolve('tests/helpers/deny-network-preload.mjs')).href,resolve('tests/helpers/pilot-resume-child.mjs'),directory,'claim-refusal'],{stdio:['pipe','pipe','pipe'],windowsHide:true});
 let err='';child.stderr.on('data',b=>err+=b);child.stdout.resume();
 t.after(()=>{if(child.exitCode===null)child.kill();child.stdin.destroy();});
 const exit=new Promise(r=>child.once('exit',(code,signal)=>r({code,signal})));
 assert.deepEqual(await Promise.race([exit,sleep(5000,undefined,{ref:false}).then(()=>null)]),{code:2,signal:null},err);
 const result=JSON.parse(readFileSync(join(directory,'child-result.json'),'utf8'));
 assert.equal(result.result.authorizationStatus,'CLOSED');assert.equal(result.result.notLaunched,true);
 assert.equal(result.result.counts.reads,0);assert.equal(result.result.counts.writes,0);
 assert.equal(existsSync(join(directory,'run','request-0.json')),false);
});
