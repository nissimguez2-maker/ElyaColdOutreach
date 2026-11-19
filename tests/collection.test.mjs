import test from 'node:test';
import assert from 'node:assert/strict';
import {openStore,getRecord,putRecord,controls} from '../src/store.mjs';
import {adoptAssessedProspect} from '../src/workflow.mjs';
import {blockNetwork} from './helpers/network-block.mjs';
import {collectionFixture} from './fixtures/collection-input.mjs';
const api=await import('../src/collection.mjs').catch(e=>{if(e.code==='ERR_MODULE_NOT_FOUND')return {};throw e;});
const dbFor=t=>{blockNetwork(t);const db=openStore(':memory:');t.after(()=>db.close());return db;};

test('fresh page and exact-address verification become sourced business briefs without adoption',t=>{
 const db=dbFor(t),f=collectionFixture();
 assert.equal(typeof api.recordCollectionEvidence,'function','fresh evidence ingestion is implemented');
 api.recordCollectionEvidence(db,f.page);api.recordCollectionEvidence(db,f.verification);
 const result=api.refineCollectedEvidence(db,f.spec),brief=result.briefs[0];
 assert.equal(brief.businessFit.state,'PASS');assert.equal(brief.contacts[0].verification.accepted,true);
 assert.equal(brief.contacts[0].verification.records[0].provider,'bounceverify/bounceverify-email-verifier');
 assert.equal(brief.facts.length,5);assert.ok(brief.facts.every(c=>c.originId==='apify:run-page:dataset-page'));
 assert.equal(getRecord(db,'contact','qa@example.test'),null);assert.equal(getRecord(db,'candidate','SYN-1'),null);
 assert.equal(db.prepare('SELECT count(*) n FROM batches').get().n,0);assert.equal(controls(db).stopped,true);
 assert.throws(()=>adoptAssessedProspect(db,{briefHash:brief.hash,email:'qa@example.test',operatingCheckId:'none',attributionCheckId:'none',synthetic:true}),/CURRENT_ASSERTION/);
 assert.equal(getRecord(db,'collection_refinement',f.spec.id).briefHashes[0],brief.hash);
});

test('exact duplicate evidence and refinement do not duplicate durable observations',t=>{
 const db=dbFor(t),f=collectionFixture();
 const first=api.recordCollectionEvidence(db,f.page);api.recordCollectionEvidence(db,f.verification);
 assert.deepEqual(api.recordCollectionEvidence(db,f.page),first);
 const a=api.refineCollectedEvidence(db,f.spec),before=db.prepare('SELECT count(*) n FROM journal').get().n;
 assert.deepEqual(api.refineCollectedEvidence(db,f.spec),a);assert.equal(db.prepare('SELECT count(*) n FROM journal').get().n,before);
 assert.equal(db.prepare("SELECT count(*) n FROM records WHERE kind='collection_evidence'").get().n,2);
 const changed=structuredClone(f.page);changed.results.structuredContent.items[0].markdown+=' edited';
 assert.throws(()=>api.recordCollectionEvidence(db,changed),/IMMUTABLE/);
 assert.throws(()=>api.refineCollectedEvidence(db,{...f.spec,asOf:'2026-11-16T21:00:00Z'}),/IMMUTABLE/);
});

test('new verification cannot clear authoritative holds or suppression',t=>{
 const db=dbFor(t),f=collectionFixture();
 putRecord(db,'contact','qa@example.test',{candidateId:'SYN-1',verification:'HELD_USER',suppressed:true});
 api.recordCollectionEvidence(db,f.page);api.recordCollectionEvidence(db,f.verification);
 const brief=api.refineCollectedEvidence(db,f.spec).briefs[0];
 assert.equal(brief.contacts[0].reviewEligible,false);assert.equal(brief.contacts[0].suppression,'SUPPRESSED');
 assert.deepEqual(brief.contacts[0].existingHolds,['HELD_USER']);assert.equal(getRecord(db,'contact','qa@example.test').verification,'HELD_USER');
});

test('failed pages stay evidence and cannot supply facts despite SUCCEEDED run',t=>{
 const db=dbFor(t),f=collectionFixture();f.page.results.structuredContent.items[0].crawl.requestStatus='failed';
 api.recordCollectionEvidence(db,f.page);api.recordCollectionEvidence(db,f.verification);
 assert.throws(()=>api.refineCollectedEvidence(db,f.spec),/PAGE_UNUSABLE/);
 const brief=api.refineCollectedEvidence(db,{...f.spec,mappings:[]}).briefs[0];
 assert.equal(brief.businessFit.state,'HOLD');assert.equal(brief.facts.length,0);assert.ok(brief.holds.some(h=>h.code==='SOURCE_UNAVAILABLE'));
});

test('unmatched, incomplete and wrong-dataset evidence fails before persistence',t=>{
 const db=dbFor(t),f=collectionFixture();
 for(const mutate of [x=>{x.results.structuredContent.datasetId='wrong';},x=>{x.results.structuredContent.totalItemCount=2;},x=>{x.results.structuredContent.items[0].email='other@example.test';},x=>{x.run.structuredContent.actorName='unknown';},x=>{x.results.structuredContent.offset=1;}]){
  const x=structuredClone(f.verification);mutate(x);assert.throws(()=>api.recordCollectionEvidence(db,x),/COLLECTION_/);
 }
 assert.equal(db.prepare("SELECT count(*) n FROM records WHERE kind='collection_evidence'").get().n,0);
});

test('review mappings bind exact source values, observed entity targets and supported source shape',t=>{
 const db=dbFor(t),f=collectionFixture();api.recordCollectionEvidence(db,f.page);api.recordCollectionEvidence(db,f.verification);
 for(const change of [{sourceValueHash:'not-the-text'},{entityId:'wrong'},{pointer:'/missing'},{mode:'DIRECT'}]){
  const spec=structuredClone(f.spec);Object.assign(spec.mappings[0],change);assert.throws(()=>api.refineCollectedEvidence(db,spec),/COLLECTION_/);
 }
 assert.equal(getRecord(db,'collection_refinement',f.spec.id),null);
});

test('catch-all and incomplete provider flags cannot become accepted verification',t=>{
 const db=dbFor(t),f=collectionFixture();f.verification.results.structuredContent.items[0].is_catch_all=true;
 api.recordCollectionEvidence(db,f.page);api.recordCollectionEvidence(db,f.verification);
 const brief=api.refineCollectedEvidence(db,f.spec).briefs[0];assert.equal(brief.contacts[0].verification.state,'CATCH_ALL');assert.equal(brief.contacts[0].verification.accepted,false);
 const next=collectionFixture();next.verification.id='missing-flags';delete next.verification.results.structuredContent.items[0].mx_found;
 assert.throws(()=>api.recordCollectionEvidence(db,next.verification),/VERIFIER_CONTRACT/);
});

test('raw decimal-bearing provider response is retained without using stats as charge evidence',t=>{
 const db=dbFor(t),f=collectionFixture();f.page.run.structuredContent.stats={runTimeSecs:2.241,computeUnits:0.00031125};
 const saved=api.recordCollectionEvidence(db,f.page);assert.equal(JSON.parse(saved.rawRun).structuredContent.stats.runTimeSecs,2.241);
 assert.equal(saved.run.stats.computeUnits,'0.00031125');assert.equal(db.prepare('SELECT count(*) n FROM operations').get().n,0);
});

test('selected Contact Details Scraper maps reviewed contact provenance without inventing business facts',t=>{
 const db=dbFor(t),f=collectionFixture();api.recordCollectionEvidence(db,f.contact);api.recordCollectionEvidence(db,f.verification);
 const spec={...f.spec,evidenceIds:[f.contact.id,f.verification.id],mappings:[f.contactMapping]};
 const brief=api.refineCollectedEvidence(db,spec).briefs[0];assert.equal(brief.contacts[0].email,'qa@example.test');
 assert.equal(brief.contacts[0].verification.accepted,true);assert.equal(brief.businessFit.state,'HOLD');assert.equal(brief.facts.length,1);
 assert.equal(brief.facts[0].evidenceClass,'PROVIDER_RESULT');assert.equal(brief.facts[0].sourceLocation,'https://example.test/about');
 assert.throws(()=>api.refineCollectedEvidence(db,{...spec,id:'bad-contact-facts',mappings:[{...f.contactMapping,predicate:'independent',value:true}]}),/CONTACT_ONLY/);
});

test('selected collector rejects cross-site output and excess per-site pages',t=>{
 const db=dbFor(t),f=collectionFixture(),bad=structuredClone(f.contact);bad.results.structuredContent.items[0].url='https://outside.example.test/';
 assert.throws(()=>api.recordCollectionEvidence(db,bad),/COLLECTION_/);
 const excess=structuredClone(f.contact);excess.results.structuredContent.items.push(...Array.from({length:2},()=>structuredClone(excess.results.structuredContent.items[0])));excess.results.structuredContent.itemCount=3;excess.results.structuredContent.totalItemCount=3;
 assert.throws(()=>api.recordCollectionEvidence(db,excess),/COLLECTION_/);
});

test('a valid label without affirmative SMTP evidence cannot enter accepted verification',t=>{
 const db=dbFor(t),f=collectionFixture();f.verification.results.structuredContent.items[0].smtp_valid=null;
 assert.throws(()=>api.recordCollectionEvidence(db,f.verification),/VERIFIER_CONTRACT/);
});
