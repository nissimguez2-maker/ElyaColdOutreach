// Non-executable decision preparation. No imports, reservations, approvals or transport.
import {canonical,digest,decimal,timestamp,required} from './values.mjs';
import {getRecord,controls} from './store.mjs';
import {prepareAssistedImport,validateCriticalReviewResult} from './drafting-handoff.mjs';
import {evaluateRelease,latestBatch} from './batches.mjs';
import {evaluateManualContactGate} from './manual-response.mjs';

const hash=v=>digest(canonical(v));
const unique=v=>[...new Set(v)];
function fields(value,allowed,label){
 if(!value||Object.getPrototypeOf(value)!==Object.prototype||Object.keys(value).some(k=>!allowed.includes(k)))throw Error(label);
}
function fresh(value,at,days){
 if(!Number.isSafeInteger(days)||days<0)return false;
 try{const age=timestamp(at)-timestamp(value);return age>=0&&age<=days*86400000;}catch{return false;}
}
export function prepareSingleMessageDecision(db,input){
 fields(input,['packet','result','provenance','reviewBinding','review','reviewedSteps','at','plan'],'DECISION_INPUT_FIELDS');
 canonical(input);timestamp(input.at);
 const {packet,result,provenance,reviewBinding,review,at}=input,plan=input.plan??{};
 fields(plan,['sender','batchId','approvalId','monitoring','cost'],'PLAN_UNKNOWN_FIELD');
 if(plan.sender!==undefined&&plan.sender!==null){required(plan.sender);if(!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(plan.sender))throw Error('SENDER_EMAIL_REQUIRED');}
 for(const key of ['batchId','approvalId'])if(plan[key]!==undefined&&plan[key]!==null)required(plan[key]);
 const monitoring=plan.monitoring??{owner:null,coverageStartsAt:null,coverageEndsAt:null,reviewIntervalMinutes:null};
 fields(monitoring,['owner','coverageStartsAt','coverageEndsAt','reviewIntervalMinutes'],'MONITORING_FIELDS');
 if(monitoring.owner!==null&&monitoring.owner!==undefined)required(monitoring.owner);
 for(const key of ['coverageStartsAt','coverageEndsAt'])if(monitoring[key]!==null&&monitoring[key]!==undefined)timestamp(monitoring[key]);
 if(monitoring.reviewIntervalMinutes!==null&&monitoring.reviewIntervalMinutes!==undefined&&(!Number.isSafeInteger(monitoring.reviewIntervalMinutes)||monitoring.reviewIntervalMinutes<=0))throw Error('MONITORING_INTERVAL');
 const cost=plan.cost??{maximumUsd:null,basis:'UNKNOWN',permissionRef:null};
 fields(cost,['maximumUsd','basis','permissionRef'],'COST_FIELDS');
 if(cost.maximumUsd!==null&&cost.maximumUsd!==undefined)decimal(cost.maximumUsd);
 if(cost.basis!==undefined)required(cost.basis);if(cost.permissionRef!==null&&cost.permissionRef!==undefined)required(cost.permissionRef);
 if(!reviewBinding||canonical(reviewBinding.draftResult)!==canonical(result)||canonical(reviewBinding.sourcePacket)!==canonical(packet))throw Error('REVIEW_COPY_BINDING_MISMATCH');
 const reviewCheck=validateCriticalReviewResult(reviewBinding,review);
 const reviewedSteps=input.reviewedSteps??null;
 if(reviewedSteps!==null&&(!Array.isArray(reviewedSteps)||!reviewedSteps.length||reviewedSteps.some((step,i)=>![1,2,3].includes(step)||i>0&&step<=reviewedSteps[i-1])))throw Error('REVIEWED_STEPS_INVALID');
 // Validation of supplied artifacts never imports their draft rows or creates approval.
 prepareAssistedImport(db,{packet,result,provenance});
 const {candidateId,email,campaignId}=packet.spec;
 const candidate=getRecord(db,'candidate',candidateId),contact=getRecord(db,'contact',email),policy=getRecord(db,'writing_policy',campaignId);
 const refinement=getRecord(db,'refinement_current',candidateId),freshnessRef=getRecord(db,'settings','current-contact-freshness');
 const freshness=freshnessRef?getRecord(db,freshnessRef.policyKind,freshnessRef.revision):null;
 const first={subject:result.drafts[0].subject,body:result.drafts[0].body},blockers=[];
 if(candidate?.qualification!=='QUALIFIED')blockers.push('BUSINESS_QUALIFICATION_HELD');
 if(refinement?.disposition!=='QUALIFIED_FOR_REVIEW')blockers.push('REFINEMENT_DISPOSITION_HELD');
 if(contact?.candidateId!==candidateId||!contact?.attribution)blockers.push('CONTACT_IDENTITY_OR_ATTRIBUTION_UNRESOLVED');
 if(contact?.verification!=='PASSED')blockers.push('CONTACT_VERIFICATION_HELD');
 if(contact?.suppressed!==false)blockers.push(contact?.suppressed===true?'CONTACT_SUPPRESSED':'SUPPRESSION_NOT_CLEARED');
 if(!fresh(contact?.verifiedAt,at,freshness?.emailVerification?.daysBeforeFirstRelease))blockers.push('VERIFICATION_FRESHNESS_UNESTABLISHED');
 if(!fresh(contact?.attributionCorroboratedAt,at,freshness?.contactRoleAttribution?.meaningfulCorroborationDays))blockers.push('ATTRIBUTION_FRESHNESS_UNESTABLISHED');
 if(!fresh(candidate?.operatingStatusCheckedAt,at,freshness?.operatingStatus?.daysBeforeFirstRelease))blockers.push('OPERATING_STATUS_FRESHNESS_UNESTABLISHED');
 const manual=evaluateManualContactGate(db,{email,candidateId,at});blockers.push(...manual.reasons);
 if(candidate?.synthetic===true||packet.spec.synthetic===true)blockers.push('SYNTHETIC_RECORD_NOT_BUSINESS_LAUNCH');
 if(!reviewedSteps?.includes(1))blockers.push('FIRST_TOUCH_EDITORIAL_SCOPE_UNESTABLISHED');
 if(!review.dimensions.every(d=>d.judgment==='PASS'))blockers.push('EDITORIAL_CONCERNS_REMAIN');
 if(review.verdict!=='NEEDS_HUMAN_REVIEW')blockers.push('EDITORIAL_VERDICT_'+review.verdict);
 // These prose arrays may contain limitations or "no corrections". Preserve and
 // display them; only explicit verdict/dimension judgments become editorial gates.
 if(policy?.physicalAddressApproved!==true||!policy.physicalAddress?.trim())blockers.push('PHYSICAL_FOOTER_UNAPPROVED');
 else if(!first.body.includes(policy.physicalAddress))blockers.push('APPROVED_PHYSICAL_FOOTER_MISSING_FROM_EXACT_COPY');
 if(policy?.optOutApproved!==true||policy?.optOut?.approved!==true||!policy.optOut?.text?.trim())blockers.push('OPT_OUT_UNAPPROVED');
 else if(!first.body.includes(policy.optOut.text))blockers.push('APPROVED_OPT_OUT_MISSING_FROM_EXACT_COPY');
 if(policy?.approvalExpiry?.approved!==true)blockers.push('APPROVAL_EXPIRY_POLICY_UNAPPROVED');
 if(policy?.sequence?.steps!==1||policy?.sequence?.endpointApproved!==true)blockers.push('SINGLE_MESSAGE_POLICY_NOT_APPROVED');
 const batch=plan.batchId?latestBatch(db,plan.batchId):null;
 const approval=plan.approvalId?db.prepare('SELECT * FROM approvals WHERE id=?').get(plan.approvalId):null;
 if(!batch||!approval)blockers.push('EXACT_CONTENT_AND_BATCH_APPROVAL_MISSING');
 if(batch){
  const b=JSON.parse(batch.content_json),r=b.recipients;
  if(b.campaignId!==campaignId||!Array.isArray(r)||r.length!==1||r[0].candidateId!==candidateId||r[0].email!==email||canonical(r[0].messages)!==canonical([first])||b.sequence?.steps!==1)blockers.push('EXACT_FIRST_TOUCH_BATCH_MISMATCH');
  blockers.push(...evaluateRelease(db,plan.batchId,plan.approvalId??'',at).reasons);
 }
 if(!plan.sender)blockers.push('PROSPECT_SENDER_SELECTION_UNAPPROVED');
 if(!monitoring.owner||!monitoring.coverageStartsAt||!monitoring.coverageEndsAt||!monitoring.reviewIntervalMinutes)blockers.push('MONITORING_COVERAGE_UNDECIDED');
 else if(timestamp(monitoring.coverageEndsAt)<=timestamp(monitoring.coverageStartsAt))throw Error('MONITORING_COVERAGE_ORDER');
 // These are operator proposals, not independently recorded permission or acceptance.
 blockers.push('MONITORING_AND_NATIVE_STOP_RESPONSIBILITIES_REQUIRE_ACCEPTANCE','COST_EXPOSURE_OR_PERMISSION_UNRESOLVED','LIVE_CONFIGURATION_AND_STATUS_READBACK_REQUIRED');
 const control=controls(db);if(control.stopped)blockers.push('System stopped');if(!control.launchAuthorized)blockers.push('System launch not authorized');
 const output={version:'single-message-decision-v1',label:'PREVIEW - NOT RELEASED',status:'BLOCKED',at,target:{candidateId,email,campaignId,sender:plan.sender??null},
  messages:[first],messageHash:hash(first),sourceResultHash:reviewCheck.reviewedResultHash,sourceDraftHash:reviewCheck.reviewedDraftHash,followUpCount:0,window:null,
  editorial:{verdict:review.verdict,dimensions:review.dimensions.map(d=>({dimension:d.dimension,judgment:d.judgment})),unresolved:[...review.unresolved],proposedChanges:[...review.proposedChanges],reviewedSteps,scope:reviewedSteps?.includes(1)?'FIRST_TOUCH_INCLUDED_AS_REPORTED':'FIRST_TOUCH_NOT_ESTABLISHED',contentApproval:false,meaning:'Reported review scope and attributed editorial assessment, not a human approval or release decision.'},
  contact:{verification:contact?.verification??null,suppressed:contact?.suppressed??null,attribution:contact?.attribution??null,manualGate:manual},
  approval:{batchId:plan.batchId??null,approvalId:plan.approvalId??null,expiry:approval?.expires_at??null,meaning:'References are checked against existing records; this preview creates none.'},
  monitoring:{...monitoring,status:'PROPOSED_NOT_ACCEPTED',handler:'Daniel Rosen in Instantly',automaticReplies:false,automaticNegotiation:false},
  cost:{maximumUsd:cost.maximumUsd??null,basis:cost.basis??'UNKNOWN',permissionRef:cost.permissionRef??null,permissionVerified:false,reservationCreated:false,projectWeekdayCeilingUsd:'20',existingGptSubscriptionExcluded:true},
  stopConditions:['Reply or opt-out/refusal','Unknown recipient, conflicting evidence or suppression state','Uncertain provider completion','Unexpected extra recipient, message, sender or sending path','Coverage unavailable or approved window expired'],
  nativeReadback:{required:true,status:'NOT_PERFORMED',checks:['Exact recipient, sender, one step and one variant','No CC/BCC or additional sending paths','Suppression/unsent eligibility and current entitlement','Bounded schedule and confirmed inactive/paused state after safety action'],localStopDoesNotPauseRemoteCampaign:true},
  blockers:unique(blockers),controls:control,generalDispatchEnabled:false,releaseAllowed:false,executable:false,
  releaseContractNote:'The separate first-touch-only-v1 contract requires its own exact-content review, batch approval and release checks. Legacy three-slot contracts remain unchanged. This decision bundle is not an executable batch or provider payload.'};
 return {...output,hash:hash(output)};
}
export function renderSingleMessageDecision(bundle){
 if(bundle?.version!=='single-message-decision-v1'||bundle.executable!==false||bundle.releaseAllowed!==false)throw Error('NON_EXECUTABLE_DECISION_REQUIRED');
 return [bundle.label,'One first touch; zero automatic follow-ups. No date/window selected.',`Recipient under consideration: ${bundle.target.email}`,`Sender: ${bundle.target.sender??'UNDECIDED'}`,`Subject: ${bundle.messages[0].subject}`,'',bundle.messages[0].body,'',`Editorial verdict: ${bundle.editorial.verdict} (not content approval)`,`Reported reviewed steps: ${bundle.editorial.reviewedSteps?.join(', ')??'UNKNOWN'}; ${bundle.editorial.scope}`,...bundle.editorial.unresolved.map(s=>'Editorial unresolved: '+s),...bundle.editorial.proposedChanges.map(s=>'Editorial proposed change: '+s),'','Unresolved gates:',...bundle.blockers.map(r=>'- '+r),'',`Approval expiry: ${bundle.approval.expiry??'UNDECIDED'}`,`Maximum cost: ${bundle.cost.maximumUsd??'UNKNOWN'} USD; no reservation.`,
 'Daniel handles replies in Instantly. Coverage, opt-out handling and native pause/readback responsibilities require explicit acceptance.',...bundle.stopConditions.map(s=>'Stop condition: '+s),bundle.releaseContractNote,'No content, batch or launch approval is granted.'].join('\n')+'\n';
}
