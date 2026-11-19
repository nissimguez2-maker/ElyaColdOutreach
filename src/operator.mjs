// Foreground local operator commands only. No timer, credentials or live transport.
import {DatabaseSync} from 'node:sqlite';
import {fileURLToPath} from 'node:url';
import {resolve} from 'node:path';
import {readFileSync,realpathSync} from 'node:fs';
import {getRecord,controls,setStopped} from './store.mjs';
import {budgetStatus,recoverOperations} from './operations.mjs';
const root=fileURLToPath(new URL('../',import.meta.url)),args=process.argv.slice(2);
const command=args.shift()??'status';let path=resolve(root,'data/elya.sqlite');
const index=args.indexOf('--db');if(index>=0){if(!args[index+1])throw Error('DATABASE_PATH_REQUIRED');path=resolve(args[index+1]);args.splice(index,2);}
let db;
try{
 if(!['status','report','stop','recover','prepare','import-drafts','draft-context','draft-packet','validate-draft-result','import-draft-result','prepare-draft-review','validate-draft-review','writing-current','writing-receive','launch-preview','response-status','response-preview','response-record'].includes(command))throw Error('UNKNOWN_OPERATOR_COMMAND');
 if(command==='response-record'){
  if(index<0)throw Error('RESPONSE_RECORD_REQUIRES_EXPLICIT_DATABASE');
  if(args.length!==4||args[2]!=='--confirm-preview'||!/^[a-f0-9]{64}$/.test(args[3]))throw Error('RESPONSE_RECORD_REQUIRES_EVENT_PREVIEW_AND_EXACT_CONFIRMATION');
  path=realpathSync(path);
 }
 db=new DatabaseSync(path,{readOnly:['status','report','draft-context','draft-packet','validate-draft-result','prepare-draft-review','validate-draft-review','writing-current','writing-receive','launch-preview','response-status','response-preview'].includes(command)});
 if(command==='response-record')db.exec('PRAGMA busy_timeout=5000; PRAGMA foreign_keys=ON; PRAGMA synchronous=FULL;');
 const rows=kind=>db.prepare('SELECT id,data_json FROM records WHERE kind=? ORDER BY id').all(kind).map(r=>({id:r.id,...JSON.parse(r.data_json)}));
 const assessedAttribution=c=>{if(c.attributionClass)return c.attributionClass;if(typeof c.candidateId!=='string')return 'UNESTABLISHED';const current=getRecord(db,'refinement_current',c.candidateId);const assessment=current&&getRecord(db,'refinement_assessment',c.candidateId+':'+current.semanticHash);return assessment?.contacts?.find(x=>x.email===c.id)?.attribution?.class??'UNESTABLISHED';};
 let output,plainText=false;
 if(command==='writing-current'){
  if(args.length>1)throw Error('WRITING_CURRENT_EXPECTS_AT_MOST_ONE_INDEX');
  const {readCurrentWriting}=await import('./drafting-session.mjs');
  output=readCurrentWriting({root,db,...(args[0]?{indexPath:args[0]}:{})}).readable;plainText=true;
 }
 if(command==='writing-receive'){
  if(args.length!==1)throw Error('WRITING_RECEIVE_REQUIRES_ONE_LOCAL_REQUEST_JSON');
  const {receiveWritingResult}=await import('./drafting-session.mjs');
  output=receiveWritingResult(db,JSON.parse(readFileSync(resolve(args[0]),'utf8')),{root});
  if(output.status==='REJECTED')process.exitCode=1;
 }
 if(command==='launch-preview'){
  if(args.length>1)throw Error('LAUNCH_PREVIEW_EXPECTS_AT_MOST_ONE_LOCAL_REQUEST_JSON');
  const {prepareSingleMessageDecision,renderSingleMessageDecision}=await import('./single-message-decision.mjs');
  let input;
  if(args[0])input=JSON.parse(readFileSync(resolve(args[0]),'utf8'));
  else {const {readCurrentWriting}=await import('./drafting-session.mjs'),current=readCurrentWriting({root,db});input={...current.envelope,reviewBinding:current.reviewBinding,review:current.review,reviewedSteps:current.reviewedSteps,at:new Date().toISOString(),plan:{}};}
  output=renderSingleMessageDecision(prepareSingleMessageDecision(db,input));plainText=true;
 }
 if(command==='response-status'){
  if(args.length!==2)throw Error('RESPONSE_STATUS_REQUIRES_EMAIL_AND_CANDIDATE_ID');
  const {evaluateManualContactGate}=await import('./manual-response.mjs');
  output=evaluateManualContactGate(db,{email:args[0],candidateId:args[1],at:new Date().toISOString()});
 }
 if(command==='response-preview'||command==='response-record'){
  if(command==='response-preview'&&args.length!==1)throw Error('RESPONSE_PREVIEW_REQUIRES_ONE_EVENT_JSON');
  const {previewManualResponseEvent,recordPreviewedManualResponseEvent}=await import('./manual-response.mjs');
  const readJson=file=>JSON.parse(readFileSync(resolve(file),'utf8').replace(/^\uFEFF/,'')),input=readJson(args[0]),at=new Date().toISOString();
  output=command==='response-preview'?previewManualResponseEvent(db,input,at):recordPreviewedManualResponseEvent(db,input,readJson(args[1]),{confirmedPreviewHash:args[3],at});
 }
 if(command==='status')output={controls:controls(db),generalLiveDispatchEnabled:false,execution:'FOREGROUND_LOCAL_ONLY',contactHolds:rows('contact').filter(c=>c.verification!=='PASSED'||c.suppressed!==false||assessedAttribution(c)==='UNESTABLISHED').map(c=>({email:c.id,verification:c.verification,suppressionClearance:c.suppressed===false?'CLEAR':c.suppressed===true?'SUPPRESSED':'UNKNOWN',attributionClass:assessedAttribution(c)})),writingPolicies:rows('writing_policy').map(p=>({campaignId:p.id,cadenceApproved:p.sequence?.cadenceApproved===true,endpointApproved:p.sequence?.endpointApproved===true,physicalAddressApproved:p.physicalAddressApproved===true,optOutApproved:p.optOutApproved===true,expiryApproved:p.approvalExpiry?.approved===true})),policyStatusMeaning:'Stored approval flags; full release eligibility is independently validated before handoff',budgets:db.prepare('SELECT id FROM budgets').all().map(({id})=>({id,...budgetStatus(db,id)})),operationsRequiringReconciliation:db.prepare("SELECT id,kind,status,reservation_usd FROM operations WHERE status IN ('DISPATCHING','RECONCILIATION')").all(),reconciliationNote:'Journal/accounting state is distinct from preserved functional test results',telegramOwner:getRecord(db,'telegram_consumer_owner','primary')?.status??'ABSENT',telegramCursor:getRecord(db,'telegram_writing_cursor','primary')?.nextOffset??null};
 if(command==='report'){const {monitoringReport}=await import('./monitoring.mjs');output=monitoringReport(db,{});}
 if(command==='draft-context'){
  if(args.length!==1)throw Error('DRAFT_CONTEXT_REQUIRES_ONE_LOCAL_SPEC_JSON');
  const {previewDraftingContext}=await import('./writing.mjs');output=previewDraftingContext(db,JSON.parse(readFileSync(resolve(args[0]),'utf8')));
 }
 if(['draft-packet','validate-draft-result','import-draft-result'].includes(command)){
  if(args.length!==1)throw Error('DRAFT_HANDOFF_REQUIRES_ONE_LOCAL_JSON_FILE');
  const {createDraftingPacket,prepareAssistedImport}=await import('./drafting-handoff.mjs'),input=JSON.parse(readFileSync(resolve(args[0]),'utf8'));
  if(command==='draft-packet')output=createDraftingPacket(db,input);
  else {
   const proposal=prepareAssistedImport(db,input);
   if(command==='validate-draft-result')output={status:'VALID_LOCAL_PROPOSAL_NOT_IMPORTED',...proposal};
   else {const {importDraftProposal}=await import('./workflow.mjs'),packet=importDraftProposal(db,proposal);output={reviewId:packet.reviewId,packetHash:packet.hash,version:packet.version,contentApproved:false,releaseAuthorized:false,liveCalls:0,provenanceRecorded:true};}
  }
 }
 if(['prepare-draft-review','validate-draft-review'].includes(command)){
  if(args.length!==1)throw Error('DRAFT_REVIEW_REQUIRES_ONE_LOCAL_JSON_FILE');
  const {createCriticalReviewPacket,validateCriticalReviewResult}=await import('./drafting-handoff.mjs'),input=JSON.parse(readFileSync(resolve(args[0]),'utf8'));
  output=command==='prepare-draft-review'?createCriticalReviewPacket(input.packet,input.result):validateCriticalReviewResult(input.binding,input.result);
 }
 if(command==='stop'){if(args.length)throw Error('NO_EXTRA_STOP_ARGUMENTS');setStopped(db,true,'Operator foreground stop');output={controls:controls(db),warning:'Local stop does not recall messages or stop an already running remote campaign.'};}
 if(command==='recover'){
  const {recoverMonitoring}=await import('./monitoring.mjs'),{recoverWorkflowJobs}=await import('./workflow-jobs.mjs'),{recoverTelegramConsumer}=await import('./telegram-consumer.mjs');
  output={operations:recoverOperations(db),notifications:recoverMonitoring(db),jobs:recoverWorkflowJobs(db),telegram:recoverTelegramConsumer(db),note:'Uncertain work remains in reconciliation. Nothing is replayed; uncertain Telegram ownership is retained.'};
 }
 if(command==='import-drafts'){
  if(args.length!==1)throw Error('IMPORT_DRAFTS_REQUIRES_ONE_LOCAL_JSON_FILE');
  const {importDraftProposal}=await import('./workflow.mjs');
  const packet=importDraftProposal(db,JSON.parse(readFileSync(resolve(args[0]),'utf8')));
  output={reviewId:packet.reviewId,packetHash:packet.hash,version:packet.version,contentApproved:false,liveCalls:0,note:'Local draft proposal only. No Telegram transmission or sending authorization.'};
 }
 if(command==='prepare'){
  if(args.length!==2||args[0]!=='--as-of')throw Error('PREPARE_REQUIRES_EXPLICIT_AS_OF');
  const {loadSavedRefinement}=await import('./refinement-saved.mjs'),{PHILADELPHIA_POLICY}=await import('./refinement-policy.mjs'),{refineBusinessBrief}=await import('./workflow.mjs');
  const ref=getRecord(db,'settings','current-contact-freshness'),freshness=ref?getRecord(db,ref.policyKind,ref.revision):null;
  const policy=freshness?{...PHILADELPHIA_POLICY,revision:PHILADELPHIA_POLICY.revision+':'+ref.revision,verificationMaxAgeDays:freshness.emailVerification?.daysBeforeFirstRelease??null,eventMaxAgeDays:freshness.personalization?.timelyEventDays??null}:PHILADELPHIA_POLICY;
  const briefs=refineBusinessBrief(db,{input:loadSavedRefinement(db),policy,asOf:args[1],observationId:'operator:'+args[1]});
  output={briefs:briefs.map(b=>({entityId:b.entityId,hash:b.hash,businessFit:b.businessFit,holds:b.holds})),draftsChanged:false,liveCalls:0};
 }
 console.log(plainText?output:JSON.stringify(output,null,2));
}catch(e){console.error(e.message);process.exitCode=1;}finally{db?.close();}
