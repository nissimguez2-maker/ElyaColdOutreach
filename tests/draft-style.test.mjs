import test from 'node:test';
import assert from 'node:assert/strict';
import {blockNetwork} from './helpers/network-block.mjs';
async function api(t){blockNetwork(t);return import('../src/draft-style.mjs');}
const names=[{kind:'PERSON',name:'Daniel Rosen',aliases:['Daniel']},{kind:'BUSINESS',name:'Elya Partners',aliases:['Elya']},{kind:'BUSINESS',name:'M2O Hospitality Group',aliases:['M2O']},{kind:'PERSON',name:'Alice Morgan',aliases:['Alice']},{kind:'BUSINESS',name:'Töska Restaurant & Brewery',aliases:['Töska']}];
const snapshot=()=>({policy:{sender:{name:'Daniel Rosen',company:'Elya Partners'}},candidate:{name:'Fixture Bistro'},assessment:{personIdentity:[]}});
const policy=a=>a.resolveDraftStylePolicy({knownNames:names,facts:[]},snapshot());
const check=(a,p,subject,body)=>a.checkDraftStyle({subject,body},p);
test('prospect-only budget excludes configured sender identities and exact final signature',async t=>{
 const a=await api(t),p=policy(a),r=check(a,p,'M2O','Hi M2O team,\nA specific note.\n\nDaniel Rosen\nElya Partners');
 assert.equal(r.knownMentionTotal,2);assert.equal(r.signatureExclusion,'EXACT_CONFIGURED_STANDARD_SUFFIX');assert.equal(r.findings.some(f=>f.severity==='BLOCK'),false);assert.equal(r.entities.find(e=>e.name==='Elya Partners').scope,'SENDER');
});
test('prospect-only policy keeps sender-company body references in semantic redundancy review',async t=>{
 const a=await api(t),p=policy(a),r=check(a,p,'M2O','Elya Partners. Elya. ELYA PARTNERS.\n\nDaniel Rosen\nElya Partners');
 assert.equal(r.knownMentionTotal,1);assert.ok(r.findings.some(f=>f.code==='SENDER_COMPANY_REDUNDANCY_REVIEW'&&f.severity==='REVIEW'));assert.equal(r.findings.some(f=>f.severity==='BLOCK'),false);
});
test('prospect mentions across subject, greeting and body share the budget; full names count once',async t=>{
 const a=await api(t),r=check(a,policy(a),'M2O','Hi Alice Morgan,\nA specific note about Töska.\n\nDaniel Rosen\nElya Partners');
 assert.equal(r.knownMentionTotal,3);assert.equal(r.findings.some(f=>f.severity==='BLOCK'),false);
 assert.equal(r.entities.find(e=>e.name==='Alice Morgan').count,1);assert.equal(r.entities.find(e=>e.name==='Daniel Rosen').count,0);
 assert.equal(r.coverage,'KNOWN_NAMES_ONLY_SEMANTIC_REVIEW_REQUIRED');
 const over=check(a,policy(a),'M2O','Hi Alice,\nM2O and Töska.\n\nDaniel Rosen\nElya Partners');
 assert.equal(over.knownMentionTotal,4);assert.ok(over.findings.some(f=>f.code==='NAME_TOTAL_LIMIT'&&f.severity==='BLOCK'));
});
test('case insensitive explicit aliases share a per-entity limit without overlapping double counts',async t=>{
 const a=await api(t),r=check(a,policy(a),'M2O HOSPITALITY GROUP','m2o and M2O Hospitality Group');
 assert.equal(r.knownMentionTotal,3);assert.equal(r.entities.find(e=>e.name==='M2O Hospitality Group').count,3);assert.ok(r.findings.some(f=>f.code==='NAME_ENTITY_LIMIT'));
 assert.equal(check(a,policy(a),'Alice Morgan','Alice').knownMentionTotal,2);
 assert.equal(check(a,policy(a),'Danielson','M2Organization').knownMentionTotal,0);
});
test('matching handles Unicode names, spaces and literal regex punctuation',async t=>{
 const a=await api(t),p=a.resolveDraftStylePolicy({facts:[],knownNames:[{kind:'BUSINESS',name:'Töska Restaurant & Brewery',aliases:['Töska']},{kind:'BUSINESS',name:'A+B (Kitchen)',aliases:[]},{kind:'PERSON',name:'Alice Morgan',aliases:[]}]},snapshot());
 const r=check(a,p,'TÖSKA RESTAURANT & BREWERY','Töska\nA+B (Kitchen)');assert.equal(r.knownMentionTotal,3);assert.equal(r.entities.find(e=>e.name==='Töska Restaurant & Brewery').count,2);
 assert.equal(check(a,p,'Alice\nMorgan','').knownMentionTotal,1);
});
test('every U+2014 is blocked, including the subject and an exempt legal footer; text is never rewritten',async t=>{
 const a=await api(t),s=snapshot();s.policy.mandatoryLegalFooter={approved:true,mandatory:true,text:'Elya Partners\nLegal notice — fixture'};const p=a.resolveDraftStylePolicy({facts:[]},s),d={subject:'Hello — test',body:'Hi team,\n\n'+p.mandatoryLegalFooter};const original=structuredClone(d),r=a.checkDraftStyle(d,p);
 assert.equal(r.emDashCount,2);assert.ok(r.findings.some(f=>f.code==='EM_DASH_FORBIDDEN'&&f.severity==='BLOCK'));assert.deepEqual(d,original);
});
test('exact signature before exact approved legal footer is excluded; subject prospect names remain counted',async t=>{
 const a=await api(t),s=snapshot(),footer='M2O Hospitality Group\nFixture legal notice';s.policy.mandatoryLegalFooter={approved:true,mandatory:true,text:footer};const p=a.resolveDraftStylePolicy({facts:[],knownNames:names},s);
 const r=check(a,p,'M2O','Hi Alice,\nA note about Töska.\n\nDaniel Rosen\nElya Partners\n\n'+footer);
 assert.equal(r.footerExclusion,'EXACT_APPROVED_MANDATORY_SUFFIX');assert.equal(r.signatureExclusion,'EXACT_CONFIGURED_STANDARD_SUFFIX');assert.equal(r.knownMentionTotal,3);assert.equal(r.findings.some(f=>f.severity==='BLOCK'),false);
 const changed=check(a,p,'','M2O\n\n'+footer+' changed');assert.equal(changed.footerExclusion,'NONE');assert.equal(changed.knownMentionTotal,2);assert.ok(changed.findings.some(f=>f.code==='LEGAL_FOOTER_UNMATCHED'));
 const only=check(a,p,'',footer);assert.equal(only.footerExclusion,'NONE');
});
test('unapproved or nonmandatory footers do not exempt names; draft-supplied exemption is ignored',async t=>{
 const a=await api(t);for(const settings of [{approved:false,mandatory:true},{approved:true,mandatory:false}]){const s=snapshot();s.policy.mandatoryLegalFooter={...settings,text:'M2O'};const p=a.resolveDraftStylePolicy({facts:[],knownNames:names},s);assert.equal(p.mandatoryLegalFooter,null);assert.equal(a.checkDraftStyle({subject:'',body:'M2O\n\nM2O',mandatoryLegalFooter:'M2O'},p).knownMentionTotal,2);}
});
test('footer/signature overlap cannot hide prospect text added around the standard signature',async t=>{
 const a=await api(t),s=snapshot();s.policy.sender.title='Head of Operations and Underwriting';const signature='Daniel Rosen\nHead of Operations and Underwriting\nElya Partners';
 for(const text of [signature,signature+'\nLegal address',signature.toLowerCase()]){s.policy.mandatoryLegalFooter={approved:true,mandatory:true,text:'M2O\n'+text};const p=a.resolveDraftStylePolicy({facts:[],knownNames:names},s),r=check(a,p,'M2O','M2O\n\n'+s.policy.mandatoryLegalFooter.text);assert.equal(r.footerExclusion,'NONE');assert.equal(r.signatureExclusion,'NONE');assert.equal(r.knownMentionTotal,3);assert.ok(r.findings.some(f=>f.code==='LEGAL_FOOTER_SIGNATURE_OVERLAP'));assert.ok(r.findings.some(f=>f.code==='NAME_ENTITY_LIMIT'&&f.severity==='BLOCK'));}
});
test('ambiguous email matches do not inflate a definite blocking count',async t=>{
 const a=await api(t),r=check(a,policy(a),'M2O','Alice Morgan\nTöska\nalice@example.invalid');assert.equal(r.knownMentionTotal,3);assert.equal(r.candidateMentionSpanCount,4);assert.ok(r.findings.some(f=>f.code==='NAME_COUNT_AMBIGUOUS'&&f.severity==='REVIEW'));assert.equal(r.findings.some(f=>f.code==='NAME_TOTAL_LIMIT'),false);
});
test('shared aliases and competing overlapping entities are ambiguous rather than guessed',async t=>{
 const a=await api(t),p=a.resolveDraftStylePolicy({facts:[],knownNames:[{kind:'PERSON',name:'Alex Smith',aliases:['Alex']},{kind:'PERSON',name:'Alex Jones',aliases:['Alex']},{kind:'BUSINESS',name:'Smith Kitchen',aliases:[]}]},snapshot());
 for(const body of ['Alex','Alex Smith Kitchen']){const r=check(a,p,'',body);assert.ok(r.findings.some(f=>f.code==='NAME_COUNT_AMBIGUOUS'&&f.severity==='REVIEW'));assert.ok(r.ambiguities.length);}
});
test('a full business name is not also counted as another business short alias',async t=>{
 const a=await api(t),p=a.resolveDraftStylePolicy({facts:[],knownNames:[...names,{kind:'BUSINESS',name:'M2O Burgers & Salads',aliases:[]}]},snapshot()),r=check(a,p,'M2O Burgers & Salads','M2O');
 assert.equal(r.knownMentionTotal,2);assert.equal(r.ambiguities.length,0);assert.equal(r.entities.find(e=>e.name==='M2O Burgers & Salads').count,1);assert.equal(r.entities.find(e=>e.name==='M2O Hospitality Group').count,1);
});
test('markup, encoded characters and invisible splitting require review; no fuzzy spelling substitutions',async t=>{
 const a=await api(t),p=policy(a);for(const body of ['Daniel <b>Rosen</b>','Dan\u200biel Rosen','Elya&#32;Partners','contact Daniel@example.invalid']){const r=check(a,p,'',body);assert.ok(r.findings.some(f=>f.code==='NAME_COUNT_AMBIGUOUS'),body);}
 const r=check(a,p,'Danyel','A note');assert.equal(r.knownMentionTotal,0);assert.match(r.coverage,/SEMANTIC_REVIEW_REQUIRED/);
});
test('structured known identities are included without deriving email or first-name aliases; malformed catalogs fail',async t=>{
 const a=await api(t),s=snapshot();s.assessment.personIdentity=[{value:{personId:'p1',name:'Lindsey Pete'}}];const p=a.resolveDraftStylePolicy({facts:[{entity:{brand:'Töska',organization:'M2O Hospitality Group'}}]},s);
 assert.ok(p.knownNames.some(n=>n.name==='Lindsey Pete'));assert.ok(p.knownNames.some(n=>n.name==='M2O Hospitality Group'));assert.equal(check(a,p,'Lindsey','').knownMentionTotal,0);
 assert.throws(()=>a.resolveDraftStylePolicy({facts:[],knownNames:[{kind:'PERSON',name:'',aliases:[]}]},s),/NAME_CATALOG/);
 assert.throws(()=>a.resolveDraftStylePolicy({facts:[],knownNames:[{kind:'PERSON',name:'Valid',aliases:[null]}]},s),/NAME_CATALOG/);
});
test('only the exact final configured signature is exempt, never draft labels or altered body blocks',async t=>{
 const a=await api(t),p=policy(a),sig=p.requiredSignature;
 for(const body of ['Hi team,\n\n'+sig+'\nM2O', 'Hi team,\n\n'+sig.toLowerCase(),'Hi team,\n\nM2O M2O M2O']){
  const r=a.checkDraftStyle({subject:'',body,standardSignature:body,signature:body},p);assert.equal(r.signatureExclusion,'NONE');
 }
 const altered=check(a,p,'','Hi team,\n\n'+sig+'\nM2O M2O M2O');assert.equal(altered.knownMentionTotal,3);assert.ok(altered.findings.some(f=>f.code==='NAME_ENTITY_LIMIT'));
 assert.throws(()=>a.resolveDraftStylePolicy({facts:[],knownNames:[{kind:'BUSINESS',name:'M2O',aliases:[],scope:'SENDER'}]},snapshot()),/NAME_CATALOG/);
});
test('Rule 0 checks the original exact signature as well as the exempt legal footer',async t=>{
 const a=await api(t),s=snapshot();s.policy.sender.title='Director\u2014fixture';s.policy.mandatoryLegalFooter={approved:true,mandatory:true,text:'Legal\u2014fixture'};const p=a.resolveDraftStylePolicy({facts:[],knownNames:names},s),r=check(a,p,'Subject\u2014fixture','Hi M2O team,\n\n'+p.requiredSignature+'\n\n'+p.mandatoryLegalFooter);
 assert.equal(r.signatureExclusion,'EXACT_CONFIGURED_STANDARD_SUFFIX');assert.equal(r.footerExclusion,'EXACT_APPROVED_MANDATORY_SUFFIX');assert.equal(r.emDashCount,3);assert.ok(r.findings.some(f=>f.code==='EM_DASH_FORBIDDEN'&&f.severity==='BLOCK'));
});
test('a prospect sharing a sender alias remains ambiguous, not silently excluded',async t=>{
 const a=await api(t),p=a.resolveDraftStylePolicy({facts:[],knownNames:[...names,{kind:'PERSON',name:'Daniel Example',aliases:['Daniel']}]},snapshot()),r=check(a,p,'','Hi Daniel,');assert.ok(r.findings.some(f=>f.code==='NAME_COUNT_AMBIGUOUS'));assert.equal(r.mentions[0].scope,null);
});
test('a structured prospect sharing the sender full name is explicitly ambiguous',async t=>{
 const a=await api(t),s=snapshot();s.assessment.personIdentity=[{value:{personId:'prospect-daniel',name:'Daniel Rosen'}}];const p=a.resolveDraftStylePolicy({facts:[],knownNames:names},s),r=check(a,p,'Daniel Rosen','Hi Daniel Rosen,\nDaniel Rosen\n\n'+p.requiredSignature);
 assert.equal(p.knownNames.find(e=>e.name==='Daniel Rosen').scope,'AMBIGUOUS');assert.equal(r.signatureExclusion,'EXACT_CONFIGURED_STANDARD_SUFFIX');assert.equal(r.ambiguities.filter(x=>x.reason==='SENDER_PROSPECT_CANONICAL_COLLISION').length,3);assert.ok(r.findings.some(f=>f.code==='NAME_COUNT_AMBIGUOUS'&&f.severity==='REVIEW'));
});
