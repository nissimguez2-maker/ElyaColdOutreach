import test from 'node:test';import assert from 'node:assert/strict';
import {mkdtempSync,readFileSync,writeFileSync,mkdirSync} from 'node:fs';import {tmpdir} from 'node:os';import {join,resolve} from 'node:path';import {randomUUID} from 'node:crypto';
import {writingTelegramFixture,at,expires} from './helpers/telegram-writing-fixture.mjs';
import {collectionFixture} from './fixtures/collection-input.mjs';
import {fixtureReplyContract,decodeFixtureReplyPage} from './fixtures/monitoring-provider-fixture.mjs';
import {productionTransport} from './helpers/handoff-production-fixture.mjs';
import {blockNetwork} from './helpers/network-block.mjs';
import {getRecord,putRecord,setLaunch,setStopped,openStore,controls,backupStore} from '../src/store.mjs';
import {registerWorkflowTask,runWorkflowTask,recoverWorkflowRuntime} from '../src/workflow-runtime.mjs';
import {adoptAssessedProspect} from '../src/workflow.mjs';
import {createBudget,operation} from '../src/operations.mjs';
import {createBatch,decideApproval} from '../src/batches.mjs';
import {issueWritingTelegramReview} from '../src/telegram-writing-decisions.mjs';
import {deliverWritingTelegramFixture} from '../src/telegram-writing-adapter.mjs';
import {createTelegramWritingFixtureApi,createTelegramConsumerFixtureApi} from '../src/telegram-api.mjs';
import {runTelegramConsumer} from '../src/telegram-consumer.mjs';
import * as handoff from '../src/handoff.mjs';
import {registerLeadMapping,monitoringReport} from '../src/monitoring.mjs';
import {createProviderReplyDecoder} from '../src/monitoring-provider.mjs';
import {previewReplyDelivery,prepareMonitoringReportDelivery} from '../src/monitoring-delivery.mjs';
import {createIsolatedCollectionAdapter,prepareCollectionOperation} from '../src/collection-operation.mjs';

test('new integrations connect fresh evidence to reviewed handoff, provider decoder, notification, report and durable jobs',async t=>{
 const network=blockNetwork(t),directory=mkdtempSync(join(tmpdir(),'elya-acceptance-integrated-')),path=join(directory,'state.sqlite'),f=writingTelegramFixture(path);let db=f.db;t.after(()=>db.close());
 const baselineHeld=structuredClone(getRecord(db,'contact',f.spec.email));
 putRecord(db,'settings','workflow-runtime',{enabled:true,generalDispatchEnabled:true,approvedBy:'fixture',approvedAt:at,revision:'fixture-only',timeZone:'America/New_York'});
 const tasks=[];async function task(id,action,args,services={}){
  registerWorkflowTask(db,{id,action,arguments:args,runAt:at,timeoutMs:10000});
  const result=await runWorkflowTask(db,id,{services,ownerId:'integration-fixture',clock:()=>at});tasks.push({id,action,status:result.status});assert.equal(result.status,'SUCCEEDED',JSON.stringify(result));
  return getRecord(db,'workflow_task_result',id).result;
 }
 const fresh=collectionFixture();fresh.spec.asOf=at;fresh.spec.policy={...fresh.spec.policy,campaignId:f.spec.campaignId,verificationMaxAgeDays:14};
 createBudget(db,'integration-budget','1','0','0');putRecord(db,'settings','collection-fixture-isolation',{isolated:true,fixtureId:'integration'});
 setStopped(db,false,'temporary collection fixture only');let collectionCalls=0;
 for(const evidence of [fresh.contact,fresh.page,fresh.verification]){
  const adapter=createIsolatedCollectionAdapter(db,{execute:async call=>{collectionCalls++;return {response:call.step==='RUN_ACTOR'?evidence.run:evidence.results,actual:'0',chargeEvidenceRef:'fixture:zero-external-cost'};}});
  const spec={id:evidence.id+':run',step:'RUN_ACTOR',actor:evidence.actor,targets:evidence.targets,sourceRef:'fixture:collection-transport',budgetId:'integration-budget',reservation:'0.01',authorizationRef:'fixture:collection-scope',notBefore:at,expiresAt:expires};
  prepareCollectionOperation(db,spec,{at});const run=await task(spec.id,'COLLECT',{operationId:spec.id},{collectionAdapter:adapter});
  const readSpec={...spec,id:evidence.id+':read',step:'READ_DATASET',runOperationId:spec.id,reservation:'0'};prepareCollectionOperation(db,readSpec,{at});const read=await task(readSpec.id,'COLLECT',{operationId:readSpec.id},{collectionAdapter:adapter});
  await task(evidence.id+':ingest','INGEST',{evidence:{...evidence,run:JSON.parse(run.responseJson),results:JSON.parse(read.responseJson)}});
 }
 assert.equal(collectionCalls,6);setStopped(db,true,'fixture stopped for local review');
 fresh.spec.evidenceIds.push(fresh.contact.id);fresh.spec.mappings.push(fresh.contactMapping);
 const {briefs:[brief]}=await task('refine','REFINE',{spec:fresh.spec});assert.equal(brief.businessFit.state,'PASS');assert.equal(brief.contacts[0].verification.accepted,true);
 for(const [id,kind]of [['new-operating','OPERATING_STATUS'],['new-attribution','CONTACT_ATTRIBUTION']])putRecord(db,'evidence_check',id,{kind,entityId:'SYN-1',email:'qa@example.test',reviewed:true,sourceRef:'fixture:explicit-current-evidence',assertedAt:at,open:true,description:'Synthetic generic business inbox'});
 adoptAssessedProspect(db,{briefHash:brief.hash,email:'qa@example.test',operatingCheckId:'new-operating',attributionCheckId:'new-attribution',synthetic:true});
 assert.deepEqual(getRecord(db,'contact',f.spec.email),baselineHeld,'existing held contact was not rescued or overwritten');
 putRecord(db,'campaign',f.spec.campaignId,{purpose:'synthetic_qa',mustRemainInactive:false});
 putRecord(db,'writing_policy',f.spec.campaignId,{...getRecord(db,'writing_policy',f.spec.campaignId),sequence:{steps:3,cadenceApproved:true,endpointApproved:true},physicalAddressApproved:true,physicalAddress:'Synthetic address',optOutApproved:true,optOut:{approved:true,mode:'REPLY_STOP',text:'Synthetic opt-out'},approvalExpiry:{approved:true,approvedBy:'Daniel Rosen',approvedAt:at,revision:'fixture-only',maxAgeMs:300000}});
 const spec={...f.spec,reviewId:'new-reviewed-writing',candidateId:'SYN-1',email:'qa@example.test',recipient:{class:'GENERAL_BUSINESS',greeting:'Hi QA team,'},draftIds:[1,2,3].map(n=>'new:step'+n)};
 spec.steps=f.spec.steps.map((s,i)=>({...s,draftId:spec.draftIds[i]}));
 const drafts=f.spec.draftIds.map((id,i)=>({id:spec.draftIds[i],data:{...getRecord(db,'draft',id),candidateId:spec.candidateId,email:spec.email}}));
 const packet=await task('draft-import','IMPORT_DRAFTS',{proposal:{drafts,spec}});
 const review=issueWritingTelegramReview(db,{id:'integrated-review',reviewId:packet.reviewId,packetHash:packet.hash,at,expiresAt:expires,expiryBasis:'EXPLICIT_SYNTHETIC_TEST'});
 const wire=[];let message=500;
 const api=createTelegramWritingFixtureApi(async(method,body)=>{wire.push({method,body});return {status:200,body:JSON.stringify({ok:true,result:method==='sendMessage'?{message_id:message++,from:{id:777,is_bot:true},chat:{id:42,type:'private'}}:true})};});
 await deliverWritingTelegramFixture(db,review.id,api,5000,at);
 const rendered=wire.findLast(w=>w.body.reply_markup),button=rendered.body.reply_markup.inline_keyboard.flat().find(b=>b.text==='Approve content'),bound=getRecord(db,'telegram_writing_review',review.id);
 const update={update_id:1,callback_query:{id:'integration-callback',data:button.callback_data,from:{id:42,is_bot:false},message:{message_id:bound.messageId,date:Date.parse(at)/1000,from:{id:777,is_bot:true},chat:{id:42,type:'private'}}}};
 putRecord(db,'telegram_writing_cursor','primary',{nextOffset:0});
 const consumer=createTelegramConsumerFixtureApi(async(method)=>({status:200,body:JSON.stringify({ok:true,result:method==='getMe'?{id:777,is_bot:true}:method==='getWebhookInfo'?{url:''}:method==='getUpdates'?[update]:true})}));
 await runTelegramConsumer({db,api:consumer,ownerId:'integration-consumer',limits:{maxPolls:1,maxUpdates:1,maxRequests:5,totalMs:10000},at,timestampNow:()=>at});
 const approved=getRecord(db,'telegram_writing_review',review.id);assert.equal(approved.status,'APPROVED');
 const b=createBatch(db,'integrated-batch',{campaignId:spec.campaignId,recipients:[{candidateId:spec.candidateId,email:spec.email,messages:packet.messages,writing:{reviewId:packet.reviewId,packetHash:packet.hash,decisionId:approved.decisionId}}],sequence:packet.policy.sequence,settings:{syntheticOnly:true}}),approval=decideApproval(db,'integrated-batch',b.version,b.hash,'APPROVED','Daniel Rosen',expires,at);
 putRecord(db,'settings','handoff-fixture-isolation',{isolated:true,fixtureId:'full-integration'});putRecord(db,'settings','handoff-production',{enabled:true,generalDispatchEnabled:true});
 const transport=productionTransport({db});
 const snapshot=JSON.parse(readFileSync('tests/fixtures/instantly-handoff-schema-captured.json','utf8'));
 const contract=handoff.buildSavedInstantlyContract({id:'integration-contract',campaignId:spec.campaignId,snapshot,sourceRef:snapshot.sourceRef,approvedBy:'Daniel Rosen',approvedAt:at,expiresAt:expires,fixtureOnly:true,readbackRequired:true});putRecord(db,'instantly_handoff_contract',contract.id,contract);
 const authority=handoff.buildHandoffAuthorization(db,{id:'integration-authority',batchId:'integrated-batch',approvalId:approval.id,contractId:contract.id,budgetId:'integration-budget',notBefore:at,expiresAt:expires,approvedBy:'Daniel Rosen',fixtureOnly:true,maxRequests:3,reservation:'0'});putRecord(db,'handoff_authorization',authority.id,authority);
 const input={id:'integration-import',batchId:'integrated-batch',approvalId:approval.id,contractId:contract.id,authorizationId:authority.id,budgetId:'integration-budget',reservation:'0',at};
 assert.throws(()=>handoff.prepareHandoff(db,input,{productionAdapter:transport.adapter}),/stopped|launch/i);assert.equal(transport.calls.length,0);
 setStopped(db,false,'isolated fixture release');setLaunch(db,true,'isolated fixture release');
 handoff.prepareHandoff(db,input,{productionAdapter:transport.adapter});await task('handoff','HANDOFF',{importId:input.id},{handoffAdapter:transport.adapter});
 assert.deepEqual(transport.calls.map(c=>c.tool),['instantly_ai.create_lead','instantly_ai.update_lead','instantly_ai.get_lead']);assert.equal(operation(db,input.id).status,'SUCCEEDED');
 registerLeadMapping(db,{provider:'instantly',campaignId:spec.campaignId,leadId:'fixture-created-1',candidateId:spec.candidateId,email:spec.email,importOperationId:input.id,evidenceRef:input.id});
 const decoder=createProviderReplyDecoder({contract:fixtureReplyContract,decodePage:decodeFixtureReplyPage});
 putRecord(db,'monitor_poll_authorization','poll-grant',{id:'poll-grant',status:'APPROVED',enabled:true,streamId:'integration-stream',campaignId:spec.campaignId,contractHash:decoder.contractHash,budgetId:'integration-budget',reservationUsd:'0',approvedAt:at,expiresAt:expires,maxPages:1,pageSize:10,timeoutMs:1000,transportMode:'offline',evidenceRef:'fixture:poll-grant'});
 let polls=0;const replyTransport={mode:'offline',async fetchPage(){polls++;return {payload:{fixtureCursor:null,fixtureReplies:[{fixtureId:'integration-reply',fixtureLead:'fixture-created-1',fixtureEmail:spec.email,fixtureTime:at,fixtureText:'Synthetic reply.'}]},evidenceRef:'fixture:reply-page',actualUsd:'0'};}};
 await task('reply-poll','POLL_REPLIES',{options:{runId:'integration-poll',streamId:'integration-stream',campaignId:spec.campaignId,authorizationId:'poll-grant',maxPages:1,pageSize:10,timeoutMs:1000}},{replyDecoder:decoder,replyTransport});assert.equal(polls,1);
 const notification=db.prepare("SELECT id FROM records WHERE kind='reply_notification'").get().id;
 let sends=0;const delivery=createTelegramConsumerFixtureApi(async(method,body)=>{assert.equal(method,'sendMessage');sends++;return {status:200,body:JSON.stringify({ok:true,result:{message_id:600+sends,from:{id:777,is_bot:true},chat:{id:42,type:'private'}}})};});
 function grant(id,preview){putRecord(db,'monitor_delivery_authorization',id,{id,status:'APPROVED',enabled:true,kind:preview.kind,subjectId:preview.subjectId,contentHash:preview.contentHash,destination:preview.destination,budgetId:'integration-budget',approvedAt:at,expiresAt:expires,transportMode:'OFFLINE_FIXTURE',timeoutMs:1000,evidenceRef:'fixture:delivery-grant'});}
 grant('notify-grant',previewReplyDelivery(db,notification));await task('notify','NOTIFY',{notificationId:notification,authorizationId:'notify-grant'},{telegramApi:delivery});
 const report=await task('prepare-delivery','PREPARE_REPORT_DELIVERY',{reportId:'integration-report',campaignId:spec.campaignId,includeSynthetic:true,destinationBindingId:'primary'});grant('report-grant',report);
 await task('deliver-report','DELIVER_REPORT',{reportId:'integration-report',authorizationId:'report-grant'},{telegramApi:delivery});assert.equal(sends,2);
 setStopped(db,true,'fixture shutdown');setLaunch(db,false,'fixture shutdown');db.close();db=openStore(path);const recovered=recoverWorkflowRuntime(db,at);assert.equal(recovered.jobs.length,0);
 assert.equal(getRecord(db,'reply_notification',notification).status,'DELIVERED');assert.equal(getRecord(db,'monitor_report_delivery','integration-report').status,'DELIVERED');assert.deepEqual(getRecord(db,'contact',f.spec.email),baselineHeld);
 const summary=monitoringReport(db,{campaignId:spec.campaignId,includeSynthetic:true},at);assert.equal(summary.replied.observedCount,1);assert.equal(summary.sent.total,null);assert.equal(network.attempts,0);
 // Sandbox temp folders can disappear when the tool process exits. Preserve this
 // new run in an exclusive evidence directory, never over an earlier acceptance.
 const artifacts=resolve('work/local-integrations-v1/acceptance-runs',randomUUID());mkdirSync(artifacts,{recursive:true});
 const savedDatabase=join(artifacts,'state.sqlite');await backupStore(db,savedDatabase);
 const evidence={status:'PASS',at:new Date().toISOString(),fixtureDatabase:path,savedDatabase,tasks,collectionCalls,providerCalls:transport.calls,polls,notificationReportSends:sends,networkAttempts:network.attempts,protectedOriginalFixtureHoldUnchanged:true,controls:controls(db),report:summary};
 writeFileSync(join(artifacts,'integration-evidence.json'),JSON.stringify(evidence,null,2),{flag:'wx'});t.diagnostic('Integrated evidence: '+join(artifacts,'integration-evidence.json'));
});
