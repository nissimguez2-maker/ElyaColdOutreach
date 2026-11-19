import test from 'node:test';import assert from 'node:assert/strict';
import {readFileSync,mkdtempSync,mkdirSync,writeFileSync,existsSync,readdirSync} from 'node:fs';import {tmpdir} from 'node:os';import {join} from 'node:path';
import {openStore,putRecord,getRecord,controls} from '../src/store.mjs';
import {armAcceptance,claimAcceptance,closeAcceptance} from '../src/acceptance-authority.mjs';
import {digest} from '../src/values.mjs';import {INSTANTLY_QA_ID} from '../src/instantly-qa-contract.mjs';
import {blockNetwork} from './helpers/network-block.mjs';
const module=await import('../src/instantly-qa-command.mjs').catch(()=>null);
const readiness=await import('../src/instantly-qa-readiness.mjs').catch(()=>null);
const manifest=JSON.parse(readFileSync('work/instantly-qa-acceptance-v1/manifest.json','utf8'));
function fixture(t){
 blockNetwork(t);const db=openStore(':memory:');t.after(()=>db.close());const root=mkdtempSync(join(tmpdir(),'elya-qa-command-'));
 mkdirSync(join(root,'work/instantly-qa-acceptance-v1'),{recursive:true});writeFileSync(join(root,'marker'),'fixed');
 writeFileSync(join(root,'work/instantly-qa-acceptance-v1/manifest.json'),JSON.stringify(manifest));
 putRecord(db,'acceptance_authorization','elya-acceptance-continuation-v1',{status:'CLOSED'});
 putRecord(db,'acceptance_result','elya-acceptance-continuation-v1',{authorizationStatus:'CLOSED',telegram:{status:'PASSED',cleanup:{confirmed:true},scenarios:{staleVersion:{status:'PASS'},requestChanges:{status:'PASS'}}}});
 armAcceptance(db,manifest,[{path:'marker',sha256:digest('fixed')}],1000);
 const calls=[];return {db,root,calls,args:{db,root,startedAtMs:2000,now:()=>2000,emit:()=>{},phaseRunner:async({phase})=>{calls.push(phase);return {status:'PASSED',cleanup:{confirmed:true}};}}};
}
test('Instantly-only command boundary exists',()=>assert.ok(module?.runInstantlyQaCommand));
test('one command closes durably and saves the result; a repeated command never launches',async t=>{
 const f=fixture(t),before=controls(f.db);const r=await module.runInstantlyQaCommand(f.args);
 assert.equal(r.status,'PASS');assert.deepEqual(f.calls,[1,2]);assert.equal(r.telegram.status,'NOT_APPLICABLE');assert.equal(getRecord(f.db,'acceptance_authorization',INSTANTLY_QA_ID).status,'CLOSED');
 const path=join(f.root,'work/instantly-qa-acceptance-v1/live-once/result.json'),bytes=readFileSync(path,'utf8');assert.equal(JSON.parse(bytes).status,'PASS');
 const repeat=await module.runInstantlyQaCommand(f.args);assert.equal(repeat.status,'BLOCKED');assert.equal(repeat.reason,'ACCEPTANCE_AUTHORIZATION_CLOSED');assert.deepEqual(f.calls,[1,2]);assert.equal(readFileSync(path,'utf8'),bytes);assert.deepEqual(controls(f.db),before);
});
for(const mode of ['missing','malformed','changed','existing-directory','changed-source'])test(`command ${mode} stops and consumes fresh approval without a provider launch`,async t=>{
 const f=fixture(t);
 if(mode==='missing')f.args.manifestPath=join(f.root,'absent.json');
 if(mode==='malformed')writeFileSync(join(f.root,'work/instantly-qa-acceptance-v1/manifest.json'),'{');
 if(mode==='changed')writeFileSync(join(f.root,'work/instantly-qa-acceptance-v1/manifest.json'),JSON.stringify({...manifest,changed:true}));
 if(mode==='existing-directory')mkdirSync(join(f.root,'work/instantly-qa-acceptance-v1/live-once'));
 if(mode==='changed-source')writeFileSync(join(f.root,'marker'),'changed');
 const r=await module.runInstantlyQaCommand(f.args);assert.equal(r.status,'BLOCKED');assert.deepEqual(f.calls,[]);assert.equal(getRecord(f.db,'acceptance_authorization',INSTANTLY_QA_ID).status,'CLOSED');assert.ok(r.firstFailingStage);assert.equal(getRecord(f.db,'acceptance_authorization','elya-acceptance-continuation-v1').status,'CLOSED');
});
test('a concurrent command cannot close another command claimed authorization',async t=>{
 const f=fixture(t),g=getRecord(f.db,'acceptance_authorization',INSTANTLY_QA_ID);putRecord(f.db,'acceptance_authorization',INSTANTLY_QA_ID,{...g,status:'CLAIMED'});
 const r=await module.runInstantlyQaCommand(f.args);assert.equal(r.status,'BLOCKED');assert.equal(getRecord(f.db,'acceptance_authorization',INSTANTLY_QA_ID).status,'CLAIMED');assert.deepEqual(f.calls,[]);assert.equal(existsSync(join(f.root,'work/instantly-qa-acceptance-v1/live-once')),false);
});
test('normal-user entry preflight failure closes the fresh grant before manifest or provider work',async t=>{
 const f=fixture(t);f.args.entryCheck=()=>{throw Error('NORMAL_USER_INTERACTIVE_POWERSHELL_REQUIRED');};
 const r=await module.runInstantlyQaCommand(f.args);assert.equal(r.reason,'NORMAL_USER_INTERACTIVE_POWERSHELL_REQUIRED');assert.equal(r.authorizationStatus,'CLOSED');assert.deepEqual(f.calls,[]);assert.equal(existsSync(join(f.root,'work/instantly-qa-acceptance-v1/live-once')),false);
});

test('another claimant winning during preclaim error reporting is not closed or labeled zero-call CLOSED',async t=>{
 const f=fixture(t);let observations=0,entryFailed=false;f.args.entryCheck=()=>{entryFailed=true;throw Error('ENTRY_FAILED');};
 f.args.now=()=>{if(entryFailed&&++observations===3)claimAcceptance(f.db,manifest,2000);return 2000;};
 const r=await module.runInstantlyQaCommand(f.args);assert.equal(r.authorizationStatus,'CLAIMED');assert.equal(r.reason,'ACCEPTANCE_UNSTARTED_CLOSURE_LOST_OWNERSHIP');assert.equal(Object.hasOwn(r,'liveCalls'),false);assert.equal(getRecord(f.db,'acceptance_authorization',INSTANTLY_QA_ID).status,'CLAIMED');assert.equal(getRecord(f.db,'acceptance_result',INSTANTLY_QA_ID),null);assert.deepEqual(f.calls,[]);
});

test('readiness and CLI reject the saved CLOSED lifecycle, preserving two separate denied attempts',async t=>{
 const f=fixture(t),base=join(f.root,'work/instantly-qa-acceptance-v1');
 writeFileSync(join(base,'ready-to-run.json'),JSON.stringify({status:'READY_TO_RUN',authorizationStatus:'APPROVED'}));
 claimAcceptance(f.db,manifest,Date.parse('2026-11-17T16:41:13.836Z'));
 closeAcceptance(f.db,{id:INSTANTLY_QA_ID,status:'BLOCKED',reason:'INSTANTLY_PHASE_1_NOT_PASSED'},Date.parse('2026-11-17T16:41:25.535Z'));
 const old=getRecord(f.db,'acceptance_authorization',INSTANTLY_QA_ID),history=f.db.prepare('SELECT * FROM record_history').all(),oldResult=getRecord(f.db,'acceptance_result',INSTANTLY_QA_ID);
 assert.ok(readiness?.checkInstantlyQaReadiness,'shared read-only readiness required');
 assert.throws(()=>readiness.checkInstantlyQaReadiness(f.args),/ACCEPTANCE_AUTHORIZATION_CLOSED/);
 for(const at of ['2026-11-17T17:38:10.223Z','2026-11-17T17:50:38.365Z']){
  const r=await module.runInstantlyQaCommand({...f.args,now:()=>Date.parse(at)});
  assert.equal(r.reason,'ACCEPTANCE_AUTHORIZATION_CLOSED');assert.equal(r.attemptExternalActivity,'NOT_STARTED');
  assert.equal(r.authorizationState.closedAt,'2026-11-17T16:41:25.535Z');assert.equal(r.authorizationState.previousReason,'INSTANTLY_PHASE_1_NOT_PASSED');
 }
 const reports=readdirSync(join(base,'attempts')).filter(n=>n.endsWith('.result.json'));assert.equal(reports.length,2);
 assert.deepEqual(f.calls,[]);assert.deepEqual(getRecord(f.db,'acceptance_authorization',INSTANTLY_QA_ID),old);
 assert.deepEqual(getRecord(f.db,'acceptance_result',INSTANTLY_QA_ID),oldResult);assert.deepEqual(f.db.prepare('SELECT * FROM record_history').all(),history);
 assert.equal(JSON.parse(readFileSync(join(base,'ready-to-run.json'))).authorizationStatus,'APPROVED');
});

for(const mode of ['valid','missing','unknown','closed','claimed','cancelled','lifecycle','manifest','source','protected','directory'])test(`shared readiness/CLI agreement: ${mode}`,async t=>{
 const f=fixture(t),g=getRecord(f.db,'acceptance_authorization',INSTANTLY_QA_ID);
 const reasons={missing:'ACCEPTANCE_AUTHORIZATION_MISSING',unknown:'ACCEPTANCE_AUTHORIZATION_NOT_APPROVED',closed:'ACCEPTANCE_AUTHORIZATION_CLOSED',claimed:'ACCEPTANCE_AUTHORIZATION_CLAIMED',cancelled:'ACCEPTANCE_CANCELLED',lifecycle:'ACCEPTANCE_UNSTARTED_LIFECYCLE_INVALID',manifest:'ACCEPTANCE_MANIFEST_CHANGED',source:'ACCEPTANCE_SOURCE_CHANGED',protected:'ACCEPTANCE_PROTECTED_STATE_CHANGED',directory:'INSTANTLY_QA_DIRECTORY_EXISTS_NO_REPLAY'};
 if(mode==='missing')f.db.prepare('DELETE FROM records WHERE kind=? AND id=?').run('acceptance_authorization',INSTANTLY_QA_ID);
 if(mode==='unknown')putRecord(f.db,'acceptance_authorization',INSTANTLY_QA_ID,{...g,status:'UNKNOWN'});
 if(['closed','claimed','cancelled','lifecycle','manifest'].includes(mode))putRecord(f.db,'acceptance_authorization',INSTANTLY_QA_ID,{...g,...({closed:{status:'CLOSED'},claimed:{status:'CLAIMED'},cancelled:{cancellationRequestedAt:'2026-11-17T00:00:00Z'},lifecycle:{deadlineAt:'2026-11-17T00:00:00Z'},manifest:{manifestHash:'wrong'}}[mode])});
 if(mode==='source')writeFileSync(join(f.root,'marker'),'changed');
 if(mode==='protected')putRecord(f.db,'acceptance_authorization','elya-acceptance-continuation-v1',{status:'CHANGED'});
 if(mode==='directory')mkdirSync(join(f.root,'work/instantly-qa-acceptance-v1/live-once'));
 assert.ok(readiness?.checkInstantlyQaReadiness);
 const before=f.db.prepare('SELECT * FROM records').all();
 if(mode==='valid')assert.equal(readiness.checkInstantlyQaReadiness(f.args).authorizationState.status,'APPROVED');
 else assert.throws(()=>readiness.checkInstantlyQaReadiness(f.args),e=>e.message===reasons[mode]);
 assert.deepEqual(f.db.prepare('SELECT * FROM records').all(),before,'readiness must not claim or close');
 const r=await module.runInstantlyQaCommand(f.args);
 if(mode==='valid'){assert.equal(r.status,'PASS');assert.deepEqual(f.calls,[1,2]);}
 else {assert.equal(r.reason,reasons[mode]);assert.deepEqual(f.calls,[]);}
});

test('attempt evidence persistence failure prevents any provider phase',async t=>{
 const f=fixture(t);writeFileSync(join(f.root,'work/instantly-qa-acceptance-v1/attempts'),'file prevents directory');
 const r=await module.runInstantlyQaCommand(f.args);
 assert.equal(r.reason,'INSTANTLY_QA_ATTEMPT_EVIDENCE_PERSISTENCE_FAILED');assert.equal(r.authorizationStatus,'CLOSED');assert.deepEqual(f.calls,[]);
});

for(const evidenceBlocked of [false,true])test(`a misresolved file database is refused without consuming its grant, evidenceBlocked=${evidenceBlocked}`,async t=>{
 const f=fixture(t),other=openStore(join(f.root,'wrong.sqlite'));t.after(()=>other.close());
 if(evidenceBlocked)writeFileSync(join(f.root,'work/instantly-qa-acceptance-v1/attempts'),'file prevents directory');
 for(const row of f.db.prepare('SELECT * FROM records').all())putRecord(other,row.kind,row.id,JSON.parse(row.data_json),row.basis);
 const before=other.prepare('SELECT * FROM records').all();
 assert.throws(()=>readiness.checkInstantlyQaReadiness({...f.args,db:other}),/DATABASE_PATH_MISMATCH/);
 const r=await module.runInstantlyQaCommand({...f.args,db:other});
 assert.equal(r.reason,'INSTANTLY_QA_DATABASE_PATH_MISMATCH');assert.deepEqual(f.calls,[]);assert.deepEqual(other.prepare('SELECT * FROM records').all(),before);
});

test('a successful readiness observation cannot override an intervening claim',async t=>{
 const f=fixture(t);readiness.checkInstantlyQaReadiness(f.args);claimAcceptance(f.db,manifest,2000);
 const r=await module.runInstantlyQaCommand(f.args);
 assert.equal(r.reason,'ACCEPTANCE_AUTHORIZATION_CLAIMED');assert.deepEqual(f.calls,[]);assert.equal(getRecord(f.db,'acceptance_authorization',INSTANTLY_QA_ID).status,'CLAIMED');
});
