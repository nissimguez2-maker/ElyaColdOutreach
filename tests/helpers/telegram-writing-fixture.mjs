import {openStore,putRecord} from '../../src/store.mjs';
import {prepareWritingReview} from '../../src/writing.mjs';
export const at='2026-11-16T22:00:00Z',expires='2026-11-16T22:05:00Z';
export function writingTelegramFixture(path=':memory:'){
 const db=openStore(path),campaignId='qa-tg-writing',candidateId='synthetic-writing',email='qa@example.invalid';
 putRecord(db,'telegram_binding','primary',{confirmed:true,testOnly:true,userId:42,chatId:42,botId:777},'configuration');
 putRecord(db,'candidate',candidateId,{name:'Synthetic Café',qualification:'QUALIFIED',synthetic:true,operatingStatusCheckedAt:at});
 putRecord(db,'contact',email,{candidateId,email,attribution:'Synthetic shared inbox',attributionClass:'GROUP_SHARED',verification:'CATCH_ALL',verifiedAt:at,attributionCorroboratedAt:at,suppressed:null});
 putRecord(db,'campaign',campaignId,{purpose:'synthetic_qa',mustRemainInactive:true});
 putRecord(db,'refinement_current',candidateId,{semanticHash:'assessment-v1',disposition:'QUALIFIED_FOR_REVIEW'});
 putRecord(db,'refinement_assessment',candidateId+':assessment-v1',{businessFit:{state:'PASS'},contacts:[]});
 putRecord(db,'writing_evidence','fact-source',{text:'The synthetic café offers catering.',observedAt:at});
 putRecord(db,'writing_policy',campaignId,{revision:'fixture-only-v1',sender:{name:'Daniel Rosen',title:'Head of Operations and Underwriting',company:'Elya Partners'},approver:'Daniel Rosen',sequence:{steps:3,cadenceApproved:false,endpointApproved:false},physicalAddressApproved:false,optOutApproved:false,synthetic:true});
 putRecord(db,'operational_policy','freshness-fixture',{emailVerification:{daysBeforeFirstRelease:14},contactRoleAttribution:{meaningfulCorroborationDays:90},operatingStatus:{daysBeforeFirstRelease:30},personalization:{timelyEventDays:90,ongoingOrFutureStatusCheckDays:30}});
 putRecord(db,'settings','current-contact-freshness',{policyKind:'operational_policy',revision:'freshness-fixture'});
 const draftIds=[1,2,3].map(step=>`${candidateId}:v1:step${step}`);
 for(const [i,id]of draftIds.entries())putRecord(db,'draft',id,{candidateId,email,version:1,step:i+1,status:'UNAPPROVED',subject:`Synthetic content review ${i+1}`,body:`Hi QA team,\n\nSynthetic step ${i+1}: café, equipment & catering. This is test content only.\n\nDaniel Rosen\nHead of Operations and Underwriting\nElya Partners`});
 const spec={reviewId:'qa-writing-review',campaignId,candidateId,email,draftIds,asOf:at,synthetic:true,recipient:{class:'GROUP_SHARED',greeting:'Hi QA team,'},facts:[{id:'catering',text:'Synthetic catering context',source:{kind:'writing_evidence',id:'fact-source',pointer:'/text',excerpt:'offers catering'},usage:'CONTEXT',eventDate:null}],salesHypotheses:['Synthetic test only; no real financing need.'],unknowns:['No real recipient or operating business.'],steps:draftIds.map(draftId=>({draftId,factIds:['catering'],angle:'Synthetic test',findings:[{code:'FIXTURE_CAUTION',severity:'REVIEW',detail:'Synthetic wording only; no outreach authorization.'}]}))};
 return {db,spec,packet:prepareWritingReview(db,spec)};
}
export function callback(review,action='APPROVED',id=1){return {update_id:id,callback_query:{id:String(id),from:{id:42,is_bot:false},message:{message_id:review.messageId??100,date:Math.floor(Date.parse(at)/1000),chat:{id:42,type:'private'},from:{id:777,is_bot:true}},data:review.actions[action]}};}
