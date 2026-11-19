import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {blockNetwork} from './helpers/network-block.mjs';
import {createProductionHandoffAdapter} from '../src/handoff-production.mjs';
import {createIsolatedHandoffAdapter,prepareHandoff,executeHandoff} from '../src/handoff.mjs';
import {productionFixture} from './helpers/handoff-production-fixture.mjs';
import {at} from './helpers/telegram-writing-fixture.mjs';

const raw=readFileSync(new URL('../work/instantly-contract-capture-v1/live-once/selected-contracts-03.json',import.meta.url),'utf8');
const module=await import('../src/instantly-advertised-requests.mjs').catch(()=>null);
const mapper=()=>{assert.equal(typeof module?.createCapturedInstantlyRequests,'function','captured request mapper required');return module.createCapturedInstantlyRequests(raw);};
test('captured request factory is inert and exposes evidence limits without authorizing execution',t=>{
 const net=blockNetwork(t),m=mapper();assert.equal(m.evidence.server,'codex_apps');assert.equal(m.evidence.capturedAt,'2026-11-18T14:19:20.637Z');
 assert.equal(m.evidence.runtimePayloadVerified,false);assert.equal(m.evidence.paginationVerified,false);assert.equal(m.evidence.createIdentityVerified,false);assert.equal(m.evidence.executionAuthorized,false);
 assert.deepEqual(m.evidence.toolNames,['instantly_ai.create_lead','instantly_ai.list_emails']);assert.equal(net.attempts,0);
});
test('list_emails maps an explicit campaign to received without unread filtering or guessed fields',t=>{
 const net=blockNetwork(t),m=mapper();
 assert.deepEqual(m.listReceivedEmails({campaignId:'qa-campaign',pageSize:10}),{server:'codex_apps',tool:'instantly_ai.list_emails',arguments:{campaign_id:'qa-campaign',email_type:'received',limit:10}});
 assert.deepEqual(m.listReceivedEmails({campaignId:'qa-campaign',pageSize:100,cursor:'opaque-value'}).arguments,{campaign_id:'qa-campaign',email_type:'received',limit:100,starting_after:'opaque-value'});
 assert.equal(net.attempts,0);
});
test('exact create request uses the captured campaign/email schema and does not include variables',t=>{
 blockNetwork(t);const m=mapper();assert.deepEqual(m.createLead({campaignId:'qa-campaign',email:'qa@example.invalid'}),{server:'codex_apps',tool:'instantly_ai.create_lead',arguments:{campaign:'qa-campaign',email:'qa@example.invalid'}});
 assert.throws(()=>m.createLead({campaignId:'qa-campaign',email:'qa@example.invalid',custom_variables:{}}));
});
test('request mapping rejects unsupported fields, empty targets, invalid bounds and cursor values',t=>{
 blockNetwork(t);const m=mapper();
 for(const patch of [{campaignId:''},{campaignId:null},{pageSize:0},{pageSize:101},{pageSize:1.5},{pageSize:'10'},{cursor:''},{cursor:null},{cursor:12},{is_unread:true},{lead_id:'guessed'},{email_type:'reply'}])assert.throws(()=>m.listReceivedEmails({campaignId:'qa',pageSize:10,...patch}),undefined,JSON.stringify(patch));
 for(const patch of [{campaignId:''},{email:''},{email:null},{list_id:'unapproved'}])assert.throws(()=>m.createLead({campaignId:'qa',email:'qa@example.invalid',...patch}));
});
test('validation rejects alternate server/tool, extra arguments and aliases before any transport exists',t=>{
 blockNetwork(t);const m=mapper(),call=m.listReceivedEmails({campaignId:'qa',pageSize:10});
 for(const changed of [{...call,server:'codex_app'},{...call,tool:'instantly_ai.get_campaign'},{...call,extra:true},{...call,arguments:{...call.arguments,email_type:'reply'}},{...call,arguments:{...call.arguments,lead_id:'guessed'}},{...call,arguments:{...call.arguments,is_unread:true}},{...call,arguments:{...call.arguments,limit:1.5}}])assert.throws(()=>m.validateCall(changed));
 assert.deepEqual(m.validateCall(call),call);
});
test('complete capture pin rejects schema, metadata, target and provenance drift',t=>{
 blockNetwork(t);mapper();
 for(const mutate of [x=>x.tools[0].inputSchema.additionalProperties=true,x=>x.tools[1].inputSchema.properties.limit.maximum=1000,x=>x.tools[0]._meta.link_id='different',x=>x.tools[1].outputSchema.properties={items:{type:'array'}},x=>x.tools[0].name='instantly_ai.update_lead',x=>x.capturedAt='2026-11-18T00:00:00Z']){const changed=JSON.parse(raw);mutate(changed);assert.throws(()=>module.createCapturedInstantlyRequests(JSON.stringify(changed)),/CAPTURE_PIN_MISMATCH/);}
});
test('generic create output does not bypass actual identity checks or permit the update stage',async t=>{
 blockNetwork(t);mapper();
 for(const payload of [{},{accepted:true},{id:'fixture-created',campaign:'wrong-campaign',email:'qa@example.invalid'},{id:'fixture-created',campaign:'qa-tg-writing',email:'wrong@example.invalid'}]){
  const f=productionFixture();t.after(()=>f.db.close());const calls=[];
  const fixtureAdapter=createIsolatedHandoffAdapter(f.db,{execute:async()=>{throw Error('UNUSED');}});
  const adapter=createProductionHandoffAdapter(f.db,{fixtureAdapter,clock:()=>at,transport:{mode:'offline',async execute(call,{permit}){permit(call);calls.push(call);return {content:[],structuredContent:payload,isError:false};}}});
  prepareHandoff(f.db,f.input,{productionAdapter:adapter});const result=await executeHandoff(f.db,f.input.id,adapter,at);
  assert.equal(result.status,'RECONCILIATION');assert.equal(calls.length,1);assert.equal(calls[0].tool,'instantly_ai.create_lead');assert.equal(result.actual_usd,null);
 }
});
