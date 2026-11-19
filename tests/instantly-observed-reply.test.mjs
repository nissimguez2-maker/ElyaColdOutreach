import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {canonical,digest} from '../src/values.mjs';
import {openStore,putRecord,getRecord,controls} from '../src/store.mjs';
import {ingestReplyPage,validateNormalizedProviderEvent} from '../src/monitoring.mjs';
import {blockNetwork} from './helpers/network-block.mjs';

const responsePath='work/internal-pilot-live-v3/response-reply1.json';
const request=JSON.parse(readFileSync('work/internal-pilot-live-v3/request-reply1.json','utf8')).call;
const sample=()=>JSON.parse(readFileSync(responsePath,'utf8'));
const mapping={provider:'instantly',campaignId:'e0b018cf-160f-454c-9891-e73b4204d7cd',leadId:'01a1e4b0-51d4-799a-9249-e089d63d5fb0',email:'drosen@elyapartners.com',confirmed:true,evidenceRef:'work/internal-pilot-live-v3/response-leadBefore.json'};
const context=()=>({request:structuredClone(request),recipientEmail:'drosen@elyapartners.com',marker:'ELYA-B-11b81c38ac29497a94339fd2086d6f24',notBefore:'2026-11-18T17:31:00.000Z',observedAt:'2026-11-18T17:36:25.162Z',evidenceRef:responsePath,leadMappings:[structuredClone(mapping)]});
const changed=mutate=>{const r=sample();mutate(r.structuredContent);r.content[0].text=JSON.stringify(r.structuredContent);return r;};
async function decoder(t){const net=blockNetwork(t);t.after(()=>assert.equal(net.attempts,0));const module=await import('../src/instantly-observed-reply.mjs').catch(()=>null);assert.equal(typeof module?.decodeObservedInstantlyReply,'function','observed reply decoder required');return module.decodeObservedInstantlyReply;}

test('saved nonempty received reply resolves the lead UUID from confirmed local evidence and preserves distinct identifiers',async t=>{
 const decode=await decoder(t),raw=sample(),before=canonical(raw),ctx=context(),result=decode(raw,ctx);
 assert.equal(result.status,'MATCHED_OBSERVED_RECEIVED_VARIANT');
 assert.deepEqual(result.event,{version:1,provider:'instantly',eventId:'01a1efb9-6bc8-7bdc-8cfe-fcb4389650d4',type:'REPLIED',campaignId:'e0b018cf-160f-454c-9891-e73b4204d7cd',leadId:'01a1e4b0-51d4-799a-9249-e089d63d5fb0',email:'drosen@elyapartners.com',occurredAt:'2026-11-18T17:34:11.000Z',evidenceRef:responsePath,excerpt:'QA reply received — ELYA-B-11b81c38ac29497a94339fd2086d6f24.'});
 assert.deepEqual(validateNormalizedProviderEvent(result.event,ctx.observedAt),result.event);
 assert.equal(result.identity.rfcMessageId,'<JNAP275MB2374C5C39F23C5A4E744D83FB87A2@JNAP275MB2374.ZAFP275.PROD.OUTLOOK.COM>');
 assert.equal(result.identity.threadId,'e0-fLNQuDa7NQh2qdOa9T-0RwI');assert.notEqual(result.identity.recordId,result.identity.rfcMessageId);
 assert.equal(result.evidence.timestampCreated,'2026-11-18T17:34:29.000Z');assert.equal(result.evidence.ueType,2);assert.equal(result.evidence.ueTypeMeaning,'OBSERVED_RECEIVED_VARIANT_ONLY');assert.equal(result.evidence.bodyTextTruncated,true);assert.equal(result.evidence.bodyHtmlTruncated,true);assert.equal(result.conversationUrl,null);
 assert.deepEqual(result.pagination,{field:'next_starting_after',present:true,value:'01a1efb9-6bc8-7bdc-8cfe-fcb4389650d4',termination:'UNKNOWN',continuationSemantics:'UNVERIFIED'});
 assert.equal(canonical(raw),before);assert.deepEqual(ctx,context());
});

test('conflicting or incomplete connector representations cannot borrow convenient values',async t=>{
 const decode=await decoder(t),conflict=sample();conflict.structuredContent.items[0].id='aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';assert.throws(()=>decode(conflict,context()),/REPRESENTATIONS_CONFLICT/);
 const incomplete=sample();delete incomplete.structuredContent.next_starting_after;assert.throws(()=>decode(incomplete,context()),/REPRESENTATIONS_CONFLICT/);
 for(const r of [{...sample(),isError:true},{...sample(),content:[]},{...sample(),structuredContent:null},{...sample(),content:[{type:'text',text:'not JSON'}]}])assert.throws(()=>decode(r,context()));
});

for(const [label,mutate]of [
 ['direction',i=>{i.ue_type=1;}],['numeric direction required',i=>{i.ue_type='2';}],['campaign',i=>{i.campaign_id='aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';}],['account',i=>{i.eaccount='other@example.invalid';}],['from',i=>{i.from_address_email='other@example.invalid';}],['to',i=>{i.to_address_email_list='other@example.invalid';}],['lead email',i=>{i.lead='01a1e4b0-51d4-799a-9249-e089d63d5fb0';}],['from identity conflict',i=>{i.from_address_json[0].address='other@example.invalid';}],['to identity conflict',i=>{i.to_address_json[0].address='other@example.invalid';}],['multiple recipients',i=>{i.to_address_json.push({name:'Other',address:'other@example.invalid'});}],['subject marker',i=>{i.subject='Other reply';}],['preview marker',i=>{i.content_preview='Other reply';}],['body marker',i=>{i.body.text='Other reply';}]
])test(`unmatched ${label} cannot create a normalized reply`,async t=>{const decode=await decoder(t);assert.throws(()=>decode(changed(v=>mutate(v.items[0])),context()),/OBSERVED_REPLY_/);});

for(const [label,mutate]of [
 ['missing record id',i=>{delete i.id;}],['record id array',i=>{i.id=['01a1efb9-6bc8-7bdc-8cfe-fcb4389650d4'];}],['invalid RFC id',i=>{i.message_id='not-an-rfc-id';}],['missing thread',i=>{delete i.thread_id;}],['thread wrong type',i=>{i.thread_id=42;}],['missing email timestamp',i=>{delete i.timestamp_email;}],['invalid email timestamp',i=>{i.timestamp_email='2026-02-31T17:34:11.000Z';}],['before permitted window',i=>{i.timestamp_email='2026-11-18T17:10:00.000Z';}],['future timestamp',i=>{i.timestamp_email='2026-11-19T17:34:11.000Z';}],['creation before message',i=>{i.timestamp_created='2026-11-18T17:30:00.000Z';}],['body wrong type',i=>{i.body=[];}],['preview wrong type',i=>{i.content_preview=true;}]
])test(`invalid ${label} is rejected without coercion`,async t=>{const decode=await decoder(t);assert.throws(()=>decode(changed(v=>mutate(v.items[0])),context()),/OBSERVED_REPLY_/);});

test('missing or ambiguous confirmed local mapping cannot promote an email into a lead UUID',async t=>{
 const decode=await decoder(t);
 for(const mappings of [[],[mapping,{...mapping,leadId:'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'}],[{...mapping,confirmed:false}],[{...mapping,leadId:mapping.email}]])assert.throws(()=>decode(sample(),{...context(),leadMappings:mappings}),/OBSERVED_REPLY_MAPPING/);
});
test('only the observed received campaign/account limit-one request is supported',async t=>{
 const decode=await decoder(t);
 for(const args of [{...request.arguments,email_type:'sent'},{...request.arguments,limit:2},{...request.arguments,starting_after:'anything'},{...request.arguments,is_unread:true}])assert.throws(()=>decode(sample(),{...context(),request:{...request,arguments:args}}),/OBSERVED_REPLY_REQUEST/);
});
test('absence of a cursor remains unknown and empty or multiple items do not establish matching reply or termination',async t=>{
 const decode=await decoder(t),result=decode(changed(v=>{delete v.next_starting_after;}),context());assert.deepEqual(result.pagination,{field:'next_starting_after',present:false,value:null,termination:'UNKNOWN',continuationSemantics:'UNVERIFIED'});
 assert.throws(()=>decode(changed(v=>{v.next_starting_after=null;}),context()),/CURSOR_UNSUPPORTED/);
 assert.throws(()=>decode(changed(v=>{v.items=[];}),context()),/ITEM_COUNT_UNSUPPORTED/);
 assert.throws(()=>decode(changed(v=>{v.items.push(structuredClone(v.items[0]));}),context()),/ITEM_COUNT_UNSUPPORTED/);
});
test('same record ID with conflicting saved message or thread identity is rejected before ingestion',async t=>{
 const decode=await decoder(t),first=decode(sample(),context());
 for(const field of ['message_id','thread_id'])assert.throws(()=>decode(changed(v=>{v.items[0][field]=field==='message_id'?'<different@example.invalid>':'different-thread';}),{...context(),priorIdentity:first.identity}),/IDENTITY_CONFLICT/);
 assert.deepEqual(decode(sample(),{...context(),priorIdentity:first.identity}).identity,first.identity);
});
test('isolated replay through existing ingestion produces one event and one pending notification without sends or business mutations',async t=>{
 const decode=await decoder(t),db=openStore(':memory:');t.after(()=>db.close());const before=controls(db),result=decode(sample(),context());
 const id=digest(canonical({provider:'instantly',campaignId:mapping.campaignId,leadId:mapping.leadId}));putRecord(db,'provider_lead_mapping',id,{...mapping,candidateId:'synthetic-internal-pilot'});putRecord(db,'telegram_binding','primary',{confirmed:true,testOnly:true,userId:42,chatId:42,botId:777});
 const page={streamId:'isolated-observed-reply',campaignId:mapping.campaignId,expectedCursor:null,nextCursor:result.pagination.value,events:[result.event],evidenceRef:'fixture:one-observed-page'};
 assert.equal(ingestReplyPage(db,page,context().observedAt).inserted,1);assert.equal(ingestReplyPage(db,page,context().observedAt).duplicate,true);
 const again={...page,expectedCursor:result.pagination.value,evidenceRef:'fixture:same-record-second-receipt'};assert.equal(ingestReplyPage(db,again,context().observedAt).inserted,0);
 assert.equal(db.prepare("SELECT count(*) n FROM records WHERE kind='provider_event'").get().n,1);assert.equal(db.prepare("SELECT count(*) n FROM records WHERE kind='reply_notification'").get().n,1);assert.equal(db.prepare("SELECT json_extract(data_json,'$.status') status FROM records WHERE kind='reply_notification'").get().status,'PENDING');
 assert.equal(getRecord(db,'monitor_checkpoint',page.streamId).complete,false);assert.equal(db.prepare('SELECT count(*) n FROM operations').get().n,0);assert.equal(db.prepare('SELECT count(*) n FROM budgets').get().n,0);assert.deepEqual(controls(db),before);
 assert.throws(()=>ingestReplyPage(db,{...again,events:[{...result.event,excerpt:'conflicting content'}]},context().observedAt),/IDENTITY_MISMATCH/);
});
