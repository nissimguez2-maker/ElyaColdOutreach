import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {canonical,digest} from '../src/values.mjs';
import {openStore,putRecord,getRecord,transaction,setStopped,setLaunch} from '../src/store.mjs';
import {createBatch,decideApproval,evaluateRelease} from '../src/batches.mjs';
const api=await import('../src/writing.mjs').catch(()=>null);
const handoff=await import('../src/writing-handoff.mjs').catch(()=>null);
const at='2026-11-16T20:00:00Z';
function fixture(path=':memory:'){
 const db=openStore(path),campaignId='qa-writing',candidateId='synthetic-writing',email='qa@example.test';
 putRecord(db,'candidate',candidateId,{qualification:'QUALIFIED',synthetic:true,operatingStatusCheckedAt:at});
 putRecord(db,'contact',email,{candidateId,email,attribution:'Synthetic group inbox',attributionClass:'GROUP_SHARED',verification:'PASSED',verifiedAt:at,attributionCorroboratedAt:at,suppressed:false});
 putRecord(db,'campaign',campaignId,{purpose:'synthetic_qa',synthetic:true});
 putRecord(db,'refinement_current',candidateId,{semanticHash:'assessment-v1',disposition:'QUALIFIED_FOR_REVIEW'});
 putRecord(db,'refinement_assessment',candidateId+':assessment-v1',{businessFit:{state:'PASS'},contacts:[]});
 putRecord(db,'writing_evidence','fact-source',{text:'The synthetic restaurant offers catering.',observedAt:at});
 putRecord(db,'writing_policy',campaignId,{revision:'qa-v1',sender:{name:'Daniel Rosen',title:'Head of Operations and Underwriting',company:'Elya Partners'},approver:'Daniel Rosen',sequence:{steps:3,cadenceApproved:true,endpointApproved:true},physicalAddressApproved:true,optOutApproved:true,synthetic:true});
 putRecord(db,'operational_policy','freshness-fixture',{emailVerification:{daysBeforeFirstRelease:14},contactRoleAttribution:{meaningfulCorroborationDays:90},operatingStatus:{daysBeforeFirstRelease:30},personalization:{timelyEventDays:90,ongoingOrFutureStatusCheckDays:30}});
 putRecord(db,'settings','current-contact-freshness',{policyKind:'operational_policy',revision:'freshness-fixture'});
 const draftIds=[1,2,3].map(step=>`${candidateId}:v1:step${step}`);
 for(const [i,id] of draftIds.entries())putRecord(db,'draft',id,{candidateId,email,version:1,step:i+1,status:'UNAPPROVED',subject:`Synthetic subject ${i+1}`,body:'Hi QA team,\n\nThe synthetic restaurant offers catering. If funding becomes relevant, would an introduction be useful?\n\nDaniel Rosen\nHead of Operations and Underwriting\nElya Partners\n\nLet me know if you prefer no further contact.'});
 const spec={reviewId:'qa-review',campaignId,candidateId,email,draftIds,asOf:at,synthetic:true,recipient:{class:'GROUP_SHARED',greeting:'Hi QA team,'},facts:[{id:'catering',text:'Synthetic catering context',source:{kind:'writing_evidence',id:'fact-source',pointer:'/text',excerpt:'offers catering'},usage:'CONTEXT',eventDate:null}],salesHypotheses:['Funding may be relevant; no need known.'],unknowns:['Funding need'],steps:draftIds.map(draftId=>({draftId,factIds:['catering'],angle:'Conditional introduction',findings:[]}))};
 return {db,spec};
}
const approve=(db,p,extra={})=>api.decideWritingReview(db,{actionId:'approve-1',reviewId:p.reviewId,packetHash:p.hash,decision:'APPROVED',actor:'Daniel Rosen',expiresAt:'2026-11-20T00:00:00Z',at,acknowledgedFindings:[],...extra});
test('offline writing contract implemented',()=>{assert.ok(api);assert.ok(handoff);});
if(api&&handoff){
test('synthetic content is eligible but no real handoff or release is possible',()=>{
 const {db,spec}=fixture();const p=api.prepareWritingReview(db,spec),d=approve(db,p);
 const gate=api.evaluateWritingReview(db,p.reviewId,d.id,at);assert.equal(gate.contentApproved,true);assert.equal(gate.contactEligible,true);assert.equal(gate.campaignEligible,true);assert.equal(gate.synthetic,true);
 const content={campaignId:spec.campaignId,recipients:[{candidateId:spec.candidateId,email:spec.email,messages:p.messages,writing:{reviewId:p.reviewId,packetHash:p.hash,decisionId:d.id}}],sequence:p.policy.sequence,settings:{syntheticOnly:true}};
 const b=createBatch(db,'qa-batch',content);const approval=decideApproval(db,'qa-batch',b.version,b.hash,'APPROVED','fixture','2026-11-20T00:00:00Z',at);setStopped(db,false,'offline fixture');setLaunch(db,true,'offline fixture');
 assert.equal(evaluateRelease(db,'qa-batch',approval.id,at).allowed,false);assert.throws(()=>handoff.prepareWritingHandoff(db,'qa-batch',approval.id,at),/Synthetic|synthetic/);db.close();
});
test('unapproved and held contacts can be reviewed but never pass handoff',()=>{
 const {db,spec}=fixture();putRecord(db,'contact',spec.email,{candidateId:spec.candidateId,attribution:'Synthetic group inbox',attributionClass:'GROUP_SHARED',verification:'CATCH_ALL',suppressed:null});
 const p=api.prepareWritingReview(db,spec);assert.match(api.renderWritingReview(p),/HELD|held/);const g=api.evaluateWritingReview(db,p.reviewId,null,at);assert.equal(g.contentApproved,false);assert.equal(g.contactEligible,false);
 const d=approve(db,p);assert.equal(api.evaluateWritingReview(db,p.reviewId,d.id,at).contentApproved,true);assert.equal(api.evaluateWritingReview(db,p.reviewId,d.id,at).contactEligible,false);db.close();
});
test('unsupported evidence, guessed attribution, and timely year-only facts fail',()=>{
 const {db,spec}=fixture();const bad=structuredClone(spec);bad.facts[0].source.excerpt='invented expansion';assert.throws(()=>api.prepareWritingReview(db,bad),/EVIDENCE/);
 const wrong=structuredClone(spec);wrong.recipient={class:'DIRECT_PERSON',greeting:'Hi Pep,'};assert.throws(()=>api.prepareWritingReview(db,wrong),/ATTRIBUTION/);
 const recent=structuredClone(spec);recent.facts[0].usage='TIMELY';recent.facts[0].eventDate='2026';assert.throws(()=>api.prepareWritingReview(db,recent),/EVENT/);db.close();
});
test('unsupported financing claims and unresolved variables block content approval',()=>{
 const {db,spec}=fixture();for(const [i,id]of spec.draftIds.entries()){const old=getRecord(db,'draft',id);const newId=id.replace(':v1:',':v2:');putRecord(db,'draft',newId,{...old,version:2,body:old.body+'\nYou are preapproved for guaranteed funding. {{missing}}'});spec.draftIds[i]=newId;spec.steps[i].draftId=newId;}
 const p=api.prepareWritingReview(db,spec);assert.ok(p.findings.some(f=>f.code==='PROHIBITED_CLAIM'));assert.throws(()=>approve(db,p),/BLOCK/);db.close();
});
test('named greeting must match the person explicitly attributed to that email',()=>{
 const {db,spec}=fixture();putRecord(db,'contact',spec.email,{candidateId:spec.candidateId,attribution:'Named business contact',attributionClass:'DIRECT_PERSON',verification:'PASSED',suppressed:false});
 putRecord(db,'refinement_assessment',spec.candidateId+':assessment-v1',{contacts:[{email:spec.email,attribution:{class:'DIRECT_PERSON',personId:'person-a'}}],personIdentity:[{value:{personId:'person-a',name:'Alice Example'}},{value:{personId:'person-b',name:'Bob Example'}}]});
 spec.recipient={class:'DIRECT_PERSON',greeting:'Hi Bob,'};for(const [i,id]of spec.draftIds.entries()){const old=getRecord(db,'draft',id),next=id.replace('v1','v2');putRecord(db,'draft',next,{...old,version:2,body:old.body.replace('Hi QA team,','Hi Bob,')});spec.draftIds[i]=next;spec.steps[i].draftId=next;}
 assert.throws(()=>api.prepareWritingReview(db,spec),/ATTRIBUTION/);db.close();
});
test('unknown campaign cannot bypass new handoff and stopped control remains an independent block',()=>{
 const {db,spec}=fixture();const p=api.prepareWritingReview(db,spec);const b=createBatch(db,'unknown',{campaignId:'not-configured',recipients:[{candidateId:spec.candidateId,email:spec.email,messages:p.messages}],sequence:{},settings:{}});const a=decideApproval(db,'unknown',b.version,b.hash,'APPROVED','fixture','2026-11-20T00:00:00Z',at);
 assert.throws(()=>handoff.prepareWritingHandoff(db,'unknown',a.id,at),/Writing review binding required/);assert.ok(evaluateRelease(db,'unknown',a.id,at).reasons.includes('System stopped'));db.close();
});
test('freshness blocks missing, future or old verification and attribution dates without new verification',()=>{
 for(const patch of [{verifiedAt:null},{verifiedAt:'2026-11-17T00:00:00Z'},{verifiedAt:'2026-10-01T00:00:00Z'},{attributionCorroboratedAt:'2026-07-01T00:00:00Z'}]){
  const {db,spec}=fixture();putRecord(db,'contact',spec.email,{...getRecord(db,'contact',spec.email),...patch});const p=api.prepareWritingReview(db,spec),d=approve(db,p);assert.equal(api.evaluateWritingReview(db,p.reviewId,d.id,at).contactEligible,false);assert.equal(db.prepare('SELECT count(*) n FROM operations').get().n,0);db.close();
 }
 const {db,spec}=fixture();putRecord(db,'candidate',spec.candidateId,{...getRecord(db,'candidate',spec.candidateId),operatingStatusCheckedAt:'2026-10-01T00:00:00Z'});const p=api.prepareWritingReview(db,spec),d=approve(db,p);assert.equal(api.evaluateWritingReview(db,p.reviewId,d.id,at).contactEligible,false);db.close();
});
test('timely fact expires at handoff according to the bound policy',()=>{
 const {db,spec}=fixture();const policy=getRecord(db,'operational_policy','freshness-fixture');policy.personalization.timelyEventDays=1;putRecord(db,'operational_policy','freshness-fixture',policy);spec.facts[0].usage='TIMELY';spec.facts[0].eventDate='2026-11-16';const p=api.prepareWritingReview(db,spec),d=approve(db,p);
 assert.equal(api.evaluateWritingReview(db,p.reviewId,d.id,'2026-11-18T00:00:00Z').contentApproved,false);db.close();
});
test('packet repeat and decision duplicate are idempotent; action collision rejected',()=>{
 const {db,spec}=fixture();const p=api.prepareWritingReview(db,spec);assert.equal(api.prepareWritingReview(db,spec).hash,p.hash);const d=approve(db,p);assert.equal(approve(db,p).id,d.id);assert.equal(db.prepare("SELECT count(*) n FROM records WHERE kind='writing_decision'").get().n,1);assert.throws(()=>approve(db,p,{decision:'REJECTED'}),/ACTION/);db.close();
});
test('material revision invalidates old decision and stale packet approval',()=>{
 const {db,spec}=fixture();const p=api.prepareWritingReview(db,spec),d=approve(db,p);spec.unknowns.push('Timing');const p2=api.prepareWritingReview(db,spec);assert.notEqual(p2.hash,p.hash);assert.equal(getRecord(db,'writing_decision',d.id).decision,'INVALIDATED');assert.throws(()=>approve(db,p,{actionId:'stale'}),/STALE/);assert.equal(api.evaluateWritingReview(db,p.reviewId,d.id,at).contentApproved,false);db.close();
});

test('older quality policy is stale at evaluation and duplicate approval without rewriting history',()=>{
 const {db,spec}=fixture(),p=api.prepareWritingReview(db,spec),old=structuredClone(p);
 old.qualityReport.version='fixture-previous-quality-policy';delete old.qualityReport.hash;old.qualityReport.hash=digest(canonical(old.qualityReport));old.coreHash=digest(canonical({contractVersion:old.contractVersion,spec:old.spec,snapshot:old.snapshot,qualityReport:old.qualityReport,findings:old.findings}));delete old.hash;old.hash=digest(canonical(old));
 putRecord(db,'writing_packet',old.hash,old);putRecord(db,'writing_current',spec.reviewId,{packetHash:old.hash,version:old.version});
 const action={actionId:'legacy-approved',reviewId:old.reviewId,packetHash:old.hash,decision:'APPROVED',actor:'Daniel Rosen',expiresAt:'2026-11-20T00:00:00Z',at,acknowledgedFindings:[]};
 putRecord(db,'writing_decision',action.actionId,{...action,id:action.actionId,reason:null});putRecord(db,'writing_action',action.actionId,{inputHash:digest(canonical(action)),decisionId:action.actionId});
 const historical=canonical(getRecord(db,'writing_packet',old.hash));
 const gate=api.evaluateWritingReview(db,old.reviewId,action.actionId,at);assert.equal(gate.contentApproved,false);assert.ok(gate.reasons.includes('WRITING_STALE_QUALITY_POLICY'));
 assert.throws(()=>api.decideWritingReview(db,action),/STALE_QUALITY_POLICY/);assert.throws(()=>api.decideWritingReview(db,{...action,actionId:'new-action'}),/STALE_QUALITY_POLICY/);
 assert.equal(getRecord(db,'writing_decision',action.actionId).decision,'APPROVED');assert.equal(canonical(getRecord(db,'writing_packet',old.hash)),historical);
 const next=api.prepareWritingReview(db,spec);assert.notEqual(next.hash,old.hash);assert.equal(getRecord(db,'writing_decision',action.actionId).decision,'INVALIDATED');assert.equal(canonical(getRecord(db,'writing_packet',old.hash)),historical);db.close();
});

test('direct review/import path blocks em dash and prospect name limits at approval',()=>{
 for(const subject of ['Rule\u20140','Fixture Bistro Other Bistro Fixture Bistro Other Bistro','Fixture Bistro Fixture Bistro Fixture Bistro']){
  const {db,spec}=fixture(),d=getRecord(db,'draft',spec.draftIds[0]),newId=d.candidateId+':v2:step1';spec.knownNames=[{kind:'BUSINESS',name:'Fixture Bistro',aliases:[]},{kind:'BUSINESS',name:'Other Bistro',aliases:[]}];
  putRecord(db,'draft',newId,{...d,version:2,subject});spec.draftIds[0]=newId;spec.steps[0].draftId=newId;
  const p=api.prepareWritingReview(db,spec);assert.ok(p.findings.some(f=>['EM_DASH_FORBIDDEN','NAME_TOTAL_LIMIT','NAME_ENTITY_LIMIT'].includes(f.code)&&f.severity==='BLOCK'));assert.throws(()=>approve(db,p),/CONTENT_BLOCKED/);db.close();
 }
});
test('a mandatory-footer label cannot hide extra prospect text attached to the signature',()=>{
 const {db,spec}=fixture(),policy=getRecord(db,'writing_policy',spec.campaignId),signature='Daniel Rosen\nHead of Operations and Underwriting\nElya Partners';
 spec.knownNames=[{kind:'BUSINESS',name:'Fixture Bistro',aliases:[]}];putRecord(db,'writing_policy',spec.campaignId,{...policy,mandatoryLegalFooter:{approved:true,mandatory:true,text:'Fixture Bistro\n'+signature}});
 const first=spec.draftIds[0],d=getRecord(db,'draft',first),id=first.replace(':v1:',':v2:');putRecord(db,'draft',id,{...d,version:2,subject:'Fixture Bistro',body:'Hi QA team,\n\nFixture Bistro\n\nFixture Bistro\n'+signature});spec.draftIds[0]=id;spec.steps[0].draftId=id;
 const p=api.prepareWritingReview(db,spec);assert.ok(p.findings.some(f=>f.code==='NAME_ENTITY_LIMIT'&&f.severity==='BLOCK'));assert.throws(()=>approve(db,p,{acknowledgedFindings:p.findings.map(f=>f.code)}),/CONTENT_BLOCKED/);db.close();
});
for(const target of ['source','recipient','campaign','policy','refinement','suppression','draft'])test(`changed ${target} invalidates effective approval`,()=>{
 const {db,spec}=fixture();const p=api.prepareWritingReview(db,spec),d=approve(db,p);
 if(target==='source')putRecord(db,'writing_evidence','fact-source',{text:'Changed evidence'});
 if(target==='recipient'||target==='suppression'){const c=getRecord(db,'contact',spec.email);putRecord(db,'contact',spec.email,{...c,...(target==='suppression'?{suppressed:true}:{attribution:'Changed ownership'})});}
 if(target==='campaign')putRecord(db,'campaign',spec.campaignId,{purpose:'synthetic_qa',changed:true});
 if(target==='policy')putRecord(db,'writing_policy',spec.campaignId,{...getRecord(db,'writing_policy',spec.campaignId),revision:'qa-v2'});
 if(target==='refinement')putRecord(db,'refinement_current',spec.candidateId,{semanticHash:'changed',disposition:'HOLD'});
 if(target==='draft'){const d0=getRecord(db,'draft',spec.draftIds[0]);putRecord(db,'draft','new-draft-v2',{...d0,version:2,body:d0.body+' Material change'});}
 assert.equal(api.evaluateWritingReview(db,p.reviewId,d.id,at).contentApproved,false);db.close();
});
test('rejection, revocation, future and expired approvals fail closed',()=>{
 for(const decision of ['REJECTED','REVISION_REQUESTED','REVOKED']){const {db,spec}=fixture();const p=api.prepareWritingReview(db,spec),d=approve(db,p);api.decideWritingReview(db,{actionId:'later',reviewId:p.reviewId,packetHash:p.hash,decision,actor:'Daniel Rosen',expiresAt:'2026-11-20T00:00:00Z',at,acknowledgedFindings:[]});assert.equal(api.evaluateWritingReview(db,p.reviewId,d.id,at).contentApproved,false);db.close();}
 const {db,spec}=fixture();const p=api.prepareWritingReview(db,spec),d=approve(db,p);assert.equal(api.evaluateWritingReview(db,p.reviewId,d.id,'2026-11-21T00:00:00Z').contentApproved,false);assert.equal(api.evaluateWritingReview(db,p.reviewId,d.id,'2026-11-16T19:59:00Z').contentApproved,false);db.close();
});
test('transaction interruption rolls back packet and restart preserves recorded decisions without replay',()=>{
 const path=join(mkdtempSync(join(tmpdir(),'elya-writing-')),'state.sqlite');const {db,spec}=fixture(path);
 assert.throws(()=>transaction(db,()=>{api.prepareWritingReview(db,spec);throw Error('interruption');}));assert.equal(getRecord(db,'writing_current',spec.reviewId),null);
 const p=api.prepareWritingReview(db,spec),d=approve(db,p);db.close();const restarted=openStore(path);assert.equal(api.evaluateWritingReview(restarted,p.reviewId,d.id,at).contentApproved,true);assert.equal(approve(restarted,p).id,d.id);assert.equal(restarted.prepare('SELECT count(*) n FROM operations').get().n,0);restarted.close();
});
test('review warnings require explicit acknowledgment and relative-year text expires across year',()=>{
 const {db,spec}=fixture();spec.steps[0].findings=[{code:'EVENT_CONTEXT',severity:'REVIEW',detail:'Year only, not a timely event'}];const old=getRecord(db,'draft',spec.draftIds[0]);const id='relative-year-v2';putRecord(db,'draft',id,{...old,version:2,body:old.body+'\nYour historical timeline lists a new concept this year.'});spec.draftIds[0]=id;spec.steps[0].draftId=id;
 const p=api.prepareWritingReview(db,spec);assert.throws(()=>approve(db,p),/ACKNOWLEDGMENT/);const d=approve(db,p,{expiresAt:'2027-02-01T00:00:00Z',acknowledgedFindings:['EVENT_CONTEXT']});assert.equal(api.evaluateWritingReview(db,p.reviewId,d.id,'2027-01-01T00:00:00Z').contentApproved,false);db.close();
});
test('six variables escape HTML while preserving paragraph text and special characters',()=>{
 const {db,spec}=fixture();const old=getRecord(db,'draft',spec.draftIds[0]);const id='special-v2';putRecord(db,'draft',id,{...old,version:2,body:old.body+'\n\nA & B <script> "Töska’s"'});spec.draftIds[0]=id;spec.steps[0].draftId=id;const p=api.prepareWritingReview(db,spec);const v=api.reviewVariables(p);assert.equal(Object.keys(v).length,6);assert.match(v.pilot_body_1,/&amp; B &lt;script&gt;/);assert.match(v.pilot_body_1,/<br><br>/);assert.match(v.pilot_body_1,/Töska’s/);db.close();
});
test('prospect campaign release path requires writing even without a writing binding',()=>{
 const {db,spec}=fixture();putRecord(db,'campaign',spec.campaignId,{purpose:'prospect'});const p=api.prepareWritingReview(db,spec);const b=createBatch(db,'missing-writing',{campaignId:spec.campaignId,recipients:[{candidateId:spec.candidateId,email:spec.email,messages:p.messages}],sequence:{steps:3},settings:{}});const a=decideApproval(db,'missing-writing',b.version,b.hash,'APPROVED','fixture','2026-11-20T00:00:00Z',at);setStopped(db,false,'fixture');setLaunch(db,true,'fixture');assert.ok(evaluateRelease(db,'missing-writing',a.id,at).reasons.some(r=>r.includes('Writing')));db.close();
});
test('campaign remain-inactive restriction independently blocks campaign eligibility',()=>{
 const {db,spec}=fixture();putRecord(db,'campaign',spec.campaignId,{purpose:'synthetic_qa',mustRemainInactive:true});const p=api.prepareWritingReview(db,spec),d=approve(db,p);setStopped(db,false,'fixture');setLaunch(db,true,'fixture');const g=api.evaluateWritingReview(db,p.reviewId,d.id,at);assert.equal(g.contentApproved,true);assert.equal(g.campaignEligible,false);assert.ok(g.reasons.includes('WRITING_CAMPAIGN_MUST_REMAIN_INACTIVE'));db.close();
});
test('unknown and unattributed classes cannot prepare owner-personal greetings',()=>{
 for(const cls of ['UNATTRIBUTED','unknown',null]){const {db,spec}=fixture();putRecord(db,'contact',spec.email,{...getRecord(db,'contact',spec.email),attribution:'Not established',attributionClass:cls});spec.recipient={class:cls,greeting:'Hi Pep,'};for(const [i,id]of spec.draftIds.entries()){const old=getRecord(db,'draft',id),next=id.replace('v1','v2');putRecord(db,'draft',next,{...old,version:2,body:old.body.replace('Hi QA team,','Hi Pep,')});spec.draftIds[i]=next;spec.steps[i].draftId=next;}assert.throws(()=>api.prepareWritingReview(db,spec),/ATTRIBUTION/);db.close();}
});
for(const target of ['contact','policy','source','source-table','freshness-pointer','freshness-policy','draft-set'])test(`change and restoration of ${target} cannot revive an approval without an intervening evaluation`,()=>{
 const {db,spec}=fixture();
 if(target==='source-table'){db.prepare('INSERT INTO sources VALUES(?,?,?,?,?)').run('source-test','source-test.json','fixture-hash',JSON.stringify({text:'The synthetic restaurant offers catering.'}),at);spec.facts[0].source={kind:'source',id:'source-test',pointer:'/text',excerpt:'offers catering'};}
 const p=api.prepareWritingReview(db,spec),d=approve(db,p);
 if(['contact','policy','source'].includes(target)){
  const [kind,id]=target==='contact'?['contact',spec.email]:target==='policy'?['writing_policy',spec.campaignId]:['writing_evidence','fact-source'];const original=getRecord(db,kind,id);putRecord(db,kind,id,{...original,...(target==='contact'?{suppressed:true}:{changed:true})});putRecord(db,kind,id,original);
 }
 if(target==='source-table'){const original=db.prepare('SELECT content_json FROM sources WHERE id=?').get('source-test').content_json;db.prepare('UPDATE sources SET content_json=? WHERE id=?').run(JSON.stringify({text:'Changed'}),'source-test');db.prepare('UPDATE sources SET content_json=? WHERE id=?').run(original,'source-test');}
 if(target==='freshness-pointer'||target==='freshness-policy'){const [kind,id]=target==='freshness-pointer'?['settings','current-contact-freshness']:['operational_policy','freshness-fixture'];const original=getRecord(db,kind,id);putRecord(db,kind,id,{...original,changed:true});putRecord(db,kind,id,original);}
 if(target==='draft-set'){const original=getRecord(db,'draft',spec.draftIds[0]);putRecord(db,'draft','newer-draft',{...original,version:2,body:original.body+' Changed'});db.prepare("DELETE FROM records WHERE kind='draft' AND id='newer-draft'").run();}
 const g=api.evaluateWritingReview(db,p.reviewId,d.id,at);assert.equal(g.contentApproved,false);assert.ok(g.reasons.includes('WRITING_STALE_BINDINGS'));assert.throws(()=>approve(db,p,{actionId:'old-reapprove'}),/STALE/);db.close();
});
test('unrelated record mutation does not invalidate an exact review',()=>{
 const {db,spec}=fixture();const p=api.prepareWritingReview(db,spec),d=approve(db,p);putRecord(db,'candidate','unrelated',{qualification:'HOLD'});putRecord(db,'writing_evidence','unrelated',{text:'Other business'});assert.equal(api.evaluateWritingReview(db,p.reviewId,d.id,at).contentApproved,true);db.close();
});
test('review rendering shares freshness and qualification checks with handoff eligibility',()=>{
 const {db,spec}=fixture();putRecord(db,'contact',spec.email,{...getRecord(db,'contact',spec.email),verifiedAt:null});const p=api.prepareWritingReview(db,spec);const text=api.renderWritingReview(p);assert.match(text,/CONTACT HELD/);assert.match(text,/WRITING_VERIFICATION_FRESHNESS_UNESTABLISHED/);assert.doesNotMatch(text,/CONTACT CHECKS PASSED/);db.close();
});
}
