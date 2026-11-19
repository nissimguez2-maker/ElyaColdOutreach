// New local evidence joins the existing refinement path. Provider text is data,
// never instructions or automatic authority for a claim, hold release or send.
import {canonical,digest,required,timestamp,parseLossless,assertSafe} from './values.mjs';
import {getRecord,putRecord,transaction,journal,now} from './store.mjs';
import {sourceValue} from './refinement.mjs';
import {refineBusinessBrief} from './workflow.mjs';
import {isIP} from 'node:net';

const PAGE='apify/rag-web-browser',VERIFIER='bounceverify/bounceverify-email-verifier',CONTACT='vdrmota/contact-info-scraper';
const atomic=(db,fn)=>db.isTransaction?fn():transaction(db,fn);
const hash=value=>digest(canonical(value));
const object=value=>value!==null&&typeof value==='object'&&!Array.isArray(value);
const count=value=>/^(0|[1-9]\d*)$/.test(String(value))&&Number.isSafeInteger(Number(value))?Number(value):-1;
const email=value=>typeof value==='string'&&/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
function url(value){try{const u=new URL(value),host=u.hostname.replace(/^\[|\]$/g,'');if(typeof value!=='string'||value!==value.trim()||!['https:','http:'].includes(u.protocol)||u.username||u.password||isIP(host)||!host.includes('.')||/(?:^|\.)(?:localhost|local)$/i.test(host))throw Error();u.hash='';return u.href;}catch{throw Error('COLLECTION_URL_INVALID');}}
function document(value){
 const raw=typeof value==='string'?value:JSON.stringify(value);required(raw);assertSafe(raw);
 if(Buffer.byteLength(raw)>2_000_000)throw Error('COLLECTION_EVIDENCE_TOO_LARGE');
 const parsed=parseLossless(raw),data=parsed?.structuredContent??parsed;
 if(parsed?.isError===true||!object(data))throw Error('COLLECTION_PROVIDER_RESULT_INVALID');
 canonical(data);return {raw,data};
}
export function validateCollectionTargets(actor,targets){
 if(![PAGE,VERIFIER,CONTACT].includes(actor))throw Error('COLLECTION_ACTOR_CONTRACT_UNAVAILABLE');
 if(!Array.isArray(targets)||!targets.length||targets.length>(actor===CONTACT?5:actor===PAGE?1:2))throw Error('COLLECTION_TARGET_BOUND_REQUIRED');
 for(const t of targets){
  if(!object(t)||Object.keys(t).sort().join(',')!==(actor===VERIFIER?'email,entityId':'entityId,url'))throw Error('COLLECTION_TARGET_SHAPE');
  required(t.entityId);if(actor!==VERIFIER)url(t.url);else if(!email(t.email))throw Error('COLLECTION_EMAIL_INVALID');
 }
 const keys=targets.map(t=>actor!==VERIFIER?url(t.url):t.email.toLowerCase());
 if(new Set(keys).size!==keys.length)throw Error('COLLECTION_DUPLICATE_TARGET');
 return targets.map(t=>actor===VERIFIER?{entityId:t.entityId,email:t.email.toLowerCase()}:{entityId:t.entityId,url:url(t.url)});
}
export function validateCollectionEvidence(input){
 const {id,actor,sourceRef,receivedAt}=input;required(id);required(sourceRef);timestamp(receivedAt);
 const targets=validateCollectionTargets(actor,input.targets),run=document(input.run),results=document(input.results),r=run.data,d=results.data;
 required(r.runId);required(r.storages?.datasets?.default?.id);
 if(r.actorName!==actor||r.status!=='SUCCEEDED'||timestamp(r.startedAt)>timestamp(r.finishedAt)||timestamp(r.finishedAt)>timestamp(receivedAt))throw Error('COLLECTION_RUN_MISMATCH_OR_INCOMPLETE');
 if(d.datasetId!==r.storages.datasets.default.id||!Array.isArray(d.items)||d.items.length>targets.length*(actor===CONTACT?2:1)||count(d.offset)!==0||count(d.itemCount)!==d.items.length||count(d.totalItemCount)!==d.items.length||count(d.limit)<d.items.length||count(d.limit)>100)throw Error('COLLECTION_DATASET_MISMATCH_OR_PARTIAL');
 if(actor===PAGE){
  for(const item of d.items){
   if(!object(item.crawl)||!['handled','failed'].includes(item.crawl.requestStatus)||url(item.metadata?.url)!==url(targets[0].url))throw Error('COLLECTION_PAGE_CONTRACT_OR_TARGET_MISMATCH');
   if(timestamp(item.crawl.loadedAt)>timestamp(receivedAt))throw Error('COLLECTION_FUTURE_OBSERVATION');
  }
 }else if(actor===CONTACT){
  const seen=new Map(),pages=new Set(),host=value=>new URL(url(value)).hostname.replace(/^www\./,'');
  for(const item of d.items){
   const target=targets.find(t=>url(t.url)===url(item.originalStartUrl));
   if(!target||host(item.url)!==host(target.url)||!Array.isArray(item.emails)||item.emails.some(e=>!email(e))||new Set(item.emails.map(e=>e.toLowerCase())).size!==item.emails.length||typeof item.domain!=='string'||item.domain.replace(/^www\./,'')!==host(item.url)||item.referrerUrl!==null&&item.referrerUrl!==undefined&&host(item.referrerUrl)!==host(target.url)||count(item.depth)<0||count(item.depth)>1)throw Error('COLLECTION_CONTACT_CONTRACT_OR_TARGET_MISMATCH');
   const key=url(item.originalStartUrl)+'\n'+url(item.url);if(pages.has(key))throw Error('COLLECTION_DUPLICATE_ROW');pages.add(key);
   const n=(seen.get(target.url)??0)+1;if(n>2)throw Error('COLLECTION_CONTACT_PAGE_BOUND_EXCEEDED');seen.set(target.url,n);
  }
 }else{
  const seen=new Set();
  for(const item of d.items){
   if(!email(item.email)||!targets.some(t=>t.email.toLowerCase()===item.email.toLowerCase())||seen.has(item.email.toLowerCase()))throw Error('COLLECTION_VERIFIER_TARGET_MISMATCH');
   seen.add(item.email.toLowerCase());
   if(typeof item.status!=='string'||!['syntax_valid','domain_exists','mx_found','smtp_valid','is_catch_all','is_disposable','is_role_based','is_spamtrap'].every(k=>Object.hasOwn(item,k)&&(item[k]===null||typeof item[k]==='boolean'))||typeof item.risk_type!=='string')throw Error('COLLECTION_VERIFIER_CONTRACT_INCOMPLETE');
   if(item.status==='valid'&&['syntax_valid','domain_exists','mx_found','smtp_valid'].some(k=>item[k]===null))throw Error('COLLECTION_VERIFIER_CONTRACT_MISSING_AFFIRMATIVE_EVIDENCE');
   if(timestamp(item.verified_at)>timestamp(receivedAt))throw Error('COLLECTION_FUTURE_OBSERVATION');
  }
  if(seen.size!==targets.length)throw Error('COLLECTION_VERIFIER_MISSING_TARGET_RESULT');
 }
 return {id,actor,sourceRef,receivedAt,targets,rawRun:run.raw,rawResults:results.raw,run:r,results:d};
}

export function recordCollectionEvidence(db,input){
 const evidence=validateCollectionEvidence(input),value={...evidence,hash:hash(evidence)};
 return atomic(db,()=>{
  const old=getRecord(db,'collection_evidence',input.id);
  if(old){if(old.hash!==value.hash)throw Error('COLLECTION_EVIDENCE_IMMUTABLE');return old;}
  const duplicates=db.prepare("SELECT data_json FROM records WHERE kind='collection_evidence'").all().map(r=>JSON.parse(r.data_json));
  if(duplicates.some(e=>e.run.runId===value.run.runId&&e.results.datasetId===value.results.datasetId))throw Error('COLLECTION_RUN_ALREADY_INGESTED');
  putRecord(db,'collection_evidence',input.id,value,'provider_result');
  journal(db,'COLLECTION_EVIDENCE_RECORDED',input.id,{hash:value.hash,actor:value.actor,runId:value.run.runId,datasetId:value.results.datasetId,items:value.results.items.length,sourceRef:value.sourceRef});return value;
 });
}

function buildInput(db,spec){
 const input=structuredClone(spec.input),sources=new Map(),evidence=new Map();
 if(!Array.isArray(spec.evidenceIds)||!spec.evidenceIds.length||spec.evidenceIds.length>100||new Set(spec.evidenceIds).size!==spec.evidenceIds.length||!Array.isArray(spec.mappings)||spec.mappings.length>10000)throw Error('COLLECTION_REFINEMENT_BOUNDS');
 for(const id of spec.evidenceIds){
  const saved=getRecord(db,'collection_evidence',id);if(!saved)throw Error('COLLECTION_EVIDENCE_REQUIRED');
  const {hash:stored,...body}=saved;if(stored!==hash(body))throw Error('COLLECTION_EVIDENCE_INTEGRITY');
  if(timestamp(saved.receivedAt)>timestamp(spec.asOf))throw Error('COLLECTION_AS_OF_PRECEDES_RECEIPT');
  for(const t of saved.targets)if(!input.entities.some(e=>e.id===t.entityId))throw Error('COLLECTION_ENTITY_NOT_IN_INPUT');
  evidence.set(id,saved);
  const base={id:`collection:${id}:provider`,document:saved.results,kind:'PROVIDER_RESULT',originId:`apify:${saved.run.runId}:${saved.results.datasetId}`,url:null,observedAt:saved.run.finishedAt,publishedAt:null,provenance:{evidenceId:id,evidenceHash:saved.hash,sourceRef:saved.sourceRef,pointer:'/results',runId:saved.run.runId,datasetId:saved.results.datasetId}};
  input.sources.push(base);
  if(saved.actor===VERIFIER){
   for(const [i,raw]of saved.results.items.entries())input.verifications.push({email:raw.email,provider:saved.actor,raw,checkedAt:raw.verified_at,method:null,tier:null,sourceId:base.id,pointer:`/items/${i}`});
  }else if(saved.actor===CONTACT){
   for(const [i,item]of saved.results.items.entries()){
    const target=saved.targets.find(t=>url(t.url)===url(item.originalStartUrl));
    const source={...base,id:`collection:${id}:item:${i}`,document:item,url:item.url,provenance:{...base.provenance,pointer:`/results/items/${i}`,originalStartUrl:item.originalStartUrl,referrerUrl:item.referrerUrl??null}};
    input.sources.push(source);sources.set(`${id}:${i}`,source);
    input.retrieval.push({entityId:target.entityId,runId:saved.run.runId,runStatus:saved.run.status,pageStatus:'CONTACT_OUTPUT_ONLY',usable:true,sourceId:source.id,url:item.url,observedAt:saved.run.finishedAt,error:null});
   }
  }else{
   for(const [i,item]of saved.results.items.entries()){
    const usable=item.crawl.requestStatus==='handled'&&typeof item.markdown==='string'&&!!item.markdown.trim();
    input.retrieval.push({entityId:saved.targets[0].entityId,runId:saved.run.runId,runStatus:saved.run.status,pageStatus:item.crawl.requestStatus,usable,sourceId:base.id,url:item.metadata.url,observedAt:item.crawl.loadedAt,error:item.crawl.requestStatus==='failed'?(item.crawl.httpStatusMessage??null):null});
    const source={...base,id:`collection:${id}:item:${i}`,document:item,kind:'DIRECT_PAGE',url:item.metadata.canonicalUrl??item.metadata.url,observedAt:item.crawl.loadedAt,provenance:{...base.provenance,pointer:`/results/items/${i}`}};
    if(usable){input.sources.push(source);sources.set(`${id}:${i}`,source);}
   }
  }
 }
 for(const m of spec.mappings){
  const e=evidence.get(m.evidenceId),source=sources.get(`${m.evidenceId}:${m.itemIndex}`);
  if(!e||![PAGE,CONTACT].includes(e.actor)||!Number.isSafeInteger(m.itemIndex)||!e.targets.some(t=>t.entityId===m.entityId))throw Error('COLLECTION_MAPPING_TARGET_MISMATCH');
  if(!source)throw Error('COLLECTION_PAGE_UNUSABLE');
  let actual;try{actual=sourceValue(source.document,m.pointer);}catch{throw Error('COLLECTION_MAPPING_POINTER_INVALID');}
  if(e.actor===CONTACT){
   const target=e.targets.find(t=>url(t.url)===url(source.document.originalStartUrl));
   if(target?.entityId!==m.entityId)throw Error('COLLECTION_MAPPING_TARGET_MISMATCH');
   if(m.predicate!=='contact'||m.mode!=='REVIEWED'||!/^\/emails\/\d+$/.test(m.pointer)||typeof actual!=='string'||m.value?.email!==actual)throw Error('COLLECTION_CONTACT_ONLY_REVIEWED_EMAIL_MAPPING');
  }
  const claim={entityId:m.entityId,predicate:m.predicate,value:m.value,sourceId:source.id,pointer:m.pointer,mode:m.mode,reviewId:null,entityMatch:'CONFIRMED',eventDate:null,limitations:[]};
  if(m.mode==='DIRECT'){if(canonical(actual)!==canonical(m.value))throw Error('COLLECTION_DIRECT_MAPPING_UNSUPPORTED');}
  else if(m.mode==='REVIEWED'){
   if(m.sourceValueHash!==hash(actual)||typeof m.note!=='string'||!m.note.trim()||typeof m.reviewedBy!=='string'||!m.reviewedBy.trim())throw Error('COLLECTION_REVIEW_MAPPING_REQUIRED');
   const review={entityId:m.entityId,predicate:m.predicate,value:m.value,sourceId:source.id,pointer:m.pointer,sourceValueHash:m.sourceValueHash,note:m.note,reviewedBy:m.reviewedBy};
   claim.reviewId='collection-review:'+hash(review);input.reviews.push({id:claim.reviewId,...review});
  }else throw Error('COLLECTION_MAPPING_MODE_UNSUPPORTED');
  input.claims.push(claim);
 }
 return input;
}

export function refineCollectedEvidence(db,spec){
 required(spec.id);timestamp(spec.asOf);const specHash=hash(spec);
 return atomic(db,()=>{
  const old=getRecord(db,'collection_refinement',spec.id);
  if(old){if(old.specHash!==specHash)throw Error('COLLECTION_REFINEMENT_IMMUTABLE');return {id:spec.id,evidenceIds:old.evidenceIds,briefs:old.briefHashes.map(h=>({...getRecord(db,'business_brief',h),hash:h}))};}
  const input=buildInput(db,spec),briefs=refineBusinessBrief(db,{input,policy:spec.policy,asOf:spec.asOf,observationId:'collection:'+spec.id});
  putRecord(db,'collection_refinement_input',spec.id,{input,policy:spec.policy,asOf:spec.asOf,specHash},'assessment');
  putRecord(db,'collection_refinement',spec.id,{specHash,evidenceIds:spec.evidenceIds,briefHashes:briefs.map(b=>b.hash),createdAt:now()},'assessment');
  journal(db,'COLLECTION_REFINED',spec.id,{evidenceIds:spec.evidenceIds,briefHashes:briefs.map(b=>b.hash)});
  return {id:spec.id,evidenceIds:spec.evidenceIds,briefs};
 });
}
