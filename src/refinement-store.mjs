import {randomUUID} from 'node:crypto';
import {refine,sourceIdentity} from './refinement.mjs';
import {canonical,digest,required} from './values.mjs';
import {transaction,getRecord,putRecord,journal,now} from './store.mjs';

export function processRefinement(db,input,policy,asOf,observationId=randomUUID()){
 required(observationId);
 const commit=()=>{
  // Reprocessing cannot clear authoritative suppression or existing contact holds.
  const effective=structuredClone(input);
  for(const row of db.prepare("SELECT id,data_json FROM records WHERE kind='contact'").all()){
   const c=JSON.parse(row.data_json);
   if(c.suppressed===true)effective.suppressions.push({email:row.id,state:'SUPPRESSED'});
   if(typeof c.verification==='string'&&c.verification!=='PASSED')effective.existingHolds.push({email:row.id,reason:c.verification});
  }
  const result=refine(effective,policy,asOf),key=result.semanticHash;
  const immutable=(kind,id,data)=>{const previous=getRecord(db,kind,id);if(previous){if(canonical(previous)!==canonical(data))throw Error('REFINEMENT_IMMUTABLE_RECORD_MISMATCH');}else putRecord(db,kind,id,data,'assessment');};
  const sourceReferences=[];
  for(const s of effective.sources){
   const id=sourceIdentity(s),value={document:s.document,kind:s.kind,originId:s.originId,url:s.url??null,observedAt:s.observedAt??null,publishedAt:s.publishedAt??null};
   immutable('refinement_source',id,value);
   sourceReferences.push({sourceKey:id,inputSourceId:s.id,provenance:s.provenance??null});
  }
  immutable('refinement_policy',result.policyHash,policy);
  immutable('refinement_run',key,result);
  for(const a of result.assessments){
   const related=new Set([a.entityId,...a.personIdentity.map(p=>p.value.personId),...a.relationships.map(r=>r.value.targetId),...a.contacts.map(c=>c.attribution.personId).filter(Boolean)]);
   const assessmentHash=digest(canonical({assessment:a,policyHash:result.policyHash,processorVersion:result.processorVersion,asOf:result.asOf,claims:result.claims.filter(c=>related.has(c.entityId)),entities:result.entities.filter(e=>related.has(e.id))}));
   immutable('refinement_assessment',a.entityId+':'+assessmentHash,a);
   putRecord(db,'refinement_current',a.entityId,{semanticHash:assessmentHash,runHash:key,policyRevision:result.policyRevision,disposition:a.disposition},'assessment');
  }
  for(const task of result.tasks)immutable('refinement_task',task.id+':'+digest(canonical(task)),task);
  const observation={runHash:key,sourceReferences,reviewMappings:effective.reviews};
  const old=getRecord(db,'refinement_observation',observationId);
  if(old){if(canonical({...old,processedAt:null})!==canonical({...observation,processedAt:null}))throw Error('REFINEMENT_OBSERVATION_ID_REUSED');}
  else{putRecord(db,'refinement_observation',observationId,{...observation,processedAt:now()},'confirmed');journal(db,'OFFLINE_REFINEMENT_RECORDED',observationId,{runHash:key,entities:result.assessments.length,liveCalls:0});}
  return result;
 };
 return db.isTransaction?commit():transaction(db,commit);
}

export function renderRefinementReview(result){
 const lines=[`# Offline Philadelphia refinement review`, `As of ${result.asOf}. Policy ${result.policyRevision}. Processor ${result.processorVersion}.`,
  'Derived saved-evidence assessments only. No draft approval, underwriting conclusion, import or sending authority. No live research or verification.',
  `Business fit passed: ${result.assessments.filter(a=>a.businessFit.state==='PASS').length}; qualified for human review: ${result.assessments.filter(a=>a.disposition==='QUALIFIED_FOR_REVIEW').length}; held: ${result.assessments.filter(a=>a.disposition==='HOLD').length}; rejected: ${result.assessments.filter(a=>a.disposition==='REJECT').length}.`];
 for(const a of result.assessments){
  lines.push(`\n## ${a.entityId} — ${a.business}`,a.location??'Location unknown',`**${a.disposition}** — business fit: ${a.businessFit.state}.`);
  lines.push(`People/roles: ${a.personIdentity.map(p=>`${p.value.name}: ${p.value.role}`).join('; ')||'Not established'}.`);
  for(const c of a.contacts){const records=c.verification.records;lines.push(`Contact: ${c.email} — ${c.attribution.class}; verification ${c.verification.state}${records.length?'; '+records.map(v=>`${v.provider}, ${v.checkedAt??'date unknown'}`).join('; '):'; not checked'}. Current mailbox controller unknown. Suppression: ${c.suppression}.`);}
  if(!a.contacts.length)lines.push('Contact: none supported in the inspected material.');
  lines.push(`Personalization lane: ${a.personalization.lane}.`,...a.personalization.facts.map(f=>`- ${f.value} (${f.evidenceClass}; claim ${f.claimId.slice(0,12)}).`));
  for(const e of a.personalization.events)lines.push(`Event: ${e.value.description}; event date ${e.eventDate}; publication ${e.publicationDate??'unknown'}; observed ${e.observedAt??'unknown'}.`);
  if(!a.personalization.events.length)lines.push('No supported dated event used for timely outreach.');
  if(a.holdReasons.length)lines.push(`Holds: ${a.holdReasons.map(h=>`${h.code}: ${h.detail}`).join('; ')}.`);
  if(a.contradictions.length)lines.push(`Contradictions: ${a.contradictions.join('; ')}.`);
  lines.push(`Unknown: ${a.unknowns.join('; ')}.`,`Next: ${a.nextAction}`);
  const refs=[...new Set(result.claims.filter(c=>c.entityId===a.entityId).map(c=>c.sourceLocation).filter(Boolean))];
  lines.push(`Evidence references: ${refs.join(' ; ')||'See claim ledger and source pointers in JSON'}.`,`Audit: ${a.evidenceReferences.length} claim references retained in JSON; original file hashes/pointers retained in SQLite observation/source records.`);
 }
 return lines.join('\n\n')+'\n';
}
