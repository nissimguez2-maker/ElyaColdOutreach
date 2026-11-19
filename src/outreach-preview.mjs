// Local preparation only. SELECTs and a read transaction; no grants, reservations,
// file writes, transport or release operations. Time and record selectors are explicit.
import {getRecord,controls} from './store.mjs';
import {latestBatch,evaluateRelease} from './batches.mjs';
import {evaluateWritingBatch,evaluateWritingReview,reviewVariables} from './writing.mjs';
import {canonical,digest,required,timestamp} from './values.mjs';
import {formatOutreachCsv,CSV_COLUMNS} from './outreach-csv.mjs';
import {evaluateManualContactGate} from './manual-response.mjs';
import {writingMode} from './writing-mode.mjs';

const releaseOnly=new Set(['System stopped','System launch not authorized','Outside New York sending window']);
const unique=values=>[...new Set(values)];
function readSnapshot(db,fn){
 if(db.isTransaction)throw Error('PREVIEW_REQUIRES_SEPARATE_READ_SNAPSHOT');
 db.exec('BEGIN');
 try{const result=fn();db.exec('COMMIT');return result;}
 catch(error){db.exec('ROLLBACK');throw error;}
}
function input(value,allowRecipients){
 canonical(value);timestamp(value.at);
 const allowed=['batchId','approvalId','at',...(allowRecipients?['recipients']:[])];
 if(Object.keys(value).some(k=>!allowed.includes(k)))throw Error('PREVIEW_UNKNOWN_OPTION');
 if(value.batchId){required(value.batchId);if(value.recipients!==undefined)throw Error('PREVIEW_SELECT_BATCH_OR_RECIPIENTS');}
 else if(!allowRecipients||!Array.isArray(value.recipients)||!value.recipients.length)throw Error('PREVIEW_RECIPIENTS_REQUIRED');
 if(value.recipients)for(const r of value.recipients){
  if(!r||Object.getPrototypeOf(r)!==Object.prototype||Object.keys(r).some(k=>!['candidateId','email','reviewId','decisionId'].includes(k)))throw Error('PREVIEW_SELECTOR_FIELDS_INVALID');
  required(r.candidateId);required(r.email);if(r.reviewId!==undefined&&r.reviewId!==null)required(r.reviewId);if(r.decisionId!==undefined&&r.decisionId!==null)required(r.decisionId);
 }
 if(value.approvalId!==undefined&&value.approvalId!==null)required(value.approvalId);
}
function batchAssessment(db,{batchId,approvalId,at}){
 const batch=latestBatch(db,batchId);if(!batch)return {batch:null,content:null,allowed:false,batchApproved:false,reasons:['EXACT_BATCH_MISSING'],releaseReasons:[]};
 const content=JSON.parse(batch.content_json),approval=approvalId?db.prepare('SELECT * FROM approvals WHERE id=?').get(approvalId):null;
 let batchApproved=!!approval&&approval.decision==='APPROVED'&&approval.batch_id===batchId&&approval.version===batch.version&&approval.hash===batch.hash&&digest(canonical(content))===batch.hash&&timestamp(approval.created_at)<=timestamp(at)&&timestamp(approval.expires_at)>timestamp(at);
 // Reuse every existing release-data check. Only operational stop/launch/window
 // reasons are reported separately: a local export does not acquire release authority.
 const release=evaluateRelease(db,batchId,approvalId??'',at),writing=evaluateWritingBatch(db,content,at);
 const reasons=unique([...release.reasons.filter(r=>!releaseOnly.has(r)),...writing.reasons]);
 if(content.recipients.some(r=>getRecord(db,'writing_packet',r.writing?.packetHash??'')?.policy.approver!==approval?.actor)){reasons.push('EXPORT_BATCH_APPROVER_MISMATCH');batchApproved=false;}
 return {batch,content,batchApproved,allowed:reasons.length===0,reasons:unique(reasons),releaseReasons:release.reasons.filter(r=>releaseOnly.has(r))};
}
function recipientPreview(db,r,at,batchApproved){
 required(r.candidateId);required(r.email);
 const binding=r.writing??r,current=binding.reviewId?getRecord(db,'writing_current',binding.reviewId):null;
 const packet=getRecord(db,'writing_packet',binding.packetHash??current?.packetHash??'');
 const matches=packet?.candidateId===r.candidateId&&packet?.email===r.email&&packet?.reviewId===binding.reviewId;
 const contact=getRecord(db,'contact',r.email),candidate=getRecord(db,'candidate',r.candidateId),refinement=getRecord(db,'refinement_current',r.candidateId);
 const check=matches?evaluateWritingReview(db,binding.reviewId,binding.decisionId??null,at):{contactEligible:false,contentApproved:false,campaignEligible:false,reasons:['PREVIEW_PACKET_MISSING_OR_IDENTITY_MISMATCH']};
 if(matches&&(check.packetHash!==packet.hash||(r.messages!==undefined&&canonical(r.messages)!==canonical(packet.messages)))){
  check.contentApproved=false;check.reasons.push('PREVIEW_DISPLAYED_COPY_OR_PACKET_BINDING_MISMATCH');
 }
 const manualGate=evaluateManualContactGate(db,{email:r.email,candidateId:r.candidateId,at});
 const reasons=[...check.reasons,...manualGate.reasons],flags=[];
 if(contact?.suppressed===true)flags.push('SUPPRESSED');
 if(contact?.verification!=='PASSED'||reasons.some(r=>r.includes('VERIFICATION_FRESHNESS')))flags.push('UNVERIFIED');
 if(contact?.suppressed!==true&&contact?.suppressed!==false)flags.push('SUPPRESSION_UNKNOWN');
 if(!check.contentApproved||!batchApproved)flags.push('APPROVAL_MISSING');
 if(!manualGate.allowed||contact?.candidateId!==r.candidateId||candidate?.qualification!=='QUALIFIED'||refinement?.disposition!=='QUALIFIED_FOR_REVIEW'||!check.contactEligible||!check.campaignEligible||check.synthetic||contact?.suppressed!==false)flags.unshift('HELD');
 if(check.synthetic)reasons.push('Synthetic writing records cannot reach handoff');
 if(!batchApproved)reasons.push('EXACT_BATCH_APPROVAL_MISSING');
 if(!flags.length)flags.push('ELIGIBLE');
 return {candidateId:r.candidateId,email:r.email,attribution:contact?.attribution??null,verification:contact?.verification??null,suppressed:contact?.suppressed??null,flags:unique(flags),reasons:unique(reasons),contentApproved:check.contentApproved,batchApproved,
  messages:structuredClone(r.messages??(matches?packet.messages:[])),
  evidence:matches?packet.spec.facts.map(f=>({...structuredClone(f),sourceHash:packet.snapshot.sources.find(s=>s.factId===f.id)?.hash??null})):[],
  evidenceMeaning:'Evidence bound to the displayed writing packet; stale-binding reasons remain applicable'};
}
export function previewOutreach(db,request){
 input(request,true);
 return readSnapshot(db,()=>{
  const assessment=request.batchId?batchAssessment(db,request):null;
  const recipients=assessment?.content?.recipients??request.recipients??[];
  const rows=recipients.map(r=>recipientPreview(db,r,request.at,assessment?.batchApproved===true));
  if(assessment&&!assessment.allowed)for(const row of rows){
   row.flags=unique(['HELD',...row.flags.filter(flag=>flag!=='ELIGIBLE')]);row.reasons.push('BATCH_EXPORT_BLOCKED_SEE_BATCH_REASONS');
  }
  return {label:'PREVIEW — NOT RELEASED',mode:'DIAGNOSTIC_PREVIEW',asOf:request.at,batchId:request.batchId??null,batchVersion:assessment?.batch?.version??null,batchHash:assessment?.batch?.hash??null,
   recipients:rows,exportEligible:assessment?.allowed===true,csvValidation:'NOT_PERFORMED',reasons:assessment?.reasons??['EXACT_BATCH_APPROVAL_MISSING'],releaseReasons:assessment?.releaseReasons??[],controls:controls(db),releaseAllowed:false,dispatchEnabled:false};
 });
}
export function renderOutreachPreview(preview){
 if(preview?.label!=='PREVIEW — NOT RELEASED'||preview.mode!=='DIAGNOSTIC_PREVIEW')throw Error('DIAGNOSTIC_PREVIEW_REQUIRED');
 const lines=[preview.label,'Diagnostic local report. Not a campaign-import CSV; no release authority.',`As of: ${preview.asOf}`,`Record eligibility: ${preview.exportEligible?'PASS':'BLOCKED'}; CSV validation is separate.`,`Release controls: ${JSON.stringify(preview.controls)}`,...preview.reasons.map(r=>'Export reason: '+JSON.stringify(r)),...preview.releaseReasons.map(r=>'Release reason: '+JSON.stringify(r))];
 for(const row of preview.recipients){lines.push('',`Recipient: ${JSON.stringify(row.email)}`,`States: ${row.flags.join(', ')}`,`Attribution: ${JSON.stringify(row.attribution)}`,...row.reasons.map(r=>'Reason: '+JSON.stringify(r)));
  row.messages.forEach((m,i)=>lines.push(`Step ${i+1} subject: ${JSON.stringify(m.subject)}`,`Step ${i+1} body: ${JSON.stringify(m.body)}`));
  row.evidence.forEach(f=>lines.push('Bound evidence: '+JSON.stringify(f)));
 }
 return lines.join('\n')+'\n';
}
export function evaluateOutreachExport(db,request){
 input(request,false);return readSnapshot(db,()=>{const result=batchAssessment(db,request);return {allowed:result.allowed,reasons:result.reasons,batchId:request.batchId,batchVersion:result.batch?.version??null,batchHash:result.batch?.hash??null,releaseAllowed:false,releaseReasons:result.releaseReasons};});
}
export function buildApprovedOutreachCsv(db,request){
 input(request,false);
 return readSnapshot(db,()=>{
  const checked=batchAssessment(db,request),base={label:'APPROVED CSV — NOT RELEASED',batchId:request.batchId,batchVersion:checked.batch?.version??null,batchHash:checked.batch?.hash??null,releaseAllowed:false,dispatchEnabled:false,releaseReasons:checked.releaseReasons};
  if(!checked.allowed)return {...base,label:'EXPORT BLOCKED — NOT RELEASED',status:'BLOCKED',reasons:checked.reasons};
  const rows=checked.content.recipients.map(r=>{
   const fields=r.standardFields??{};canonical(fields);
   if(!fields||Object.getPrototypeOf(fields)!==Object.prototype||Object.keys(fields).some(k=>!CSV_COLUMNS.slice(1,6).includes(k)))throw Error('EXPORT_STANDARD_FIELDS_INVALID');
   return {...fields,email:r.email,...reviewVariables(getRecord(db,'writing_packet',r.writing.packetHash))};
  });
  const modes=checked.content.recipients.map(r=>writingMode(getRecord(db,'writing_packet',r.writing.packetHash).spec));
  if(new Set(modes).size!==1)throw Error('EXPORT_MIXED_WRITING_CONTRACTS');
  const formatted=formatOutreachCsv(rows,{contractVersion:modes[0]});
  if(formatted.spreadsheetConflicts.length)return {...base,label:'EXPORT BLOCKED — NOT RELEASED',status:'BLOCKED',reasons:['CSV_SPREADSHEET_SAFETY_CONFLICT_REQUIRES_REVIEW'],spreadsheetConflicts:formatted.spreadsheetConflicts};
  return {...base,status:'APPROVED_EXPORT_NOT_RELEASED',encoding:formatted.encoding,columns:formatted.columns,csv:formatted.csv,csvHash:digest(formatted.csv),recipientCount:rows.length};
 });
}
