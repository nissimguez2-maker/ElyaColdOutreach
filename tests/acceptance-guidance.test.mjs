import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {WRITING_BUTTONS} from '../src/telegram-writing-render.mjs';
const api=await import('../src/acceptance-guidance.mjs').catch(()=>null);
const descriptor={title:'SYNTHETIC QA — Content review • Synthetic Acceptance A • v1',version:1,messageId:20,location:'Step 3 (button-bearing message)'};

test('one-action console guidance module exists',()=>assert.ok(api));
if(api){
test('prompt identifies exact title, version, bound message, button and expected result',()=>{
 const event=api.nextAcceptanceAction([{key:'stale',target:'v1',action:'APPROVED',expectedResult:'STALE_REVIEW'},{key:'changes',target:'v2',action:'REVISION_REQUESTED',expectedResult:'REVISION_REQUESTED'}],{stale:{status:'PENDING'},changes:{status:'PENDING'}},{v1:descriptor,v2:{...descriptor,version:2,messageId:24}}, {workingPollsRemaining:3,apiSecondsRemaining:90});
 assert.equal(event.messageId,20);assert.equal(event.buttonLabel,WRITING_BUTTONS.APPROVED);assert.equal(event.expectedResult,'STALE_REVIEW');
 const text=api.formatAcceptanceEvent(event);assert.match(text,/Synthetic Acceptance A • v1/);assert.match(text,/Version: 1/);assert.match(text,/Message ID: 20/);assert.match(text,/Step 3/);assert.match(text,/Approve content/);assert.match(text,/STALE_REVIEW/);assert.doesNotMatch(text,/Request changes/);
});
test('no premature instruction when current target is unbound, and next action only follows its pass',()=>{
 const steps=[{key:'stale',target:'v1',action:'APPROVED',expectedResult:'STALE_REVIEW'},{key:'changes',target:'v2',action:'REVISION_REQUESTED',expectedResult:'REVISION_REQUESTED'}],targets={v1:descriptor,v2:{...descriptor,version:2,messageId:24}};
 assert.equal(api.nextAcceptanceAction(steps,{},{}),null);
 assert.equal(api.nextAcceptanceAction(steps,{stale:{status:'PENDING'}},targets).messageId,20);
 assert.equal(api.nextAcceptanceAction(steps,{stale:{status:'PASS'}},targets).buttonLabel,'Request changes');
 assert.equal(api.nextAcceptanceAction(steps,{stale:{status:'PASS'},changes:{status:'PASS'}},targets),null);
});
test('out-of-scope and uncertain acknowledgments remain understandable without claiming decisions or UI visibility',()=>{
 const text=api.formatAcceptanceEvent(api.acceptanceOutcome(descriptor,'REJECTED','ACTION_OUTSIDE_ACCEPTANCE_SCOPE',64381645));
 assert.match(text,/No content decision/);assert.match(text,/Reject content/);assert.match(text,/Message ID: 20/);
 assert.match(api.formatAcceptanceEvent({event:'OPERATOR_ACK_STATUS',status:'UNCERTAIN'}),/uncertain/i);
 assert.match(api.formatAcceptanceEvent({event:'OPERATOR_ACK_STATUS',status:'API_CONFIRMED'}),/does not confirm.*visible/i);
});
test('title and location derive from the actual page carrying the buttons',()=>{
 const page={text:descriptor.title+'\n\n## Step 3\n\nSynthetic body',reply_markup:{inline_keyboard:[[{text:'Approve content',callback_data:'opaque-never-in-output'}]]}};
 assert.deepEqual(api.acceptanceTarget(page,{version:1,messageId:20}),descriptor);
 assert.throws(()=>api.acceptanceTarget({text:'summary'},{version:1,messageId:20}),/BUTTON_PAGE/);
 assert.ok(!JSON.stringify(api.acceptanceTarget(page,{version:1,messageId:20})).includes('opaque'));
});
}

test('closed timeline explains bounded exhaustion without changing request limits or historical outcomes',()=>{
 const r=JSON.parse(readFileSync('work/acceptance-manifest-v1/live-once/result.json','utf8')),t=r.telegram;
 assert.equal(t.reason,'ACCEPTANCE_POLL_BUDGET_EXHAUSTED');assert.equal(t.counts.normalPolls,16);assert.equal(t.attempts.length,36);
 assert.equal(t.attempts.filter(x=>x.kind==='normalPolls').reduce((sum,x)=>sum+Date.parse(x.finishedAt)-Date.parse(x.at),0),308026);
 assert.equal(r.elapsedMs,333487);assert.equal(t.scenarios.a1Approval.status,'PASS');assert.equal(t.scenarios.b1Rejection.status,'PASS');assert.equal(r.authorizationStatus,'CLOSED');
});
