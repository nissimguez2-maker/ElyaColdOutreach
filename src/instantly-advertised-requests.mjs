// Pure request mapping from a specific saved advertisement. This module has no
// transport, authorization creation, response decoder or provider side effects.
import {digest,required,canonical} from './values.mjs';
import {inputSchema} from './acceptance-instantly.mjs';
import {prepareOutputSchema,checkOutputSchema} from './diagnostic-output-schema.mjs';

export const INSTANTLY_REQUEST_CAPTURE=Object.freeze({
 path:'work/instantly-contract-capture-v1/live-once/selected-contracts-03.json',
 sha256:'d32b8e3aa3d1a5d89e68442fc2758fb29ead428602f4417bd870a786890c0d5e',
 capturedAt:'2026-11-18T14:19:20.637Z',
});
const names=Object.freeze(['instantly_ai.create_lead','instantly_ai.list_emails']);
function exact(value,keys){
 if(!value||Object.getPrototypeOf(value)!==Object.prototype||Object.keys(value).sort().join()!==[...keys].sort().join())throw Error('INSTANTLY_REQUEST_FIELDS_INVALID');
 canonical(value);
}

export function createCapturedInstantlyRequests(rawCapture){
 if(typeof rawCapture!=='string'||digest(rawCapture)!==INSTANTLY_REQUEST_CAPTURE.sha256)throw Error('INSTANTLY_CAPTURE_PIN_MISMATCH');
 const capture=JSON.parse(rawCapture),schemas={};
 for(const name of names){
  const tool=capture.tools.find(t=>t.name===name);
  schemas[name]=inputSchema(tool.inputSchema,name);
  if(Object.hasOwn(tool,'outputSchema'))prepareOutputSchema(tool.outputSchema,{tool:name,side:'output'});
 }
 const validateCall=call=>{
  exact(call,['server','tool','arguments']);
  if(call.server!=='codex_apps'||!names.includes(call.tool))throw Error('INSTANTLY_REQUEST_TARGET_UNSUPPORTED');
  const a=call.arguments;
  if(call.tool===names[0]){exact(a,['campaign','email']);required(a.campaign);required(a.email);}
  else{
   exact(a,['campaign_id','email_type','limit',...(Object.hasOwn(a??{},'starting_after')?['starting_after']:[])]);
   required(a.campaign_id);
   if(a.email_type!=='received'||!Number.isSafeInteger(a.limit)||a.limit<1||a.limit>100)throw Error('INSTANTLY_REPLY_REQUEST_SCOPE_INVALID');
   if(Object.hasOwn(a,'starting_after')){required(a.starting_after);if(a.starting_after.length>2000)throw Error('INSTANTLY_REPLY_CURSOR_TOO_LONG');}
  }
  if(!checkOutputSchema(schemas[call.tool],a))throw Error('INSTANTLY_CAPTURED_INPUT_SCHEMA_MISMATCH');
  return structuredClone(call);
 };
 return Object.freeze({
  evidence:Object.freeze({...INSTANTLY_REQUEST_CAPTURE,server:'codex_apps',toolNames:names,
   outputSchema:'GENERIC_OBJECT_ONLY',runtimePayloadVerified:false,paginationVerified:false,createIdentityVerified:false,executionAuthorized:false}),
  validateCall,
  createLead(input){
   exact(input,['campaignId','email']);
   return validateCall({server:'codex_apps',tool:names[0],arguments:{campaign:input.campaignId,email:input.email}});
  },
  listReceivedEmails(input){
   exact(input,['campaignId','pageSize',...(Object.hasOwn(input??{},'cursor')?['cursor']:[])]);
   return validateCall({server:'codex_apps',tool:names[1],arguments:{campaign_id:input.campaignId,email_type:'received',limit:input.pageSize,...(Object.hasOwn(input,'cursor')?{starting_after:input.cursor}:{})}});
  },
 });
}
