// Deterministic plain-text checks only. No entity inference, rewriting or approval.
export const DRAFT_STYLE_VERSION='elya-draft-style-v2';
export const DRAFT_STYLE_INSTRUCTIONS=[
 'RULE 0: Never use an em dash (Unicode U+2014) anywhere in an outreach draft, including the subject, body, signature and footer. Rewrite naturally; do not mechanically substitute another punctuation mark.',
 'NAME LIMITS: Each PROSPECT person or PROSPECT business may be mentioned at most twice, and all prospect-person/business mentions combined at most three per draft. Count prospect mentions across the subject, greeting and body. Exclude only the exact configured standard sender signature and an exact approved mandatory legal footer. Arbitrary body text cannot be labeled as a signature or footer. Sender identities are outside this prospect-personalization budget; sender-company references in the body still require semantic redundancy review. Match case-insensitively using the supplied known-name catalog and explicit aliases. Count a full name once, without double-counting overlapping short-name matches. Do not evade limits through spelling changes or unnatural substitutions. Flag ambiguous or unlisted entities for semantic review; known-name checks are not perfect entity detection.',
 'HUMAN WRITING: Preserve supported business-specific personalization. Remove redundant introductions, repeated ideas, generic praise and forced financing connections. Never invent a visit, customer experience, familiarity, admiration or funding need. Critical review must check prospect-name limits and sender-company redundancy separately, and check U+2014 throughout the subject, body, signature and legal footer. Passing deterministic punctuation/name checks does not establish naturalness, factual support or persuasive quality.'
];
const normalize=s=>s.normalize('NFC').toLowerCase().replace(/\s+/gu,' ').trim();
const escape=s=>s.replace(/[.*+?^${}()|[\]\\]/g,'\\$&');
export function resolveDraftStylePolicy(spec,snapshot){
 const entities=new Map();
 function add(kind,name,aliases=[],scope='PROSPECT'){
  if(!['PERSON','BUSINESS'].includes(kind)||typeof name!=='string'||!name.trim()||!Array.isArray(aliases)||aliases.some(a=>typeof a!=='string'||!a.trim()))throw Error('DRAFT_NAME_CATALOG_INVALID');
  const key=kind+':'+normalize(name),old=entities.get(key)??{kind,name:name.trim(),aliases:[],scope};
  if(old.scope!==scope)old.scope='AMBIGUOUS';
  old.aliases=[...new Map([...old.aliases,...aliases].filter(a=>normalize(a)!==normalize(old.name)).map(a=>[normalize(a),a.trim()])).values()];entities.set(key,old);
 }
 const s=snapshot.policy?.sender;
 if(s?.name)add('PERSON',s.name,[],'SENDER');if(s?.company)add('BUSINESS',s.company,[],'SENDER');
 if(snapshot.candidate?.name)add('BUSINESS',snapshot.candidate.name);
 for(const p of snapshot.assessment?.personIdentity??[])if(p.value?.name)add('PERSON',p.value.name);
 for(const f of spec.facts??[])for(const key of ['brand','organization'])if(f.entity?.[key])add('BUSINESS',f.entity[key]);
 if(spec.knownNames!==undefined&&!Array.isArray(spec.knownNames))throw Error('DRAFT_NAME_CATALOG_INVALID');
 for(const e of spec.knownNames??[]){if(!e||Object.keys(e).some(k=>!['kind','name','aliases'].includes(k))||typeof e.name!=='string')throw Error('DRAFT_NAME_CATALOG_INVALID');add(e.kind,e.name,e.aliases??[],entities.get(e.kind+':'+normalize(e.name))?.scope??'PROSPECT');}
 const footer=snapshot.policy?.mandatoryLegalFooter;
 if(footer?.approved===true&&footer.mandatory===true&&(typeof footer.text!=='string'||!footer.text.trim()))throw Error('MANDATORY_LEGAL_FOOTER_TEXT_REQUIRED');
 return {version:DRAFT_STYLE_VERSION,countScope:'PROSPECT_ONLY',knownNames:[...entities.values()],requiredSignature:[s?.name,s?.title,s?.company].filter(Boolean).join('\n'),mandatoryLegalFooter:footer?.approved===true&&footer.mandatory===true?footer.text:null,perEntityMaximum:2,combinedMaximum:3,coverage:'KNOWN_NAMES_ONLY_SEMANTIC_REVIEW_REQUIRED'};
}
export function checkDraftStyle(draft,policy){
 if(typeof draft.subject!=='string'||typeof draft.body!=='string'||policy?.version!==DRAFT_STYLE_VERSION)throw Error('DRAFT_STYLE_INPUT_REQUIRED');
 const findings=[],ambiguities=[],mentions=[],counts=policy.knownNames.map(e=>({...e,count:0}));
 const add=(code,severity,detail)=>findings.push({code,severity,detail});
 const emDashCount=(draft.subject.match(/\u2014/g)??[]).length+(draft.body.match(/\u2014/g)??[]).length;
 if(emDashCount)add('EM_DASH_FORBIDDEN','BLOCK',`${emDashCount} U+2014 character(s) in subject/body including signature/footer; rewrite naturally.`);
 let body=draft.body,footerExclusion='NONE',signatureExclusion='NONE';
 if(policy.mandatoryLegalFooter){
  const suffix='\n\n'+policy.mandatoryLegalFooter;
  const signaturePattern=policy.requiredSignature?.trim().split(/\s+/u).map(escape).join('\\s+');
  const signatureOverlap=signaturePattern&&body.endsWith(suffix)&&[...body.matchAll(new RegExp(signaturePattern,'giu'))].some(m=>m.index+m[0].length>body.length-policy.mandatoryLegalFooter.length);
  if(signatureOverlap)add('LEGAL_FOOTER_SIGNATURE_OVERLAP','REVIEW','The proposed footer exemption overlaps the required signature; no names were excluded.');
  else if(body.endsWith(suffix)&&body.slice(0,-suffix.length).trim()){body=body.slice(0,-suffix.length);footerExclusion='EXACT_APPROVED_MANDATORY_SUFFIX';}
  else add('LEGAL_FOOTER_UNMATCHED','REVIEW','Approved mandatory footer is not an exact separate trailing block; no names were excluded.');
 }
 // Only the configured sender fields define this exact final block. Draft labels
 // cannot supply exemption text. Strip after the independently approved footer.
 if(policy.requiredSignature){const suffix='\n\n'+policy.requiredSignature;if(body.endsWith(suffix)&&body.slice(0,-suffix.length).trim()){body=body.slice(0,-suffix.length);signatureExclusion='EXACT_CONFIGURED_STANDARD_SUFFIX';}}
 for(const [field,raw]of [['subject',draft.subject],['body',body]]){
  const text=raw.normalize('NFC'),matches=[];
  if(/<\/?[a-z][^>]*>|&(?:#\d+|#x[0-9a-f]+|[a-z]+);|\p{Cf}/iu.test(text))ambiguities.push({field,reason:'MARKUP_ENCODING_OR_INVISIBLE_CHARACTER_REQUIRES_RENDERED_REVIEW'});
  const addresses=[...text.matchAll(/(?:https?:\/\/\S+|[\p{L}\p{N}._%+\-]+@[\p{L}\p{N}.\-]+)/gu)].map(m=>({start:m.index,end:m.index+m[0].length}));
  for(const [entity,e]of counts.entries())for(const alias of new Set([e.name,...e.aliases])){
   const pattern=alias.normalize('NFC').trim().split(/\s+/u).map(escape).join('\\s+');
   for(const m of text.matchAll(new RegExp('(?<![\\p{L}\\p{N}\\p{M}_])'+pattern+'(?![\\p{L}\\p{N}\\p{M}_])','giu')))matches.push({entity,start:m.index,end:m.index+m[0].length});
  }
  matches.sort((a,b)=>a.start-b.start||b.end-a.end);
  const groups=[];
  for(const m of matches){const last=groups.at(-1);if(last&&m.start<last.end){last.matches.push(m);last.end=Math.max(last.end,m.end);}else groups.push({start:m.start,end:m.end,matches:[m]});}
  for(const g of groups){
   const ids=[...new Set(g.matches.map(m=>m.entity))],enclosing=[...new Set(g.matches.filter(m=>m.start===g.start&&m.end===g.end).map(m=>m.entity))],inAddress=addresses.some(a=>g.start<a.end&&g.end>a.start);
   // A complete longest name takes precedence over contained short aliases.
   const scopeConflict=enclosing.length===1&&counts[enclosing[0]].scope==='AMBIGUOUS';
   if(enclosing.length!==1||inAddress||scopeConflict){ambiguities.push({field,start:g.start,end:g.end,candidateNames:ids.map(i=>counts[i].name),reason:inAddress?'NAME_IN_ADDRESS_OR_URL':scopeConflict?'SENDER_PROSPECT_CANONICAL_COLLISION':enclosing.length>1?'SHARED_ALIAS_OR_OVERLAPPING_ENTITIES':'PARTIAL_OVERLAP'});}
   else counts[enclosing[0]].count++;
   mentions.push({field,start:g.start,end:g.end,name:enclosing.length===1&&!inAddress&&!scopeConflict?counts[enclosing[0]].name:null,scope:enclosing.length===1&&!inAddress&&!scopeConflict?counts[enclosing[0]].scope:null});
  }
 }
 for(const e of counts)if(e.scope==='PROSPECT'&&e.count>2)add('NAME_ENTITY_LIMIT','BLOCK',`${e.name}: ${e.count} unambiguous prospect mentions; maximum 2.`);
 const knownMentionTotal=counts.filter(e=>e.scope==='PROSPECT').reduce((sum,e)=>sum+e.count,0);
 if(knownMentionTotal>3)add('NAME_TOTAL_LIMIT','BLOCK',`${knownMentionTotal} unambiguous prospect-name mentions; maximum 3 combined. Ambiguous spans are separately flagged for review.`);
 const senderCompanyMentions=mentions.filter(m=>m.field==='body'&&m.scope==='SENDER'&&counts.some(e=>e.scope==='SENDER'&&e.kind==='BUSINESS'&&e.name===m.name)).length;
 if(senderCompanyMentions)add('SENDER_COMPANY_REDUNDANCY_REVIEW',senderCompanyMentions>1?'REVIEW':'NOTE','Sender-company references outside the exact standard signature/footer are not prospect mentions; assess whether they are necessary or redundant.');
 if(ambiguities.length)add('NAME_COUNT_AMBIGUOUS','REVIEW','Known-name counting is ambiguous; review the listed spans/formatting and all unlisted names. Do not infer a perfect entity count.');
 return {version:DRAFT_STYLE_VERSION,countScope:policy.countScope,coverage:policy.coverage,emDashCount,knownMentionTotal,candidateMentionSpanCount:mentions.length,countMeaning:ambiguities.length?'PARTIAL_KNOWN_COUNT_WITH_AMBIGUITIES':'EXACT_FOR_SUPPLIED_NAMES_ONLY',entities:counts,mentions,ambiguities,signatureExclusion,footerExclusion,findings};
}
