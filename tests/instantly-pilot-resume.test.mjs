import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {resolve,join} from 'node:path';
import {openStore,getRecord,putRecord,controls} from '../src/store.mjs';
import {armAcceptance,claimAcceptance} from '../src/acceptance-authority.mjs';
import {canonical,digest} from '../src/values.mjs';
import {blockNetwork} from './helpers/network-block.mjs';
const root=resolve('.'),at=Date.parse('2026-11-18T18:00:00Z');
const saved=name=>JSON.parse(readFileSync(`work/inactive-setup-authority-v1/live-once/${name}.json`,'utf8'));
const envelope=value=>({content:[{type:'text',text:JSON.stringify(value)}],structuredContent:structuredClone(value),isError:false});
async function fixture(t,{arm=true}={}){
 const network=blockNetwork(t);t.after(()=>assert.equal(network.attempts,0));
 const scope=await import('../src/instantly-pilot-scope.mjs');
 assert.equal(typeof scope.buildInactiveLeadCopyManifest,'function','fixed remaining lead-copy profile required');
 const {createInactiveSetupSession}=await import('../src/instantly-pilot-session.mjs');
 const raw=readFileSync('work/inactive-one-step-pilot-v1/proposal.json','utf8'),manifest=scope.buildInactiveLeadCopyManifest(raw);
 const db=openStore(':memory:');t.after(()=>db.close());
 putRecord(db,'acceptance_authorization',scope.INACTIVE_SETUP_ID,{id:scope.INACTIVE_SETUP_ID,status:'CLOSED'});
 putRecord(db,'acceptance_result',scope.INACTIVE_SETUP_ID,saved('result'));
 putRecord(db,'inactive_setup_session',scope.INACTIVE_SETUP_ID,{status:'CLOSED',priorEvidence:'preserve exact'});
 putRecord(db,'contact','held',{held:true});putRecord(db,'draft','unapproved',{approved:false});
 const sources=scope.INACTIVE_LEAD_COPY_SOURCES.map(path=>({path,sha256:digest(readFileSync(join(root,path)))}));
 const approval={type:'EXPLICIT_LIVE_EXECUTION_APPROVAL',manifestHash:digest(canonical(manifest)),reference:'OFFLINE FIXTURE ONLY',approvedAt:new Date(at).toISOString()};
 if(arm)armAcceptance(db,manifest,sources,at,{executionApproval:approval});
 let clock=at+1000;
 const options={db,root,manifest,invocationId:'offline-resume-owner',now:()=>clock},session=createInactiveSetupSession(options);
 const campaign=saved('response-3').structuredContent,lead=saved('response-1').structuredContent,sent=[],contexts=[];
 const copy=JSON.parse(raw).leadArguments.custom_variables;
 const provider=async(call,context)=>{
  sent.push(structuredClone(call));contexts.push(context);
  if(call.tool==='instantly_ai.get_campaign')return envelope(campaign);
  if(call.tool==='instantly_ai.get_lead')return envelope(lead);
  if(call.tool==='instantly_ai.update_lead'){Object.assign(lead.payload,call.arguments.custom_variables);return {content:[],isError:false};}
  throw Error('UNEXPECTED_PROVIDER_OPERATION');
 };
 return {scope,raw,manifest,db,sources,approval,options,session,campaign,lead,copy,sent,contexts,provider,createInactiveSetupSession,setClock:v=>{clock=v;}};
}
test('remaining execution writes only approved lead copy, preserves old evidence and closes once',async t=>{
 const f=await fixture(t),oldRows=f.db.prepare('SELECT * FROM records ORDER BY kind,id').all(),before=controls(f.db),leadBefore=structuredClone(f.lead);
 const result=await f.session.run(f.provider);
 assert.equal(result.status,'PASS');assert.equal(result.authorizationStatus,'CLOSED');
 assert.deepEqual(f.sent.map(c=>c.tool),['instantly_ai.get_campaign','instantly_ai.get_lead','instantly_ai.update_lead','instantly_ai.get_lead']);
 assert.deepEqual(f.sent[2].arguments,{id:'01a1e4b0-51d4-799a-9249-e089d63d5fb0',custom_variables:f.copy});
 assert.deepEqual(Object.keys(f.copy).sort(),['pilot_body_1','pilot_subject_1']);
 assert.deepEqual(result.counts,{reads:3,writes:1});assert.equal(result.campaignReadback,'VERIFIED');assert.equal(result.leadReadback,'VERIFIED');
 assert.equal(Date.parse(f.contexts[0].deadlineAt)-Date.parse(result.startedAt),120000);assert.deepEqual(f.contexts.map(c=>c.index),[0,1,2,3]);
 Object.assign(leadBefore.payload,f.copy);assert.deepEqual(f.lead,leadBefore);
 for(const row of oldRows.filter(r=>r.id!==f.manifest.id))assert.deepEqual(f.db.prepare('SELECT * FROM records WHERE kind=? AND id=?').get(row.kind,row.id),row);
 assert.deepEqual(controls(f.db),before);assert.equal(f.db.prepare('SELECT count(*) n FROM budgets').get().n,0);assert.equal(f.db.prepare('SELECT count(*) n FROM operations').get().n,0);
 assert.throws(()=>armAcceptance(f.db,f.manifest,f.sources,at+2000,{executionApproval:f.approval}),/ALREADY_EXISTS/);
 const again=await f.createInactiveSetupSession({...f.options,invocationId:'second'}).run(f.provider);assert.equal(again.status,'BLOCKED');assert.equal(f.sent.length,4);
});
test('already exact copy skips its write slot and still verifies an independent lead readback',async t=>{
 const f=await fixture(t);Object.assign(f.lead.payload,f.copy);
 const result=await f.session.run(f.provider);
 assert.equal(result.status,'PASS');assert.deepEqual(result.counts,{reads:3,writes:0});
 assert.deepEqual(f.sent.map(c=>c.tool),['instantly_ai.get_campaign','instantly_ai.get_lead','instantly_ai.get_lead']);
 assert.deepEqual(f.contexts.map(c=>c.index),[0,1,3]);assert.equal(result.leadReadback,'VERIFIED');
 assert.equal(getRecord(f.db,'inactive_setup_call',`${f.manifest.id}:2`).state,'SKIPPED_ALREADY_EXACT');
});
test('fresh scope requires explicit matching approval, closed prior grant and all bound sources',async t=>{
 const f=await fixture(t,{arm:false});
 assert.throws(()=>claimAcceptance(f.db,f.manifest,at+1000,{root,now:()=>at+1000,invocationId:'missing'}),/MISSING/);
 assert.throws(()=>armAcceptance(f.db,f.manifest,f.sources,at),/EXPLICIT_EXECUTION_APPROVAL_REQUIRED/);
 assert.throws(()=>armAcceptance(f.db,f.manifest,f.sources,at,{executionApproval:{...f.approval,manifestHash:'0'.repeat(64)}}),/EXPLICIT_EXECUTION_APPROVAL_REQUIRED/);
 assert.throws(()=>armAcceptance(f.db,f.manifest,f.sources.slice(1),at,{executionApproval:f.approval}),/FINGERPRINTS_REQUIRED/);
 putRecord(f.db,'acceptance_authorization',f.scope.INACTIVE_SETUP_ID,{status:'CLAIMED'});
 assert.throws(()=>armAcceptance(f.db,f.manifest,f.sources,at,{executionApproval:f.approval}),/PRIOR_EVIDENCE_REQUIRED/);
 assert.equal(getRecord(f.db,'acceptance_authorization',f.manifest.id),null);
});
for(const [name,mutate] of [
 ['wrong target',m=>{m.calls[0].arguments.id='other';}],['campaign write',m=>{m.calls[2].tool='instantly_ai.update_campaign';}],
 ['different copy',m=>{m.calls[2].arguments.custom_variables.pilot_body_1='changed';}],['additional variable',m=>{m.calls[2].arguments.custom_variables.pilot_body_2='changed';}],
 ['longer deadline',m=>{m.limits.totalMs=120001;}],['extra operation',m=>{m.calls.push(m.calls[0]);}],
])test(`fixed remaining scope rejects ${name}`,async t=>{
 const f=await fixture(t),m=structuredClone(f.manifest);mutate(m);
 assert.throws(()=>f.createInactiveSetupSession({...f.options,manifest:m}),/MANIFEST_MISMATCH/);assert.equal(f.sent.length,0);
});
for(const [name,change,reads] of [
 ['campaign sender',f=>{f.campaign.email_list.push('other@example.com');},1],['missing campaign stop control',f=>{delete f.campaign.stop_on_auto_reply;},1],
 ['enabled sending day',f=>{f.campaign.campaign_schedule.schedules[0].days['1']=true;},1],['lead identity',f=>{f.lead.email='other@example.com';},2],
 ['partial approved copy',f=>{f.lead.payload.pilot_subject_1=f.copy.pilot_subject_1;},2],['different copy',f=>{f.lead.payload.pilot_body_1='unapproved';},2],
 ['protected QA variable',f=>{delete f.lead.payload.pilot_subject_3;},2],['protected lead status',f=>{f.lead.status=99;},2],
])test(`changed ${name} stops before any write`,async t=>{
 const f=await fixture(t);change(f);const result=await f.session.run(f.provider);
 assert.notEqual(result.status,'PASS');assert.equal(result.authorizationStatus,'CLOSED');assert.deepEqual(result.counts,{reads,writes:0});assert.equal(f.sent.length,reads);
});
test('lead readback must preserve all other returned fields and the four other QA variables',async t=>{
 const f=await fixture(t);const result=await f.session.run(async(c,context)=>{const r=await f.provider(c,context);if(c.tool==='instantly_ai.update_lead')delete f.lead.payload.pilot_body_2;return r;});
 assert.equal(result.status,'UNRESOLVED');assert.equal(result.reason,'INACTIVE_SETUP_LEAD_READBACK_MISMATCH');assert.equal(result.authorizationStatus,'CLOSED');assert.equal(f.sent.length,4);
});
test('overall deadline is 120 seconds and no call starts at its boundary',async t=>{
 const f=await fixture(t);const result=await f.session.run(async(c,context)=>{const r=await f.provider(c,context);f.setClock(c.tool==='instantly_ai.get_campaign'?at+61000:at+121000);return r;});
 assert.equal(result.reason,'INACTIVE_SETUP_DEADLINE');assert.deepEqual(result.counts,{reads:2,writes:0});assert.equal(f.sent.length,2);assert.equal(result.authorizationStatus,'CLOSED');
});
test('uncertain write closes without readback, retry, or replay',async t=>{
 const f=await fixture(t);const result=await f.session.run(async(c,context)=>{await f.provider(c,context);if(c.tool==='instantly_ai.update_lead')throw Error('connection lost');return c.tool==='instantly_ai.get_campaign'?envelope(f.campaign):envelope(f.lead);});
 assert.equal(result.status,'UNRESOLVED');assert.equal(result.reason,'INACTIVE_SETUP_TRANSPORT_UNCERTAIN');assert.equal(result.remoteCancellationConfirmed,false);assert.deepEqual(result.counts,{reads:2,writes:1});assert.equal(f.sent.length,3);
 const second=await f.createInactiveSetupSession({...f.options,invocationId:'retry'}).run(f.provider);assert.equal(second.status,'BLOCKED');assert.equal(f.sent.length,3);
});
test('changed local protected records prevent the fresh claim',async t=>{
 const f=await fixture(t);putRecord(f.db,'contact','held',{held:false});
 const result=await f.session.run(f.provider);assert.equal(result.reason,'ACCEPTANCE_PROTECTED_STATE_CHANGED');assert.equal(f.sent.length,0);
});
test('original fixed scope keeps its exact previous hash, calls and sixty-second ceiling',async t=>{
 const f=await fixture(t),old=f.scope.buildInactiveSetupManifest(f.raw);
 assert.equal(digest(canonical(old)),'7b691143ff0dd96b13937c422f0a250fe7215e53fbff5957a979fd298d353443');
 assert.equal(old.calls.length,6);assert.equal(old.limits.totalMs,60000);assert.equal(old.limits.maxWrites,2);assert.notEqual(old.id,f.manifest.id);
});
