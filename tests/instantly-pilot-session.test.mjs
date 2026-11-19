import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import fs from 'node:fs';
import {syncBuiltinESMExports} from 'node:module';
import {resolve,join} from 'node:path';
import {openStore,getRecord,putRecord,controls} from '../src/store.mjs';
import {armAcceptance} from '../src/acceptance-authority.mjs';
import {canonical,digest} from '../src/values.mjs';
import {blockNetwork} from './helpers/network-block.mjs';
const root=resolve('.'),at=Date.parse('2026-11-18T18:00:00Z');
const envelope=value=>({content:[{type:'text',text:JSON.stringify(value)}],structuredContent:structuredClone(value),isError:false});
async function fixture(t){
 const network=blockNetwork(t);t.after(()=>assert.equal(network.attempts,0));
 const api=await import('../src/instantly-pilot-session.mjs').catch(()=>null);
 assert.equal(typeof api?.createInactiveSetupSession,'function','fixed setup session required');
 const scope=await import('../src/instantly-pilot-scope.mjs');
 const manifest=scope.buildInactiveSetupManifest(readFileSync('work/inactive-one-step-pilot-v1/proposal.json','utf8'));
 const db=openStore(':memory:');t.after(()=>db.close());
 putRecord(db,'contact','synthetic-held',{held:true,verification:'CATCH_ALL'});
 putRecord(db,'draft','synthetic-unapproved',{approved:false,body:'Synthetic only'});
 const sources=scope.INACTIVE_SETUP_SOURCES.map(path=>({path,sha256:digest(readFileSync(join(root,path)))}));
 armAcceptance(db,manifest,sources,at,{executionApproval:{type:'EXPLICIT_LIVE_EXECUTION_APPROVAL',manifestHash:digest(canonical(manifest)),reference:'OFFLINE FIXTURE ONLY',approvedAt:new Date(at).toISOString()}});
 let clock=at+1000;
 const options={db,root,manifest,invocationId:'fixture-invocation',now:()=>clock};
 const session=api.createInactiveSetupSession(options);
 const campaign=JSON.parse(readFileSync('work/track-b-prerequisites-v1/inspection-result.json','utf8')).campaign.structuredContent;
 const lead=JSON.parse(readFileSync('work/track-b-prerequisites-v1/continuation/raw-internal-lead.json','utf8')).structuredContent;
 const sent=[];
 const provider=async call=>{
  sent.push(structuredClone(call));
  if(call.tool==='instantly_ai.get_campaign')return envelope(campaign);
  if(call.tool==='instantly_ai.get_lead')return envelope(lead);
  if(call.tool==='instantly_ai.update_campaign'){Object.assign(campaign,structuredClone(call.arguments));return {content:[],isError:false};}
  if(call.tool==='instantly_ai.update_lead'){Object.assign(lead.payload,call.arguments.custom_variables);return {content:[],isError:false};}
  throw Error('UNEXPECTED_FAKE_PROVIDER_CALL');
 };
 return {api,scope,manifest,db,options,session,campaign,lead,sent,provider,setClock:v=>{clock=v;},advance:v=>{clock+=v;}};
}
test('fixed six-call session journals snapshots, confirms exact readback and closes without changing controls or budgets',async t=>{
 const f=await fixture(t),before=controls(f.db),other=structuredClone(f.lead.payload);delete other.pilot_subject_1;delete other.pilot_body_1;
 const result=await f.session.run(f.provider);
 assert.equal(result.status,'PASS');assert.equal(result.authorizationStatus,'CLOSED');
 assert.deepEqual(f.sent.map(c=>c.tool),['instantly_ai.get_campaign','instantly_ai.get_lead','instantly_ai.update_campaign','instantly_ai.get_campaign','instantly_ai.update_lead','instantly_ai.get_lead']);
 assert.deepEqual(result.counts,{reads:4,writes:2});assert.equal(result.campaignReadback,'VERIFIED');assert.equal(result.leadReadback,'VERIFIED');
 for(const [k,v]of Object.entries(other))assert.deepEqual(f.lead.payload[k],v);
 assert.equal(f.db.prepare('SELECT count(*) n FROM budgets').get().n,0);assert.equal(f.db.prepare('SELECT count(*) n FROM operations').get().n,0);assert.deepEqual(controls(f.db),before);
 assert.equal(getRecord(f.db,'contact','synthetic-held').held,true);assert.equal(getRecord(f.db,'draft','synthetic-unapproved').approved,false);
 assert.equal(f.db.prepare("SELECT count(*) n FROM journal WHERE event='INACTIVE_SETUP_CALL_INTENT'").get().n,6);
 assert.equal(getRecord(f.db,'inactive_setup_call',`${f.manifest.id}:0`).response.structuredContent.sequences[0].steps.length,3);
 const again=await f.api.createInactiveSetupSession({...f.options,invocationId:'repeat'}).run(f.provider);assert.equal(again.status,'BLOCKED');assert.equal(f.sent.length,6);
});
test('campaign is verified before failed lead write; partial state is retained and never replayed',async t=>{
 const f=await fixture(t);const result=await f.session.run(async c=>c.tool==='instantly_ai.update_lead'?(f.sent.push(c),{content:[{type:'text',text:'Provider failure'}],isError:true}):f.provider(c));
 assert.equal(result.status,'FAILED');assert.equal(result.reason,'INSTANTLY_TOOL_ERROR');assert.equal(result.campaignReadback,'VERIFIED');assert.equal(result.leadReadback,'NOT_VERIFIED');assert.equal(result.authorizationStatus,'CLOSED');
 assert.deepEqual(result.counts,{reads:3,writes:2});assert.equal(f.campaign.status,0);assert.equal(f.campaign.sequences[0].steps.length,1);assert.equal(f.sent.length,5);
 assert.notEqual(f.lead.payload.pilot_subject_1,f.manifest.calls[4].arguments.custom_variables.pilot_subject_1);
});
test('uncertain first write closes with durable unresolved intent and no readback or later write',async t=>{
 const f=await fixture(t);const result=await f.session.run(async c=>{if(c.tool==='instantly_ai.update_campaign'){f.sent.push(c);throw Error('connection lost');}return f.provider(c);});
 assert.equal(result.status,'UNRESOLVED');assert.equal(result.reason,'INACTIVE_SETUP_TRANSPORT_UNCERTAIN');assert.equal(result.authorizationStatus,'CLOSED');assert.equal(f.sent.length,3);
 assert.equal(getRecord(f.db,'inactive_setup_call',`${f.manifest.id}:2`).state,'UNRESOLVED');
});
test('deadline between calls prevents the next write and closes without extending sixty seconds',async t=>{
 const f=await fixture(t);const result=await f.session.run(async c=>{const r=await f.provider(c);if(f.sent.length===2)f.setClock(at+61000);return r;});
 assert.equal(result.reason,'INACTIVE_SETUP_DEADLINE');assert.equal(result.authorizationStatus,'CLOSED');assert.equal(f.sent.length,2);assert.equal(result.counts.writes,0);
 assert.equal(getRecord(f.db,'inactive_setup_call',`${f.manifest.id}:1`).response.structuredContent.id,'01a1e4b0-51d4-799a-9249-e089d63d5fb0');
});
test('deadline expiring after durable intent but before plugin entry prevents the request',async t=>{
 const f=await fixture(t);
 f.db.function('fixture_expire_soon',()=>{queueMicrotask(()=>f.setClock(at+61000));return 0;});
 f.db.exec("CREATE TRIGGER fixture_expire_intent AFTER INSERT ON journal WHEN NEW.event='INACTIVE_SETUP_CALL_INTENT' BEGIN SELECT fixture_expire_soon(); END;");
 const result=await f.session.run(f.provider);assert.equal(result.reason,'INACTIVE_SETUP_DEADLINE');assert.equal(f.sent.length,0);assert.equal(result.authorizationStatus,'CLOSED');
});
test('source verification crossing the deadline prevents plugin invocation',async t=>{
 const f=await fixture(t),original=fs.readFileSync;let reads=0;
 t.mock.method(fs,'readFileSync',(...args)=>{const result=original(...args);if(String(args[0]).replaceAll('\\','/').endsWith('/src/values.mjs')&&++reads===3)f.setClock(at+61000);return result;});
 syncBuiltinESMExports();
 try{const result=await f.session.run(f.provider);assert.equal(result.reason,'INACTIVE_SETUP_DEADLINE');assert.equal(f.sent.length,0);assert.equal(result.authorizationStatus,'CLOSED');}
 finally{t.mock.restoreAll();syncBuiltinESMExports();}
});
test('known provider sequence annotations are accepted without allowing extra steps or disabled variants',async t=>{
 const f=await fixture(t);const result=await f.session.run(async c=>{const r=await f.provider(c);if(c.tool==='instantly_ai.update_campaign'){const s=f.campaign.sequences[0].steps[0];s.delay_unit='days';s.pre_delay_unit='days';s.variants[0].v_disabled=false;}return r;});
 assert.equal(result.status,'PASS');assert.equal(result.campaignReadback,'VERIFIED');
});
test('deadline at final closure is reported even if both readbacks were validated',async t=>{
 const f=await fixture(t);f.db.function('fixture_expire_at_close',()=>{f.setClock(at+61000);return 0;});
 f.db.exec("CREATE TRIGGER fixture_expire_final AFTER INSERT ON journal WHEN NEW.event='INACTIVE_SETUP_CALL_VALIDATED' AND NEW.subject LIKE '%:5' BEGIN SELECT fixture_expire_at_close(); END;");
 const result=await f.session.run(f.provider);assert.equal(result.reason,'INACTIVE_SETUP_DEADLINE');assert.notEqual(result.status,'PASS');assert.equal(result.authorizationStatus,'CLOSED');assert.equal(f.sent.length,6);
});
test('pending write timeout closes locally; a later response is not cancellation evidence or permission to continue',async t=>{
 const f=await fixture(t);t.mock.timers.enable({apis:['setTimeout']});let late;
 const running=f.session.run(async c=>{if(c.tool==='instantly_ai.update_campaign'){f.sent.push(c);return new Promise(resolve=>{late=resolve;});}return f.provider(c);});
 for(let i=0;i<30&&!late;i++)await Promise.resolve();assert.equal(typeof late,'function');
 f.setClock(at+61000);t.mock.timers.tick(60000);const result=await running;
 assert.equal(result.status,'UNRESOLVED');assert.equal(result.authorizationStatus,'CLOSED');assert.equal(result.remoteCancellationConfirmed,false);
 late({content:[],isError:false});await Promise.resolve();assert.equal(f.sent.length,3);assert.equal(getRecord(f.db,'inactive_setup_call',`${f.manifest.id}:2`).state,'UNRESOLVED');
});
for(const [name,change]of [
 ['wrong campaign',f=>{f.campaign.id='other';}],['active campaign',f=>{f.campaign.status=1;}],['wrong lead association',f=>{f.lead.campaign='other';}],
 ['changed original variable',f=>{f.lead.payload.pilot_subject_2='Changed externally';}],['unexpected sender',f=>{f.campaign.email_list=['other@example.invalid'];}],
])test(`precondition ${name} blocks all writes`,async t=>{
 const f=await fixture(t);change(f);const result=await f.session.run(f.provider);assert.notEqual(result.status,'PASS');assert.equal(result.counts.writes,0);assert.equal(result.authorizationStatus,'CLOSED');
});
for(const [name,change]of [
 ['missing daily limit',f=>{delete f.campaign.daily_limit;}],['enabled day',f=>{f.campaign.campaign_schedule.schedules[0].days['1']=true;}],
 ['extra variant',f=>{f.campaign.sequences[0].steps[0].variants.push({subject:'extra',body:'extra'});}],['wrong end date',f=>{f.campaign.campaign_schedule.end_date='2026-12-01';}],
 ['unapproved start date',f=>{f.campaign.campaign_schedule.start_date='2099-01-01';}],['unapproved nested calendar field',f=>{f.campaign.campaign_schedule.unapproved_setting=true;}],
])test(`campaign readback ${name} stops before lead update`,async t=>{
 const f=await fixture(t);const result=await f.session.run(async c=>{const r=await f.provider(c);if(c.tool==='instantly_ai.update_campaign')change(f);return r;});
 assert.equal(result.status,'UNRESOLVED');assert.equal(result.reason,'INACTIVE_SETUP_CAMPAIGN_READBACK_MISMATCH');assert.equal(result.counts.writes,1);assert.equal(f.sent.length,4);assert.equal(result.authorizationStatus,'CLOSED');
});
for(const [name,change]of [
 ['wrong approved value',f=>{f.lead.payload.pilot_body_1='Wrong copy';}],['lost other variable',f=>{delete f.lead.payload.pilot_subject_3;}],['unrelated field changed',f=>{f.lead.status=99;}],
])test(`lead readback ${name} stays unresolved without replay`,async t=>{
 const f=await fixture(t);const result=await f.session.run(async c=>{const r=await f.provider(c);if(c.tool==='instantly_ai.update_lead')change(f);return r;});
 assert.equal(result.status,'UNRESOLVED');assert.equal(result.reason,'INACTIVE_SETUP_LEAD_READBACK_MISMATCH');assert.equal(result.counts.writes,2);assert.equal(f.sent.length,6);assert.equal(result.authorizationStatus,'CLOSED');
});
test('changed call and extra operation are denied before provider dispatch',async t=>{
 const f=await fixture(t);f.session.start();
 const altered=structuredClone(f.manifest.calls[0]);altered.arguments.id='other';assert.throws(()=>f.session.prepare(altered),/CALL_MISMATCH/);
 assert.equal(getRecord(f.db,'acceptance_authorization',f.manifest.id).status,'CLOSED');assert.equal(f.sent.length,0);
});
test('duplicate/concurrent session cannot close or consume the owner session',async t=>{
 const f=await fixture(t);f.session.start();const competitor=f.api.createInactiveSetupSession({...f.options,invocationId:'competitor'});
 const refusal=await competitor.run(f.provider);assert.equal(refusal.status,'BLOCKED');assert.equal(getRecord(f.db,'acceptance_authorization',f.manifest.id).status,'CLAIMED');assert.equal(f.sent.length,0);
 f.session.finish('INACTIVE_SETUP_CANCELLED');assert.equal(getRecord(f.db,'acceptance_authorization',f.manifest.id).status,'CLOSED');
});
test('interruption after dispatch intent closes as unresolved on recovery with no provider replay',async t=>{
 const f=await fixture(t);f.session.start();f.session.prepare(f.manifest.calls[0]);
 const recovered=f.api.createInactiveSetupSession(f.options).recover();assert.equal(recovered.status,'UNRESOLVED');assert.equal(recovered.authorizationStatus,'CLOSED');assert.equal(f.sent.length,0);
 assert.equal(getRecord(f.db,'inactive_setup_call',`${f.manifest.id}:0`).state,'UNRESOLVED');
});
test('response persistence failure prevents any next operation and records a closed uncertain result',async t=>{
 const f=await fixture(t);f.db.exec("CREATE TRIGGER fixture_fail_response BEFORE INSERT ON journal WHEN NEW.event='INACTIVE_SETUP_RESPONSE_SAVED' BEGIN SELECT RAISE(ABORT,'fixture response persistence error'); END;");
 const result=await f.session.run(f.provider);assert.equal(result.status,'UNRESOLVED');assert.equal(result.reason,'INACTIVE_SETUP_EVIDENCE_PERSISTENCE_FAILED');assert.equal(f.sent.length,1);assert.equal(result.authorizationStatus,'CLOSED');
});
test('conflicting or secret-bearing returned evidence fails closed without logging secret values',async t=>{
 for(const mode of ['conflict','secret']){
  const f=await fixture(t);const result=await f.session.run(async c=>{const r=await f.provider(c);if(mode==='conflict')r.structuredContent.status=1;else r.structuredContent.password='fixture-sensitive';return r;});
  assert.notEqual(result.status,'PASS');assert.equal(result.authorizationStatus,'CLOSED');assert.equal(f.sent.length,1);
  assert.equal(JSON.stringify(f.db.prepare('SELECT * FROM records').all()).includes('fixture-sensitive'),false);
 }
});
