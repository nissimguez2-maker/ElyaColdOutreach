import test from 'node:test';
import assert from 'node:assert/strict';
import {openStore,putRecord,getRecord,setStopped,controls} from '../src/store.mjs';
import {createBudget,operation,budgetStatus} from '../src/operations.mjs';
import {collectionFixture} from './fixtures/collection-input.mjs';
import * as collection from '../src/collection.mjs';
import * as operations from '../src/collection-operation.mjs';
const at='2026-11-16T20:00:00Z';
function fixture(t){
 const db=openStore(':memory:');t.after(()=>db.close());
 putRecord(db,'settings','collection-fixture-isolation',{isolated:true,fixtureId:'operational-collection'});
 createBudget(db,'collection-fixture','2','0','0','Isolated accounting only');setStopped(db,false,'Synthetic fixture');
 const f=collectionFixture(),spec={id:'run',step:'RUN_ACTOR',actor:f.contact.actor,targets:f.contact.targets,sourceRef:'fixture:selected-contract',budgetId:'collection-fixture',reservation:'0.5',authorizationRef:'fixture:bounded-approval',notBefore:'2026-11-16T00:00:00Z',expiresAt:'2026-11-17T00:00:00Z'};
 return {db,f,spec};
}
test('collection rejects private-network targets and unknown request fields before reserving',t=>{
 const {db,spec}=fixture(t);
 for(const url of ['http://127.0.0.1/','http://[::1]/','http://169.254.169.254/','http://localhost/','https://box.local/',' https://example.test/'])assert.throws(()=>operations.prepareCollectionOperation(db,{...spec,targets:[{entityId:'SYN-1',url}]},{at}),/COLLECTION_TARGET|COLLECTION_URL/);
 assert.throws(()=>operations.prepareCollectionOperation(db,{...spec,maxRequests:100},{at}),/COLLECTION_OPERATION_SHAPE/);
 assert.equal(db.prepare('SELECT count(*) n FROM operations').get().n,0);
});
test('duplicate URL fragments cannot create different paid actions for the same exact page',t=>{
 const {db,spec}=fixture(t);
 assert.throws(()=>operations.prepareCollectionOperation(db,{...spec,targets:[spec.targets[0],{entityId:'SYN-2',url:spec.targets[0].url+'#contact'}]},{at}),/DUPLICATE_TARGET/);
 operations.prepareCollectionOperation(db,{...spec,targets:[{...spec.targets[0],url:spec.targets[0].url+'#contact'}]},{at});
 assert.throws(()=>operations.prepareCollectionOperation(db,{...spec,id:'second-fragment',targets:[{...spec.targets[0],url:spec.targets[0].url+'#footer'}]},{at}),/Duplicate action/);
});
test('invalid provider output retains attributable known charge and blocks an observed overrun',async t=>{
 const {db,f,spec}=fixture(t),bad=structuredClone(f.contact.run);bad.structuredContent.actorName='different/actor';
 operations.prepareCollectionOperation(db,spec,{at});
 const adapter=operations.createIsolatedCollectionAdapter(db,{execute:async()=>({response:bad,actual:'0.6',chargeEvidenceRef:'fixture:known-overrun'})});
 const result=await operations.executeCollectionOperation(db,spec.id,{adapter,at});
 assert.equal(result.status,'RECONCILIATION');assert.equal(result.actual,'0.6');assert.equal(result.chargeEvidenceRef,'fixture:known-overrun');assert.equal(operation(db,spec.id).actual_usd,null);assert.equal(budgetStatus(db,'collection-fixture').reserved,'0.6');assert.equal(budgetStatus(db,'collection-fixture').blocked,true);
});
test('contact rows require unique page identity and consistent domain and referrer provenance',t=>{
 const {db,f}=fixture(t);
 for(const mutate of [x=>x.domain='other.test',x=>x.referrerUrl='https://other.test/',x=>x.emails.push('qa@example.test')]){
  const evidence=structuredClone(f.contact);mutate(evidence.results.structuredContent.items[0]);assert.throws(()=>collection.recordCollectionEvidence(db,evidence),/COLLECTION_CONTACT/);
 }
 const evidence=structuredClone(f.contact);evidence.results.structuredContent.items.push(structuredClone(evidence.results.structuredContent.items[0]));evidence.results.structuredContent.itemCount=2;evidence.results.structuredContent.totalItemCount=2;
 assert.throws(()=>collection.recordCollectionEvidence(db,evidence),/COLLECTION_DUPLICATE_ROW/);
 assert.equal(getRecord(db,'collection_evidence',f.contact.id),null);
});
test('dataset acknowledgement must validate target attribution before settling success',async t=>{
 const {db,f,spec}=fixture(t);let calls=0;
 const bad=structuredClone(f.contact.results);bad.structuredContent.items[0].originalStartUrl='https://unapproved.test/';
 const adapter=operations.createIsolatedCollectionAdapter(db,{execute:async({step})=>{calls++;return {response:step==='RUN_ACTOR'?f.contact.run:bad,actual:'0',chargeEvidenceRef:'fixture:charge'};}});
 operations.prepareCollectionOperation(db,spec,{at});await operations.executeCollectionOperation(db,'run',{adapter,at});
 operations.prepareCollectionOperation(db,{...spec,id:'read',step:'READ_DATASET',runOperationId:'run',reservation:'0'},{at});
 const result=await operations.executeCollectionOperation(db,'read',{adapter,at});assert.equal(result.status,'RECONCILIATION');assert.equal(operation(db,'read').status,'RECONCILIATION');
 await assert.rejects(operations.executeCollectionOperation(db,'read',{adapter,at}),/RECONCILIATION/);assert.equal(calls,2);
});
test('completed run/read bridge persists exact operation provenance once without changing eligibility',async t=>{
 const {db,f,spec}=fixture(t);let calls=0;
 const adapter=operations.createIsolatedCollectionAdapter(db,{execute:async({step})=>{calls++;return {response:step==='RUN_ACTOR'?f.contact.run:f.contact.results,actual:'0.001',chargeEvidenceRef:'fixture:charge'};}});
 operations.prepareCollectionOperation(db,spec,{at});await operations.executeCollectionOperation(db,'run',{adapter,at});
 operations.prepareCollectionOperation(db,{...spec,id:'read',step:'READ_DATASET',runOperationId:'run',reservation:'0.01'},{at});await operations.executeCollectionOperation(db,'read',{adapter,at});
 assert.equal(typeof operations.ingestCompletedCollectionOperation,'function','Completed evidence bridge is required');
 const input={id:'bridged',runOperationId:'run',readOperationId:'read',sourceRef:'fixture:received-operation-pair',receivedAt:at};
 const first=operations.ingestCompletedCollectionOperation(db,input),journalCount=db.prepare('SELECT count(*) n FROM journal').get().n;
 assert.equal(first.run.runId,'run-contact');assert.equal(first.results.items[0].originalStartUrl,'https://example.test/about');
 assert.deepEqual(operations.ingestCompletedCollectionOperation(db,input),first);assert.equal(db.prepare('SELECT count(*) n FROM journal').get().n,journalCount);
 const binding=getRecord(db,'collection_operation_evidence','bridged');assert.equal(binding.runOperationId,'run');assert.equal(binding.readOperationId,'read');assert.equal(binding.evidenceHash,first.hash);
 assert.equal(getRecord(db,'candidate','SYN-1'),null);assert.equal(getRecord(db,'contact','qa@example.test'),null);assert.equal(controls(db).launchAuthorized,false);assert.equal(calls,2);
 assert.equal(budgetStatus(db,'collection-fixture').actual,'0.002');
 assert.throws(()=>operations.ingestCompletedCollectionOperation(db,{...input,id:'duplicate'}),/ALREADY_INGESTED/);
 assert.throws(()=>operations.ingestCompletedCollectionOperation(db,{...input,readOperationId:'run'}),/COLLECTION_READ/);
});
