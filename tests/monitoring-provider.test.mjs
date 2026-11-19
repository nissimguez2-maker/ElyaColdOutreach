import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {openStore,putRecord,getRecord,setStopped} from '../src/store.mjs';
import {createBudget,budgetStatus} from '../src/operations.mjs';
import {digest,canonical} from '../src/values.mjs';
import * as provider from '../src/monitoring-provider.mjs';
import {fixtureReplyContract,decodeFixtureReplyPage,fixtureReplyPayload} from './fixtures/monitoring-provider-fixture.mjs';
const at='2026-11-16T17:01:00Z',expiresAt='2026-11-16T18:00:00Z';
function fixture(t,{reservationUsd='0',limit='1',maxPages=3,baseDirectory=tmpdir()}={}){
 const dir=mkdtempSync(join(baseDirectory,'elya-poll-')),path=join(dir,'state.sqlite');let db=openStore(path);
 t.after(()=>{db.close();rmSync(dir,{recursive:true,force:true});});setStopped(db,false,'temporary offline fixture');createBudget(db,'fixture',limit,'0','0');
 putRecord(db,'campaign','fixture-campaign',{synthetic:true});putRecord(db,'candidate','fixture-candidate',{synthetic:true});
 putRecord(db,'contact','qa@example.invalid',{candidateId:'fixture-candidate'});
 putRecord(db,'telegram_binding','primary',{confirmed:true,testOnly:true,userId:42,chatId:42,botId:777});
 putRecord(db,'provider_lead_mapping',digest(canonical({provider:'instantly',campaignId:'fixture-campaign',leadId:'fixture-lead'})),{provider:'instantly',campaignId:'fixture-campaign',leadId:'fixture-lead',candidateId:'fixture-candidate',email:'qa@example.invalid',evidenceRef:'fixture:imported'});
 const decoder=provider.createProviderReplyDecoder({contract:fixtureReplyContract,decodePage:decodeFixtureReplyPage});
 const grant={id:'fixture-poll-grant',status:'APPROVED',enabled:true,streamId:'fixture-stream',campaignId:'fixture-campaign',contractHash:decoder.contractHash,budgetId:'fixture',reservationUsd,approvedAt:'2026-11-16T17:00:00Z',expiresAt,maxPages,pageSize:10,timeoutMs:1000,transportMode:'offline',evidenceRef:'fixture:explicit-scoped-poll-authority'};
 putRecord(db,'monitor_poll_authorization',grant.id,grant,'configuration');
 const options={runId:'fixture-run',streamId:'fixture-stream',campaignId:'fixture-campaign',decoder,authorizationId:grant.id,enabled:true,maxPages:3,pageSize:10,timeoutMs:1000,clock:()=>at};
 return {get db(){return db;},decoder,grant,options,reopen(){db.close();db=openStore(path);}};
}
const transport=(payload=fixtureReplyPayload(),extra={})=>({mode:'offline',async fetchPage(){return {payload,evidenceRef:'fixture:provider-page',actualUsd:'0'};},...extra});
test('missing provider contract and disabled polling make no external call or reservation',async t=>{
 const f=fixture(t);let calls=0;const tx=transport(undefined,{fetchPage:async()=>{calls++;throw Error();}});
 await assert.rejects(provider.pollProviderReplies(f.db,{...f.options,enabled:false,transport:tx}),/DISABLED/);
 await assert.rejects(provider.pollProviderReplies(f.db,{...f.options,decoder:null,transport:tx}),/CONTRACT_REQUIRED/);
 assert.equal(calls,0);assert.equal(f.db.prepare('SELECT count(*) n FROM operations').get().n,0);
});
test('bounded synthetic decoder polling persists reply, outbox, checkpoint, cost and duplicate protection through restart',async t=>{
 const f=fixture(t);let calls=0;
 const tx=transport(undefined,{async fetchPage(request){calls++;assert.equal(request.campaignId,'fixture-campaign');assert.equal(request.cursor,null);assert.equal(request.pageSize,10);return {payload:fixtureReplyPayload(),evidenceRef:'fixture:page-1',actualUsd:'0'};}});
 const r=await provider.pollProviderReplies(f.db,{...f.options,transport:tx});assert.equal(r.status,'COMPLETE');assert.equal(r.pages,1);
 assert.equal(getRecord(f.db,'monitor_checkpoint','fixture-stream').complete,true);assert.equal(f.db.prepare("SELECT count(*) n FROM records WHERE kind='reply_notification'").get().n,1);
 f.reopen();assert.equal((await provider.pollProviderReplies(f.db,{...f.options,transport:tx})).status,'COMPLETE');assert.equal(calls,1);
 assert.equal(budgetStatus(f.db,'fixture').actual,'0');assert.equal(getRecord(f.db,'monitor_poll_page','fixture-run:1').status,'APPLIED');
});
test('synthetic contract cannot be used with an operational transport',async t=>{
 const f=fixture(t);await assert.rejects(provider.pollProviderReplies(f.db,{...f.options,transport:transport(undefined,{mode:'authorized-provider'})}),/SYNTHETIC|TRANSPORT/);
 assert.equal(f.db.prepare('SELECT count(*) n FROM operations').get().n,0);
});
test('exact scoped authorization, stopped state and budget prevent polling before dispatch',async t=>{
 const f=fixture(t,{reservationUsd:'2'});let calls=0;const tx=transport(undefined,{fetchPage:async()=>{calls++;throw Error();}});
 await assert.rejects(provider.pollProviderReplies(f.db,{...f.options,streamId:'wrong',transport:tx}),/SCOPE/);
 setStopped(f.db,true,'fixture stop');await assert.rejects(provider.pollProviderReplies(f.db,{...f.options,transport:tx}),/STOPPED/);setStopped(f.db,false,'fixture restart');
 await assert.rejects(provider.pollProviderReplies(f.db,{...f.options,transport:tx}),/Budget/);assert.equal(calls,0);
});
test('per-invocation and durable grant page limits bound pagination across new runs',async t=>{
 const f=fixture(t,{maxPages:2});let calls=0;
 const tx=transport(undefined,{async fetchPage({cursor}){calls++;return {payload:fixtureReplyPayload(cursor===null?'cursor-1':'cursor-2'),evidenceRef:`fixture:page-${calls}`,actualUsd:'0'};}});
 assert.equal((await provider.pollProviderReplies(f.db,{...f.options,maxPages:1,transport:tx})).status,'PAUSED');
 assert.equal((await provider.pollProviderReplies(f.db,{...f.options,runId:'fixture-run-2',maxPages:1,transport:tx})).status,'PAUSED');
 await assert.rejects(provider.pollProviderReplies(f.db,{...f.options,runId:'fixture-run-3',maxPages:1,transport:tx}),/PAGE_LIMIT/);assert.equal(calls,2);
 assert.equal(f.db.prepare("SELECT count(*) n FROM records WHERE kind='provider_event'").get().n,1);
});
test('invalid or cross-campaign decoded data never advances the checkpoint',async t=>{
 const f=fixture(t),payload=fixtureReplyPayload();payload.fixtureReplies[0].fixtureCampaign='other-campaign';
 await assert.rejects(provider.pollProviderReplies(f.db,{...f.options,transport:transport(payload)}),/CAMPAIGN/);
 assert.equal(getRecord(f.db,'monitor_checkpoint','fixture-stream'),null);assert.equal(getRecord(f.db,'monitor_health','fixture-stream').state,'FAILED');
 assert.equal(f.db.prepare("SELECT status FROM operations").get().status,'SUCCEEDED');
});
test('stop after response preserves the received page for local resume without repeating provider I/O',async t=>{
 const f=fixture(t);let calls=0;const tx=transport(undefined,{async fetchPage(){calls++;setStopped(f.db,true,'fixture stop during read');return {payload:fixtureReplyPayload(),evidenceRef:'fixture:received-before-stop',actualUsd:'0'};}});
 assert.equal((await provider.pollProviderReplies(f.db,{...f.options,transport:tx})).status,'PAUSED');assert.equal(getRecord(f.db,'monitor_checkpoint','fixture-stream'),null);
 f.reopen();setStopped(f.db,false,'fixture explicit restart');assert.equal((await provider.pollProviderReplies(f.db,{...f.options,transport:tx})).status,'COMPLETE');assert.equal(calls,1);
});
test('uncertain provider read survives restart without automatic retry or cursor consumption',async t=>{
 const f=fixture(t);let calls=0;const tx=transport(undefined,{async fetchPage(){calls++;throw Error('fixture uncertain');}});
 assert.equal((await provider.pollProviderReplies(f.db,{...f.options,transport:tx})).status,'RECONCILIATION');f.reopen();
 await assert.rejects(provider.pollProviderReplies(f.db,{...f.options,transport:tx}),/RECONCILIATION/);assert.equal(calls,1);assert.equal(getRecord(f.db,'monitor_checkpoint','fixture-stream'),null);
});
test('fixture evidence cannot be relabeled as an approved production contract',()=>{
 assert.throws(()=>provider.createProviderReplyDecoder({contract:{...fixtureReplyContract,basis:'APPROVED_SAVED_EVIDENCE'},decodePage:decodeFixtureReplyPage}),/SYNTHETIC/);
});
test('poll recovery persists interrupted read reconciliation and never releases its reservation',async t=>{
 const f=fixture(t,{reservationUsd:'0.25'});
 f.db.exec("CREATE TEMP TRIGGER fail_read_outcome BEFORE UPDATE ON operations WHEN NEW.status='SUCCEEDED' BEGIN SELECT RAISE(ABORT,'fixture read outcome failure'); END;");
 await assert.rejects(provider.pollProviderReplies(f.db,{...f.options,transport:transport()}),/fixture read outcome failure/);
 assert.equal(getRecord(f.db,'monitor_poll_run','fixture-run').status,'RUNNING');f.reopen();
 assert.equal(provider.recoverProviderReplyPolling(f.db,at)[0].status,'RECONCILIATION');assert.equal(budgetStatus(f.db,'fixture').reserved,'0.25');
 assert.equal(getRecord(f.db,'monitor_checkpoint','fixture-stream'),null);
});
test('bounded timeout records uncertain read instead of hanging or silently retrying',async t=>{
 const f=fixture(t),tx=transport(undefined,{fetchPage:()=>new Promise(()=>{})});
 const result=await provider.pollProviderReplies(f.db,{...f.options,timeoutMs:1,transport:tx});assert.equal(result.status,'RECONCILIATION');
 assert.equal(f.db.prepare('SELECT status FROM operations').get().status,'RECONCILIATION');
});
test('outer job cancellation aborts the provider request and cannot consume a late response',async t=>{
 const f=fixture(t),controller=new AbortController();let requestSignal;
 const tx=transport(undefined,{fetchPage(request){requestSignal=request.signal;controller.abort();return new Promise(resolve=>setTimeout(()=>resolve({payload:fixtureReplyPayload(),evidenceRef:'fixture:late',actualUsd:'0'}),5));}});
 assert.equal((await provider.pollProviderReplies(f.db,{...f.options,transport:tx,signal:controller.signal})).status,'RECONCILIATION');
 assert.equal(requestSignal.aborted,true);await new Promise(resolve=>setTimeout(resolve,10));assert.equal(getRecord(f.db,'monitor_checkpoint','fixture-stream'),null);
});
test('explicit read reconciliation closes an uncertain run without inventing its missing reply page',async t=>{
 const f=fixture(t,{reservationUsd:'0.25'}),tx=transport(undefined,{async fetchPage(){throw Error('fixture unknown');}});
 await provider.pollProviderReplies(f.db,{...f.options,transport:tx});
 const closed=provider.reconcileProviderReplyPolling(f.db,'fixture-run',{status:'READ_CONFIRMED',actualUsd:'0.1',evidenceRef:'fixture:manual-provider-cost-confirmation'},at);
 assert.equal(closed.status,'CLOSED');assert.equal(budgetStatus(f.db,'fixture').actual,'0.1');assert.equal(budgetStatus(f.db,'fixture').reserved,'0');assert.equal(getRecord(f.db,'monitor_checkpoint','fixture-stream'),null);
 await assert.rejects(provider.pollProviderReplies(f.db,{...f.options,transport:tx}),/NEW_RUN_REQUIRED/);
});
test('runtime dispatch revocation after a read blocks cursor commit and resumes its stored page without a second read',async t=>{
 const f=fixture(t);let enabled=true,calls=0;const options={...f.options,assertDispatch(){if(!enabled)throw Error('FIXTURE_RUNTIME_DISPATCH_DISABLED');}};
 const tx=transport(undefined,{async fetchPage(){calls++;enabled=false;return {payload:fixtureReplyPayload(),evidenceRef:'fixture:policy-changed',actualUsd:'0'};}});
 await assert.rejects(provider.pollProviderReplies(f.db,{...options,transport:tx}),/RUNTIME_DISPATCH_DISABLED/);assert.equal(getRecord(f.db,'monitor_checkpoint','fixture-stream'),null);
 enabled=true;assert.equal((await provider.pollProviderReplies(f.db,{...options,transport:tx})).status,'COMPLETE');assert.equal(calls,1);
});
test('crash after settled read but before durable page closes the old run and preserves cost without inventing a cursor',async t=>{
 const f=fixture(t,{reservationUsd:'0.25'});
 f.db.exec("CREATE TEMP TRIGGER fail_page_insert BEFORE INSERT ON records WHEN NEW.kind='monitor_poll_page' BEGIN SELECT RAISE(ABORT,'fixture page storage failure'); END; CREATE TEMP TRIGGER fail_run_failure BEFORE INSERT ON records WHEN NEW.kind='monitor_poll_run' AND json_extract(NEW.data_json,'$.status')='FAILED' BEGIN SELECT RAISE(ABORT,'fixture interruption before failure state'); END;");
 const tx=transport(undefined,{async fetchPage(){return {payload:fixtureReplyPayload(),evidenceRef:'fixture:completed-paid-read',actualUsd:'0.1'};}});
 await assert.rejects(provider.pollProviderReplies(f.db,{...f.options,transport:tx}),/fixture interruption/);
 assert.equal(getRecord(f.db,'monitor_poll_run','fixture-run').status,'RUNNING');assert.equal(f.db.prepare('SELECT status FROM operations').get().status,'SUCCEEDED');assert.equal(getRecord(f.db,'monitor_poll_page','fixture-run:1'),null);
 f.reopen();const recovered=provider.recoverProviderReplyPolling(f.db,at)[0];assert.equal(recovered.status,'CLOSED');assert.equal(recovered.reason,'COMPLETED_READ_WITHOUT_PAGE_NEW_RUN_REQUIRED');
 assert.equal(budgetStatus(f.db,'fixture').actual,'0.1');assert.equal(budgetStatus(f.db,'fixture').reserved,'0');assert.equal(getRecord(f.db,'monitor_checkpoint','fixture-stream'),null);
 assert.equal(getRecord(f.db,'monitor_poll_receipt','fixture-run:1').evidenceRef,'fixture:completed-paid-read');
 await assert.rejects(provider.pollProviderReplies(f.db,{...f.options,transport:tx}),/NEW_RUN_REQUIRED/);
 assert.equal((await provider.pollProviderReplies(f.db,{...f.options,runId:'replacement-run',transport:transport()})).status,'COMPLETE');
 assert.equal(f.db.prepare("SELECT count(*) n FROM records WHERE kind='provider_event'").get().n,1);assert.equal(budgetStatus(f.db,'fixture').actual,'0.1');
});
test('synthetic polling rejects mixed real-like records before transport or reservation',async t=>{
 const f=fixture(t);putRecord(f.db,'candidate','real-prospect',{qualification:'QUALIFIED'});putRecord(f.db,'contact','person@actual-company.com',{candidateId:'real-prospect'});let calls=0;
 await assert.rejects(provider.pollProviderReplies(f.db,{...f.options,transport:transport(undefined,{async fetchPage(){calls++;return {payload:fixtureReplyPayload(),evidenceRef:'fixture:must-not-read',actualUsd:'0'};}})}),/FIXTURE_ISOLATION/);
 assert.equal(calls,0);assert.equal(f.db.prepare('SELECT count(*) n FROM operations').get().n,0);assert.equal(f.db.prepare("SELECT count(*) n FROM records WHERE kind IN ('provider_event','reply_notification','monitor_checkpoint')").get().n,0);
});
test('synthetic polling rejects non-test pairing before transport or reservation',async t=>{
 const f=fixture(t);putRecord(f.db,'telegram_binding','primary',{confirmed:true,userId:42,chatId:42,botId:777});let calls=0;
 await assert.rejects(provider.pollProviderReplies(f.db,{...f.options,transport:transport(undefined,{async fetchPage(){calls++;throw Error();}})}),/FIXTURE_ISOLATION/);
 assert.equal(calls,0);assert.equal(f.db.prepare('SELECT count(*) n FROM operations').get().n,0);
});
test('synthetic polling rejects a disposable non-OS-temp database before transport or reservation',async t=>{
 // Newly created, synthetic-only scratch DB; no project or protected DB is read.
 const f=fixture(t,{baseDirectory:fileURLToPath(new URL('../work/local-integrations-v1/',import.meta.url))});let calls=0;
 await assert.rejects(provider.pollProviderReplies(f.db,{...f.options,transport:transport(undefined,{async fetchPage(){calls++;throw Error();}})}),/FIXTURE_ISOLATION/);
 assert.equal(calls,0);assert.equal(f.db.prepare('SELECT count(*) n FROM operations').get().n,0);
});
test('an offline transport cannot bypass isolation by supplying a forged approved-contract record',async t=>{
 const f=fixture(t);putRecord(f.db,'candidate','real-prospect',{qualification:'QUALIFIED'});
 // Deliberately forged approval in the disposable negative-test database only.
 const contract={...fixtureReplyContract,id:'forged-negative-test-contract',basis:'APPROVED_SAVED_EVIDENCE',evidence:Object.fromEntries(Object.keys(fixtureReplyContract.evidence).map(key=>[key,`negative-test:forged-${key}`]))};
 const decoder=provider.createProviderReplyDecoder({contract,decodePage:decodeFixtureReplyPage});
 putRecord(f.db,'monitor_provider_contract',contract.id,{status:'APPROVED',contract,contractHash:decoder.contractHash,approvedBy:'Negative test fixture',approvedAt:at,evidenceRef:'negative-test:forged-approval'});
 putRecord(f.db,'monitor_poll_authorization',f.grant.id,{...f.grant,contractHash:decoder.contractHash});let calls=0;
 await assert.rejects(provider.pollProviderReplies(f.db,{...f.options,decoder,transport:transport(undefined,{async fetchPage(){calls++;throw Error();}})}),/FIXTURE_ISOLATION/);
 assert.equal(calls,0);assert.equal(f.db.prepare('SELECT count(*) n FROM operations').get().n,0);
});
