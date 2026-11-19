// Offline evidence/review contract. Lexical checks are not semantic fact verification.
// Decisions are called only by a trusted local/authenticated adapter; actor strings are not authentication.
import {canonical,digest,required,timestamp} from './values.mjs';
import {getRecord,putRecord,transaction,journal,now} from './store.mjs';
import {permitsIsolatedHandoff} from './handoff-isolation.mjs';
import {DRAFTING_QUALITY_VERSION,assembleDraftingContext,assessDraftQuality} from './drafting-quality.mjs';
import {FIRST_TOUCH_CONTRACT,LEGACY_WRITING_CONTRACT,writingMode,messageStepsForMode,assertSequenceForMode,sequenceReleaseReady,firstTouchExpiryPolicyConfigured,firstTouchApprovalDeadline} from './writing-mode.mjs';

const hash=value=>digest(canonical(value));
const atomic=(db,fn)=>db.isTransaction?fn():transaction(db,fn);
const get=(db,kind,id)=>{const r=getRecord(db,kind,id);if(!r)throw Error('WRITING_MISSING_RECORD: '+kind);return r;};
const allowedAttribution=new Set(['GROUP_SHARED','GENERAL_BUSINESS','BUSINESS_ROLE','DIRECT_PERSON']);
// Content hashes alone cannot detect change -> restore. SQLite counters survive process
// restarts and cover direct SQL writes as well as putRecord. Counters are per identity,
// never global; unrelated business changes do not invalidate a packet.
function installRevisionTracking(db){
 const bump=key=>`INSERT INTO metadata(key,value) VALUES (${key},'1') ON CONFLICT(key) DO UPDATE SET value=CAST(CAST(metadata.value AS INTEGER)+1 AS TEXT);`;
 const recordKey=row=>`'writing-revision-record:'||hex(${row}.kind)||':'||hex(${row}.id)`;
 const sourceKey=row=>`'writing-revision-source:'||hex(${row}.id)`;
 const draftKey=row=>`'writing-revision-drafts:'||hex(json_extract(${row}.data_json,'$.candidateId'))`;
 for(const [table,key]of [['records',recordKey],['sources',sourceKey]]){
  for(const [event,row]of [['INSERT','new'],['DELETE','old']])db.exec(`CREATE TRIGGER IF NOT EXISTS writing_${table}_${event.toLowerCase()} AFTER ${event} ON ${table} BEGIN ${bump(key(row))} END;`);
  const changed=table==='records'?'old.kind IS NOT new.kind OR old.id IS NOT new.id':'old.id IS NOT new.id';
  db.exec(`CREATE TRIGGER IF NOT EXISTS writing_${table}_update AFTER UPDATE ON ${table} BEGIN ${bump(key('old'))} END;
   CREATE TRIGGER IF NOT EXISTS writing_${table}_rename AFTER UPDATE ON ${table} WHEN ${changed} BEGIN ${bump(key('new'))} END;`);
 }
 for(const [event,row]of [['INSERT','new'],['DELETE','old']])db.exec(`CREATE TRIGGER IF NOT EXISTS writing_draft_set_${event.toLowerCase()} AFTER ${event} ON records WHEN ${row}.kind='draft' AND json_extract(${row}.data_json,'$.candidateId') IS NOT NULL BEGIN ${bump(draftKey(row))} END;`);
 db.exec(`CREATE TRIGGER IF NOT EXISTS writing_draft_set_update AFTER UPDATE ON records WHEN old.kind='draft' AND json_extract(old.data_json,'$.candidateId') IS NOT NULL BEGIN ${bump(draftKey('old'))} END;
  CREATE TRIGGER IF NOT EXISTS writing_draft_set_move AFTER UPDATE ON records WHEN new.kind='draft' AND json_extract(new.data_json,'$.candidateId') IS NOT NULL AND (old.kind<>'draft' OR json_extract(old.data_json,'$.candidateId') IS NOT json_extract(new.data_json,'$.candidateId')) BEGIN ${bump(draftKey('new'))} END;`);
}
const hex=value=>Buffer.from(value,'utf8').toString('hex').toUpperCase();
function revision(db,key){return db.prepare('SELECT value FROM metadata WHERE key=?').get(key)?.value??'0';}
function recordRevision(db,kind,id){return revision(db,`writing-revision-record:${hex(kind)}:${hex(id)}`);}
function immutable(db,kind,id,data){const old=getRecord(db,kind,id);if(old&&canonical(old)!==canonical(data))throw Error('WRITING_IMMUTABLE_MISMATCH');if(!old)putRecord(db,kind,id,data,'assessment');}
function pointer(value,path){
 if(path==='')return value;
 if(typeof path!=='string'||!path.startsWith('/'))throw Error('WRITING_EVIDENCE_POINTER');
 for(const token of path.slice(1).split('/')){const key=token.replace(/~1/g,'/').replace(/~0/g,'~');if(!value||typeof value!=='object'||!Object.hasOwn(value,key))throw Error('WRITING_EVIDENCE_POINTER');value=value[key];}
 return value;
}
function sourceRecord(db,source){
 if(source.kind==='source'){const row=db.prepare('SELECT content_json FROM sources WHERE id=?').get(source.id);if(!row)throw Error('WRITING_EVIDENCE_SOURCE');return JSON.parse(row.content_json);}
 if(!['refinement_run','refinement_assessment','research_checkpoint','external_observation','writing_evidence'].includes(source.kind))throw Error('WRITING_EVIDENCE_KIND');
 return get(db,source.kind,source.id);
}
function latestDrafts(db,spec){
 const drafts=db.prepare("SELECT id,data_json FROM records WHERE kind='draft'").all().map(r=>({id:r.id,data:JSON.parse(r.data_json)})).filter(r=>r.data.candidateId===spec.candidateId&&r.data.email===spec.email);
 return messageStepsForMode(writingMode(spec)).map(step=>{const matching=drafts.filter(r=>Number(r.data.step)===step);const max=Math.max(...matching.map(r=>Number(r.data.version)));return matching.filter(r=>Number(r.data.version)===max).map(r=>({id:r.id,hash:hash(r.data)})).sort((a,b)=>a.id.localeCompare(b.id));});
}
function capture(db,spec){
 const candidate=get(db,'candidate',spec.candidateId),contact=get(db,'contact',spec.email),campaign=get(db,'campaign',spec.campaignId),policy=get(db,'writing_policy',spec.campaignId),refinement=get(db,'refinement_current',spec.candidateId);
 const assessment=get(db,'refinement_assessment',spec.candidateId+':'+refinement.semanticHash);
 const freshnessRef=getRecord(db,'settings','current-contact-freshness');
 const freshness=freshnessRef?get(db,freshnessRef.policyKind,freshnessRef.revision):null;
 const drafts=spec.draftIds.map(id=>({id,data:get(db,'draft',id)}));
 const sources=spec.facts.map(f=>({factId:f.id,source:f.source,hash:hash(sourceRecord(db,f.source))}));
 const refs=[['candidate',spec.candidateId],['contact',spec.email],['campaign',spec.campaignId],['writing_policy',spec.campaignId],['refinement_current',spec.candidateId],['refinement_assessment',spec.candidateId+':'+refinement.semanticHash],['settings','current-contact-freshness'],...spec.draftIds.map(id=>['draft',id])];
 if(freshnessRef)refs.push([freshnessRef.policyKind,freshnessRef.revision]);
 const revisions={records:refs.map(([kind,id])=>({kind,id,revision:recordRevision(db,kind,id)})),sources:spec.facts.map(f=>({factId:f.id,revision:f.source.kind==='source'?revision(db,`writing-revision-source:${hex(f.source.id)}`):recordRevision(db,f.source.kind,f.source.id)})),draftSet:revision(db,`writing-revision-drafts:${hex(spec.candidateId)}`)};
 return {candidate,contact,campaign,policy,refinement,assessment,freshnessRef,freshness,drafts,sources,revisions,latestDrafts:latestDrafts(db,spec)};
}
function authorityClass(contact,assessment,email){
 const explicit=contact.attributionClass??assessment.contacts?.find(c=>c.email===email)?.attribution?.class;
 if(explicit)return explicit;
 if(/group|generic.*M2O/i.test(contact.attribution??''))return 'GROUP_SHARED';
 if(/named|person|Lindsey/i.test(contact.attribution??''))return 'DIRECT_PERSON';
 if(/generic|general/i.test(contact.attribution??''))return 'GENERAL_BUSINESS';
 return null;
}
function withinDays(value,at,days){
 try{if(!Number.isSafeInteger(days)||days<0)return false;const age=timestamp(at)-timestamp(value);return age>=0&&age<=days*86400000;}catch{return false;}
}
function timely(fact,at,policy){
 if(!/^\d{4}-\d\d-\d\d$/.test(fact.eventDate??''))return false;
 const date=fact.eventDate+'T00:00:00Z';
 if(!Number.isFinite(Date.parse(date))||new Date(date).toISOString().slice(0,10)!==fact.eventDate)return false;
 return withinDays(date,at,policy?.personalization?.timelyEventDays);
}
function checkedInputs(db,spec,snapshot){
 canonical(spec);timestamp(spec.asOf);
 for(const key of ['reviewId','campaignId','candidateId','email'])required(spec[key],key);
 const count=messageStepsForMode(writingMode(spec)).length;
 if(typeof spec.synthetic!=='boolean'||!Array.isArray(spec.draftIds)||spec.draftIds.length!==count||new Set(spec.draftIds).size!==count||!Array.isArray(spec.facts)||!Array.isArray(spec.steps)||spec.steps.length!==count||!Array.isArray(spec.salesHypotheses)||!Array.isArray(spec.unknowns))throw Error('WRITING_SPEC_SHAPE');
 if(snapshot.contact.candidateId!==spec.candidateId||!snapshot.contact.attribution)throw Error('WRITING_ATTRIBUTION_MISMATCH');
 const cls=authorityClass(snapshot.contact,snapshot.assessment,spec.email);
 if(!allowedAttribution.has(cls)||!spec.recipient||spec.recipient.class!==cls)throw Error('WRITING_ATTRIBUTION_CLASS');
 required(spec.recipient.greeting);
 if(['GROUP_SHARED','GENERAL_BUSINESS','BUSINESS_ROLE'].includes(cls)&&!/^Hi .*(?:team|office),$/i.test(spec.recipient.greeting))throw Error('WRITING_ATTRIBUTION_GROUP_GREETING');
 if(cls==='DIRECT_PERSON'){
  const personId=snapshot.assessment.contacts?.find(c=>c.email===spec.email)?.attribution?.personId;
  const name=snapshot.assessment.personIdentity?.find(p=>p.value.personId===personId)?.value.name;
  if(!name||![`Hi ${name},`,`Hi ${name.split(/\s+/)[0]},`].includes(spec.recipient.greeting))throw Error('WRITING_ATTRIBUTION_PERSON_GREETING');
 }
 const ids=new Set();
 for(const fact of spec.facts){
  required(fact.id);required(fact.text);required(fact.source.excerpt);
  if(ids.has(fact.id)||!['CONTEXT','HISTORICAL','TIMELY'].includes(fact.usage))throw Error('WRITING_FACT_SHAPE');ids.add(fact.id);
  const value=pointer(sourceRecord(db,fact.source),fact.source.pointer),text=typeof value==='string'?value:canonical(value);
  if(!text.includes(fact.source.excerpt))throw Error('WRITING_EVIDENCE_EXCERPT_MISSING');
  if(fact.usage==='TIMELY'&&!timely(fact,spec.asOf,snapshot.freshness))throw Error('WRITING_EVENT_NOT_TIMELY');
 }
 for(const [i,row]of snapshot.drafts.entries()){
  const d=row.data,s=spec.steps[i];
  if(d.candidateId!==spec.candidateId||d.email!==spec.email||Number(d.step)!==i+1||s.draftId!==row.id||!snapshot.latestDrafts[i].some(x=>x.id===row.id)||snapshot.latestDrafts[i].length!==1)throw Error('WRITING_DRAFT_VERSION_OR_RECIPIENT');
  required(d.subject);required(d.body);required(s.angle);
  if(!d.body.startsWith(spec.recipient.greeting+'\n'))throw Error('WRITING_ATTRIBUTION_GREETING');
  if(!Array.isArray(s.factIds)||s.factIds.some(id=>!ids.has(id))||!Array.isArray(s.findings))throw Error('WRITING_UNSUPPORTED_FACT_REFERENCE');
  for(const f of s.findings){required(f.code);required(f.detail);if(!['BLOCK','REVIEW','NOTE'].includes(f.severity))throw Error('WRITING_FINDING_SHAPE');}
 }
 for(const text of [...spec.salesHypotheses,...spec.unknowns])required(text);
 const p=snapshot.policy;required(p.revision);required(p.approver);
 for(const k of ['name','title','company'])required(p.sender?.[k]);
 assertSequenceForMode(p.sequence,writingMode(spec));
}
function contentFindings(spec,snapshot){
 const findings=spec.steps.flatMap(s=>s.findings.map(f=>({...f,draftId:s.draftId})));
 for(const {id,data:d}of snapshot.drafts){
  const text=d.subject+'\n'+d.body;
  if(/\b(pre[ -]?approved|guaranteed|lowest rate|no risk|nothing to lose|we fund directly|we reviewed your finances|you need \$|you are expanding|you are purchasing|you qualify for)\b/i.test(text))findings.push({draftId:id,code:'PROHIBITED_CLAIM',severity:'BLOCK',detail:'Unsupported approval, need, expansion, purchase, eligibility or guaranteed-term assertion.'});
  if(/\{\{|\}\}/.test(text))findings.push({draftId:id,code:'UNRESOLVED_VARIABLE',severity:'BLOCK',detail:'Unresolved template variable.'});
  if(!d.body.includes(`${snapshot.policy.sender.name}\n${snapshot.policy.sender.title}\n${snapshot.policy.sender.company}`))findings.push({draftId:id,code:'SENDER_IDENTITY',severity:'BLOCK',detail:'Sender signature does not match writing policy.'});
  const synthetic=spec.synthetic||snapshot.candidate.synthetic===true||snapshot.candidate.syntheticOnly===true||snapshot.policy.synthetic===true||snapshot.campaign.purpose==='synthetic_qa'||/^(?:synthetic|qa)[-_:]/i.test(spec.candidateId)||/\.(?:test|invalid|example)$/i.test(spec.email);
  if(!synthetic&&snapshot.policy.physicalAddressApproved===true&&(!snapshot.policy.physicalAddress?.trim()||!d.body.includes(snapshot.policy.physicalAddress)))findings.push({draftId:id,code:'PHYSICAL_ADDRESS_FOOTER_MISSING',severity:'BLOCK',detail:'Approved physical address must appear in the reviewed body.'});
  if(!synthetic&&snapshot.policy.optOutApproved===true&&(!snapshot.policy.optOut?.text?.trim()||!d.body.includes(snapshot.policy.optOut.text)))findings.push({draftId:id,code:'OPT_OUT_TEXT_MISSING',severity:'BLOCK',detail:'Approved opt-out text must appear in the reviewed body.'});
 }
 return findings;
}
function invalidateDecisions(db,reviewId,reason){
 for(const row of db.prepare("SELECT id,data_json FROM records WHERE kind='writing_decision'").all()){
  const d=JSON.parse(row.data_json);if(d.reviewId===reviewId&&d.decision==='APPROVED')putRecord(db,'writing_decision',row.id,{...d,decision:'INVALIDATED',reason},'assessment');
 }
}
// Read-only preparation for assisted drafting. Deliberately does not install
// revision triggers, create packets, import drafts or mutate approvals.
export function previewDraftingContext(db,spec){
 const snapshot=capture(db,spec);checkedInputs(db,spec,snapshot);
 const sourceDetails=spec.facts.map(f=>{const source=sourceRecord(db,f.source);return {factId:f.id,evidenceClass:source.evidenceClass??null,publishedAt:source.publishedAt??null,observedAt:source.observedAt??null,assertedAt:source.assertedAt??null,sourceLocation:source.sourceLocation??source.url??null};});
 return assembleDraftingContext({spec,snapshot,sourceDetails});
}
export function prepareWritingReview(db,spec){
 return atomic(db,()=>{
  installRevisionTracking(db);
  const snapshot=capture(db,spec);checkedInputs(db,spec,snapshot);
  const qualityReport=assessDraftQuality(spec,snapshot);
  const core={contractVersion:writingMode(spec),spec,snapshot,qualityReport,findings:[...contentFindings(spec,snapshot),...qualityReport.findings]};
  const coreHash=hash(core),current=getRecord(db,'writing_current',spec.reviewId);
  if(current){const old=get(db,'writing_packet',current.packetHash);if(old.coreHash===coreHash)return old;}
  const data={...core,coreHash,reviewId:spec.reviewId,version:(current?.version??0)+1,campaignId:spec.campaignId,candidateId:spec.candidateId,email:spec.email,policy:snapshot.policy,messages:snapshot.drafts.map(({data:d})=>({subject:d.subject,body:d.body})),synthetic:spec.synthetic||snapshot.candidate.synthetic===true||snapshot.candidate.syntheticOnly===true||snapshot.policy.synthetic===true||snapshot.campaign.purpose==='synthetic_qa'||/^(?:synthetic|qa)[-_:]/i.test(spec.candidateId)||/\.(?:test|invalid|example)$/i.test(spec.email)};
  const packet={...data,hash:hash(data)};immutable(db,'writing_packet',packet.hash,packet);invalidateDecisions(db,spec.reviewId,'Material review revision');
  putRecord(db,'writing_current',spec.reviewId,{packetHash:packet.hash,version:packet.version},'assessment');journal(db,'WRITING_REVIEW_PREPARED',spec.reviewId,{packetHash:packet.hash,version:packet.version});return packet;
 });
}
function currentPacket(db,reviewId,packetHash){
 const current=getRecord(db,'writing_current',reviewId),packet=getRecord(db,'writing_packet',packetHash);
 if(!packet||current?.packetHash!==packetHash||packet.reviewId!==reviewId)throw Error('WRITING_STALE_PACKET');
 const {hash:stored,...content}=packet;if(stored!==hash(content))throw Error('WRITING_PACKET_INTEGRITY');
 if(packet.contractVersion!==writingMode(packet.spec))throw Error('WRITING_CONTRACT_VERSION');
 if(packet.qualityReport?.version!==DRAFTING_QUALITY_VERSION)throw Error('WRITING_STALE_QUALITY_POLICY');
 if(canonical(capture(db,packet.spec))!==canonical(packet.snapshot))throw Error('WRITING_STALE_BINDINGS');
 return packet;
}
export function decideWritingReview(db,input){
 canonical(input);for(const k of ['actionId','reviewId','packetHash','actor'])required(input[k]);timestamp(input.at);timestamp(input.expiresAt);
 if(!['APPROVED','REJECTED','REVISION_REQUESTED','REVOKED'].includes(input.decision)||!Array.isArray(input.acknowledgedFindings))throw Error('WRITING_DECISION_SHAPE');
 return atomic(db,()=>{
  const receipt=getRecord(db,'writing_action',input.actionId),inputHash=hash(input);
  if(receipt){if(receipt.inputHash!==inputHash)throw Error('WRITING_ACTION_REUSED');currentPacket(db,input.reviewId,input.packetHash);return {...get(db,'writing_decision',receipt.decisionId),duplicate:true};}
  const p=currentPacket(db,input.reviewId,input.packetHash);
  if(input.actor!==p.policy.approver)throw Error('WRITING_UNAUTHORIZED_ACTOR');
  if(timestamp(input.expiresAt)<=timestamp(input.at))throw Error('WRITING_APPROVAL_EXPIRED');
  if((!p.synthetic||p.contractVersion===FIRST_TOUCH_CONTRACT)&&input.decision==='APPROVED'&&!writingApprovalExpiryAllowed(p.policy,input.at,input.expiresAt,p.contractVersion))throw Error('WRITING_APPROVAL_EXPIRY_POLICY_REQUIRED');
  if(input.decision==='APPROVED'){
   if(p.findings.some(f=>f.severity==='BLOCK'))throw Error('WRITING_CONTENT_BLOCKED');
   if(p.findings.some(f=>f.severity==='REVIEW'&&!input.acknowledgedFindings.includes(f.code)))throw Error('WRITING_REVIEW_ACKNOWLEDGMENT_REQUIRED');
  }
  invalidateDecisions(db,input.reviewId,'Superseded content decision');
  const d={id:input.actionId,...input,reason:null};immutable(db,'writing_decision',d.id,d);immutable(db,'writing_action',input.actionId,{inputHash,decisionId:d.id});journal(db,'WRITING_DECISION',input.reviewId,{id:d.id,packetHash:p.hash,decision:input.decision});return d;
 });
}
export function evaluateWritingReview(db,reviewId,decisionId,at=now()){
 timestamp(at);const reasons=[];const current=getRecord(db,'writing_current',reviewId);let p;
 try{p=currentPacket(db,reviewId,current?.packetHash);}catch(e){return {contentApproved:false,contactEligible:false,campaignEligible:false,synthetic:false,reasons:[e.message]};}
 const d=decisionId?getRecord(db,'writing_decision',decisionId):null;
 let contentApproved=!!d&&d.decision==='APPROVED'&&d.reviewId===reviewId&&d.packetHash===p.hash&&d.actor===p.policy.approver&&timestamp(d.at)<=timestamp(at)&&timestamp(d.expiresAt)>timestamp(at);
 if((!p.synthetic||p.contractVersion===FIRST_TOUCH_CONTRACT)&&contentApproved&&!writingApprovalExpiryAllowed(p.policy,d.at,d.expiresAt,p.contractVersion)){contentApproved=false;reasons.push('WRITING_APPROVAL_EXPIRY_POLICY_REQUIRED');}
 if(/\bthis year\b/i.test(p.messages.map(m=>m.body).join('\n'))&&new Date(at).getUTCFullYear()!==new Date(p.spec.asOf).getUTCFullYear()){contentApproved=false;reasons.push('WRITING_RELATIVE_YEAR_EXPIRED');}
 if(p.spec.facts.some(f=>f.usage==='TIMELY'&&!timely(f,at,p.snapshot.freshness))){contentApproved=false;reasons.push('WRITING_EVENT_FRESHNESS_EXPIRED');}
 if(!contentApproved)reasons.push('WRITING_CONTENT_UNAPPROVED_OR_STALE');
 const contactCheck=contactEligibility(p.snapshot,p.email,at),contactEligible=contactCheck.allowed;reasons.push(...contactCheck.reasons);
 const policy=p.policy,campaignEligible=p.snapshot.campaign.mustRemainInactive!==true&&sequenceReleaseReady(policy.sequence,p.contractVersion)&&policy.physicalAddressApproved===true&&policy.optOutApproved===true&&(p.synthetic||writingReleasePolicyConfigured(policy,p.contractVersion));
 if(p.snapshot.campaign.mustRemainInactive===true)reasons.push('WRITING_CAMPAIGN_MUST_REMAIN_INACTIVE');
 if(!campaignEligible)reasons.push('WRITING_CAMPAIGN_CONFIGURATION_UNAPPROVED');
 return {packetHash:p.hash,contentApproved,contactEligible,campaignEligible,synthetic:p.synthetic,reasons};
}
function contactEligibility(snapshot,email,at){
 const c=snapshot.contact,freshness=snapshot.freshness,reasons=[];
 const freshVerification=withinDays(c.verifiedAt,at,freshness?.emailVerification?.daysBeforeFirstRelease);
 const freshAttribution=withinDays(c.attributionCorroboratedAt,at,freshness?.contactRoleAttribution?.meaningfulCorroborationDays);
 const freshOperation=withinDays(snapshot.candidate.operatingStatusCheckedAt,at,freshness?.operatingStatus?.daysBeforeFirstRelease);
 if(!freshVerification)reasons.push('WRITING_VERIFICATION_FRESHNESS_UNESTABLISHED');
 if(!freshAttribution)reasons.push('WRITING_ATTRIBUTION_FRESHNESS_UNESTABLISHED');
 if(!freshOperation)reasons.push('WRITING_OPERATING_STATUS_FRESHNESS_UNESTABLISHED');
 if(!allowedAttribution.has(authorityClass(c,snapshot.assessment,email)))reasons.push('WRITING_ATTRIBUTION_UNESTABLISHED');
 const allowed=snapshot.candidate.qualification==='QUALIFIED'&&snapshot.refinement.disposition==='QUALIFIED_FOR_REVIEW'&&c.verification==='PASSED'&&c.suppressed===false&&reasons.length===0;
 if(!allowed)reasons.push('WRITING_CONTACT_HELD_OR_SUPPRESSED');
 return {allowed,reasons};
}
export function evaluateWritingBatch(db,content,at=now(),options={}){
 const isolated=permitsIsolatedHandoff(db,options.fixtureAdapter);
 const reasons=[];
 if(!Array.isArray(content?.recipients)||!content.recipients.length)return {allowed:false,reasons:['Writing recipients required']};
 for(const r of content.recipients){
  if(!r.writing){reasons.push('Writing review binding required');continue;}
  const w=r.writing,g=evaluateWritingReview(db,w.reviewId,w.decisionId,at),p=getRecord(db,'writing_packet',w.packetHash);
  if(p?.contractVersion===FIRST_TOUCH_CONTRACT&&content.recipients.length!==1){reasons.push('First-touch-only requires one exact recipient');continue;}
  if(!p||p.hash!==g.packetHash||p.campaignId!==content.campaignId||p.candidateId!==r.candidateId||p.email!==r.email||canonical(p.messages)!==canonical(r.messages)||canonical(p.policy.sequence)!==canonical(content.sequence)){reasons.push('Writing packet, recipient, messages or sequence mismatch');continue;}
  if(!g.contentApproved||!g.contactEligible||!g.campaignEligible)reasons.push(...g.reasons);
  if(g.synthetic&&!isolated)reasons.push('Synthetic writing records cannot reach handoff');
 }
 return {allowed:reasons.length===0,reasons};
}
export function writingApprovalExpiryAllowed(policy,issuedAt,expiresAt,mode=LEGACY_WRITING_CONTRACT){
 try{
  const p=policy.approvalExpiry,start=timestamp(issuedAt),end=timestamp(expiresAt);
  if(writingMode({contractVersion:mode})===FIRST_TOUCH_CONTRACT)return firstTouchExpiryPolicyConfigured(policy)&&timestamp(p.approvedAt)<=start&&end>start&&end<=timestamp(firstTouchApprovalDeadline(issuedAt));
  return p?.approved===true&&p.approvedBy===policy.approver&&typeof p.revision==='string'&&!!p.revision.trim()&&timestamp(p.approvedAt)<=start&&Number.isSafeInteger(p.maxAgeMs)&&p.maxAgeMs>0&&end>start&&end-start<=p.maxAgeMs;
 }catch{return false;}
}
export function writingReleasePolicyConfigured(policy,mode=LEGACY_WRITING_CONTRACT){
 const p=policy.approvalExpiry;
 const expiryConfigured=writingMode({contractVersion:mode})===FIRST_TOUCH_CONTRACT?firstTouchExpiryPolicyConfigured(policy):p?.approved===true&&p.approvedBy===policy.approver&&typeof p.revision==='string'&&!!p.revision.trim()&&Number.isSafeInteger(p.maxAgeMs)&&p.maxAgeMs>0;
 return typeof policy.physicalAddress==='string'&&!!policy.physicalAddress.trim()&&policy.optOut?.approved===true&&policy.optOut.mode==='REPLY_STOP'&&typeof policy.optOut.text==='string'&&!!policy.optOut.text.trim()&&expiryConfigured;
}
const html=text=>text.replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;').replace(/\r\n/g,'\n').replaceAll('\n','<br>');
export function reviewVariables(packet){return Object.fromEntries(packet.messages.flatMap((m,i)=>[[`pilot_subject_${i+1}`,m.subject],[`pilot_body_${i+1}`,html(m.body)]]));}
// Shared exact-message renderer for each explicit contract mode.
export function renderWritingStep(packet,index,{details=true}={}){
 if(!Number.isSafeInteger(index)||index<0||index>=messageStepsForMode(writingMode(packet.spec)).length||!packet.messages[index])throw Error('WRITING_STEP_INDEX');
 const m=packet.messages[index];
 const lines=[`## Step ${index+1}`,`Subject: ${m.subject}`,m.body];
 if(details)lines.push(`Angle: ${packet.spec.steps[index].angle}`,`Fact references: ${packet.spec.steps[index].factIds.join(', ')||'None; sequence-close context'}`,...packet.findings.filter(f=>f.draftId===packet.spec.draftIds[index]).map(f=>`${f.severity} ${f.code}: ${f.detail}`));
 return lines.join('\n\n');
}
export function renderWritingReview(packet){
 const c=packet.snapshot.contact,check=contactEligibility(packet.snapshot,packet.email,packet.spec.asOf);
 const lines=[`# Writing review ${packet.reviewId} / v${packet.version}`,`Packet SHA-256: ${packet.hash}`,`**${!check.allowed?'CONTACT HELD — NO HANDOFF':'CONTACT CHECKS PASSED IN SNAPSHOT'}**`,`${packet.email}: ${c.attribution}. Verification: ${c.verification}; suppression: ${String(c.suppressed)}.`,`Contact evaluation as of ${packet.spec.asOf}: ${check.reasons.join('; ')||'Snapshot checks passed; recheck required at handoff'}.`, 'LOCAL COPY REVIEW ONLY. Content approval is separate from batch approval and launch authorization.',`Synthetic: ${packet.synthetic}. Policy: ${packet.policy.revision}. Human review required; lexical checks do not prove semantic truth.`, '## Supported facts',...packet.spec.facts.map(f=>`- ${f.text} [${f.usage}; ${f.source.kind}/${f.source.id}${f.source.pointer}]`),'## Sales hypotheses',...packet.spec.salesHypotheses.map(x=>`- ${x}`),'## Unknowns',...packet.spec.unknowns.map(x=>`- ${x}`)];
 for(const i of packet.messages.keys())lines.push(renderWritingStep(packet,i));
 return lines.join('\n\n')+'\n';
}
