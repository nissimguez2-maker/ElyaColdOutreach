import {canonical,digest,timestamp,required} from './values.mjs';
export const PROCESSOR_VERSION='offline-refinement-1.1';
const object=x=>x!==null&&typeof x==='object'&&!Array.isArray(x);
const email=x=>typeof x==='string'&&/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(x);
const day=x=>typeof x==='string'&&/^\d{4}-\d\d-\d\d$/.test(x)&&Number.isFinite(Date.parse(x))&&new Date(x).toISOString().slice(0,10)===x;
const kinds=['DIRECT_PERSON','BUSINESS_ROLE','GENERAL_BUSINESS','GROUP_SHARED','UNATTRIBUTED'];
const predicates=['industry','city','state','country','independent','franchise','bigCorporation','operatingBy','openingYear','personRole','relationship','contact','service','event','linkedin','ownerName'];
const unique=values=>[...new Map(values.map(v=>[canonical(v),v])).values()].sort((a,b)=>canonical(a).localeCompare(canonical(b)));
export const sourceIdentity=s=>digest(canonical({content:digest(canonical(s.document)),origin:s.originId,kind:s.kind,url:s.url??null,observedAt:s.observedAt??null,publishedAt:s.publishedAt??null}));
export function sourceValue(document,pointer){
 if(pointer==='')return document;
 if(typeof pointer!=='string'||!pointer.startsWith('/'))throw Error('SOURCE_POINTER_INVALID');
 let value=document;for(const part of pointer.slice(1).split('/')){const key=part.replace(/~1/g,'/').replace(/~0/g,'~');if(value===null||typeof value!=='object'||!Object.hasOwn(value,key))throw Error('SOURCE_POINTER_MISSING');value=value[key];}return value;
}
function claimType(c,entities){
 if(['industry','city','state','country','service','ownerName'].includes(c.predicate))return typeof c.value==='string'&&!!c.value.trim();
 if(['independent','franchise','bigCorporation'].includes(c.predicate))return typeof c.value==='boolean';
 if(c.predicate==='operatingBy')return day(c.value);
 if(c.predicate==='openingYear')return Number.isInteger(c.value)&&c.value>1700&&c.value<10000;
 if(c.predicate==='contact')return object(c.value)&&email(c.value.email)&&kinds.includes(c.value.class)&&(c.value.personId===null||entities.get(c.value.personId)?.type==='PERSON')&&(c.value.class!=='DIRECT_PERSON'||c.value.personId!==null)&&(c.value.class==='DIRECT_PERSON'||c.value.personId===null);
 if(c.predicate==='personRole')return object(c.value)&&entities.get(c.value.personId)?.type==='PERSON'&&typeof c.value.name==='string'&&typeof c.value.role==='string';
 if(c.predicate==='relationship')return object(c.value)&&typeof c.value.type==='string'&&entities.has(c.value.targetId);
 if(c.predicate==='event')return object(c.value)&&typeof c.value.description==='string'&&day(c.value.date);
 if(c.predicate==='linkedin')return object(c.value)&&['PERSON','COMPANY'].includes(c.value.kind)&&typeof c.value.url==='string'&&/^https:\/\/(www\.)?linkedin\.com\//.test(c.value.url)&&(c.value.kind==='COMPANY'?c.value.personId===null:entities.get(c.value.personId)?.type==='PERSON');
 return false;
}
function validateInput(input,policy,asOf){
 canonical(input);canonical(policy);timestamp(asOf);
 if(!object(input)||!['entities','sources','claims','reviews','verifications','conflicts','retrieval','possibleMatches','existingHolds','suppressions'].every(k=>Array.isArray(input[k])))throw Error('REFINEMENT_INPUT_INVALID');
 if(input.entities.length>500||input.sources.length>10000||input.claims.length>20000)throw Error('REFINEMENT_INPUT_LIMIT');
 for(const collection of [input.entities,input.sources,input.reviews]){const ids=new Set();for(const item of collection){if(!object(item)||typeof item.id!=='string'||!item.id||ids.has(item.id))throw Error('REFINEMENT_INPUT_ID_INVALID');ids.add(item.id);}}
 for(const e of input.entities)if(!['BUSINESS','GROUP','LOCATION','PERSON'].includes(e.type)||typeof e.name!=='string'||!['CONFIRMED','POSSIBLE'].includes(e.identityState))throw Error('REFINEMENT_INPUT_ENTITY_INVALID');
 for(const s of input.sources)if(!Object.hasOwn(s,'document')||!['DIRECT_PAGE','SAVED_SUMMARY','DISCOVERY','PROVIDER_RESULT'].includes(s.kind)||typeof s.originId!=='string')throw Error('REFINEMENT_INPUT_SOURCE_INVALID');
 required(policy.revision);required(policy.campaignId);
 if(typeof policy.industry!=='string'||typeof policy.city!=='string'||!Number.isSafeInteger(policy.minimumOperatingYears)||policy.minimumOperatingYears<0||!['HOLD','REJECT'].includes(policy.outsideCityDisposition)||typeof policy.independenceRequired!=='boolean'||!Array.isArray(policy.allowedContactClasses)||policy.allowedContactClasses.some(c=>!kinds.includes(c))||!Array.isArray(policy.excludedStates)||!Array.isArray(policy.verificationAccepted)||policy.verificationAccepted.some(v=>v!=='VALID'))throw Error('REFINEMENT_POLICY_INVALID');
 for(const k of ['verificationMaxAgeDays','evidenceMaxAgeDays','eventMaxAgeDays'])if(policy[k]!==null&&(!Number.isSafeInteger(policy[k])||policy[k]<0))throw Error('REFINEMENT_POLICY_INVALID');
}
const ageDays=(asOf,date)=>typeof date==='string'&&Number.isFinite(Date.parse(date))?(Date.parse(asOf)-Date.parse(date))/86400000:null;
function assessClaims(input,policy,asOf){
 const entities=new Map(input.entities.map(e=>[e.id,e])),reviews=new Map(input.reviews.map(r=>[r.id,r]));
 const sources=new Map(input.sources.map(s=>[s.id,{...s,key:sourceIdentity(s)}]));
 const ledger=[];
 for(const c of input.claims){
  if(!object(c)||!entities.has(c.entityId)||typeof c.sourceId!=='string'||typeof c.predicate!=='string'||!Object.hasOwn(c,'value'))throw Error('REFINEMENT_INPUT_CLAIM_INVALID');
  const s=sources.get(c.sourceId);let reason=null,sourceText=null;
  if(!predicates.includes(c.predicate))reason='UNSUPPORTED_PREDICATE';
  else if(!claimType(c,entities))reason='CLAIM_VALUE_INVALID';
  else if(!s)reason='SOURCE_UNAVAILABLE';
  else if(c.entityMatch!=='CONFIRMED'||entities.get(c.entityId).identityState!=='CONFIRMED')reason='IDENTITY_UNRESOLVED';
  else if(object(c.value)&&(c.value.personId&&entities.get(c.value.personId)?.identityState!=='CONFIRMED'||c.value.targetId&&entities.get(c.value.targetId)?.identityState!=='CONFIRMED'))reason='IDENTITY_UNRESOLVED';
  else if(s.kind==='DISCOVERY'&&['independent','operatingBy','ownerName','personRole'].includes(c.predicate))reason='SOURCE_CLASS_INSUFFICIENT';
  else{
   try{
    const value=sourceValue(s.document,c.pointer);sourceText=value;
    if(c.mode==='DIRECT'){if(canonical(value)!==canonical(c.value))reason='SOURCE_DOES_NOT_SUPPORT_CLAIM';}
    else if(c.mode==='REVIEWED'){
     const r=reviews.get(c.reviewId);
     if(!r||r.entityId!==c.entityId||r.sourceId!==c.sourceId||r.pointer!==c.pointer||r.predicate!==c.predicate||canonical(r.value)!==canonical(c.value)||r.sourceValueHash!==digest(canonical(value))||typeof r.note!=='string'||!r.note.trim())reason='REVIEWED_MAPPING_MISSING_OR_MISMATCHED';
    }else reason='EXTRACTION_MODE_UNSUPPORTED';
   }catch{reason='SOURCE_POINTER_UNAVAILABLE';}
  }
  const observedAge=s?ageDays(asOf,s.observedAt):null;
  let freshness=observedAge!==null&&observedAge<0?'FUTURE_OBSERVATION':policy.evidenceMaxAgeDays===null?'POLICY_UNDEFINED':observedAge===null?'DATE_UNKNOWN':observedAge>policy.evidenceMaxAgeDays?'STALE':'WITHIN_POLICY';
  // Historical coverage remains historical evidence, even when retrieved later.
  if(['operatingBy','openingYear'].includes(c.predicate)&&freshness!=='FUTURE_OBSERVATION')freshness='HISTORICAL_ONLY';
  if(!reason&&['STALE','FUTURE_OBSERVATION'].includes(freshness))reason='EVIDENCE_NOT_CURRENT';
  if(!reason&&c.predicate==='operatingBy'&&c.value>asOf.slice(0,10))reason='FUTURE_OPERATING_DATE';
  const semantic={entityId:c.entityId,predicate:c.predicate,value:c.value,sourceKey:s?.key??'MISSING:'+c.sourceId,pointer:c.pointer??null,mode:c.mode??null,eventDate:c.eventDate??null,limitations:c.limitations??[],assessment:reason?'UNRESOLVED':'SUPPORTED',reason,freshness};
  ledger.push({...semantic,id:digest(canonical(semantic)),evidenceClass:s?.kind??'UNAVAILABLE',originId:s?.originId??null,sourceContentHash:s?digest(canonical(s.document)):null,sourceLocation:s?.url??null,sourceText,observedAt:s?.observedAt??null,publishedAt:s?.publishedAt??null});
 }
 const claims=unique(ledger);
 for(const e of input.entities)for(const p of ['industry','city','country','state','independent','franchise','bigCorporation','openingYear']){
  const matches=claims.filter(c=>c.entityId===e.id&&c.predicate===p&&c.assessment==='SUPPORTED');
  if(new Set(matches.map(c=>canonical(c.value))).size>1)for(const c of matches){c.assessment='CONTRADICTED';c.reason='CONFLICTING_SUPPORTED_ASSERTIONS';}
 }
 return claims;
}
function verificationFor(address,input,policy,asOf){
 const rows=input.verifications.filter(v=>typeof v.email==='string'&&v.email.toLowerCase()===address).map(v=>{
  const raw=v.raw;let state='UNKNOWN',flagConflict=false;
  if(!object(raw)||!email(raw.email)||raw.email.toLowerCase()!==address)state='ERROR';
  else if(raw.error||['error','timeout','failed'].includes(raw.status))state='ERROR';
  else if(raw.is_catch_all===true||raw.risk_type==='catch_all'||raw.status==='catch_all')state='CATCH_ALL';
  else if(raw.status==='invalid')state='INVALID';
  else if(raw.status==='valid'){
   flagConflict=['syntax_valid','domain_exists','mx_found','smtp_valid'].some(k=>raw[k]===false)||raw.is_spamtrap===true;
   state=flagConflict?'UNKNOWN':'VALID';
  }
  let provenanceValid=false;try{const source=input.sources.find(s=>s.id===v.sourceId);provenanceValid=typeof v.provider==='string'&&!!v.provider.trim()&&!!source&&source.kind==='PROVIDER_RESULT'&&canonical(sourceValue(source.document,v.pointer))===canonical(raw);}catch{}
  const age=ageDays(asOf,v.checkedAt);
  return {email:address,state,flagConflict,provenanceValid,provider:v.provider??'UNKNOWN',checkedAt:v.checkedAt??null,method:v.method??null,tier:v.tier??null,raw,sourceId:v.sourceId??null,pointer:v.pointer??null,roleFlag:raw?.is_role_based??null,disposableFlag:raw?.is_disposable??null,ageDays:age===null?null:String(age),freshness:policy.verificationMaxAgeDays===null?'POLICY_UNRESOLVED':age===null?'DATE_UNKNOWN':age<0?'FUTURE_DATE':age>policy.verificationMaxAgeDays?'STALE':'WITHIN_POLICY'};
 });
 const states=unique(rows.map(v=>v.state)),conflicting=states.length>1||rows.some(v=>v.flagConflict);
 const state=!rows.length?'NOT_CHECKED':conflicting?'UNKNOWN':states[0];
 return {state,conflicting,records:unique(rows),policyRevision:policy.revision,accepted:state==='VALID'&&policy.verificationAccepted.includes(state)&&rows.every(v=>v.provenanceValid&&v.freshness==='WITHIN_POLICY'&&v.disposableFlag!==true)};
}
function buildAssessment(entity,claims,input,policy,asOf){
 const all=claims.filter(c=>c.entityId===entity.id),good=all.filter(c=>c.assessment==='SUPPORTED');
 const values=p=>good.filter(c=>c.predicate===p),one=p=>values(p)[0]?.value;
 const holds=[],exclusions=[],tasks=[];
 const hold=(code,detail)=>holds.push({code,detail});
 const task=(rule,question,why,method,resolves,priority=2)=>{
  const id=digest(canonical({entityId:entity.id,rule,question}));
  tasks.push({id,entityId:entity.id,rule,question,why,existingEvidence:unique(all.map(c=>c.id)),proposedMethod:method,resolutionEvidence:resolves,priority,priorAttempts:input.retrieval.filter(r=>r.entityId===entity.id).map(r=>({url:r.url,runId:r.runId,pageStatus:r.pageStatus})),stopCondition:'One targeted attempt only after separate authorization; stop when resolved or unavailable, retain hold; no automatic retry',costBasis:null,status:'PROPOSED_NOT_EXECUTED'});
 };
 const rules={industry:'HOLD',geography:'HOLD',independence:'HOLD',operatingHistory:'HOLD'};
 if(entity.identityState!=='CONFIRMED')hold('IDENTITY_UNRESOLVED','Entity identity is only a possible match');
 if(one('industry')===policy.industry)rules.industry='PASS';else if(one('industry')!==undefined){rules.industry='FAIL';exclusions.push('Industry differs from approved restaurant campaign');}
 if(one('city')===policy.city)rules.geography='PASS';else if(one('city')!==undefined){rules.geography=policy.outsideCityDisposition==='REJECT'?'FAIL':'HOLD';if(rules.geography==='FAIL')exclusions.push('Outside approved city');else hold('MISSING_EVIDENCE','Outside Philadelphia city; retained scope hold');}
 if(one('country')!==undefined&&one('country')!==policy.country||policy.excludedStates.includes(one('state'))){rules.geography='FAIL';exclusions.push('Explicit country/state exclusion');}
 if(one('franchise')===true||one('bigCorporation')===true||one('independent')===false){rules.independence='FAIL';exclusions.push('Franchise, big corporation or non-independent under approved rule');}
 else if(!policy.independenceRequired||one('independent')===true)rules.independence='PASS';
 const boundary=new Date(asOf);boundary.setUTCFullYear(boundary.getUTCFullYear()-policy.minimumOperatingYears);
 if(values('operatingBy').some(c=>Date.parse(c.value)<=boundary.getTime()))rules.operatingHistory='PASS';
 const businessFit={state:exclusions.length?'REJECT':Object.values(rules).every(x=>x==='PASS')&&entity.identityState==='CONFIRMED'?'PASS':'HOLD',rules,exclusions,policyRevision:policy.revision};
 if(businessFit.state==='HOLD'){
  hold('MISSING_EVIDENCE','Observable targeting requirements remain unresolved');
  task('business_fit',`For ${entity.name}, resolve ${Object.entries(rules).filter(([,v])=>v==='HOLD').map(([k])=>k).join(', ')||'identity'} against this campaign.`, 'Can change the targeting decision','One matching official About/Contact/history source; dated coverage for operating history','Matched name/address/domain/concept and source-specific support for the unresolved rules',1);
 }
 const contradictions=unique([...all.filter(c=>c.assessment==='CONTRADICTED').map(c=>`${c.predicate}: ${canonical(c.value)}`),...input.conflicts.filter(c=>c.entityId===entity.id).map(c=>c.description)]);
 if(contradictions.length){hold('CONFLICTING_EVIDENCE',contradictions.join('; '));task('conflicting_evidence',`Resolve the conflicting assertions for ${entity.name}: ${unique(all.filter(c=>c.assessment==='CONTRADICTED').map(c=>c.predicate)).join(', ')||'provider/identity evidence'}.`,'Prevents an unsupported assertion or contact acceptance','Review cited conflicting sources and exact provider methodology; targeted independent evidence only if approved','Document which assertion is supported for the exact entity and period',1);}
 const contactClaims=values('contact'),contacts=[];
 for(const address of unique(contactClaims.map(c=>c.value.email.toLowerCase()))){
  const routes=contactClaims.filter(c=>c.value.email.toLowerCase()===address),attributions=unique(routes.map(c=>({...c.value,email:address})));
  const conflict=attributions.length!==1;
  const attribution=conflict?{class:'UNATTRIBUTED',personId:null}:attributions[0];
  const verification=verificationFor(address,input,policy,asOf);
  const suppressionRows=input.suppressions.filter(s=>typeof s.email==='string'&&s.email.toLowerCase()===address);
  const suppression=suppressionRows.some(s=>s.state==='SUPPRESSED')?'SUPPRESSED':suppressionRows.length&&suppressionRows.every(s=>s.state==='CLEAR')?'CLEAR':'UNKNOWN';
  const existingHolds=unique(input.existingHolds.filter(h=>h.email.toLowerCase()===address).map(h=>h.reason));
  const routeOk=policy.allowedContactClasses.includes(attribution.class)&&!conflict;
  contacts.push({email:address,attribution:{...attribution,acceptableClass:routeOk,sourceClaimIds:routes.map(c=>c.id),mailboxController:'UNKNOWN'},verification,suppression,existingHolds,reviewEligible:routeOk&&verification.accepted&&suppression==='CLEAR'&&!existingHolds.length});
  if(!routeOk)hold('IDENTITY_UNRESOLVED','Contact attribution unresolved or conflicts');
  if(!verification.accepted){hold('CONTACT_VERIFICATION',`${address}: ${verification.state}; no accepted current mailbox evidence`);if(verification.state==='VALID'&&policy.verificationMaxAgeDays===null)hold('POLICY_UNRESOLVED','Verification freshness interval is not approved');}
  if(suppression!=='CLEAR')hold('SUPPRESSION',suppression==='SUPPRESSED'?'Contact remains suppressed':'Suppression status unknown');
  if(existingHolds.length)hold('EXISTING_HOLD',existingHolds.join('; '));
 }
 if(!contacts.length){hold('MISSING_EVIDENCE','No supported contact in inspected material; absence is not proof none exists');if(businessFit.state==='HOLD'){const t=tasks.find(t=>t.rule==='business_fit');t.question+=' Include the published business contact route in the same source review.';t.resolutionEvidence+='; published contact route with accurate attribution';t.id=digest(canonical({entityId:entity.id,rule:t.rule,question:t.question}));}else task('contact_attribution',`Which published business contact route serves ${entity.name}?`,'A usable attributed route is missing','Official Contact/About page for this entity, after business scope is resolved','Published address with business/person/group attribution; no guessed email patterns');}
 else if(contacts.some(c=>!c.reviewEligible))task('contact_review',`Resolve the contact hold(s) for ${entity.name}: ${contacts.filter(c=>!c.reviewEligible).map(c=>c.email).join(', ')}.`,'Business fit alone does not create an eligible recipient','Review existing provider/DNS/attribution and suppression records first; any new verifier requires a specific approved proposal','Accepted exact-address evidence under approved freshness policy, resolved contradictions and explicit hold/suppression handling',businessFit.state==='PASS'?1:3);
 if(entity.legacyHold)hold('EXISTING_HOLD',entity.legacyHold);
 const retrieval=input.retrieval.filter(r=>r.entityId===entity.id);
 if(retrieval.some(r=>!r.usable)&&businessFit.state!=='PASS')hold('SOURCE_UNAVAILABLE','One or more page attempts failed; run completion does not prove page retrieval');
 const events=values('event').map(c=>({value:c.value,eventDate:c.value.date,publicationDate:c.publishedAt,observedAt:c.observedAt,claimId:c.id,recent:policy.eventMaxAgeDays!==null&&ageDays(asOf,c.value.date)>=0&&ageDays(asOf,c.value.date)<=policy.eventMaxAgeDays}));
 const personalization={lane:events.some(e=>e.recent)?'EVENT_SUPPORTED':'BUSINESS_CONTEXT',facts:values('service').slice(0,3).map(c=>({classification:'OBSERVED_FACT',value:c.value,claimId:c.id,evidenceClass:c.evidenceClass})),events,salesHypotheses:[],fundingNeed:'UNKNOWN'};
 const unknowns=unique([...Object.entries(rules).filter(([,s])=>s==='HOLD').map(([k])=>k),...all.filter(c=>c.assessment==='UNRESOLVED').map(c=>`${c.predicate}: ${c.reason}`),...contacts.filter(c=>!c.verification.accepted).map(c=>`${c.email}: mailbox verification not accepted`),'Financing intent','Underwriting eligibility',...(policy.evidenceMaxAgeDays===null?['Claim freshness intervals not defined; saved observations are not a live recheck']:[])]);
 // One source review can resolve related gaps; prerequisites never authorize enrichment.
 const conflictTask=tasks.find(t=>t.rule==='conflicting_evidence'),primaryTask=tasks.find(t=>t.rule===(businessFit.state==='HOLD'?'business_fit':'contact_review'));
 if(conflictTask&&primaryTask){primaryTask.question+=' Address the recorded contradictions in this same review.';primaryTask.resolutionEvidence+='; reconcile cited contradictions without assuming the newest source is correct';primaryTask.id=digest(canonical({entityId:entity.id,rule:primaryTask.rule,question:primaryTask.question}));tasks.splice(tasks.indexOf(conflictTask),1);}
 for(const t of tasks)if(t.rule==='contact_review')t.prerequisite=businessFit.state==='PASS'?'Separate approval before any new live verification':'Business fit must pass before any new verification is proposed';
 if(one('city')!==undefined&&one('city')!==policy.city&&policy.outsideCityDisposition==='HOLD'){
  tasks.length=0;task('geography',`Has Daniel explicitly changed the Philadelphia city scope to include ${one('city')}?`,'The saved address is outside the current scope; retain the hold and do not enrich','Approved campaign instructions only; no website or paid research','An explicit user-approved scope revision, otherwise remain held',1);tasks[0].status='BLOCKED_POLICY_CHANGE';tasks[0].stopCondition='No enrichment or verification under current scope; await explicit policy change';
 }
 const disposition=businessFit.state==='REJECT'?'REJECT':businessFit.state==='PASS'&&contacts.some(c=>c.reviewEligible)&&!holds.length?'QUALIFIED_FOR_REVIEW':'HOLD';
 return {assessment:{entityId:entity.id,business:entity.name,location:entity.address??null,policyRevision:policy.revision,businessFit,personIdentity:values('personRole').map(c=>({value:c.value,claimId:c.id})),relationships:values('relationship').map(c=>({value:c.value,claimId:c.id})),linkedIn:values('linkedin').map(c=>({value:c.value,claimId:c.id})),contacts,personalization,intentState:'UNKNOWN',underwritingState:'UNKNOWN',outreachAuthorization:'NOT_GRANTED',draftApproval:'NOT_GRANTED',reviewState:disposition==='QUALIFIED_FOR_REVIEW'?'READY_FOR_HUMAN_REVIEW':'NEEDS_RESOLUTION',disposition,holdReasons:unique(holds),unknowns,contradictions,retrieval,evidenceReferences:all.map(c=>c.id),nextAction:businessFit.state==='REJECT'?'Do not enrich; documented hard exclusion':tasks.sort((a,b)=>a.priority-b.priority||a.id.localeCompare(b.id))[0]?.question??'Human review only; no release authority'},tasks:businessFit.state==='REJECT'?[]:tasks};
}
export function refine(input,policy,asOf){
 validateInput(input,policy,asOf);
 const sourceKeys=new Map(input.sources.map(s=>[s.id,sourceIdentity(s)]));
 input={...input,retrieval:unique(input.retrieval.map(r=>({...r,sourceId:sourceKeys.get(r.sourceId)??r.sourceId})))};
 const claims=assessClaims(input,policy,asOf);
 const built=input.entities.filter(e=>e.type==='BUSINESS').sort((a,b)=>a.id.localeCompare(b.id)).map(e=>buildAssessment(e,claims,input,policy,asOf));
 const assessments=built.map(x=>x.assessment),tasks=unique(built.flatMap(x=>x.tasks));
 const addressMap=new Map();for(const a of assessments)for(const c of a.contacts){if(!addressMap.has(c.email))addressMap.set(c.email,[]);addressMap.get(c.email).push(a.entityId);}
 const result={processorVersion:PROCESSOR_VERSION,policyRevision:policy.revision,policyHash:digest(canonical(policy)),campaignId:policy.campaignId,asOf,entities:unique(input.entities),claims,assessments,tasks,possibleMatches:unique(input.possibleMatches),outreachDeduplication:[...addressMap].sort(([a],[b])=>a.localeCompare(b)).map(([address,entityIds])=>({email:address,entityIds:unique(entityIds),mergeBusinesses:false,releaseAuthorized:false})),historicalSummary:input.historicalSummary??null};
 return {...result,semanticHash:digest(canonical(result))};
}
