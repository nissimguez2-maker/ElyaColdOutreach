import test from 'node:test';import assert from 'node:assert/strict';
import {readFileSync,writeFileSync,mkdtempSync,mkdirSync,readdirSync} from 'node:fs';import {tmpdir} from 'node:os';import {join} from 'node:path';
import {openStore,putRecord,getRecord,controls} from '../src/store.mjs';
import {armAcceptance,claimAcceptance,assertAcceptance,closeAcceptance,cancelAcceptance} from '../src/acceptance-authority.mjs';
import {checkInstantlyQaReadiness} from '../src/instantly-qa-readiness.mjs';
import {runInstantlyQaCommand} from '../src/instantly-qa-command.mjs';
import {validateInstantlyQaManifest} from '../src/instantly-qa-contract.mjs';
import {canonical,digest} from '../src/values.mjs';import {blockNetwork} from './helpers/network-block.mjs';

const id='elya-instantly-qa-acceptance-v2',hash='17aba6391533f3052ebc0e996ebcf52d1829a3b802131ca0b1c4a3665d4a7767';
const m=JSON.parse(readFileSync('work/instantly-qa-acceptance-v2/manifest.json','utf8'));
const bound=Date.parse('2026-11-18T00:00:00.000Z'),expires=bound+86400000;
function fixture(t,{arm=true}={}){
 blockNetwork(t);const db=openStore(':memory:');t.after(()=>db.close());const root=mkdtempSync(join(tmpdir(),'elya-v2-auth-')),base=join(root,'work/instantly-qa-acceptance-v2');mkdirSync(base,{recursive:true});
 writeFileSync(join(base,'manifest.json'),JSON.stringify(m));writeFileSync(join(base,'captured-contracts.json'),readFileSync(m.contracts.baselineSource));writeFileSync(join(root,'marker'),'tested');
 putRecord(db,'acceptance_authorization','elya-acceptance-continuation-v1',{status:'CLOSED'});
 putRecord(db,'acceptance_result','elya-acceptance-continuation-v1',{authorizationStatus:'CLOSED',telegram:{status:'PASSED',cleanup:{confirmed:true},scenarios:{staleVersion:{status:'PASS'},requestChanges:{status:'PASS'}}}});
 putRecord(db,'acceptance_authorization','elya-instantly-qa-acceptance-v1',{status:'CLOSED'});
 const sources=['marker','work/instantly-qa-acceptance-v2/manifest.json',m.contracts.baselineSource].map(path=>({path,sha256:digest(readFileSync(join(root,path)))}));
 const executionApproval={type:'EXPLICIT_LIVE_EXECUTION_APPROVAL',manifestHash:hash,reference:'offline-fixture-only',approvedAt:new Date(bound).toISOString()};
 if(arm)armAcceptance(db,m,sources,bound,{executionApproval});
 const entryCheck=()=>true,options={root,now:()=>bound+1000,entryCheck,invocationId:'offline-authorized-invocation'};
 return {db,root,base,sources,executionApproval,options,args:{db,root,authorizationId:id,now:()=>bound+1000,startedAtMs:bound+500,entryCheck,phaseRunner:async()=>({status:'PASSED',cleanup:{confirmed:true}})}};
}

test('v2 recognizes only the exact reviewed manifest',()=>{
 assert.equal(digest(canonical(m)),hash);validateInstantlyQaManifest(m);
 for(const mutate of [x=>x.calls.reverse(),x=>x.contracts.approvedContracts[0].contract.description+='x',x=>x.instantly.writeArguments.custom_variables.pilot_subject_1+='x',x=>x.limits.sessionTotalMs++,x=>x.authorizationPlan.validityWindowMs++]){const copy=structuredClone(m);mutate(copy);assert.throws(()=>validateInstantlyQaManifest(copy),/MANIFEST_MISMATCH/);}
});
test('offline implementation permission cannot bind a v2 execution grant',t=>{
 const f=fixture(t,{arm:false});assert.throws(()=>armAcceptance(f.db,m,f.sources,bound),/EXPLICIT_EXECUTION_APPROVAL_REQUIRED/);
 assert.equal(getRecord(f.db,'acceptance_authorization',id),null);
});
test('24h binding pins exact contracts, calls, write and tested sources without starting execution',t=>{
 const f=fixture(t),g=getRecord(f.db,'acceptance_authorization',id);
 assert.equal(g.boundAt,'2026-11-18T00:00:00.000Z');assert.equal(g.expiresAt,'2026-11-19T00:00:00.000Z');assert.equal(g.startedAt,null);assert.equal(g.deadlineAt,null);
 assert.equal(g.authorizationBinding.writeArgumentsHash,'dd98a5f4125280969439cfd923eb59a1874a18a8741fb974316757dbc3311a3f');
 assert.equal(g.authorizationBinding.callSequenceHash,'f31809608f49bf4afd3985715c640313cd11bdad1b30f18162846cd7dc28fcd9');
 assert.equal(g.authorizationBinding.contractBaselineSha256,'abfd1f3625c3ec4bcd11e630702aba3dc593a10448ca2afcc7814caa7d9c9451');
 assert.equal(g.authorizationBinding.sourceFingerprintsHash,digest(canonical(f.sources)));
});
for(const [label,time,reason]of [['expired',expires,'ACCEPTANCE_VALIDITY_EXPIRED'],['insufficient',expires-149999,'ACCEPTANCE_VALIDITY_INSUFFICIENT'],['clock-before-binding',bound-1,'ACCEPTANCE_VALIDITY_TIME_INVALID']])test(`${label}: readiness and atomic claim agree`,t=>{
 const f=fixture(t);assert.throws(()=>checkInstantlyQaReadiness({...f.args,now:()=>time}),e=>e.message===reason);
 assert.throws(()=>claimAcceptance(f.db,m,time,{...f.options,now:()=>time}),e=>e.message===reason);assert.equal(getRecord(f.db,'acceptance_authorization',id).status,'APPROVED');
});
test('exactly 150 seconds remaining is permitted; execution starts at operator process start',t=>{
 const f=fixture(t),at=expires-150000;
 const before=f.db.prepare('SELECT * FROM records').all();checkInstantlyQaReadiness({...f.args,now:()=>at});assert.deepEqual(f.db.prepare('SELECT * FROM records').all(),before);
 const g=claimAcceptance(f.db,m,at,{...f.options,now:()=>at});assert.equal(Date.parse(g.startedAt),at);assert.equal(Date.parse(g.deadlineAt),expires);
 assertAcceptance(f.db,m,expires-1);assert.throws(()=>assertAcceptance(f.db,m,expires),/DEADLINE|VALIDITY_EXPIRED/);
});
for(const mode of ['closed','claimed','manifest','binding','sources','validity'])test(`v2 denies ${mode} grants without replay`,t=>{
 const f=fixture(t),g=getRecord(f.db,'acceptance_authorization',id);
 if(mode==='closed'){claimAcceptance(f.db,m,bound+1000,f.options);closeAcceptance(f.db,{id,status:'BLOCKED',reason:'OFFLINE_FIXTURE',claimInvocationId:f.options.invocationId},bound+2000);}
 if(mode==='claimed')claimAcceptance(f.db,m,bound+1000,f.options);
 if(mode==='manifest')putRecord(f.db,'acceptance_authorization',id,{...g,manifestHash:'wrong'});
 if(mode==='binding')putRecord(f.db,'acceptance_authorization',id,{...g,authorizationBinding:{...g.authorizationBinding,writeArgumentsHash:'wrong'}});
 if(mode==='sources')writeFileSync(join(f.root,'marker'),'modified');
 if(mode==='validity')putRecord(f.db,'acceptance_authorization',id,{...g,expiresAt:'not-a-date'});
 assert.throws(()=>checkInstantlyQaReadiness(f.args));assert.throws(()=>claimAcceptance(f.db,m,bound+1000,f.options));
});
test('atomic claim rechecks entry, current time and sources after readiness',t=>{
 for(const mode of ['entry','time','source']){
  const f=fixture(t);checkInstantlyQaReadiness(f.args);let invoked=0;
  const options={...f.options,now:()=>mode==='time'?expires:bound+1000,entryCheck:()=>{invoked++;if(mode==='entry')throw Error('ENTRY_DENIED');return true;}};
  if(mode==='source')writeFileSync(join(f.root,'marker'),'changed');
  assert.throws(()=>claimAcceptance(f.db,m,bound+500,options));assert.equal(invoked,1);assert.equal(getRecord(f.db,'acceptance_authorization',id).status,'APPROVED');
 }
});
test('ineligible repeated invocations log separately without consuming or launching',async t=>{
 const f=fixture(t),before=f.db.prepare('SELECT * FROM records').all(),control=controls(f.db);let phases=0;
 for(let i=0;i<2;i++){
  const result=await runInstantlyQaCommand({...f.args,entryCheck:()=>{throw Error('NORMAL_USER_INTERACTIVE_POWERSHELL_REQUIRED');},phaseRunner:async()=>{phases++;}});
  assert.equal(result.reason,'NORMAL_USER_INTERACTIVE_POWERSHELL_REQUIRED');assert.equal(result.authorizationStatus,'APPROVED');assert.equal(result.attemptExternalActivity,'NOT_STARTED');
 }
 assert.equal(phases,0);assert.deepEqual(f.db.prepare('SELECT * FROM records').all(),before);assert.deepEqual(controls(f.db),control);
 assert.equal(readdirSync(join(f.base,'attempts')).filter(n=>n.endsWith('.result.json')).length,2);
});
test('entry revoked at atomic recheck is logged without consuming authorization',async t=>{
 const f=fixture(t);let checks=0,phases=0;
 const r=await runInstantlyQaCommand({...f.args,entryCheck:()=>{if(++checks>1)throw Error('OPERATOR_ENTRY_LOST');return true;},phaseRunner:async()=>{phases++;}});
 assert.equal(r.reason,'OPERATOR_ENTRY_LOST');assert.equal(r.authorizationStatus,'APPROVED');assert.equal(phases,0);assert.equal(checks,2);
});
test('eligible command can execute once in offline fixtures; repeat remains closed and logged',async t=>{
 const f=fixture(t),control=controls(f.db);let phases=0;
 const args={...f.args,phaseRunner:async()=>{phases++;return {status:'PASSED',cleanup:{confirmed:true}};}};
 const r=await runInstantlyQaCommand(args);assert.equal(r.status,'PASS');assert.equal(r.telegram.status,'NOT_APPLICABLE');assert.equal(phases,2);assert.equal(getRecord(f.db,'acceptance_authorization',id).status,'CLOSED');
 const repeat=await runInstantlyQaCommand(args);assert.equal(repeat.reason,'ACCEPTANCE_AUTHORIZATION_CLOSED');assert.equal(phases,2);assert.deepEqual(controls(f.db),control);
});

test('cancellation is restricted to the invocation that claimed v2',t=>{
 const f=fixture(t),g=claimAcceptance(f.db,m,bound+500,f.options);
 assert.equal(g.claimInvocationId,'offline-authorized-invocation');
 assert.throws(()=>cancelAcceptance(f.db,bound+1001,id,'other-invocation'),/CANCELLATION_NOT_OWNER/);
 assert.equal(getRecord(f.db,'acceptance_authorization',id).cancellationRequestedAt,null);
 assert.equal(cancelAcceptance(f.db,bound+1002,id,'offline-authorized-invocation'),true);
 assert.throws(()=>assertAcceptance(f.db,m,bound+1003),/CANCELLED/);
});
