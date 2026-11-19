import {readFileSync} from 'node:fs';
import {putRecord} from './store.mjs';
import {prepareWritingReview} from './writing.mjs';
import {canonical,digest,timestamp} from './values.mjs';

export const TEST_ID='telegram-writing-live-v1';
export const CAPS=Object.freeze({getMe:1,getWebhookInfo:1,initialMessages:4,detailsMessages:1,acknowledgments:5,polls:12,total:24});
export const DEADLINES=Object.freeze({totalMs:180000,apiMs:170000});
export const ACTIONS=Object.freeze(['DETAILS','APPROVED','APPROVED','REVISION_REQUESTED','REJECTED','STOP']);
export function sourceFingerprints(){return Object.fromEntries(['telegram-writing-live-card.mjs','telegram-writing-authority.mjs','telegram-writing-budget.mjs','telegram-writing-live.mjs','telegram-writing-live-cli.mjs','telegram-writing-adapter.mjs','telegram-writing-decisions.mjs','telegram-writing-render.mjs','telegram-api.mjs','telegram-decisions.mjs','telegram-pairing.mjs','windows-protected-storage.mjs','writing.mjs','store.mjs','values.mjs'].map(name=>[name,digest(readFileSync(new URL(name,import.meta.url)))]));}
export function cardHash(){return digest(canonical({revision:'final-card-v1',actions:ACTIONS,caps:CAPS,deadlines:DEADLINES,source:digest(readFileSync(new URL('telegram-writing-live-card.mjs',import.meta.url)))}));}
export function makeWritingTestContract(packet,pairing){return {id:TEST_ID,cardHash:cardHash(),packetHash:packet.hash,packetVersion:packet.version,pairing:{userId:pairing.userId,chatId:pairing.chatId,botId:pairing.botId},actions:[...ACTIONS],caps:{...CAPS},deadlines:{...DEADLINES},sourceFingerprints:sourceFingerprints()};}

// Fixed card inputs only. Never import a real business record, policy or cursor.
export function seedSyntheticWritingCard(db,pairing,at){
 timestamp(at);if(db.prepare('SELECT count(*) n FROM records').get().n!==0)throw Error('EMPTY_SYNTHETIC_DATABASE_REQUIRED');
 const campaignId='qa-tg-writing',candidateId='synthetic-writing',email='qa@example.invalid';
 putRecord(db,'telegram_binding','primary',{confirmed:true,testOnly:true,userId:pairing.userId,chatId:pairing.chatId,botId:pairing.botId},'configuration');
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
 return prepareWritingReview(db,{reviewId:'qa-writing-review',campaignId,candidateId,email,draftIds,asOf:at,synthetic:true,recipient:{class:'GROUP_SHARED',greeting:'Hi QA team,'},facts:[{id:'catering',text:'Synthetic catering context',source:{kind:'writing_evidence',id:'fact-source',pointer:'/text',excerpt:'offers catering'},usage:'CONTEXT',eventDate:null}],salesHypotheses:['Synthetic test only; no real financing need.'],unknowns:['No real recipient or operating business.'],steps:draftIds.map(draftId=>({draftId,factIds:['catering'],angle:'Synthetic test',findings:[{code:'FIXTURE_CAUTION',severity:'REVIEW',detail:'Synthetic wording only; no outreach authorization.'}]}))});
}
