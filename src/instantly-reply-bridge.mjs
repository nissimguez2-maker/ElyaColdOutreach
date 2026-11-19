// Dormant adapter for the captured Instantly list_emails shape. Construction
// performs no provider call, credential read, authorization write or scheduling.
import {canonical,digest,required} from './values.mjs';
import {getRecord} from './store.mjs';
import {createCapturedInstantlyRequests,INSTANTLY_REQUEST_CAPTURE} from './instantly-advertised-requests.mjs';
import {inputSchema,decodeInstantlyAcceptanceResult} from './acceptance-instantly.mjs';
import {checkOutputSchema} from './diagnostic-output-schema.mjs';
import {createProviderReplyDecoder} from './monitoring-provider.mjs';
import {decodeInstantlyReceivedItem} from './instantly-observed-reply.mjs';

const uuid=v=>typeof v==='string'&&/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(v);
const email=v=>typeof v==='string'&&v===v.toLowerCase()&&/^[^\s@,;]+@[^\s@,;]+\.[^\s@,;]+$/.test(v);
const object=v=>v!==null&&typeof v==='object'&&!Array.isArray(v);
function exact(v,keys){if(!object(v)||Object.keys(v).sort().join()!==[...keys].sort().join())throw Error('MONITOR_INSTANTLY_CONFIGURATION_INVALID');canonical(v);}

/** Pagination is an explicit reviewed contract, not inferred from the saved
 * single reply. The resulting adapter details are included in the generic
 * contract hash and therefore in both contract approval and poll authority. */
export function createInstantlyReplyServices(db,{rawCapture,configuration={},executor}={}){
 const requests=createCapturedInstantlyRequests(rawCapture),config=structuredClone(configuration),scope=config.scope,p=config.pagination;
 exact(scope,['campaignId','senderEmail','organizationId']);
 if(!uuid(scope.campaignId)||!uuid(scope.organizationId)||!email(scope.senderEmail))throw Error('MONITOR_INSTANTLY_SCOPE_INVALID');
 if(!p||p.continuation!=='NEXT_STARTING_AFTER'||!['MISSING_NEXT_STARTING_AFTER','NULL_NEXT_STARTING_AFTER'].includes(p.termination)||typeof p.evidenceRef!=='string'||!p.evidenceRef.trim())throw Error('MONITOR_INSTANTLY_PAGINATION_CONTRACT_REQUIRED');
 exact(p,['continuation','termination','evidenceRef']);
 if(config.contract?.evidence?.pagination!==p.evidenceRef)throw Error('MONITOR_INSTANTLY_PAGINATION_EVIDENCE_MISMATCH');
 const tool=JSON.parse(rawCapture).tools.find(t=>t.name==='instantly_ai.list_emails'),schema=inputSchema(tool.inputSchema,tool.name);
 const buildCall=request=>{
  if(request.campaignId!==scope.campaignId)throw Error('MONITOR_INSTANTLY_SCOPE_MISMATCH');
  const call=requests.listReceivedEmails({campaignId:scope.campaignId,pageSize:request.pageSize,...(request.cursor===null?{}:{cursor:request.cursor})});
  call.arguments.eaccount=scope.senderEmail;
  if(!checkOutputSchema(schema,call.arguments))throw Error('MONITOR_INSTANTLY_CAPTURED_REQUEST_MISMATCH');return call;
 };
 const contract={...config.contract,adapter:{kind:'INSTANTLY_CAPTURED_RECEIVED_V1',captureHash:INSTANTLY_REQUEST_CAPTURE.sha256,scope,pagination:p}};
 const replyDecoder=createProviderReplyDecoder({contract,decodePage(response,context){
  if(!object(response)||response.isError!==false||!Array.isArray(response.content)||response.content.length!==1||response.content[0]?.type!=='text'||!object(response.structuredContent))throw Error('OBSERVED_REPLY_ENVELOPE_UNSUPPORTED');
  const representations=decodeInstantlyAcceptanceResult(response,{outputSchemaPresent:false});
  if(representations.length!==2||canonical(representations[0])!==canonical(representations[1]))throw Error('OBSERVED_REPLY_REPRESENTATIONS_CONFLICT');
  const page=representations[0];
  if(!object(page)||!Array.isArray(page.items)||Object.keys(page).some(k=>!['items','next_starting_after'].includes(k)))throw Error('OBSERVED_REPLY_FIELDS_UNSUPPORTED');
  if(page.items.length>context.pageSize)throw Error('MONITOR_PROVIDER_PAGE_BOUND');
  const present=Object.hasOwn(page,'next_starting_after'),cursor=page.next_starting_after;
  let nextCursor;
  if(present&&typeof cursor==='string'&&cursor.length&&cursor.length<=2000)nextCursor=cursor;
  else if(!present&&p.termination==='MISSING_NEXT_STARTING_AFTER'||present&&cursor===null&&p.termination==='NULL_NEXT_STARTING_AFTER')nextCursor=null;
  else throw Error('MONITOR_INSTANTLY_PAGINATION_VARIANT_UNSUPPORTED');
  const mappings=db.prepare("SELECT data_json FROM records WHERE kind='provider_lead_mapping'").all().map(row=>({...JSON.parse(row.data_json),confirmed:true}));
  const events=page.items.map(item=>{
   const result=decodeInstantlyReceivedItem(item,{...scope,leadMappings:mappings,evidenceRef:context.evidenceRef,observedAt:new Date(context.at).toISOString()});
   return {...result.event,conversation:{recordId:result.identity.recordId,rfcMessageId:result.identity.rfcMessageId,threadId:result.identity.threadId,organizationId:result.identity.organizationId,senderEmail:scope.senderEmail,subject:item.subject,url:null,bodyTruncated:result.bodyTextTruncated||result.bodyHtmlTruncated}};
  });return {events,nextCursor};
 }});
 const active=()=>{
  if(config.enabled!==true)throw Error('MONITOR_INSTANTLY_ADAPTER_DISABLED');
  if(!['offline','authorized-provider'].includes(executor?.mode)||typeof executor.execute!=='function')throw Error('MONITOR_INSTANTLY_SCOPED_EXECUTOR_REQUIRED');
 };
 const replyTransport=Object.freeze({mode:executor?.mode??'authorized-provider',assertReady:active,
  assertAuthority(request){active();const call=buildCall(request);return typeof executor.assertAuthority==='function'&&executor.assertAuthority(call,{...request,contractHash:replyDecoder.contractHash})===true;},
  async fetchPage(request){
   active();request.signal?.throwIfAborted();const call=buildCall(request);
   if(executor.mode==='authorized-provider'&&(typeof executor.assertAuthority!=='function'||executor.assertAuthority(call,{...request,contractHash:replyDecoder.contractHash})!==true))throw Error('MONITOR_PROVIDER_REQUEST_AUTHORITY_REQUIRED');
   return executor.execute(call,{signal:request.signal,timeoutMs:request.timeoutMs,contractHash:replyDecoder.contractHash});
  }});
 return Object.freeze({replyDecoder,replyTransport});
}
