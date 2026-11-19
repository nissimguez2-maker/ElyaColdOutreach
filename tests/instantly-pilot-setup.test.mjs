import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {outreachPreviewFixture,tableSnapshot} from './helpers/outreach-preview-fixture.mjs';
import {blockNetwork} from './helpers/network-block.mjs';
const raw=readFileSync(new URL('../work/inactive-one-step-pilot-v1/proposal.json',import.meta.url),'utf8');
const load=()=>import('../src/instantly-pilot-setup.mjs').catch(()=>null);
async function setup(){const m=await load();assert.equal(typeof m?.createInactivePilotSetup,'function');return m.createInactivePilotSetup(raw);}

test('pure setup binds the exact internal recipient and two update requests without granting execution',async t=>{
 const net=blockNetwork(t),f=outreachPreviewFixture(':memory:',{approved:false,contact:{verification:'CATCH_ALL',suppressed:null}});t.after(()=>f.db.close());
 const before=tableSnapshot(f.db),s=await setup();
 assert.equal(s.review.label,'PROPOSAL — NOT AUTHORIZED OR RELEASED');
 assert.equal(s.review.recipient,'drosen@elyapartners.com');
 assert.equal(s.review.campaignId,'e0b018cf-160f-454c-9891-e73b4204d7cd');
 assert.equal(s.review.leadId,'01a1e4b0-51d4-799a-9249-e089d63d5fb0');
 assert.equal(s.review.sender,'daniel.rosen@elya-partners.com');
 assert.equal(s.review.executionAuthorized,false);assert.equal(s.review.activationAllowed,false);
 assert.equal(s.review.sendingWindowNotApproved,true);assert.equal(s.review.runtimeContractCompatibilityVerified,false);
 assert.deepEqual(s.review.calls.map(c=>[c.server,c.tool]),[['codex_apps','instantly_ai.update_campaign'],['codex_apps','instantly_ai.update_lead']]);
 assert.equal(s.execute,undefined);assert.equal(s.authorize,undefined);assert.equal(s.reserve,undefined);
 assert.deepEqual(tableSnapshot(f.db),before);assert.equal(net.attempts,0);
});
test('inactive profile has one sender, one step, one variant, disabled days and finite end date',async t=>{
 blockNetwork(t);const s=await setup(),a=s.review.calls[0].arguments;
 assert.deepEqual(a.email_list,['daniel.rosen@elya-partners.com']);assert.equal(a.daily_limit,1);
 assert.equal(a.sequences.length,1);assert.equal(a.sequences[0].steps.length,1);
 assert.deepEqual(a.sequences[0].steps[0],{type:'email',delay:0,variants:[{subject:'{{pilot_subject_1}}',body:'<div>{{pilot_body_1}}</div>'}]});
 assert.equal(a.campaign_schedule.schedules.length,1);
 assert.deepEqual(a.campaign_schedule.schedules[0].days,{'0':false,'1':false,'2':false,'3':false,'4':false,'5':false,'6':false});
 assert.equal(a.campaign_schedule.end_date,'2026-11-30');assert.equal(a.campaign_schedule.schedules[0].timezone,'America/Detroit');
 assert.equal(a.stop_on_reply,true);assert.equal(a.stop_on_auto_reply,true);assert.equal(a.open_tracking,false);assert.equal(a.link_tracking,false);assert.equal(a.text_only,true);
 assert.equal(Object.hasOwn(a,'status'),false);
});
test('lead request contains only the two exact synthetic variables; no replacement or create instruction',async t=>{
 blockNetwork(t);const s=await setup(),a=s.review.calls[1].arguments;
 assert.deepEqual(Object.keys(a).sort(),['custom_variables','id']);
 assert.deepEqual(Object.keys(a.custom_variables).sort(),['pilot_body_1','pilot_subject_1']);
 assert.equal(a.custom_variables.pilot_subject_1,'SYNTHETIC QA — ELYA-B-11b81c38ac29497a94339fd2086d6f24');
 assert.equal(a.custom_variables.pilot_body_1,"Hi Daniel,<br><br>This is the single internal message for Elya Partners&#39; supervised workflow test.<br>Pilot marker: ELYA-B-11b81c38ac29497a94339fd2086d6f24<br><br>Please reply to this email with: QA reply received — ELYA-B-11b81c38ac29497a94339fd2086d6f24.<br><br>Synthetic test only. No prospect outreach is authorized.<br><br>Daniel Rosen<br>Head of Operations and Underwriting<br>Elya Partners");
 assert.equal(s.review.preserveUnrelatedVariables,true);
});
test('binding and complete calls are deterministic and deeply immutable',async t=>{
 blockNetwork(t);const a=await setup(),b=await setup();assert.deepEqual(a.review,b.review);assert.match(a.review.hash,/^[a-f0-9]{64}$/);
 assert.throws(()=>{a.review.recipient='different@example.invalid';},TypeError);
 assert.throws(()=>{a.review.calls[0].arguments.campaign_schedule.schedules[0].days['1']=true;},TypeError);
 assert.throws(()=>{a.review.calls.push({});},TypeError);
 for(let i=0;i<2;i++){assert.deepEqual(a.validateCall(a.review.calls[i],i),a.review.calls[i]);assert.throws(()=>a.validateCall(a.review.calls[i],1-i),/CALL_MISMATCH/);}
 for(const index of [-1,2,'0',null,undefined])assert.throws(()=>a.validateCall(a.review.calls[0],index),/POSITION_INVALID/);
});
for(const [name,change]of [
 ['server alias',c=>{c.server='codex_app';}],
 ['activation',c=>{c.tool='instantly_ai.activate_campaign';}],
 ['different campaign',c=>{c.arguments.id='339a5dbc-075c-4745-9a38-c11a26c5d920';}],
 ['extra argument',c=>{c.arguments.status=1;}],
 ['other sender',c=>{c.arguments.email_list=['other@example.invalid'];}],
 ['enabled day',c=>{c.arguments.campaign_schedule.schedules[0].days['1']=true;}],
 ['extra step',c=>{c.arguments.sequences[0].steps.push(c.arguments.sequences[0].steps[0]);}],
 ['extra variant',c=>{c.arguments.sequences[0].steps[0].variants.push({subject:'other',body:'other'});}],
 ['extra call field',c=>{c.authorization='[REDACTED]';}],
])test(`proposal rejects ${name} without transport execution`,async t=>{
 const net=blockNetwork(t),s=await setup(),c=structuredClone(s.review.calls[0]);change(c);assert.throws(()=>s.validateCall(c,0),/CALL_MISMATCH/);assert.equal(net.attempts,0);
});
test('changed lead identity, copy, removal and extra variables are rejected',async t=>{
 blockNetwork(t);const s=await setup();
 for(const change of [c=>{c.arguments.id='another-lead';},c=>{c.arguments.custom_variables.pilot_body_1+=' extra';},c=>{delete c.arguments.custom_variables.pilot_subject_1;},c=>{c.arguments.custom_variables.pilot_body_2='overwrite';}]){
  const c=structuredClone(s.review.calls[1]);change(c);assert.throws(()=>s.validateCall(c,1),/CALL_MISMATCH/);
 }
});
test('factory rejects missing or changed proposal including identity, scope and preconditions',async t=>{
 blockNetwork(t);const m=await load();assert.equal(typeof m?.createInactivePilotSetup,'function');
 for(const invalid of [undefined,null,{},'{}',raw+' '])assert.throws(()=>m.createInactivePilotSetup(invalid),/PROPOSAL_PIN_MISMATCH/);
 for(const change of [p=>{p.recipient='other@example.invalid';},p=>{p.preconditions=[];},p=>{p.activationCalls=1;},p=>{p.campaignArguments.campaign_schedule.end_date=null;}]){
  const p=JSON.parse(raw);change(p);assert.throws(()=>m.createInactivePilotSetup(JSON.stringify(p)),/PROPOSAL_PIN_MISMATCH/);
 }
});
