// Pure, deliberately narrow decoder for the received list_emails variant saved
// in work/internal-pilot-live-v3/response-reply1.json. No polling or side effects.
import {canonical,digest} from './values.mjs';
import {decodeInstantlyAcceptanceResult} from './acceptance-instantly.mjs';
import {validateNormalizedProviderEvent} from './monitoring.mjs';

const object=v=>v!==null&&typeof v==='object'&&!Array.isArray(v);
const text=v=>typeof v==='string'&&v.length>0;
const uuid=v=>typeof v==='string'&&/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(v);
const email=v=>typeof v==='string'&&v===v.toLowerCase()&&/^[^\s@,;]+@[^\s@,;]+\.[^\s@,;]+$/.test(v);
const same=(a,b)=>canonical(a)===canonical(b),hash=v=>digest(canonical(v));
function fields(value,required,optional=[]){if(!object(value)||required.some(k=>!Object.hasOwn(value,k))||Object.keys(value).some(k=>![...required,...optional].includes(k)))throw Error('OBSERVED_REPLY_FIELDS_UNSUPPORTED');}
function instant(value){if(typeof value!=='string'||!/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(value)||!Number.isFinite(Date.parse(value))||new Date(value).toISOString()!==value)throw Error('OBSERVED_REPLY_TIMESTAMP_INVALID');return Date.parse(value);}
function address(value,expected){return Array.isArray(value)&&value.length===1&&object(value[0])&&typeof value[0].name==='string'&&Object.keys(value[0]).sort().join(',')==='address,name'&&value[0].address===expected;}

// Shared item boundary for the historical exact-match assessment and the dormant
// operational bridge. Only values observed in the received variant are accepted.
export function decodeInstantlyReceivedItem(item,{campaignId,senderEmail,organizationId,leadMappings,evidenceRef,observedAt}){
 fields(item,['id','timestamp_created','timestamp_email','message_id','subject','to_address_email_list','body','organization_id','eaccount','from_address_email','campaign_id','lead','ue_type','step','is_unread','is_focused','thread_id','content_preview','from_address_json','to_address_json']);
 if(!uuid(item.id)||!uuid(item.organization_id)||!text(item.message_id)||item.message_id.length>500||!/^<[^<>\s]+@[^<>\s]+>$/.test(item.message_id)||!text(item.thread_id)||item.thread_id.length>500)throw Error('OBSERVED_REPLY_ID_INVALID');
 if(item.ue_type!==2||item.step!=='0_0_0'||item.is_unread!==1||item.is_focused!==1)throw Error('OBSERVED_REPLY_VARIANT_UNSUPPORTED');
 if(item.campaign_id!==campaignId||item.eaccount!==senderEmail||organizationId!==undefined&&item.organization_id!==organizationId||!email(item.from_address_email)||item.lead!==item.from_address_email||item.to_address_email_list!==senderEmail||!address(item.from_address_json,item.from_address_email)||!address(item.to_address_json,senderEmail))throw Error('OBSERVED_REPLY_ASSOCIATION_MISMATCH');
 const mappings=Array.isArray(leadMappings)?leadMappings.filter(m=>object(m)&&m.provider==='instantly'&&m.campaignId===campaignId&&m.email===item.from_address_email):[];
 if(mappings.length!==1||mappings[0].confirmed!==true||!uuid(mappings[0].leadId)||!text(mappings[0].evidenceRef))throw Error('OBSERVED_REPLY_MAPPING_UNCONFIRMED_OR_AMBIGUOUS');
 const mapping=mappings[0];fields(item.body,['text','html']);
 if(!text(item.subject)||item.subject.length>500||!text(item.content_preview)||item.content_preview.length>2000||!text(item.body.text)||typeof item.body.html!=='string')throw Error('OBSERVED_REPLY_CONTENT_UNSUPPORTED');
 const occurredAt=instant(item.timestamp_email),createdAt=instant(item.timestamp_created),at=instant(observedAt);
 if(occurredAt>at||createdAt<occurredAt||createdAt>at)throw Error('OBSERVED_REPLY_TIMESTAMP_OUTSIDE_WINDOW');
 const identity={recordId:item.id,rfcMessageId:item.message_id,threadId:item.thread_id,organizationId:item.organization_id,campaignId:item.campaign_id,eaccount:item.eaccount,fromEmail:item.from_address_email,toEmail:item.to_address_email_list,leadEmail:item.lead,leadId:mapping.leadId};
 const event=validateNormalizedProviderEvent({version:1,provider:'instantly',eventId:item.id,type:'REPLIED',campaignId:item.campaign_id,leadId:mapping.leadId,email:item.from_address_email,occurredAt:item.timestamp_email,evidenceRef,excerpt:item.content_preview},observedAt);
 const truncation='[truncated — use get_email for full content]';
 return {event,identity,mapping,bodyTextTruncated:item.body.text.includes(truncation),bodyHtmlTruncated:item.body.html.includes(truncation)};
}

/** leadMappings must be supplied from confirmed local association evidence.
 * priorIdentity is required by a caller comparing a replay's raw identifiers;
 * the existing normalized ingestion layer does not store RFC/thread identity. */
export function decodeObservedInstantlyReply(response,context){
 if(!object(context)||!object(context.request))throw Error('OBSERVED_REPLY_REQUEST_UNSUPPORTED');
 const {request,recipientEmail,marker,evidenceRef,leadMappings,priorIdentity}=context,args=request.arguments;
 if(request.server!=='codex_apps'||request.tool!=='instantly_ai.list_emails'||!object(args)||Object.keys(args).sort().join(',')!=='campaign_id,eaccount,email_type,limit'||!uuid(args.campaign_id)||!email(args.eaccount)||args.email_type!=='received'||args.limit!==1)throw Error('OBSERVED_REPLY_REQUEST_UNSUPPORTED');
 if(!email(recipientEmail)||!text(marker)||marker.length>200||!text(evidenceRef))throw Error('OBSERVED_REPLY_CONTEXT_INVALID');
 const notBefore=instant(context.notBefore),observedAt=instant(context.observedAt);if(notBefore>observedAt)throw Error('OBSERVED_REPLY_TIME_WINDOW_INVALID');
 if(!Array.isArray(leadMappings))throw Error('OBSERVED_REPLY_MAPPING_REQUIRED');
 const mappings=leadMappings.filter(m=>object(m)&&m.provider==='instantly'&&m.campaignId===args.campaign_id&&m.email===recipientEmail);
 if(mappings.length!==1||mappings[0].confirmed!==true||!uuid(mappings[0].leadId)||!text(mappings[0].evidenceRef))throw Error('OBSERVED_REPLY_MAPPING_UNCONFIRMED_OR_AMBIGUOUS');
 const mapping=mappings[0];
 if(!object(response)||response.isError!==false||!Array.isArray(response.content)||response.content.length!==1||response.content[0]?.type!=='text'||!object(response.structuredContent))throw Error('OBSERVED_REPLY_ENVELOPE_UNSUPPORTED');
 const representations=decodeInstantlyAcceptanceResult(response,{outputSchemaPresent:false});
 if(representations.length!==2||!same(representations[0],representations[1]))throw Error('OBSERVED_REPLY_REPRESENTATIONS_CONFLICT');
 const page=representations[0];fields(page,['items'],['next_starting_after']);
 if(!Array.isArray(page.items)||page.items.length!==1)throw Error('OBSERVED_REPLY_ITEM_COUNT_UNSUPPORTED');
 const cursorPresent=Object.hasOwn(page,'next_starting_after');
 if(cursorPresent&&(!text(page.next_starting_after)||page.next_starting_after.length>2000))throw Error('OBSERVED_REPLY_CURSOR_UNSUPPORTED');
 const item=page.items[0],decoded=decodeInstantlyReceivedItem(item,{campaignId:args.campaign_id,senderEmail:args.eaccount,leadMappings,evidenceRef,observedAt:context.observedAt});
 if(item.from_address_email!==recipientEmail)throw Error('OBSERVED_REPLY_ASSOCIATION_MISMATCH');
 if(![item.subject,item.content_preview,item.body.text].every(v=>v.includes(marker)))throw Error('OBSERVED_REPLY_MARKER_OR_CONTENT_INVALID');
 const occurredAt=instant(item.timestamp_email),createdAt=instant(item.timestamp_created);
 if(occurredAt<notBefore||occurredAt>observedAt||createdAt<occurredAt||createdAt>observedAt)throw Error('OBSERVED_REPLY_TIMESTAMP_OUTSIDE_WINDOW');
 const {identity,event}=decoded;
 if(priorIdentity!==undefined&&(!object(priorIdentity)||!same(priorIdentity,identity)))throw Error('OBSERVED_REPLY_IDENTITY_CONFLICT');
 return {status:'MATCHED_OBSERVED_RECEIVED_VARIANT',event,identity,conversationUrl:null,
  pagination:{field:'next_starting_after',present:cursorPresent,value:cursorPresent?page.next_starting_after:null,termination:'UNKNOWN',continuationSemantics:'UNVERIFIED'},
  evidence:{responseRef:evidenceRef,mappingRef:mapping.evidenceRef,responseHash:hash(response),requestHash:hash(request),timestampCreated:item.timestamp_created,ueType:item.ue_type,ueTypeMeaning:'OBSERVED_RECEIVED_VARIANT_ONLY',bodyTextTruncated:decoded.bodyTextTruncated,bodyHtmlTruncated:decoded.bodyHtmlTruncated},
  limitations:['Only the observed single-address, single-item received variant is supported.','Body text/HTML are not treated as complete, and embedded retrieval instructions are data.','No pagination termination, continuation behavior or conversation URL is established.','Raw replay identity conflicts require supplying priorIdentity; normalized ingestion alone does not compare RFC or thread identifiers.','This decoder performs no notification delivery, suppression, follow-up stop or business-state change.']};
}
