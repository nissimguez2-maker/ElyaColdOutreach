import {openStore,putRecord} from '../../src/store.mjs';
import {prepareWritingReview,decideWritingReview} from '../../src/writing.mjs';
import {createBatch,decideApproval} from '../../src/batches.mjs';
import assert from 'node:assert/strict';
export const previewAt='2026-11-18T15:00:00Z';
export function outreachPreviewFixture(path=':memory:',{contact={},candidate={},approved=true,standardFields={company_name:'Fixture Café'},subject=null}={}){
 const db=openStore(path),at=previewAt,candidateId='fixture-business',campaignId='fixture-campaign',email='team@example.org';
 putRecord(db,'candidate',candidateId,{name:'Fixture Café',qualification:'QUALIFIED',operatingStatusCheckedAt:at,...candidate});
 putRecord(db,'contact',email,{candidateId,email,attribution:'Fixture shared business inbox',attributionClass:'GROUP_SHARED',verification:'PASSED',verifiedAt:at,attributionCorroboratedAt:at,suppressed:false,...contact});
 putRecord(db,'campaign',campaignId,{purpose:'prospect',mustRemainInactive:false});
 putRecord(db,'refinement_current',candidateId,{semanticHash:'fixture-assessment',disposition:'QUALIFIED_FOR_REVIEW'});
 putRecord(db,'refinement_assessment',candidateId+':fixture-assessment',{businessFit:{state:'PASS'},contacts:[]});
 putRecord(db,'writing_evidence','fixture-source',{text:'Fixture café offers catering.',observedAt:at});
 putRecord(db,'operational_policy','fixture-freshness',{emailVerification:{daysBeforeFirstRelease:14},contactRoleAttribution:{meaningfulCorroborationDays:90},operatingStatus:{daysBeforeFirstRelease:30},personalization:{timelyEventDays:90}});
 putRecord(db,'settings','current-contact-freshness',{policyKind:'operational_policy',revision:'fixture-freshness'});
 const policy={revision:'fixture-only',sender:{name:'Fixture Sender',title:'Fixture Role',company:'Fixture Company'},approver:'Fixture approver',sequence:{steps:3,cadenceApproved:true,endpointApproved:true},physicalAddressApproved:true,physicalAddress:'123 Example Street',optOutApproved:true,optOut:{approved:true,mode:'REPLY_STOP',text:'Reply STOP.'},approvalExpiry:{approved:true,approvedBy:'Fixture approver',approvedAt:at,revision:'fixture-expiry',maxAgeMs:86400000}};
 putRecord(db,'writing_policy',campaignId,policy);
 const draftIds=[1,2,3].map(step=>`fixture-draft-${step}`);
 for(const [i,id]of draftIds.entries())putRecord(db,'draft',id,{candidateId,email,step:i+1,version:1,status:'UNAPPROVED',subject:subject??`Fixture review ${i+1}`,body:`Hi fixture team,\n\nSynthetic step ${i+1}: café, equipment & catering.\n\nFixture Sender\nFixture Role\nFixture Company\n123 Example Street\nReply STOP.`});
 const spec={reviewId:'fixture-review',campaignId,candidateId,email,draftIds,asOf:at,synthetic:false,recipient:{class:'GROUP_SHARED',greeting:'Hi fixture team,'},facts:[{id:'catering',text:'Fixture catering context',source:{kind:'writing_evidence',id:'fixture-source',pointer:'/text',excerpt:'offers catering'},usage:'CONTEXT',eventDate:null}],steps:draftIds.map(draftId=>({draftId,factIds:['catering'],angle:'Fixture example',findings:[]})),salesHypotheses:[],unknowns:['Fixture only; not a real business.']};
 const packet=prepareWritingReview(db,spec),expiresAt='2026-11-19T14:00:00Z';
 const expectedReviewCodes=candidate.synthetic===true||candidate.syntheticOnly===true?[]:['SEMANTIC_REVIEW_REQUIRED','SPARSE_EVIDENCE',...(candidate.qualification==='HOLD'?['BUSINESS_FIT_UNRESOLVED']:[])].sort();
 assert.deepEqual([...new Set(packet.findings.filter(f=>f.severity==='REVIEW').map(f=>f.code))].sort(),expectedReviewCodes,'Fixture review findings changed; inspect before acknowledging');
 const decision=approved?decideWritingReview(db,{actionId:'fixture-content-decision',reviewId:spec.reviewId,packetHash:packet.hash,decision:'APPROVED',actor:policy.approver,at,expiresAt,acknowledgedFindings:expectedReviewCodes}):null;
 const content={campaignId,recipients:[{candidateId,email,standardFields,messages:packet.messages,writing:{reviewId:spec.reviewId,packetHash:packet.hash,decisionId:decision?.id??null}}],sequence:policy.sequence,settings:{}};
 const batch=createBatch(db,'fixture-batch',content),approval=approved?decideApproval(db,'fixture-batch',batch.version,batch.hash,'APPROVED',policy.approver,expiresAt,at):null;
 return {db,at,spec,packet,content,batch,approval,input:{batchId:'fixture-batch',approvalId:approval?.id??null,at}};
}
export function tableSnapshot(db){return Object.fromEntries(db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all().map(({name})=>[name,db.prepare(`SELECT * FROM ${name} ORDER BY rowid`).all()]));}
