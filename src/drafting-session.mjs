// Local evidence files only. No import, model call, approval or release.
import {readFileSync,writeFileSync,mkdirSync,realpathSync} from 'node:fs';
import {resolve,relative,isAbsolute,dirname} from 'node:path';
import {canonical,digest,required} from './values.mjs';
import {createDraftProvenanceTemplate,prepareAssistedImport,createCriticalReviewPacket,validateCriticalReviewResult} from './drafting-handoff.mjs';
const hash=value=>digest(canonical(value));
function parse(bytes){try{return JSON.parse(bytes.toString('utf8').replace(/^\uFEFF/,''));}catch{throw Error('INVALID_JSON');}}
function localPath(root,path,{output=false}={}){
 required(path,'Local path');
 if(isAbsolute(path)||path.includes('\\')||path.split('/').some(p=>p==='..'||p==='.'||!p)||output&&!path.startsWith('work/'))throw Error('LOCAL_WORK_PATH_REQUIRED');
 const base=realpathSync(root),target=resolve(base,path),actual=realpathSync(output?dirname(target):target),rel=relative(output?resolve(base,'work'):base,actual);
 if(rel==='..'||rel.startsWith('..'+(process.platform==='win32'?'\\':'/'))||isAbsolute(rel))throw Error('LOCAL_WORK_PATH_REQUIRED');
 return target;
}
function checkedArtifact(root,ref){
 if(!ref||!/^[a-f0-9]{64}$/.test(ref.sha256))throw Error('ARTIFACT_REFERENCE_REQUIRED');
 const bytes=readFileSync(localPath(root,ref.path));if(digest(bytes)!==ref.sha256)throw Error('ARTIFACT_HASH_MISMATCH');return bytes;
}
function draftView(result){return '# Draft proposal — UNAPPROVED / NOT SENDABLE\n\nNo content approval, contact clearance or sending authority. Slots 2 and 3 are hypothetical writing artifacts; zero automated follow-ups.\n\n'+result.drafts.map(d=>`## Step ${d.step}\n\nSubject: ${d.subject}\n\n${d.body}`).join('\n\n')+'\n';}
export function readCurrentWriting({root,indexPath='work/current-writing/index.json',db}){
 const index=parse(readFileSync(localPath(root,indexPath)));
 if(index.version!=='elya-current-writing-v1'||index.status!=='UNAPPROVED_NOT_SENDABLE')throw Error('CURRENT_WRITING_INDEX_REQUIRED');
 const bytes={};for(const [key,ref]of Object.entries(index.artifacts))bytes[key]=checkedArtifact(root,ref);
 const packet=parse(bytes.packet),result=parse(bytes.result),provenance=parse(bytes.provenance).operatorProvenance,reviewBinding=parse(bytes.reviewBinding),review=parse(bytes.review),closeout=parse(bytes.closeout),caveats=parse(bytes.caveats);
 const expected=createCriticalReviewPacket(packet,result);
 if(canonical(expected)!==canonical(reviewBinding))throw Error('CURRENT_REVIEW_BINDING_MISMATCH');
 const validation=validateCriticalReviewResult(reviewBinding,review),firstTouch=result.drafts[0],exactFirstTouchHash=hash({subject:firstTouch.subject,body:firstTouch.body});
 if(closeout.status!=='MANUAL_DRAFTING_EVALUATION_CLOSED'||closeout.contentState!=='UNAPPROVED_NOT_SENDABLE'||closeout.candidatePath!==index.artifacts.result.path||closeout.candidateFileSha256!==index.artifacts.result.sha256||closeout.packetHash!==packet.hash||closeout.reviewBindingHash!==reviewBinding.hash||closeout.reviewedDraftHash!==reviewBinding.reviewedDraftHash||closeout.reviewedResultHash!==reviewBinding.reviewedResultHash||closeout.exactFirstTouchHash!==exactFirstTouchHash||closeout.rawReviewSha256!==index.artifacts.review.sha256||closeout.reviewResultHash!==validation.resultHash||closeout.verdict!==review.verdict||closeout.humanContentApproval!==false||closeout.batchApproval!==false||closeout.sendingAuthority!==false)throw Error('CURRENT_CLOSEOUT_BINDING_MISMATCH');
 if(canonical(closeout.editorialOutcome.reviewedSteps)!=='[1]'||canonical(closeout.followUps.steps)!=='[2,3]'||closeout.followUps.newlyReviewed!==false||closeout.followUps.acceptedFirstTouchEvaluationScope!==false||closeout.historicalMetadata.status!=='HISTORICAL_NOT_CURRENT'||closeout.historicalMetadata.caveatsPath!==index.artifacts.caveats.path)throw Error('CURRENT_EVALUATION_SCOPE_MISMATCH');
 if(provenance.review.artifact?.sourceRef!==index.artifacts.review.path||provenance.review.artifact?.sha256!==index.artifacts.review.sha256||provenance.review.reviewedDraftHash!==reviewBinding.reviewedDraftHash)throw Error('CURRENT_REVIEW_PROVENANCE_MISMATCH');
 const envelope={packet,result,provenance};if(db)prepareAssistedImport(db,envelope);
 const readable=`# Retained first touch — UNAPPROVED / NOT SENDABLE\n\nManual drafting evaluation closed. Supplied review verdict: ${review.verdict}.\nEditorial review covers only step 1. Hash binding covers all three preserved slots; steps 2 and 3 were not newly reviewed and are not approved or scheduled.\nHistorical rationale and author self-critique remain preserved from earlier wording, not reassessed for this first touch.\nNo human content approval, recipient clearance, footer approval or sending authority is granted.\n\nSubject: ${firstTouch.subject}\n\n${firstTouch.body}\n\n---\n\nExact first-touch subject/body SHA-256: ${exactFirstTouchHash}\nThree-slot draft hash: ${reviewBinding.reviewedDraftHash}\nNo further model cycle is requested. Review the local launch-decision bundle and unresolved dependencies before any separately authorized action.\n`;
 if(bytes.firstTouch&&bytes.firstTouch.toString('utf8')!==readable)throw Error('CURRENT_DRAFT_VIEW_MISMATCH');
 return {status:'UNAPPROVED_NOT_SENDABLE',indexPath,index,envelope,reviewBinding,review,closeout,caveats,readable,reviewedSteps:[1],exactFirstTouchHash,currentContextChecked:Boolean(db),contentApproval:false,releaseAuthorized:false,liveCalls:0};
}
export function receiveWritingResult(db,input,{root}){
 const output=localPath(root,input.outputDirectory,{output:true});mkdirSync(output); // Exclusive: never overwrite a previous attempt.
 const receipt={version:'elya-writing-receipt-v1',kind:['draft','review'].includes(input.kind)?input.kind:null,status:'REJECTED',recordedAt:new Date().toISOString(),recordedAtMeaning:'Local receipt time only; not model generation or review time',artifacts:{},contentApproval:false,releaseAuthorized:false,imported:false,liveCalls:0};
 const save=(key,name,value)=>{const bytes=Buffer.isBuffer(value)?value:Buffer.from(typeof value==='string'?value:JSON.stringify(value,null,2)+'\n');writeFileSync(resolve(output,name),bytes,{flag:'wx'});receipt.artifacts[key]={path:input.outputDirectory+'/'+name,sha256:digest(bytes)};return bytes;};
 const source=(key,path)=>save(key,key+'.json',readFileSync(localPath(root,path)));
 try{
  const raw=save('raw','raw.txt',readFileSync(isAbsolute(input.rawPath)?input.rawPath:resolve(root,input.rawPath)));
  canonical(input);save('request','request.json',input);
  if(Object.keys(input).some(k=>!['kind','packetPath','bindingPath','rawPath','outputDirectory','provenancePath','materialEdit','review','reviewedSteps'].includes(k)))throw Error('WRITING_REQUEST_SHAPE');
  const result=parse(raw);let packet,provenance,binding;
  if(input.kind==='draft'){
   packet=parse(source('packet',input.packetPath));
   if(input.materialEdit){
    if(input.provenancePath)throw Error('EDIT_PROVENANCE_COMES_FROM_PRIOR_RECEIPT');
    const edit=input.materialEdit;
    if(Object.keys(edit).sort().join(',')!=='at,editor,previousReceiptPath,reason')throw Error('MATERIAL_EDIT_SHAPE');
    const prior=parse(source('previousReceipt',edit.previousReceiptPath));
    if(prior.version!=='elya-writing-receipt-v1'||!['VALID_LOCAL_PROPOSAL_NOT_IMPORTED','LOCAL_SCHEMA_VALIDATED_NOT_APPROVED'].includes(prior.status))throw Error('VALID_PRIOR_DRAFT_RECEIPT_REQUIRED');
    for(const ref of Object.values(prior.artifacts))checkedArtifact(root,ref);
    const previous=parse(checkedArtifact(root,prior.artifacts.envelope));prepareAssistedImport(db,previous);
    if(previous.packet.hash!==packet.hash)throw Error('MATERIAL_EDIT_PACKET_MISMATCH');
    provenance=previous.provenance;
    provenance.materialEdits.push({at:edit.at,editor:edit.editor,reason:edit.reason,beforeDraftHash:hash(previous.result.drafts),afterDraftHash:hash(result.drafts)});
   }else provenance=input.provenancePath?parse(source('provenanceInput',input.provenancePath)):createDraftProvenanceTemplate(result);
   const envelope={packet,result,provenance},proposal=prepareAssistedImport(db,envelope);binding=createCriticalReviewPacket(packet,result);
   save('envelope','envelope.json',envelope);save('provenance','provenance.json',provenance);save('normalizedProvenance','normalized-provenance.json',proposal.provenance);
   save('draftView','drafts.md',draftView(result));save('reviewBinding','review-binding.json',binding);
   save('reviewPacket','review-packet.md','# Bound critical review — UNAPPROVED / NOT SENDABLE\n\n'+binding.messages.map(m=>'## '+m.role.toUpperCase()+'\n\n'+m.content).join('\n\n')+'\n');
   receipt.status='VALID_LOCAL_PROPOSAL_NOT_IMPORTED';receipt.nextStep='If a new review is authorized, use review-packet.md and preserve its raw result with kind review. No automatic external action.';
  }else if(input.kind==='review'){
   binding=parse(source('reviewBinding',input.bindingPath));packet=binding.sourcePacket;
   const validation=validateCriticalReviewResult(binding,result);
   if(!Array.isArray(input.reviewedSteps)||!input.reviewedSteps.length||input.reviewedSteps.some((step,i)=>![1,2,3].includes(step)||i>0&&step<=input.reviewedSteps[i-1]))throw Error('EXPLICIT_REVIEWED_STEPS_REQUIRED');
   if(!input.review||Object.keys(input.review).sort().join(',')!=='method,reviewedAt,reviewerLabel'||input.review.method==='NOT_PERFORMED')throw Error('REVIEW_OBSERVATIONS_REQUIRED');
   provenance=input.provenancePath?parse(source('provenanceInput',input.provenancePath)):createDraftProvenanceTemplate(binding.draftResult);
   provenance.review={...input.review,reviewedDraftHash:binding.reviewedDraftHash,artifact:{sourceRef:receipt.artifacts.raw.path,sha256:receipt.artifacts.raw.sha256}};
   const envelope={packet,result:binding.draftResult,provenance},proposal=prepareAssistedImport(db,envelope);save('envelope','envelope.json',envelope);
   save('normalizedProvenance','normalized-provenance.json',proposal.provenance);save('provenance','provenance.json',provenance);save('validation','validation.json',validation);
   receipt.status=validation.reviewStatus;receipt.reviewedSteps=input.reviewedSteps;receipt.verdict=result.verdict;receipt.independence='NOT_ESTABLISHED';
   receipt.nextStep='Local structural validation only. Semantic assessment and any human content approval are separate; no import or release is authorized.';
  }else throw Error('WRITING_RECEIVE_KIND');
  receipt.packetHash=packet.hash;receipt.reviewedDraftHash=binding.reviewedDraftHash;receipt.reviewedResultHash=binding.reviewedResultHash;
 }catch(error){receipt.status='REJECTED';receipt.error=error.code??error.message;receipt.nextStep='Inspect rejected evidence; preserve this attempt and use a new output directory for any correction. Do not repair hashes.';}
 writeFileSync(resolve(output,'receipt.json'),JSON.stringify(receipt,null,2)+'\n',{flag:'wx'});return receipt;
}
