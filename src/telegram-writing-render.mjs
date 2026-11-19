import {evaluateWritingReview,renderWritingStep,writingApprovalExpiryAllowed} from './writing.mjs';
import {FIRST_TOUCH_CONTRACT,writingMode,sequenceReleaseReady} from './writing-mode.mjs';

export const CONTENT_DISCLAIMER='Approves this content version only. Does not clear contact holds or authorize sending.';
export const WRITING_BUTTONS={APPROVED:'Approve content',REJECTED:'Reject content',REVISION_REQUESTED:'Request changes',DETAILS:'Details'};
const recipientClass={GROUP_SHARED:'Shared group inbox',GENERAL_BUSINESS:'General business inbox',BUSINESS_ROLE:'Business-role inbox',DIRECT_PERSON:'Named business contact'};
const verificationText={HELD_CONFLICTING_PROVIDER_RESULT_MX_PRESENT:'Prior invalid result conflicts with domain-routing evidence; mailbox deliverability remains unresolved.',PROVIDER_RISKY_CATCH_ALL_HELD:'Catch-all result; this does not confirm or disprove that the mailbox accepts mail.',CATCH_ALL:'Catch-all result; this does not confirm or disprove that the mailbox accepts mail.',PASSED:'Recorded verification passed; it is an assessment, not guaranteed delivery.'};
const join=lines=>lines.join('\n\n');
function bounded(text){if(typeof text!=='string'||text.length>4096)throw Error('TELEGRAM_REVIEW_PAGE_TOO_LONG');return text;}
function detailPages(sections){
 const pages=[];let page='';
 for(const section of sections){bounded(section);if(page.length+section.length+2>4096){pages.push(page);page='';}page+=`${page?'\n\n':''}${section}`;}
 if(page)pages.push(page);return pages;
}
// Plain text deliberately uses no Telegram parse_mode: evidence and copy cannot
// inject formatting/entities. Message bodies are shared with the local renderer.
export function renderTelegramWritingReview(db,packet,{at=packet.spec.asOf,decisionId=null,review=null}={}){
 const gate=evaluateWritingReview(db,packet.reviewId,decisionId??review?.decisionId??null,at);
 if(gate.packetHash!==packet.hash)throw Error('TELEGRAM_STALE_WRITING_PACKET');
 if(review&&(review.packetHash!==packet.hash||review.reviewId!==packet.reviewId))throw Error('TELEGRAM_REVIEW_BINDING_MISMATCH');
 const c=packet.snapshot.contact,b=packet.snapshot.candidate;
 const decided=review?.status&&review.status!=='PENDING'?review.status:null;
 const content=gate.contentApproved?'APPROVED (content only)':decided==='REJECTED'?'REJECTED':decided==='REVISION_REQUESTED'?'CHANGES REQUESTED':'NOT APPROVED';
 const header=`${packet.synthetic?'SYNTHETIC QA — ':''}Content review • ${b.name??packet.candidateId} • v${packet.version}`;
 const held=gate.contactEligible?'Contact checks: passed in this snapshot; release requires recheck.':'CONTACT HELD — no outreach';
 const mode=writingMode(packet.spec),firstTouch=mode===FIRST_TOUCH_CONTRACT;
 const configured=packet.policy,expiryConfigured=writingApprovalExpiryAllowed(configured,at,new Date(Date.parse(at)+1).toISOString(),mode);
 const unresolved=[...(!sequenceReleaseReady(configured.sequence,mode)?[firstTouch?'first-touch endpoint':'cadence and endpoint']:[]),...(configured.physicalAddressApproved!==true||!configured.physicalAddress?.trim()?['physical-address footer']:[]),...(configured.optOutApproved!==true||configured.optOut?.approved!==true||configured.optOut?.mode!=='REPLY_STOP'||!configured.optOut?.text?.trim()?['operative opt-out']:[]),...(!expiryConfigured?['approval-expiry policy']:[])];
 const policy=unresolved.length?`Unresolved release requirements: ${unresolved.join('; ')}. No sending is authorized.`:'Recorded release policy is configured. Content approval remains separate from release authorization. No sending is authorized.';
 const flags=packet.findings.filter(f=>f.severity!=='NOTE');
 const summary=bounded(join([header,`Recipient: ${packet.email}\n${recipientClass[packet.spec.recipient.class]??'Attribution unresolved'} — ${c.attribution}`,held,`Content: ${content}\nHandoff: NOT PERMITTED`,
  `Contact assessment: ${verificationText[c.verification]??'Held or unresolved; see saved verification details.'} Suppression clearance: ${c.suppressed===false?'recorded':c.suppressed===true?'suppressed':'unknown'}.`,
  packet.synthetic?'Business fit: Fixture-only qualified state; no real business has been assessed.':`Business fit: ${b.qualification==='QUALIFIED'?'Meets the saved public-evidence targeting criteria':'Not established'}. ${b.reason??''}`,
  `Writing cautions (review before deciding):\n${flags.length?flags.map(f=>`• Step ${packet.spec.draftIds.indexOf(f.draftId)+1}: ${f.detail}`).join('\n'):'• None recorded.'}`,
  `Supported context:\n${packet.spec.facts.map(f=>`• ${f.text}`).join('\n')}`,
  `Unknowns:\n${packet.spec.unknowns.map(x=>`• ${x}`).join('\n')}`,
  ...(firstTouch?['One first-touch message. END_AFTER_FIRST_TOUCH: no follow-up cadence or follow-up messages.']:[]),policy,CONTENT_DISCLAIMER,
  'Approve content also acknowledges the writing cautions shown above.',
  review?`Decision window ends: ${review.expiresAt}${packet.synthetic?' (fixture-only test window; not a business default)':''}.`:`Preview only: no action references issued${expiryConfigured?'.':'; business approval-expiry policy unresolved.'}`,
  'Stop: /stop uses the existing stop control. It cannot recall an already accepted external action.'
 ]));
 const steps=packet.messages.map((_,index)=>bounded(join([header,`${held}\nContent: ${content} • Handoff: NOT PERMITTED`,renderWritingStep(packet,index,{details:false}),CONTENT_DISCLAIMER])));
 const details=detailPages([`${header}\nSupporting details\n${held}\nContent: ${content}\nHandoff: NOT PERMITTED`,...packet.spec.facts.map(f=>`${f.text}\nUse: ${f.usage}. Source: ${f.source.kind}/${f.source.id}${f.source.pointer}\n${f.source.url??''}\nPublication: ${f.source.publishedAt??'unknown'}; assertion update: ${f.source.assertionUpdatedAt??'unknown'}. Observation: ${f.source.observedAt??'see saved provenance'}.`),
  ...packet.spec.steps.map((s,i)=>`Step ${i+1} angle: ${s.angle}\nFacts: ${s.factIds.join(', ')||'Sequence close'}`),
  `Conditional sales hypotheses (not known needs):\n${packet.spec.salesHypotheses.join('\n')}`,
  ...packet.findings.filter(f=>f.severity==='NOTE').map(f=>`Note: ${f.detail}`),
  `Packet: ${packet.hash}\nReview: ${packet.reviewId}\nCampaign: ${packet.campaignId}\nSnapshot: ${packet.spec.asOf}\n${CONTENT_DISCLAIMER}`]);
 const keyboard=review?[[...['APPROVED','REJECTED'].map(k=>({text:WRITING_BUTTONS[k],callback_data:review.actions[k]}))],[...['REVISION_REQUESTED','DETAILS'].map(k=>({text:WRITING_BUTTONS[k],callback_data:review.actions[k]}))]]:null;
 return {packetHash:packet.hash,summary,steps,details,buttons:WRITING_BUTTONS,pages:[{text:summary},...steps.map((text,i)=>({text,...(i===(firstTouch?0:2)&&keyboard?{reply_markup:{inline_keyboard:keyboard}}:{})}))],state:{contactHeld:!gate.contactEligible,contentApproved:gate.contentApproved,handoffPermitted:false},actionable:!!review};
}
