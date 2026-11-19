import test from 'node:test';
import assert from 'node:assert/strict';
import {existsSync,readFileSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {getRecord} from '../src/store.mjs';
import {claimAcceptance} from '../src/acceptance-authority.mjs';
import {blockNetwork} from './helpers/network-block.mjs';
import {v2CliFixture,V2_ID,BOUND_AT,eligibleRuntime,savedText} from './helpers/v2-cli-fixture.mjs';

const loadEntry=()=>import('../src/instantly-qa-v2-entry.mjs').catch(()=>null);
const run=async args=>{const entry=await loadEntry();assert.equal(typeof entry?.runInstantlyQaV2Entry,'function','fixed CLI shared entry module is required');return entry.runInstantlyQaV2Entry(args);};
function assertUnclaimedClosure(f,result,reason,before){
 assert.equal(result.status,'BLOCKED');assert.equal(result.reason,reason);assert.equal(result.exitCode,2);assert.equal(result.authorizationStatus,'CLOSED');
 assert.equal(result.notLaunched,true);assert.equal(result.liveCalls,0);assert.equal(result.attemptExternalActivity,'NOT_STARTED');
 const grant=getRecord(f.db,'acceptance_authorization',V2_ID),old=JSON.parse(before.stored.records.find(row=>row.kind==='acceptance_authorization'&&row.id===V2_ID).data_json);
 assert.deepEqual(grant,{...old,status:'CLOSED',closedAt:new Date(f.args.now()).toISOString(),outcome:'BLOCKED',reason});assert.equal(grant.startedAt,null);assert.equal(grant.deadlineAt,null);
 const after=f.stored(),unaffected=rows=>rows.filter(row=>row.id!==V2_ID);
 assert.deepEqual(unaffected(after.records),unaffected(before.stored.records));assert.deepEqual(f.preserved(),before.preserved);
 assert.equal(after.records.length,before.stored.records.length+1);
 assert.deepEqual(after.history.slice(0,before.stored.history.length),before.stored.history);
 assert.deepEqual(after.history.slice(before.stored.history.length).map(row=>[row.kind,row.id]),[['acceptance_result',V2_ID],['acceptance_authorization',V2_ID]]);
 assert.deepEqual(after.journal.slice(0,before.stored.journal.length),before.stored.journal);
 assert.equal(after.journal.length,before.stored.journal.length+1);const closure=after.journal.at(-1);
 assert.equal(closure.event,'ACCEPTANCE_CLOSED');assert.equal(closure.subject,V2_ID);assert.deepEqual(JSON.parse(closure.details_json),{reason,status:'BLOCKED'});
 assert.equal(after.journal.filter(row=>row.subject===V2_ID&&row.event==='ACCEPTANCE_LAUNCHED_ONCE').length,0);
 assert.equal(getRecord(f.db,'acceptance_result',V2_ID).reason,reason);assert.equal(f.attempts().length,1);assert.deepEqual(f.calls,[]);assert.deepEqual(f.contexts,[]);assert.equal(f.network.attempts,0);
}

test('v2 CLI has an import-safe orchestration boundary',async t=>{
 const network=blockNetwork(t),entry=await loadEntry();assert.equal(typeof entry?.runInstantlyQaV2Entry,'function');assert.equal(network.attempts,0);
});

test('v2 CLI reaches both real worker phases, persists exact calls, and never replays a closed run',async t=>{
 const f=v2CliFixture(t),before=f.preserved(),result=await run(f.args);
 assert.equal(result.status,'PASS',JSON.stringify(result));assert.equal(result.exitCode,0);assert.deepEqual(f.phaseOrder,[1,'phase-1-cleaned',2]);
 assert.equal(result.telegram.status,'NOT_APPLICABLE');assert.equal(result.generalDispatchEnabled,false);
 assert.deepEqual(f.calls.map(({phase,threadId,...call})=>call),f.manifest.calls.map(({index,launch,...call})=>call));
 assert.deepEqual(f.calls.map(call=>call.phase),[1,1,2,2,2,2,2]);assert.equal(f.calls.filter(call=>call.tool==='instantly_ai.update_lead').length,1);
 const grant=getRecord(f.db,'acceptance_authorization',V2_ID);assert.equal(grant.status,'CLOSED');
 assert.equal(Date.parse(grant.startedAt),f.args.startedAtMs);assert.equal(Date.parse(grant.deadlineAt),f.args.startedAtMs+150000);
 assert.equal(result.startedAt,grant.startedAt);assert.equal(result.elapsedMs,1000);
 assert.ok(f.contexts.every(context=>context.readinessDeadlineMs-context.launchStartedMs===20000&&context.providerDeadlineMs-context.launchStartedMs===40000&&Date.parse(context.hardDeadlineAt)-context.launchStartedMs===60000));
 for(const phase of [1,2])assert.deepEqual(JSON.parse(readFileSync(join(f.base,'live-once',`instantly-phase-${phase}`,'selected-contracts.json'))).tools,f.manifest.contracts.approvedContracts.map(item=>item.contract));
 const path=join(f.base,'live-once/result.json'),saved=readFileSync(path,'utf8'),state=f.stored();
 assert.equal(JSON.parse(saved).status,'PASS');assert.equal(getRecord(f.db,'acceptance_result',V2_ID).status,'PASS');assert.deepEqual(f.preserved(),before);
 const denied=await run(f.args);assert.equal(denied.reason,'ACCEPTANCE_AUTHORIZATION_CLOSED');assert.equal(denied.exitCode,2);assert.equal(denied.attemptExternalActivity,'NOT_STARTED');
 assert.equal(f.calls.length,7);assert.equal(f.contexts.length,2);assert.equal(readFileSync(path,'utf8'),saved);assert.deepEqual(f.stored(),state);assert.deepEqual(f.preserved(),before);
 assert.equal(f.attempts().length,2);assert.notEqual(result.attemptId,denied.attemptId);assert.equal(f.network.attempts,0);
});

for(const args of [null,'--run-once',[],['--run-once','--run-once'],['--run-once','extra'],['--run-once '],['--run-once','--fixture'],['--run-once','--db','other.sqlite'],['--run-once','Bearer CLI_PRIVATE_SENTINEL']])test(`v2 CLI refuses exact-argument mismatch ${JSON.stringify(args)} without consumption`,async t=>{
 const f=v2CliFixture(t),before=f.stored();f.args.runtime.args=args;
 const result=await run(f.args);assert.equal(result.status,'BLOCKED');assert.equal(result.reason,'USE_RUN_ONCE_ARGUMENT_ONLY');assert.equal(result.exitCode,2);
 assert.equal(result.authorizationStatus,'APPROVED');assert.equal(result.attemptExternalActivity,'NOT_STARTED');assert.deepEqual(f.stored(),before);assert.equal(f.attempts().length,1);assert.deepEqual(f.calls,[]);assert.equal((JSON.stringify(result)+savedText(join(f.base,'attempts'))).includes('CLI_PRIVATE_SENTINEL'),false);assert.equal(f.network.attempts,0);
});

for(const [label,patch]of [['non-Windows',{platform:'linux'}],['stdin redirected',{stdinIsTTY:false}],['stdout redirected',{stdoutIsTTY:false}],['agent context',{agentContext:true}],['background',{background:true}],['missing tty facts',{stdinIsTTY:undefined}],['truthy tty string',{stdoutIsTTY:'true'}],['missing agent fact',{agentContext:undefined}],['missing background fact',{background:undefined}]])test(`v2 CLI refuses ${label} and logs each invocation without consuming`,async t=>{
 const f=v2CliFixture(t),before=f.stored();f.args.runtime={...eligibleRuntime(),...patch};
 for(let i=0;i<2;i++){const result=await run(f.args);assert.equal(result.status,'BLOCKED');assert.equal(result.exitCode,2);assert.equal(result.authorizationStatus,'APPROVED');assert.equal(result.attemptExternalActivity,'NOT_STARTED');}
 assert.deepEqual(f.stored(),before);assert.equal(f.attempts().length,2);assert.deepEqual(f.calls,[]);assert.deepEqual(f.contexts,[]);assert.equal(existsSync(join(f.base,'live-once')),false);assert.equal(f.network.attempts,0);
});

test('v2 CLI duplicate cannot close another invocation claim',async t=>{
 const f=v2CliFixture(t);claimAcceptance(f.db,f.manifest,f.args.startedAtMs,{root:f.root,now:f.args.now,entryCheck:()=>true,invocationId:'offline-existing-claim'});const before=f.stored();
 const result=await run(f.args);assert.equal(result.reason,'ACCEPTANCE_AUTHORIZATION_CLAIMED');assert.equal(result.exitCode,2);assert.equal(result.authorizationStatus,'CLAIMED');assert.deepEqual(f.stored(),before);assert.equal(f.attempts().length,1);assert.deepEqual(f.calls,[]);assert.equal(f.network.attempts,0);
});

test('v2 CLI rechecks operator eligibility at the atomic claim boundary',async t=>{
 const f=v2CliFixture(t),before=f.stored();let checks=0;
 f.args.runtime={...eligibleRuntime(),get stdinIsTTY(){return ++checks===1;}};
 const result=await run(f.args);assert.equal(result.status,'BLOCKED');assert.equal(result.exitCode,2);assert.equal(result.authorizationStatus,'APPROVED');assert.ok(checks>=2);
 assert.deepEqual(f.stored(),before);assert.deepEqual(f.calls,[]);assert.equal(f.attempts().length,1);assert.equal(f.network.attempts,0);
});

for(const [label,now,reason]of [['expired',BOUND_AT+86400000,'ACCEPTANCE_VALIDITY_EXPIRED'],['less than session',BOUND_AT+86400000-149999,'ACCEPTANCE_VALIDITY_INSUFFICIENT'],['before binding',BOUND_AT-1,'ACCEPTANCE_VALIDITY_TIME_INVALID']])test(`v2 CLI ${label} refusal is logged without a claim`,async t=>{
 const f=v2CliFixture(t);f.setTime(now);f.args.startedAtMs=now;const before={stored:f.stored(),preserved:f.preserved()};
 const result=await run(f.args);assertUnclaimedClosure(f,result,reason,before);
 const closed=f.stored(),repeat=await run(f.args);assert.equal(repeat.reason,'ACCEPTANCE_AUTHORIZATION_CLOSED');assert.deepEqual(f.stored(),closed);assert.equal(f.attempts().length,2);assert.deepEqual(f.calls,[]);
});

test('v2 CLI starts at the supplied operator process time and admits exactly one full validity window',async t=>{
 const f=v2CliFixture(t),start=BOUND_AT+86400000-150000;f.setTime(start);f.args.startedAtMs=start;
 const result=await run(f.args);assert.equal(result.status,'PASS');assert.equal(result.exitCode,0);
 const grant=getRecord(f.db,'acceptance_authorization',V2_ID);assert.equal(Date.parse(grant.startedAt),start);assert.equal(Date.parse(grant.deadlineAt),BOUND_AT+86400000);assert.equal(f.calls.length,7);assert.equal(f.network.attempts,0);
});

for(const [label,startOffset,nowOffset]of [['before binding',-1,2000],['future start',2001,2000],['session already elapsed',0,150000]])test(`v2 CLI rejects ${label} before claim`,async t=>{
 const f=v2CliFixture(t),before={stored:f.stored(),preserved:f.preserved()};f.args.startedAtMs=BOUND_AT+startOffset;f.setTime(BOUND_AT+nowOffset);
 const result=await run(f.args);assertUnclaimedClosure(f,result,'OPERATOR_EXECUTION_TIME_INVALID',before);
});

test('v2 CLI source drift closes without a claim or changes to preserved state',async t=>{
 const f=v2CliFixture(t),before={stored:f.stored(),preserved:f.preserved()};writeFileSync(join(f.root,'src/acceptance-controller.mjs'),'changed offline fixture');
 const result=await run(f.args);assertUnclaimedClosure(f,result,'ACCEPTANCE_SOURCE_CHANGED',before);
});

test('v2 CLI saves sanitized failure evidence and closes a claimed run after provider failure',async t=>{
 const f=v2CliFixture(t,{uncertainWrite:true}),before=f.preserved();const result=await run(f.args);
 assert.equal(result.status,'BLOCKED');assert.equal(result.exitCode,2);assert.equal(result.reason,'INSTANTLY_PHASE_2_NOT_PASSED');assert.equal(result.instantly[1].status,'UNCERTAIN');
 assert.equal(f.calls.length,5);assert.equal(f.calls.filter(call=>call.tool==='instantly_ai.update_lead').length,1);assert.equal(getRecord(f.db,'acceptance_authorization',V2_ID).status,'CLOSED');
 assert.equal(getRecord(f.db,'acceptance_instantly_call',V2_ID+':instantly:call:4').state,'UNCERTAIN');assert.deepEqual(f.preserved(),before);
 const text=JSON.stringify({result,events:f.events,state:f.stored()})+savedText(join(f.base,'live-once'))+savedText(join(f.base,'attempts'));
 assert.equal(text.includes('CLI_PRIVATE_SENTINEL'),false);assert.equal(text.includes('UNRELATED_PRIVATE_SENTINEL'),false);
 const repeat=await run(f.args);assert.equal(repeat.reason,'ACCEPTANCE_AUTHORIZATION_CLOSED');assert.equal(f.calls.length,5);assert.equal(f.network.attempts,0);
});

test('v2 CLI cleanup failure closes the grant and prevents phase two',async t=>{
 const f=v2CliFixture(t,{badCleanup:true}),result=await run(f.args);
 assert.equal(result.status,'BLOCKED');assert.equal(result.exitCode,2);assert.equal(result.instantly[0].reason,'INSTANTLY_CLEANUP_UNCONFIRMED');assert.equal(result.instantly[0].cleanup.confirmed,false);
 assert.deepEqual(f.phaseOrder,[1]);assert.equal(f.calls.length,2);assert.equal(getRecord(f.db,'acceptance_authorization',V2_ID).status,'CLOSED');assert.equal(f.network.attempts,0);
});

test('v2 CLI output delay cannot consume the contained launch reserve',async t=>{
 const f=v2CliFixture(t);f.args.emit=event=>{f.events.push(event);if(typeof event==='string')f.setTime(f.args.startedAtMs+80001);};
 const result=await run(f.args);assert.equal(result.status,'BLOCKED');assert.equal(result.exitCode,2);assert.equal(result.instantly[0].reason,'INSUFFICIENT_SESSION_TIME_FOR_CONTAINED_LAUNCH');assert.equal(result.instantly[0].notLaunched,true);
 assert.equal(getRecord(f.db,'acceptance_authorization',V2_ID).status,'CLOSED');assert.deepEqual(f.contexts,[]);assert.deepEqual(f.calls,[]);assert.equal(f.network.attempts,0);
});

test('v2 CLI catches a raw phase exception without retaining secret-bearing error text',async t=>{
 const f=v2CliFixture(t);f.args.phaseRunner=async()=>{throw Error('Bearer CLI_PRIVATE_SENTINEL');};
 const result=await run(f.args);assert.equal(result.status,'BLOCKED');assert.equal(result.exitCode,2);assert.equal(result.reason,'LOCAL_EXECUTION_ERROR_REQUIRES_SAVED_EVIDENCE');assert.equal(result.authorizationStatus,'CLOSED');
 assert.equal((JSON.stringify(result)+savedText(f.base)).includes('CLI_PRIVATE_SENTINEL'),false);assert.deepEqual(f.calls,[]);assert.equal(f.network.attempts,0);
});

test('v2 CLI evidence persistence failure cannot start or consume a fresh grant',async t=>{
 const f=v2CliFixture(t),before=f.stored();writeFileSync(join(f.base,'attempts'),'offline evidence obstruction');
 const result=await run(f.args);assert.equal(result.exitCode,2);assert.equal(result.reason,'INSTANTLY_QA_ATTEMPT_EVIDENCE_PERSISTENCE_FAILED');assert.equal(result.authorizationStatus,'APPROVED');assert.deepEqual(f.stored(),before);assert.deepEqual(f.calls,[]);assert.equal(f.network.attempts,0);
});

for(const [label,steps]of [['string','abc'],['array-like object',{length:3}],['malformed members',[null,{},{}]]])test(`v2 CLI blocks malformed sequence steps (${label}) before any write`,async t=>{
 const f=v2CliFixture(t,{mutate:({value,call})=>{if(call.tool==='instantly_ai.get_campaign')value.sequences[0].steps=structuredClone(steps);}}),before=f.preserved();
 const result=await run(f.args);
 assert.equal(result.status,'BLOCKED');assert.equal(result.exitCode,2);assert.equal(result.instantly[0].reason,'INSTANTLY_QA_SEQUENCE_GUARD_FAILED');
 assert.deepEqual(f.phaseOrder,[1]);assert.equal(f.calls.length,1);assert.equal(f.calls.filter(call=>call.tool==='instantly_ai.update_lead').length,0);
 assert.equal(getRecord(f.db,'acceptance_authorization',V2_ID).status,'CLOSED');assert.deepEqual(f.preserved(),before);assert.equal(f.network.attempts,0);
});

for(const failure of ['persistence','emit'])test(`v2 CLI retains completed write evidence after final phase result ${failure} failure`,async t=>{
 let f,emitFailures=0;
 const collision='{"offlineCollision":"preserve existing phase evidence"}';
 f=v2CliFixture(t,{mutate:({call,phase})=>{
  if(failure==='persistence'&&phase===2&&call.tool==='instantly_ai.update_lead')writeFileSync(join(f.base,'live-once/instantly-phase-2/phase-result.json'),collision,{flag:'wx'});
 }});
 if(failure==='emit')f.args.emit=event=>{
  f.events.push(event);if(event?.event==='INSTANTLY_PHASE_CLOSED'&&event.phase===2){emitFailures++;throw Error('Bearer FINAL_EMIT_PRIVATE_SENTINEL');}
 };
 const before=f.preserved(),result=await run(f.args),phase=result.instantly[1];
 const reason=failure==='persistence'?'INSTANTLY_PHASE_RESULT_PERSISTENCE_FAILED':'INSTANTLY_PHASE_RESULT_EMIT_FAILED';
 assert.equal(result.status,'BLOCKED');assert.equal(result.exitCode,2);assert.equal(result.reason,'INSTANTLY_PHASE_2_NOT_PASSED');
 assert.equal(phase.reason,reason);assert.equal(phase.status,'FAILED');assert.equal(phase.writeAttempted,true);assert.equal(phase.requestCounts.business,5);assert.equal(phase.cleanup.confirmed,true);
 assert.deepEqual(phase.providerOutcome,{status:'PASSED',reason:'INSTANTLY_QA_MERGE_AND_READBACK_VALIDATED'});
 assert.equal(f.calls.length,7);assert.equal(f.calls.filter(call=>call.tool==='instantly_ai.update_lead').length,1);
 assert.equal(getRecord(f.db,'acceptance_instantly_call',V2_ID+':instantly:call:4').state,'RESULT_ACCEPTED');
 assert.equal(getRecord(f.db,'acceptance_authorization',V2_ID).status,'CLOSED');assert.deepEqual(f.preserved(),before);
 const durable=getRecord(f.db,'acceptance_result',V2_ID),saved=JSON.parse(readFileSync(join(f.base,'live-once/result.json'),'utf8'));
 for(const evidence of [durable,saved]){assert.equal(evidence.status,'BLOCKED');assert.equal(evidence.instantly[1].reason,reason);assert.equal(evidence.instantly[1].writeAttempted,true);assert.equal(evidence.instantly[1].requestCounts.business,5);assert.equal(evidence.instantly[1].cleanup.confirmed,true);}
 if(failure==='persistence')assert.equal(readFileSync(join(f.base,'live-once/instantly-phase-2/phase-result.json'),'utf8'),collision);
 else assert.equal(emitFailures,1);
 assert.equal((JSON.stringify({result,state:f.stored()})+savedText(f.base)).includes('FINAL_EMIT_PRIVATE_SENTINEL'),false);
 const repeat=await run(f.args);assert.equal(repeat.reason,'ACCEPTANCE_AUTHORIZATION_CLOSED');assert.equal(f.calls.length,7);assert.equal(f.network.attempts,0);
});
