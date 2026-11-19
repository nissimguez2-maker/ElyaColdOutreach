// Curated saved-output adapter. It never fetches, generates, verifies, or approves copy.
import {readFileSync} from 'node:fs';
import {getRecord,putRecord,transaction} from './store.mjs';
import {canonical,digest,timestamp} from './values.mjs';
import {prepareWritingReview} from './writing.mjs';

export const WRITING_CAMPAIGN='339a5dbc-075c-4745-9a38-c11a26c5d920';
const reviewedSources={
 'original/philadelphia-evidence-ledger.json':['e846c3958ca06f0662a28ac51c5f50325bed18beb75c15b40cb3404b2b39c8ee','4373415e348d69ebe04a88c759c672c5ba0f8bf8d04711c352f15927b04fb9e4'],
 'work/recovery-research-and-drafts.json':['64d83487530f727abc74280af31ef66a5206516029c4843a77f6bba5f1f285a8','a373e3c3529a941008de984ac9309a599458e89e524ce16ccacdd07004c74ed1'],
 'work/synthetic-qa-created-record.json':['b1917fd4fab004dc891490cac7eebf27875cac5e2da7b13bce8a9b88584b09c5','87e69cb522f7701d95134a5b9686dc99f7b765cd6a5d875085af110687ba2208']
};
function source(db,id){
 const r=db.prepare('SELECT sha256,content_json FROM sources WHERE id=?').get(id);
 if(!r)throw Error('WRITING_SOURCE_MISSING');
 const data=JSON.parse(r.content_json),pins=reviewedSources[id];
 if(!pins||r.sha256!==pins[0]||digest(canonical(data))!==pins[1])throw Error('WRITING_SOURCE_CHANGED_REVIEW_REQUIRED');
 return {data,originalSha256:r.sha256,sanitizedContentHash:pins[1],sourceId:id};
}
function immutable(db,kind,id,data){const old=getRecord(db,kind,id);if(old&&canonical(old)!==canonical(data))throw Error('WRITING_SAVED_VERSION_CONFLICT');if(!old)putRecord(db,kind,id,data,'assessment');}
const finding=(code,detail,severity='REVIEW')=>({code,detail,severity});

export function prepareSavedWritingReviews(db,asOf){
 timestamp(asOf);
 const commit=()=>{
  const ledger=source(db,'original/philadelphia-evidence-ledger.json'),recovery=source(db,'work/recovery-research-and-drafts.json'),qa=source(db,'work/synthetic-qa-created-record.json');
  const brain=db.prepare("SELECT sha256 FROM sources WHERE id='brain'").get();
  if(brain?.sha256!=='68cb6fdacc33cd4301ca043eb893d17ecc3881098ed74dc3112e25873f8b5708')throw Error('WRITING_BRAIN_VERSION_UNREVIEWED');
  const excerptBytes=readFileSync(new URL('../work/writing/retained-stage-a-excerpts.json',import.meta.url));
  if(digest(excerptBytes)!=='3a0bd9f616a55b1da4f55104c5eaf098aa6717fd6359d9d8ca5204dae3feac8e')throw Error('WRITING_SOURCE_EXCERPTS_CHANGED');
  const excerpts=JSON.parse(excerptBytes);
  const evidence=(id,text,provenance)=>{immutable(db,'writing_evidence',id,{text,...provenance});return {kind:'writing_evidence',id,pointer:'/text'};};
  const fromSource=(id,s,pointer,text,classification,url,observedAt)=>{
   evidence(id,text,{sourceId:s.sourceId,sourcePointer:pointer,sourceSha256:s.originalSha256,sourceContentHash:s.sanitizedContentHash,evidenceClass:classification,url,observedAt,publishedAt:null,assertionUpdatedAt:null});
   // Bind the upstream imported source itself, not just our derived excerpt record.
   return {kind:'source',id:s.sourceId,pointer,evidenceClass:classification,url,observedAt,publishedAt:null,assertionUpdatedAt:null};
  };
  const portfolio=fromSource('saved-m2o-portfolio-v1',ledger,'/runs/7/results/items/0/markdown',ledger.data.runs[7].results.items[0].markdown,'DIRECT_PAGE','https://m2ohospitalitygroup.com/',ledger.data.runs[7].results.items[0].crawl.loadedAt);
  const about=fromSource('saved-m2o-about-v1',ledger,'/runs/14/results/items/0/markdown',ledger.data.runs[14].results.items[0].markdown,'DIRECT_PAGE','https://m2ohospitalitygroup.com/about',ledger.data.runs[14].results.items[0].crawl.loadedAt);
  const ch=recovery.data.qualification[1];
  const taproom=fromSource('saved-chestnut-taproom-v1',recovery,'/qualification/1/addressMatch',ch.addressMatch,'SAVED_SUMMARY','https://www.chestnuthillbrewingcompany.com/beer-garden/',recovery.data.date);
  const beer=evidence('stage-a-chestnut-beer-excerpt-v1',excerpts.sources[0].excerpt,{...excerpts.sources[0],evidenceClass:excerpts.sources[0].sourceClass,observationWindow:excerpts.originalObservationWindow,rawHtmlAvailable:false,sourceFile:'work/writing/retained-stage-a-excerpts.json',sourceSha256:digest(excerptBytes)});
  const catering=evidence('stage-a-chestnut-catering-excerpt-v1',excerpts.sources[1].excerpt,{...excerpts.sources[1],evidenceClass:excerpts.sources[1].sourceClass,observationWindow:excerpts.originalObservationWindow,rawHtmlAvailable:false,sourceFile:'work/writing/retained-stage-a-excerpts.json',sourceSha256:digest(excerptBytes)});
  const role=getRecord(db,'external_observation','planning-assistant-chestnut-about-2026-11-16');
  if(role?.provenance!=='ASSISTANT_REPORTED_EXTERNAL_OBSERVATION'||role.runnerFetched!==false||role.rawPageArtifact!==null)throw Error('WRITING_EXTERNAL_OBSERVATION_PROVENANCE_REQUIRED');
  const roleRef={kind:'external_observation',id:'planning-assistant-chestnut-about-2026-11-16',pointer:'/text'};
  const policy={revision:'restaurant-writing-v1',campaignId:WRITING_CAMPAIGN,synthetic:false,
   sender:{name:'Daniel Rosen',title:'Head of Operations and Underwriting',company:'Elya Partners'},approver:'Daniel Rosen',
   sequence:{steps:3,cadenceApproved:false,endpointApproved:false},physicalAddressApproved:false,optOutApproved:false,
   writingInstructions:['Funding/financing introduction; do not lead with broker wording or claim direct lending','First touch about 70–110 words or shorter if stronger; one easy question','Facts shape angle; 3–4 details when useful, not a mechanical quota per message','Separate known operations from hypothetical funding use; no invented need, eligibility, relationship, approval or terms','Generic/group inbox addressed as business/team; no personal owner-email inference','Follow-ups add useful information; no preliminary project budgets or document requests'],
   prohibited:['Invented funding need, purchases, expansion or financial pressure','Unsubstantiated approval, guaranteed terms, rates, timelines or refinancing','False prior contact/application','Current-event urgency inferred from a year-only timeline'],
   generation:{mode:'SAVED_OUTPUT_ONLY',liveModelCalls:0,futureInterface:'A later authorized generator receives the versioned policy and evidence brief and returns candidate subject/body plus fact links, hypotheses and unknowns; generated output is untrusted and requires the same review contract.'},
   rendering:{variables:['pilot_subject_1','pilot_body_1','pilot_subject_2','pilot_body_2','pilot_subject_3','pilot_body_3'],existingMilestone:qa.data.renderingMilestone,sourceHash:qa.sanitizedContentHash,newRenderingTestPerformed:false},
   provenance:[{source:'User explicit six-email revision',attachment:'5cf65c00-510d-46e4-80ed-24b4104f0ba7',section:'REVISE THE SIX EMAILS'},{source:'User-designated Cold Outreach Brain',sha256:brain.sha256,sections:'1–15; Appendix A is context only'},{source:'Current offline writing assignment',attachment:'7df0db43-c944-4dc6-abea-9efcc687c373'}],
   budget:{existingGptSubscriptionExcluded:true,spendingAuthority:false}};
  immutable(db,'writing_policy',WRITING_CAMPAIGN,policy);
  const fact=(id,text,ref,excerpt,usage='CONTEXT')=>({id,text,source:{...ref,excerpt},usage,eventDate:null});
  const drafts=id=>[1,2,3].map(step=>`${id}:v2:step${step}`);
  const unknowns=['No established financing need, purchase, revenue, eligibility, approved offer or terms','No verified mailbox control; existing contact hold remains','Suppression clearance unknown','Sending cadence, finite endpoint, physical-address footer and operational opt-out approval remain outstanding'];
  const tosDrafts=drafts('PHL-12'),chDrafts=drafts('PHL-13');
  const specs=[{
   reviewId:'PHL-12-writing-v2',campaignId:WRITING_CAMPAIGN,candidateId:'PHL-12',email:'main@m2ogroup.com',draftIds:tosDrafts,asOf,synthetic:false,recipient:{class:'GROUP_SHARED',greeting:'Hi M2O team,'},
   facts:[fact('mixed-concepts','M2O operates fast-casual and full-service concepts including Töska brewery.',portfolio,'a portfolio of fast-casual and full-service concepts'),fact('pep-finance','Pep is listed for finance and systems.',about,'Finance & systems\n\n### Pep'),fact('wrapd-2026','Official timeline places WRAPD joining the portfolio in 2026; no exact event date.',about,"**2026**\n\nWRAPD joins the portfolio and Spoon'D prepares to welcome Newark.",'HISTORICAL'),fact('openings-2025','Official timeline places Balboa Steaks and Founding Brothers openings in 2025.',about,'**2025**\n\nBalboa Steaks and Founding Brothers open on Main Street Newark.','HISTORICAL')],
   salesHypotheses:['A multi-concept group may value a funding contact for comparing options; this is not evidence of a current need'],unknowns:[...unknowns,'Exact WRAPD event date and recency are unknown; group inbox is not Pep’s personal mailbox'],
   steps:[{draftId:tosDrafts[0],factIds:['mixed-concepts','pep-finance','wrapd-2026'],angle:'Group-level funding flexibility; relevant to shared group inbox',findings:[finding('EVENT_RECENCY_UNESTABLISHED','Especially with WRAPD joining can imply timeliness. Timeline establishes 2026 only; human review must keep historical/contextual framing, not a recent funding trigger.')]},{draftId:tosDrafts[1],factIds:['openings-2025','wrapd-2026','pep-finance'],angle:'Adds lender/process discussion across concepts',findings:[finding('RELATIVE_YEAR_2026','This year is bound to the 2026 review, not a reusable timeless statement.'),finding('EVENT_RECENCY_UNESTABLISHED','No evidence dates the 2026 portfolio event within 90 days.')]},{draftId:tosDrafts[2],factIds:[],angle:'Practical offer-comparison value and a low-pressure close',findings:[finding('FINITE_ENDPOINT_UNAPPROVED','One final note depends on approving a finite endpoint; copy alone does not approve cadence.')]}]
  },{
   reviewId:'PHL-13-writing-v2',campaignId:WRITING_CAMPAIGN,candidateId:'PHL-13',email:'lindsey@chbrewing.com',draftIds:chDrafts,asOf,synthetic:false,recipient:{class:'DIRECT_PERSON',greeting:'Hi Lindsey,'},
   facts:[fact('founders','Official publication identifies Nick Gunderson and Lindsey Pete as founders/co-owners; observation reported by planning assistant.',roleRef,'Nick Gunderson: Founder/Co-Owner; Lindsey Pete: Founder/Co-Owner'),fact('on-site-brewing','Beer is brewed on site.',beer,'Our beer is brewed on site in a 5BBL system'),fact('year-round','Beer garden is described as open year-round.',beer,'Open year-round'),fact('taproom','Saved identity match includes the 8231 Germantown Avenue taproom.',taproom,'8231 taproom'),fact('catering','Indexed official content offers corporate catering; current availability not reconfirmed.',catering,'Chestnut Hill Corporate Catering')],
   salesHypotheses:['Multiple service formats may make a funding-options introduction relevant if a need develops; no current purchase or cash pressure inferred'],unknowns:[...unknowns,'New official role-publication observation does not establish assertion update date, current email use or mailbox control','Catering source publication date unknown; search-index crawl five months old'],
   steps:[{draftId:chDrafts[0],factIds:['founders','on-site-brewing','year-round','taproom'],angle:'Funding flexibility across a supported operating model',findings:[finding('ROLE_PUBLICATION_NOT_MAILBOX_CONTROL','Named greeting is supported for copy review; contact remains held, and source update date is unknown.')]},{draftId:chDrafts[1],factIds:['catering','on-site-brewing','year-round'],angle:'Catering adds a service-specific reason for the introduction',findings:[finding('CATERING_CURRENT_AVAILABILITY_UNCONFIRMED','Source is indexed official content; no recent assertion date or fresh availability confirmation.'),finding('SAVED_WORDCOUNT_DIFFERENCE','Saved count is 70; independent whitespace count is 66. Original metadata preserved.','NOTE')]},{draftId:chDrafts[2],factIds:['founders'],angle:'Conditional comparison of an actual future offer; respectful sequence close',findings:[finding('FINITE_ENDPOINT_UNAPPROVED','Last note for now is not sending-cadence or endpoint authorization.')]}]
  }];
  return {policyRevision:policy.revision,packets:specs.map(s=>prepareWritingReview(db,s)),liveCalls:0,originalDraftsUnchanged:true};
 };
 return db.isTransaction?commit():transaction(db,commit);
}
