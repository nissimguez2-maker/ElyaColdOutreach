import test from 'node:test';
import assert from 'node:assert/strict';
import {openStore,putRecord,getRecord,setStopped} from '../src/store.mjs';
import {createBudget,operation,budgetStatus,recoverOperations} from '../src/operations.mjs';
import {recordCollectionEvidence} from '../src/collection.mjs';
import {collectionFixture} from './fixtures/collection-input.mjs';
import {blockNetwork} from './helpers/network-block.mjs';
const api=await import('../src/collection-operation.mjs').catch(e=>{if(e.code==='ERR_MODULE_NOT_FOUND')return {};throw e;});
function fixture(t,{stopped=false,limit='1'}={}){
 blockNetwork(t);const db=openStore(':memory:');t.after(()=>db.close());
 putRecord(db,'settings','collection-fixture-isolation',{isolated:true,fixtureId:'synthetic-collection'});
 createBudget(db,'fixture-budget',limit,'0','0','Synthetic local transport only; GPT subscription excluded');
 if(!stopped)setStopped(db,false,'Temporary synthetic collection fixture');
 const f=collectionFixture(),spec={id:'collect-operation',step:'RUN_ACTOR',actor:f.page.actor,targets:f.page.targets,sourceRef:'fixture:captured-rag-request',budgetId:'fixture-budget',reservation:'0.01',authorizationRef:'fixture:local-approval',notBefore:'2026-11-16T09:00:00Z',expiresAt:'2026-11-17T09:00:00Z'};
 return {db,f,spec,at:f.asOf};
}
test('bounded actor launch then separate dataset read persist receipts and feed evidence ingestion',async t=>{
 const {db,f,spec,at}=fixture(t);let calls=0;
 assert.equal(typeof api.prepareCollectionOperation,'function','bounded collection orchestration is implemented');
 const transport=api.createIsolatedCollectionAdapter(db,{execute:async call=>{
  calls++;const request=JSON.parse(call.requestJson);
  if(call.step==='RUN_ACTOR'){
   assert.equal(request.actor,'apify/rag-web-browser');assert.equal(request.input.query,'https://example.test/about');assert.equal(request.input.maxRequestRetries,0);assert.equal(request.input.maxResults,1);assert.equal(request.callOptions.maxTotalChargeUsd,0.01);
   return {response:f.page.run,actual:'0.01',chargeEvidenceRef:'fixture:charge-run'};
  }
  assert.deepEqual(request,{datasetId:'dataset-page',offset:0,limit:1});return {response:f.page.results,actual:'0',chargeEvidenceRef:'fixture:charge-read'};
 }});
 api.prepareCollectionOperation(db,spec,{at});const run=await api.executeCollectionOperation(db,spec.id,{adapter:transport,at});assert.equal(run.status,'SUCCEEDED');
 const readSpec={...spec,id:'read-operation',step:'READ_DATASET',runOperationId:spec.id,reservation:'0'};
 api.prepareCollectionOperation(db,readSpec,{at});const read=await api.executeCollectionOperation(db,readSpec.id,{adapter:transport,at});
 assert.equal(read.status,'SUCCEEDED');assert.equal(calls,2);assert.equal(budgetStatus(db,'fixture-budget').actual,'0.01');
 const evidence=recordCollectionEvidence(db,{...f.page,run:JSON.parse(run.responseJson),results:JSON.parse(read.responseJson)});
 assert.equal(evidence.run.runId,'run-page');assert.equal(getRecord(db,'collection_operation_result',spec.id).chargeEvidenceRef,'fixture:charge-run');
 assert.equal(db.prepare("SELECT count(*) n FROM journal WHERE event='DISPATCH_INTENT'").get().n,2);
 await api.executeCollectionOperation(db,spec.id,{adapter:transport,at});assert.equal(calls,2);
});

test('dispatch remains disabled without opaque isolated fixture capability',async t=>{
 const {db,spec,at}=fixture(t);api.prepareCollectionOperation(db,spec,{at});
 await assert.rejects(api.executeCollectionOperation(db,spec.id,{at}),/DISPATCH_DISABLED/);
 await assert.rejects(api.executeCollectionOperation(db,spec.id,{at,adapter:{mode:'isolated-collection-fixture',execute:()=>{throw Error('must not execute');}}}),/ISOLATION/);
 assert.equal(operation(db,spec.id).status,'PREPARED');
});

test('stopped business state and expired authority block before provider transport',async t=>{
 const {db,spec,at}=fixture(t,{stopped:true});api.prepareCollectionOperation(db,spec,{at});let calls=0;
 const adapter=api.createIsolatedCollectionAdapter(db,{execute:async()=>{calls++;throw Error('must not execute');}});
 await assert.rejects(api.executeCollectionOperation(db,spec.id,{adapter,at}),/STOPPED/);
 setStopped(db,false,'Temporary fixture only');await assert.rejects(api.executeCollectionOperation(db,spec.id,{adapter,at:'2026-11-18T00:00:00Z'}),/AUTHORITY/);
 assert.equal(calls,0);assert.equal(operation(db,spec.id).status,'PREPARED');
});

test('budget enforcement precedes reservation and provider dispatch',t=>{
 const {db,spec,at}=fixture(t,{limit:'0'});assert.throws(()=>api.prepareCollectionOperation(db,spec,{at}),/Budget/);
 assert.equal(operation(db,spec.id),undefined);assert.equal(getRecord(db,'collection_operation',spec.id),null);
});
test('current workflow dispatch guard is checked before claim and immediately before the collection call',async t=>{
 const {db,f,spec,at}=fixture(t);api.prepareCollectionOperation(db,spec,{at});let calls=0,checks=0;
 const adapter=api.createIsolatedCollectionAdapter(db,{execute:async()=>{calls++;return {response:f.page.run,actual:'0',chargeEvidenceRef:'fixture:zero'};}});
 await assert.rejects(api.executeCollectionOperation(db,spec.id,{adapter,at,assertDispatch:()=>{throw Error('WORKFLOW_GENERAL_DISPATCH_DISABLED');}}),/DISPATCH_DISABLED/);
 assert.equal(operation(db,spec.id).status,'PREPARED');assert.equal(calls,0);
 const result=await api.executeCollectionOperation(db,spec.id,{adapter,at,assertDispatch:()=>{checks++;if(checks===3)throw Error('WORKFLOW_GENERAL_DISPATCH_DISABLED');}});
 assert.equal(checks,3);assert.equal(calls,0);assert.equal(result.status,'RECONCILIATION');
});

test('missing per-run charge evidence retains reservation and prevents next read',async t=>{
 const {db,f,spec,at}=fixture(t);api.prepareCollectionOperation(db,spec,{at});let calls=0;
 const adapter=api.createIsolatedCollectionAdapter(db,{execute:async()=>{calls++;return {response:f.page.run,actual:null,chargeEvidenceRef:null};}});
 const result=await api.executeCollectionOperation(db,spec.id,{adapter,at});assert.equal(result.status,'RECONCILIATION');
 assert.equal(operation(db,spec.id).actual_usd,null);assert.equal(budgetStatus(db,'fixture-budget').reserved,'0.01');assert.ok(result.responseJson.includes('run-page'));
 await assert.rejects(api.executeCollectionOperation(db,spec.id,{adapter,at}),/RECONCILIATION/);
 assert.throws(()=>api.prepareCollectionOperation(db,{...spec,id:'read',step:'READ_DATASET',runOperationId:spec.id,reservation:'0'},{at}),/RUN_NOT_RECONCILED/);assert.equal(calls,1);
});

test('timeout or malformed provider acknowledgement is uncertain and never retried',async t=>{
 const {db,spec,at}=fixture(t);api.prepareCollectionOperation(db,spec,{at});let calls=0;
 const adapter=api.createIsolatedCollectionAdapter(db,{timeoutMs:10,execute:async()=>{calls++;return new Promise(()=>{});}});
 const result=await api.executeCollectionOperation(db,spec.id,{adapter,at});assert.equal(result.status,'RECONCILIATION');
 await assert.rejects(api.executeCollectionOperation(db,spec.id,{adapter,at}),/RECONCILIATION/);assert.equal(calls,1);
});

test('interrupted dispatch recovery retains evidence and blocks replay',async t=>{
 const {db,f,spec,at}=fixture(t);api.prepareCollectionOperation(db,spec,{at});let calls=0;
 const adapter=api.createIsolatedCollectionAdapter(db,{execute:async()=>{calls++;recoverOperations(db);return {response:f.page.run,actual:'0.01',chargeEvidenceRef:'fixture:charge'};}});
 const result=await api.executeCollectionOperation(db,spec.id,{adapter,at});assert.equal(result.status,'RECONCILIATION');assert.ok(result.responseJson.includes('run-page'));
 await assert.rejects(api.executeCollectionOperation(db,spec.id,{adapter,at}),/RECONCILIATION/);assert.equal(calls,1);
});

test('fixture execution rejects real targets, forged capabilities and cross-database reuse',async t=>{
 const {db,spec,at}=fixture(t);spec.targets[0].url='https://real.example.com/about';api.prepareCollectionOperation(db,spec,{at});
 const adapter=api.createIsolatedCollectionAdapter(db,{execute:async()=>{throw Error('must not execute');}});
 await assert.rejects(api.executeCollectionOperation(db,spec.id,{adapter,at}),/SYNTHETIC_TARGET/);
 const other=openStore(':memory:');t.after(()=>other.close());await assert.rejects(api.executeCollectionOperation(other,spec.id,{adapter,at}),/ISOLATION/);
});

test('duplicate action and unknown actor schema cannot reserve another operation',t=>{
 const {db,spec,at}=fixture(t);api.prepareCollectionOperation(db,spec,{at});
 assert.throws(()=>api.prepareCollectionOperation(db,{...spec,id:'duplicate'},{at}),/Duplicate action/);
 assert.throws(()=>api.prepareCollectionOperation(db,{...spec,id:'unknown',actor:'unseen/actor'},{at}),/CONTRACT_UNAVAILABLE/);
 assert.equal(db.prepare('SELECT count(*) n FROM operations').get().n,1);
});

test('selected Contact Details Scraper uses observed bounded request and disables paid add-ons',async t=>{
 const {db,f,spec,at}=fixture(t);const selected={...spec,actor:'vdrmota/contact-info-scraper',reservation:'0.50'};
 const adapter=api.createIsolatedCollectionAdapter(db,{execute:async call=>{
  const r=JSON.parse(call.requestJson);assert.deepEqual(r.input.startUrls,[{url:'https://example.test/about'}]);
  assert.equal(r.input.maxRequestsPerStartUrl,2);assert.equal(r.input.maxRequests,2);assert.equal(r.input.maxDepth,1);assert.equal(r.input.sameDomain,true);
  assert.equal(r.input.maximumLeadsEnrichmentRecords,0);assert.equal(r.input.verifyLeadsEnrichmentEmails,false);assert.equal(r.input.useBrowser,false);
  assert.ok(Object.values(r.input.scrapeSocialMediaProfiles).every(v=>v===false));assert.deepEqual(r.input.proxyConfig,{useApifyProxy:true});assert.equal(r.callOptions.build,'0.2.254');
  return {response:f.contact.run,actual:'0.01',chargeEvidenceRef:'fixture:charge-contact'};
 }});
 api.prepareCollectionOperation(db,selected,{at});const result=await api.executeCollectionOperation(db,selected.id,{adapter,at});assert.equal(result.status,'SUCCEEDED');
 const read=api.prepareCollectionOperation(db,{...selected,id:'read-contact',step:'READ_DATASET',runOperationId:selected.id,reservation:'0'},{at});
 assert.deepEqual(JSON.parse(read.requestJson),{datasetId:'dataset-contact',offset:0,limit:2});
});

test('scheduler cancellation before dispatch leaves the reservation prepared and makes no call',async t=>{
 const {db,spec,at}=fixture(t);api.prepareCollectionOperation(db,spec,{at});const controller=new AbortController();controller.abort();let calls=0;
 const adapter=api.createIsolatedCollectionAdapter(db,{execute:async()=>{calls++;throw Error('must not execute');}});
 await assert.rejects(api.executeCollectionOperation(db,spec.id,{adapter,at,signal:controller.signal}),/ABORTED_BEFORE_DISPATCH/);
 assert.equal(calls,0);assert.equal(operation(db,spec.id).status,'PREPARED');
});

test('scheduler cancellation during dispatch records uncertainty and ignores a late response',async t=>{
 const {db,f,spec,at}=fixture(t);api.prepareCollectionOperation(db,spec,{at});const controller=new AbortController();let finish,providerSignal;
 const adapter=api.createIsolatedCollectionAdapter(db,{timeoutMs:100,execute:async(_call,{signal})=>{providerSignal=signal;queueMicrotask(()=>controller.abort());return new Promise(resolve=>{finish=resolve;});}});
 const execution=api.executeCollectionOperation(db,spec.id,{adapter,at,signal:controller.signal});await new Promise(resolve=>setImmediate(resolve));const forwarded=providerSignal.aborted;
 const result=await execution;assert.equal(result.status,'RECONCILIATION');assert.equal(forwarded,true);
 finish({response:f.page.run,actual:'0.01',chargeEvidenceRef:'fixture:late'});await new Promise(resolve=>setImmediate(resolve));
 assert.equal(operation(db,spec.id).status,'RECONCILIATION');assert.equal(getRecord(db,'collection_operation_result',spec.id).responseJson,null);
});

test('explicit charge reconciliation enables the separate dataset read without replaying the actor',async t=>{
 const {db,f,spec,at}=fixture(t);api.prepareCollectionOperation(db,spec,{at});let calls=0;
 const adapter=api.createIsolatedCollectionAdapter(db,{execute:async()=>{calls++;return {response:f.page.run,actual:null,chargeEvidenceRef:null};}});
 await api.executeCollectionOperation(db,spec.id,{adapter,at});
 const result=api.reconcileCollectionOperation(db,spec.id,{response:f.page.run,actual:'0.01',chargeEvidenceRef:'fixture:explicit-charge',evidenceRef:'fixture:reconciliation'},{at});
 assert.equal(result.status,'SUCCEEDED');assert.equal(operation(db,spec.id).status,'SUCCEEDED');assert.equal(calls,1);
 api.prepareCollectionOperation(db,{...spec,id:'read-after-reconciliation',step:'READ_DATASET',runOperationId:spec.id,reservation:'0'},{at});
 assert.equal(budgetStatus(db,'fixture-budget').reserved,'0');
});
