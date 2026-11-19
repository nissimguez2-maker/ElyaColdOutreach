import {canonical,digest} from './values.mjs';

// These are the preserved source revisions actually inspected for the curated mappings.
// Changed files may supply new assertions, but cannot inherit these manual reviews.
const reviewedSourceRevisions={
 'original/philadelphia-discovery-record.json':'57efd95c3cf563313b7ea43f2998208b1887099eb57c9f9e071528e178847edd',
 'original/philadelphia-evidence-summary.json':'f9222b5bf11fb4ec786c35ad0d376176ee788a65246374dafb2b9f423e8c14cc',
 'original/philadelphia-evidence-ledger.json':'e846c3958ca06f0662a28ac51c5f50325bed18beb75c15b40cb3404b2b39c8ee',
 'work/recovery-research-and-drafts.json':'64d83487530f727abc74280af31ef66a5206516029c4843a77f6bba5f1f285a8'
};
const reviewedSanitizedContent={
 'original/philadelphia-discovery-record.json':'5c152d4910c3439bdeeff667109a9c51be04a9eb1318cff71e6ec84beb12e6a0',
 'original/philadelphia-evidence-summary.json':'0dedec335d1ec999f8ed794f3be6c629eb314080143c6ad4235e9c0d025989a8',
 'original/philadelphia-evidence-ledger.json':'4373415e348d69ebe04a88c759c672c5ba0f8bf8d04711c352f15927b04fb9e4',
 'work/recovery-research-and-drafts.json':'a373e3c3529a941008de984ac9309a599458e89e524ce16ccacdd07004c74ed1'
};

// This adapter maps reviewed local fragments, never fetches pages or executes source text.
// Original source rows and live candidate/contact records are read-only inputs.
export function loadSavedRefinement(db){
 const sourceRows=new Map();
 function saved(id){
  if(!sourceRows.has(id)){
   const row=db.prepare('SELECT id,sha256,content_json FROM sources WHERE id=?').get(id);
   if(!row)throw Error('REFINEMENT_SAVED_SOURCE_MISSING: '+id);
   const data=JSON.parse(row.content_json);
   sourceRows.set(id,{...row,data,contentHash:digest(canonical(data))});
  }
  return sourceRows.get(id);
 }
 const ids={discovery:'original/philadelphia-discovery-record.json',summary:'original/philadelphia-evidence-summary.json',ledger:'original/philadelphia-evidence-ledger.json',recovery:'work/recovery-research-and-drafts.json',verification:'work/two-address-verification-raw.json'};
 const d=saved(ids.discovery).data,s=saved(ids.summary).data,l=saved(ids.ledger).data,r=saved(ids.recovery).data,v=saved(ids.verification).data;
 if(!Array.isArray(d.candidates)||!Array.isArray(s.candidates)||!Array.isArray(l.runs)||!Array.isArray(r.qualification))throw Error('REFINEMENT_SAVED_SHAPE_INVALID');
 const out={entities:[],sources:[],claims:[],reviews:[],verifications:[],conflicts:[],retrieval:[],possibleMatches:[],historicalSummary:s.counts,existingHolds:[],suppressions:[]};
 const sources=new Map(),entityIds=new Set(),contacts=db.prepare("SELECT id,data_json FROM records WHERE kind='contact' ORDER BY id").all().map(x=>JSON.parse(x.data_json));
 const candidates=new Map(db.prepare("SELECT id,data_json FROM records WHERE kind='candidate'").all().map(x=>[x.id,JSON.parse(x.data_json)]));
 function valueAt(document,pointer){
  if(pointer==='')return document;
  return pointer.slice(1).split('/').reduce((x,key)=>x?.[key.replace(/~1/g,'/').replace(/~0/g,'~')],document);
 }
 const origin=url=>{if(!url)return null;try{const u=new URL(url);u.protocol='https:';u.hostname=u.hostname.replace(/^www\./,'');u.hash='';return u.href;}catch{return url;}};
 function fragment(sourceId,pointer,kind,{url=null,observedAt=null,publishedAt=null}={}){
  const row=saved(sourceId),document=valueAt(row.data,pointer);
  if(document===undefined)throw Error('REFINEMENT_SAVED_FRAGMENT_MISSING: '+sourceId+pointer);
  const id='saved:'+digest(canonical({sourceId,pointer,document}));
  if(!sources.has(id)){
   const source={id,document,kind,originId:origin(url)??sourceId,url,observedAt,publishedAt,provenance:{sourceId,sourceHash:row.sha256,pointer}};
   sources.set(id,source);out.sources.push(source);
  }
  return sources.get(id);
 }
 function entity(id,type,name,address=null,domain=null,legacyHold=null){
  if(entityIds.has(id))return;
  entityIds.add(id);out.entities.push({id,type,name,address,domain,identityState:'CONFIRMED',legacyHold});
 }
 function claim(entityId,predicate,value,source,{direct=false,anchors=[],note='',eventDate=null,limitations=[],supported=true,entityMatch='CONFIRMED'}={}){
  const binding={entityId,predicate,value,sourceId:source.id,pointer:''};
  const evidenceText=typeof source.document==='string'?source.document:canonical(source.document);
  const reviewed=supported&&reviewedSourceRevisions[source.provenance.sourceId]===source.provenance.sourceHash&&reviewedSanitizedContent[source.provenance.sourceId]===saved(source.provenance.sourceId).contentHash&&anchors.length>0&&anchors.every(a=>evidenceText.toLowerCase().includes(a.toLowerCase()));
  let reviewId=null;
  if(!direct&&reviewed){
   const review={...binding,sourceValueHash:digest(canonical(source.document)),note};
   reviewId='review:'+digest(canonical(review));out.reviews.push({id:reviewId,...review});
  }
  out.claims.push({...binding,mode:direct?'DIRECT':'REVIEWED',reviewId,entityMatch,eventDate,limitations});
 }
 const domain=c=>{try{return new URL(c.website).hostname.replace(/^www\./,'');}catch{return null;}};
 for(const [i,c]of d.candidates.entries()){
  if(typeof c.candidateId!=='string'||typeof c.business!=='string'||!c.rawRecord)throw Error('REFINEMENT_DISCOVERY_CANDIDATE_INVALID');
  const current=candidates.get(c.candidateId),legacyHold=current?.qualification==='HELD'?current.reason??current.status:null;
  entity(c.candidateId,'BUSINESS',c.business,c.address??null,domain(c),legacyHold);
  const metadata={url:c.sourceUrl??null,observedAt:c.rawRecord.scrapedAt??null};
  const category=fragment(ids.discovery,`/candidates/${i}/category`,'DISCOVERY',metadata);
  claim(c.candidateId,'industry','Restaurant',category,{anchors:[c.category],supported:['Chinese restaurant','Dominican restaurant','Takeout Restaurant','Barbecue restaurant','Italian restaurant','American restaurant','Sushi restaurant','Brewpub','Thai restaurant','Mexican restaurant'].includes(c.category),note:'Reviewed discovery restaurant/brewpub category; not an ownership or financial fact.'});
  if(typeof c.rawRecord.city==='string')claim(c.candidateId,'city',c.rawRecord.city,fragment(ids.discovery,`/candidates/${i}/rawRecord/city`,'DISCOVERY',metadata),{direct:true});
 }
 const pages=new Map();
 for(const [i,run]of l.runs.entries()){
  const result=run.results?.structuredContent??run.results,item=result?.items?.[0];
  if(!item||!item.crawl)throw Error('REFINEMENT_PAGE_RESULT_INVALID');
  const url=item.metadata?.canonicalUrl??item.metadata?.url??run.url,observedAt=item.crawl.loadedAt??null;
  const resultPrefix=`/runs/${i}/results${run.results?.structuredContent?'/structuredContent':''}/items/0`;
  const crawl=fragment(ids.ledger,resultPrefix+'/crawl','PROVIDER_RESULT',{url,observedAt});
  out.retrieval.push({entityId:run.candidateId,runId:run.runId,runStatus:run.status,pageStatus:item.crawl.requestStatus,usable:item.crawl.requestStatus==='handled'&&typeof item.markdown==='string'&&item.markdown.trim().length>0,sourceId:crawl.id,url,observedAt,error:item.crawl.requestStatus==='failed'?(item.crawl.errorMessage??item.crawl.error??item.crawl.httpStatusMessage??null):null});
  if(typeof item.markdown==='string'&&item.crawl.requestStatus==='handled')pages.set(run.index,{source:fragment(ids.ledger,resultPrefix+'/markdown','DIRECT_PAGE',{url,observedAt}),prefix:resultPrefix,item});
 }
 const page=index=>pages.get(String(index))??pages.get(index);
 function mappedPage(index,entityId,predicate,value,anchors,note,extra={}){
  const p=page(index);if(!p)return;
  claim(entityId,predicate,value,p.source,{anchors,note,...extra});
 }
 // The opening article establishes operating BY its publication date, not an exact opening day.
 mappedPage(16,'PHL-12','operatingBy','2023-08-01',['is now open'],'Dated opening coverage establishes operating by 2023-08-01; exact opening day and uninterrupted operation are not established.',{limitations:['Publication date is an upper bound on opening, not exact opening day.']});
 if(page(16))page(16).source.publishedAt=page(16).item.metadata?.jsonLd?.[0]?.['@graph']?.[0]?.datePublished??null;
 mappedPage(4,'PHL-12','service','Wood-fired kitchen',['Wood-fired'],'Official saved page describes an operating feature; no equipment purchase inferred.');
 mappedPage(4,'PHL-12','service','In-house brewing',['brewed in-house'],'Official saved page describes brewing; no financing need inferred.');
 mappedPage(17,'PHL-12','service','Private events with menu planning and room setup',['menu planning','room setup'],'Official saved services page; no booking growth or project assumed.');
 const qmap=new Map(r.qualification.map((q,i)=>[q.id,{q,i}]));
 function qs(id,field,url=null){const found=qmap.get(id);if(!found)throw Error('REFINEMENT_QUALIFICATION_MISSING');return fragment(ids.recovery,`/qualification/${found.i}/${field}`,'SAVED_SUMMARY',{url,observedAt:r.date??null});}
 const limited=['Source-linked saved research summary; no original page fetched by this processor.'];
 claim('PHL-12','independent',true,qs('PHL-12','independence','https://m2ohospitalitygroup.com/about'),{anchors:['family-run regional M2O group'],note:'Preserved public-source classification, not legal ownership audit. Independent local groups are permitted.',limitations:limited});
 entity('GROUP-M2O','GROUP','M2O Hospitality Group',null,'m2ohospitalitygroup.com');
 claim('PHL-12','relationship',{type:'OPERATED_BY',targetId:'GROUP-M2O'},qs('PHL-12','independence','https://m2ohospitalitygroup.com/about'),{anchors:['M2O group'],note:'Explicit saved group relationship; does not merge restaurant and parent.',limitations:limited});
 for(const [name,role]of [['Jim Osmanollaj','Development and operations'],['Leo Osmanollaj','Brand and growth'],['Pep Osmanollaj','Finance and systems']]){
  const personId='PERSON-'+name.toUpperCase().replace(/ /g,'-');entity(personId,'PERSON',name);
  const fact=fragment(ids.summary,'/toskaFacts/2','SAVED_SUMMARY',{url:'https://m2ohospitalitygroup.com/about',observedAt:s.date??null});
  mappedPage(16,'PHL-12','personRole',{personId,name,role:'Owner brother (opening coverage)'},['Owners and brothers Jim, Leo, and Pep Osmanollaj'],'Saved opening coverage supports each named owner brother. Current legal ownership and direct mailbox control are not established.',{limitations:['Historical owner identity from 2023 opening coverage; not a present legal ownership audit.']});
  claim('GROUP-M2O','personRole',{personId,name,role},fact,{anchors:[name.split(' ')[0]],note:'Same person can lead several operations; group relationship does not merge businesses.',limitations:limited});
 }
 claim('PHL-13','operatingBy','2017-12-31',qs('PHL-13','age','https://www.visitphilly.com/articles/philadelphia/the-breweries-brewpubs-and-craft-beer-trail-of-greater-philadelphia/'),{anchors:['2017 opening supported'],note:'Year-only opening summary; conservative year-end bound, not an exact opening day.',limitations:[...limited,'Exact opening month/day not established.']});
 claim('PHL-13','independent',true,qs('PHL-13','independence','https://www.chestnuthillbrewingcompany.com/about/'),{anchors:['founders/co-owners','small and family-owned'],note:'Indexed official content in saved summary; original page access had failures. No franchise/legal audit claimed.',limitations:limited});
 for(const name of ['Nick Gunderson','Lindsey Pete']){
  const personId='PERSON-'+name.toUpperCase().replace(/ /g,'-');entity(personId,'PERSON',name);
  claim('PHL-13','personRole',{personId,name,role:'Founder/co-owner'},qs('PHL-13','independence','https://www.chestnuthillbrewingcompany.com/about/'),{anchors:[name,'founders/co-owners'],note:'Saved summary attributes official About role; identity separate from mailbox control.',limitations:limited});
 }
 for(const [j,fact]of (qmap.get('PHL-13')?.q.copyFacts??[]).entries()){
  if(j>=3)break;
  const source=fragment(ids.recovery,`/qualification/${qmap.get('PHL-13').i}/copyFacts/${j}`,'SAVED_SUMMARY',{url:'https://www.chestnuthillbrewingcompany.com/beer-garden/',observedAt:r.date??null});
  claim('PHL-13','service',fact,source,{anchors:[fact],note:'Curated saved service fact; underlying page not re-fetched.',limitations:[...limited,'No growth, planned purchase, or funding need established.']});
 }
 claim('PHL-11','operatingBy','2015-02-11',qs('PHL-11','age','https://www.paeats.org/news/2015/7-restaurants-celebrate-valentines-day-chestnut-hill/'),{anchors:['2015-02-11','7830 Germantown'],note:'Saved research matched dated coverage by address and phone. Establishes operating by article date, not exact opening.',limitations:limited});
 claim('PHL-11','independent',true,qs('PHL-11','independence'),{supported:false,note:'Directory claims explicitly judged insufficient in saved assessment.',limitations:['Editorial provenance unclear; independence unresolved.']});
 for(const name of ['Jim','Jin'])claim('PHL-11','ownerName',name,qs('PHL-11','ownerIdentity'),{supported:false,entityMatch:'POSSIBLE',limitations:['Conflicting wording; no person identity assigned.']});
 out.conflicts.push({entityId:'PHL-11',kind:'OWNER_IDENTITY',description:'Saved research records Jim/Jin wording conflict; no confident merger or owner assignment.',sourceIds:[qs('PHL-11','ownerIdentity').id]});
 mappedPage(13,'PHL-07','openingYear',1996,['since 1996'],'Official body says since 1996; metadata gives conflicting 1997. Do not assert a precise anniversary.');
 if(page(13)){
  const p=page(13),meta=fragment(ids.ledger,p.prefix+'/metadata/description','DIRECT_PAGE',{url:p.source.url,observedAt:p.source.observedAt});
  claim('PHL-07','openingYear',1997,meta,{anchors:['Established in 1997'],note:'Conflicting metadata assertion retained separately from body1996.'});
  claim('PHL-07','operatingBy','1997-12-31',meta,{anchors:['Established in 1997'],note:'Even the later of two asserted years supports the two-year threshold; exact year remains conflicted.',limitations:['Body1996 vs metadata1997; stale nearly25years wording is not current precise age.']});
 }
 // Known locations remain separate nodes; a shared domain never merges them.
 for(const id of ['PHL-07','PHL-10','PHL-11','PHL-12','PHL-13']){
  const index=d.candidates.findIndex(c=>c.candidateId===id),c=d.candidates[index],locationId=id+'-LOCATION';
  entity(locationId,'LOCATION',c.business+' — '+c.address,c.address,domain(c));
  const addressSource=fragment(ids.discovery,`/candidates/${index}/address`,'DISCOVERY',{url:c.sourceUrl,observedAt:c.rawRecord.scrapedAt??null});
  claim(id,'relationship',{type:'HAS_LOCATION',targetId:locationId},addressSource,{anchors:[c.address],note:'Explicit discovery address bound to this candidate; not a domain-based merger.'});
 }
 const chestnutAddress=qs('PHL-13','addressMatch');
 entity('PHL-13-TAPROOM','LOCATION','Chestnut Hill Brewing taproom','8231 Germantown Avenue, Philadelphia',domain(d.candidates.find(c=>c.candidateId==='PHL-13')));
 claim('PHL-13','relationship',{type:'HAS_LOCATION',targetId:'PHL-13-TAPROOM'},chestnutAddress,{anchors:['8231 taproom','Same domain and concept'],note:'Saved address/concept matching supports separate beer-garden and taproom locations.',limitations:limited});
 for(const c of contacts){
  const q=qmap.get(c.candidateId),index=s.contacts.findIndex(x=>x.email.toLowerCase()===c.email.toLowerCase());
  let source,classification,personId=null,anchors;
  if(q){source=fragment(ids.recovery,`/qualification/${q.i}`,'SAVED_SUMMARY',{url:q.q.sources?.[0]??null,observedAt:r.date??null});anchors=[q.q.attribution,c.email];}
  else if(index>=0){source=fragment(ids.summary,`/contacts/${index}`,'SAVED_SUMMARY',{observedAt:s.date??null});anchors=[s.contacts[index].attribution,c.email];}
  else throw Error('REFINEMENT_CONTACT_PROVENANCE_MISSING');
  if(c.candidateId==='PHL-12')classification='GROUP_SHARED';
  else if(c.candidateId==='PHL-11')classification='GENERAL_BUSINESS';
  else if(c.candidateId==='PHL-13'){classification='DIRECT_PERSON';personId='PERSON-LINDSEY-PETE';}
  else classification='UNATTRIBUTED';
  claim(c.candidateId,'contact',{email:c.email.toLowerCase(),class:classification,personId},source,{anchors,note:'Explicit stored contact and attribution mapping; no mailbox deliverability or current controller claim.',limitations:classification==='DIRECT_PERSON'?[...limited,'Business-published email in June2020 PDF; person link from AllBiz; present mailbox controller unknown.']:limited});
  if(c.candidateId==='PHL-12')claim('GROUP-M2O','contact',{email:c.email.toLowerCase(),class:'GROUP_SHARED',personId:null},source,{anchors,note:'Shared group inbox; not a personal owner email.',limitations:limited});
  if(c.verification?.includes('HELD'))out.existingHolds.push({email:c.email.toLowerCase(),reason:c.verification});
  out.suppressions.push({email:c.email.toLowerCase(),state:c.suppressed===true?'SUPPRESSED':c.suppressed===false?'CLEAR':'UNKNOWN'});
 }
 const verificationResult=v.results?.structuredContent??v.results,run=v.run?.structuredContent??v.run;
 if(!Array.isArray(verificationResult?.items))throw Error('REFINEMENT_VERIFICATION_SHAPE_INVALID');
 for(const [i,raw]of verificationResult.items.entries()){
  const pointer=`/results${v.results?.structuredContent?'/structuredContent':''}/items/${i}`;
  const source=fragment(ids.verification,pointer,'PROVIDER_RESULT',{observedAt:raw.verified_at??null});
  out.verifications.push({email:raw.email,provider:run.actorName,raw,checkedAt:raw.verified_at??null,method:null,tier:null,sourceId:source.id,pointer:''});
 }
 const dns=fragment(ids.recovery,'/independentDnsDiagnosis','SAVED_SUMMARY');
 if(r.independentDnsDiagnosis?.domainExists===true&&r.independentDnsDiagnosis?.mxPresent===true){
  const checked=out.verifications.find(x=>x.email==='main@m2ogroup.com');
  out.conflicts.push({entityId:'PHL-12',kind:'VERIFIER_DNS_CONTRADICTION',description:'Verifier says domain does not exist; later local MX/SOA lookup found domain and MX. This does not validate the mailbox. Original DNS time range preserved in source.',sourceIds:[dns.id,...(checked?[checked.sourceId]:[])]});
 }
 canonical(out);return out;
}
