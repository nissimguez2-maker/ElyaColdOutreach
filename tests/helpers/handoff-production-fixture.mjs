import {readFileSync} from 'node:fs';
import {writingTelegramFixture,at,expires} from './telegram-writing-fixture.mjs';
import {getRecord,putRecord,setLaunch,setStopped} from '../../src/store.mjs';
import {prepareWritingReview,decideWritingReview} from '../../src/writing.mjs';
import {createBatch,decideApproval} from '../../src/batches.mjs';
import {createBudget} from '../../src/operations.mjs';
import * as handoff from '../../src/handoff.mjs';
import * as production from '../../src/handoff-production.mjs';
const snapshot=JSON.parse(readFileSync(new URL('../fixtures/instantly-handoff-schema-captured.json',import.meta.url),'utf8'));
export function productionFixture({path=':memory:',enabled=true,reservation='0',limit='1'}={}){
 const {db,spec}=writingTelegramFixture(path);
 putRecord(db,'settings','handoff-fixture-isolation',{isolated:true,fixtureId:'production-handoff-test'});
 putRecord(db,'contact',spec.email,{...getRecord(db,'contact',spec.email),verification:'PASSED',suppressed:false});
 putRecord(db,'campaign',spec.campaignId,{purpose:'synthetic_qa',mustRemainInactive:false});
 putRecord(db,'writing_policy',spec.campaignId,{...getRecord(db,'writing_policy',spec.campaignId),sequence:{steps:3,cadenceApproved:true,endpointApproved:true},physicalAddressApproved:true,physicalAddress:'Synthetic fixture address',optOutApproved:true,optOut:{approved:true,mode:'REPLY_STOP',text:'Synthetic opt-out'},approvalExpiry:{approved:true,approvedBy:'Daniel Rosen',approvedAt:at,revision:'fixture-v1',maxAgeMs:300000}});
 const packet=prepareWritingReview(db,spec),decision=decideWritingReview(db,{actionId:'production-content',reviewId:packet.reviewId,packetHash:packet.hash,decision:'APPROVED',actor:'Daniel Rosen',at,expiresAt:expires,acknowledgedFindings:['FIXTURE_CAUTION']});
 const b=createBatch(db,'production-batch',{campaignId:spec.campaignId,recipients:[{candidateId:spec.candidateId,email:spec.email,messages:packet.messages,writing:{reviewId:packet.reviewId,packetHash:packet.hash,decisionId:decision.id}}],sequence:packet.policy.sequence,settings:{syntheticOnly:true}});
 const approval=decideApproval(db,'production-batch',b.version,b.hash,'APPROVED','Daniel Rosen',expires,at);
 createBudget(db,'production-budget',limit,'0','0');setStopped(db,false,'isolated test');setLaunch(db,true,'isolated test');
 if(enabled)putRecord(db,'settings','handoff-production',{enabled:true,generalDispatchEnabled:true});
 const contract=handoff.buildSavedInstantlyContract({id:'production-contract',campaignId:spec.campaignId,snapshot,sourceRef:snapshot.sourceRef,approvedBy:'Daniel Rosen',approvedAt:at,expiresAt:expires,fixtureOnly:true,readbackRequired:true});
 putRecord(db,'instantly_handoff_contract',contract.id,contract);
 const authority=handoff.buildHandoffAuthorization(db,{id:'production-authority',batchId:'production-batch',approvalId:approval.id,contractId:contract.id,budgetId:'production-budget',notBefore:at,expiresAt:expires,approvedBy:'Daniel Rosen',fixtureOnly:true,maxRequests:3,reservation});
 putRecord(db,'handoff_authorization',authority.id,authority);
 return {db,spec,packet,contract,authority,input:{id:'production-import',batchId:'production-batch',approvalId:approval.id,contractId:contract.id,authorizationId:authority.id,budgetId:'production-budget',reservation,at}};
}
export function productionTransport(f,{afterCall=()=>{},ack={success:true},readbackPatch=x=>x,skipPermit=false}={}){
 const calls=[];let lead;
 const transport={mode:'offline',async execute(call,{permit}){
  const exact=skipPermit?call:permit(call);calls.push(structuredClone(exact));
  let value;
  if(exact.tool==='instantly_ai.create_lead'){lead={id:'fixture-created-1',campaign:exact.arguments.campaign,email:exact.arguments.email};value=lead;}
  else if(exact.tool==='instantly_ai.update_lead'){lead={...lead,payload:{email:lead.email,campaign:lead.campaign,...exact.arguments.custom_variables}};value=ack;}
  else if(exact.tool==='instantly_ai.get_lead')value=readbackPatch(lead);
  else throw Error('Unexpected call');
  await afterCall(exact,calls.length);return {content:[],structuredContent:value,isError:false};
 }};
 const fixtureAdapter=handoff.createIsolatedHandoffAdapter(f.db,{execute:()=>{throw Error('Legacy fixture route must not execute');}});
 return {calls,transport,fixtureAdapter,adapter:production.createProductionHandoffAdapter(f.db,{transport,fixtureAdapter,clock:()=>at})};
}

