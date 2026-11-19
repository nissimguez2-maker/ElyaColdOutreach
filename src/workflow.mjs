// Local orchestration over the existing authority. No model, provider or network calls.
import {processRefinement} from './refinement-store.mjs';
import {prepareWritingReview} from './writing.mjs';
import {putRecord,getRecord,transaction} from './store.mjs';
import {canonical,digest,timestamp,required} from './values.mjs';
import {validateImportedProvenance} from './drafting-handoff.mjs';
import {writingMode,messageStepsForMode,FIRST_TOUCH_CONTRACT} from './writing-mode.mjs';

export function refineBusinessBrief(db,{input,policy,asOf,observationId}){
 const result=processRefinement(db,input,policy,asOf,observationId);
 return result.assessments.map(a=>{
  const brief={entityId:a.entityId,runHash:result.semanticHash,assessmentHash:getRecord(db,'refinement_current',a.entityId).semanticHash,asOf,policyRevision:policy.revision,businessFit:a.businessFit,contacts:a.contacts,facts:result.claims.filter(c=>c.entityId===a.entityId&&c.assessment==='SUPPORTED'),hypotheses:a.personalization.salesHypotheses,unknowns:a.unknowns,holds:a.holdReasons,writingPolicy:getRecord(db,'writing_policy',policy.campaignId),generation:'LOCAL_BRIEF_ONLY_NO_MODEL_CALL'};
  const hash=digest(canonical(brief));putRecord(db,'business_brief',hash,brief,'assessment');return {...brief,hash};
 });
}

// Adopt an assessment only with explicit current-check records. Fetch time alone
// never fills assertion freshness. Existing user/provider holds are not removed.
export function adoptAssessedProspect(db,{briefHash,email,operatingCheckId,attributionCheckId,synthetic=false}){
 return transaction(db,()=>{
  const brief=getRecord(db,'business_brief',briefHash);if(!brief)throw Error('BUSINESS_BRIEF_REQUIRED');
  if(getRecord(db,'refinement_current',brief.entityId)?.semanticHash!==brief.assessmentHash)throw Error('STALE_BUSINESS_BRIEF');
  const c=brief.contacts.find(c=>c.email===email);if(!c)throw Error('SOURCED_CONTACT_REQUIRED');
  const check=(id,kind)=>{const r=getRecord(db,'evidence_check',id);if(!r||r.kind!==kind||r.entityId!==brief.entityId||r.reviewed!==true||!r.sourceRef||(kind==='CONTACT_ATTRIBUTION'&&r.email!==email))throw Error('CURRENT_ASSERTION_REVIEW_REQUIRED');timestamp(r.assertedAt);if(timestamp(r.assertedAt)>timestamp(brief.asOf))throw Error('FUTURE_ASSERTION');return r;};
  const operating=check(operatingCheckId,'OPERATING_STATUS'),attribution=check(attributionCheckId,'CONTACT_ATTRIBUTION');
  const sourceSynthetic=brief.facts.some(f=>/example\.(test|invalid)|synthetic/i.test(f.sourceLocation??''));
  if((sourceSynthetic||/\.(test|invalid|example)$/i.test(email))&&!synthetic)throw Error('SYNTHETIC_EVIDENCE_REQUIRES_ISOLATION');
  const old=getRecord(db,'contact',email),business=getRecord(db,'candidate',brief.entityId);
  if((old?.synthetic||business?.synthetic)&&!synthetic)throw Error('SYNTHETIC_FLAG_CANNOT_BE_REMOVED');
  if(old&&(old.verification!=='PASSED'||old.suppressed===true))throw Error('EXISTING_CONTACT_HOLD_REQUIRES_SEPARATE_REVIEW');
  if(business?.qualification&&business.qualification!=='QUALIFIED')throw Error('EXISTING_BUSINESS_HOLD_REQUIRES_REVIEW');
  const verifiedAt=c.verification.records.filter(v=>v.state==='VALID'&&v.provenanceValid).map(v=>v.checkedAt).sort().at(-1)??null;
  putRecord(db,'candidate',brief.entityId,{...business,name:business?.name??brief.entityId,qualification:brief.businessFit.state==='PASS'?'QUALIFIED':'HELD',synthetic,operatingStatusCheckedAt:operating.open===true?operating.assertedAt:null,briefHash},'assessment');
  putRecord(db,'contact',email,{...old,candidateId:brief.entityId,email,attribution:attribution.description,attributionClass:c.attribution.class,verification:c.reviewEligible&&c.verification.accepted?'PASSED':'HELD_ASSESSMENT',verifiedAt,attributionCorroboratedAt:attribution.assertedAt,suppressed:c.suppression==='CLEAR'?false:c.suppression==='SUPPRESSED'?true:null,synthetic,briefHash},'assessment');
  return {candidateId:brief.entityId,email};
 });
}

export function importDraftProposal(db,{drafts,spec,provenance,assistedHandoff}){
 const mode=writingMode(spec),count=messageStepsForMode(mode).length;
 if(!Array.isArray(drafts)||drafts.length!==count)throw Error(mode===FIRST_TOUCH_CONTRACT?'ONE_DRAFT_REQUIRED':'THREE_DRAFTS_REQUIRED');
 if(!Array.isArray(spec?.draftIds)||new Set(drafts.map(d=>d.id)).size!==count||canonical(drafts.map(d=>d.id))!==canonical(spec.draftIds))throw Error('DRAFT_IDS_MUST_MATCH');
 return transaction(db,()=>{
  validateImportedProvenance(db,{drafts,spec,provenance,assistedHandoff});
  for(const row of drafts){required(row.id);if(row.data?.status!=='UNAPPROVED')throw Error('DRAFT_IMPORT_CANNOT_APPROVE');putRecord(db,'draft',row.id,row.data,'assessment');}
  const packet=prepareWritingReview(db,spec);
  if(provenance){
   putRecord(db,'draft_provenance',packet.hash,{...provenance,reviewPacketHash:packet.hash},'user_reported');
   putRecord(db,'draft_assisted_source',packet.hash,{packet:assistedHandoff.packet,result:assistedHandoff.result,operatorProvenance:assistedHandoff.provenance},'user_reported');
  }
  return packet;
 });
}
