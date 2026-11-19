import test from 'node:test';import assert from 'node:assert/strict';
import {openStore,getRecord,putRecord} from '../src/store.mjs';
import {refineBusinessBrief,adoptAssessedProspect,importDraftProposal} from '../src/workflow.mjs';
import {writingTelegramFixture} from './helpers/telegram-writing-fixture.mjs';
import {fixture} from './fixtures/refinement-input.mjs';
import {blockNetwork} from './helpers/network-block.mjs';
test('refinement brief preserves sourced eligibility and requires explicit current assertion checks',t=>{
 blockNetwork(t);const db=openStore(':memory:');t.after(()=>db.close());const f=fixture();
 const [brief]=refineBusinessBrief(db,{...f,asOf:'2026-11-16T20:00:00Z',observationId:'brief'});
 assert.equal(brief.businessFit.state,'PASS');assert.equal(brief.contacts[0].verification.accepted,true);
 assert.throws(()=>adoptAssessedProspect(db,{briefHash:brief.hash,email:'qa@example.test',operatingCheckId:'op',attributionCheckId:'attr',synthetic:true}),/CURRENT_ASSERTION/);
 for(const [id,kind]of [['op','OPERATING_STATUS'],['attr','CONTACT_ATTRIBUTION']])putRecord(db,'evidence_check',id,{kind,entityId:'SYN-1',email:'qa@example.test',reviewed:true,sourceRef:'fixture-only',assertedAt:'2026-11-16T10:00:00Z',open:true,description:'Synthetic business inbox'});
 adoptAssessedProspect(db,{briefHash:brief.hash,email:'qa@example.test',operatingCheckId:'op',attributionCheckId:'attr',synthetic:true});assert.equal(getRecord(db,'contact','qa@example.test').verification,'PASSED');
 putRecord(db,'contact','qa@example.test',{...getRecord(db,'contact','qa@example.test'),verification:'HELD_USER'});
 assert.throws(()=>adoptAssessedProspect(db,{briefHash:brief.hash,email:'qa@example.test',operatingCheckId:'op',attributionCheckId:'attr',synthetic:true}),/EXISTING_CONTACT_HOLD/);
});
test('draft import is exact and cannot overwrite an existing immutable draft version',t=>{
 const {db,spec}=writingTelegramFixture();t.after(()=>db.close());
 const drafts=spec.draftIds.map(id=>({id,data:getRecord(db,'draft',id)}));
 const first=importDraftProposal(db,{drafts,spec});
 assert.equal(importDraftProposal(db,{drafts,spec}).hash,first.hash);
 const changed=structuredClone(drafts);changed[0].data.subject='Changed under old version';
 assert.throws(()=>importDraftProposal(db,{drafts:changed,spec}),/Draft version is immutable/);
 assert.deepEqual(getRecord(db,'draft',drafts[0].id),drafts[0].data);
 assert.throws(()=>importDraftProposal(db,{drafts:[drafts[0],drafts[0],drafts[2]],spec}),/DRAFT_IDS_MUST_MATCH/);
});
