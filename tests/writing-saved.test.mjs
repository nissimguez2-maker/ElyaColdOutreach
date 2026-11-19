import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync,backup} from 'node:sqlite';
import {mkdtempSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import http from 'node:http';import https from 'node:https';import net from 'node:net';import dns from 'node:dns';import childProcess from 'node:child_process';
import {openStore,getRecord,controls} from '../src/store.mjs';
import {evaluateWritingReview} from '../src/writing.mjs';
const saved=await import('../src/writing-saved.mjs').catch(()=>null);
test('saved writing adapter exists to bind all six preserved messages to independent evidence',()=>assert.ok(saved));
if(saved){
 async function copy(){const path=join(mkdtempSync(join(tmpdir(),'elya-writing-real-')),'state.sqlite');const src=new DatabaseSync(fileURLToPath(new URL('../data/elya.sqlite',import.meta.url)),{readOnly:true});try{await backup(src,path);}finally{src.close();}return openStore(path);}
 test('real held contacts stay reviewable with unapproved originals and grounded facts, without network capability',async t=>{
  const db=await copy();t.after(()=>db.close());
  const before=JSON.stringify(db.prepare("SELECT * FROM records WHERE kind IN ('draft','contact','refinement_current','refinement_run','campaign') ORDER BY kind,id").all());
  let attempts=0;const deny=()=>{attempts++;throw Error('OFFLINE_ONLY');};t.mock.method(globalThis,'fetch',deny);
  for(const [module,names]of [[http,['get','request']],[https,['get','request']],[net,['connect','createConnection']],[dns,['lookup','resolve']],[childProcess,['spawn','spawnSync','exec','execFile']]])for(const name of names)t.mock.method(module,name,deny);
  const result=saved.prepareSavedWritingReviews(db,'2026-11-16T22:00:00Z');
  assert.equal(result.packets.length,2);assert.equal(result.packets.reduce((n,p)=>n+p.messages.length,0),6);
  assert.equal(attempts,0);assert.equal(controls(db).stopped,true);assert.equal(controls(db).launchAuthorized,false);
  assert.equal(JSON.stringify(db.prepare("SELECT * FROM records WHERE kind IN ('draft','contact','refinement_current','refinement_run','campaign') ORDER BY kind,id").all()),before);
  assert.ok(result.packets.every(p=>p.spec.facts.length>=3));
  const tos=result.packets.find(p=>p.spec.candidateId==='PHL-12');const ch=result.packets.find(p=>p.spec.candidateId==='PHL-13');
  assert.equal(tos.spec.recipient.class,'GROUP_SHARED');assert.equal(ch.spec.recipient.class,'DIRECT_PERSON');
  assert.ok(tos.spec.steps.flatMap(s=>s.findings).some(f=>f.code==='EVENT_RECENCY_UNESTABLISHED'));
  assert.ok(ch.spec.steps.flatMap(s=>s.findings).some(f=>f.code==='CATERING_CURRENT_AVAILABILITY_UNCONFIRMED'));
  assert.ok(ch.spec.facts.some(f=>f.id==='on-site-brewing'));
  const count=db.prepare("SELECT count(*) n FROM records WHERE kind='writing_packet'").get().n;
  assert.deepEqual(saved.prepareSavedWritingReviews(db,'2026-11-16T22:00:00Z').packets.map(p=>p.hash),result.packets.map(p=>p.hash));
  assert.equal(db.prepare("SELECT count(*) n FROM records WHERE kind='writing_packet'").get().n,count);
  assert.equal(getRecord(db,'draft','PHL-12:v2:step1').status,'UNAPPROVED');
 });
 test('modified independent saved evidence cannot silently inherit curated writing assertions',async t=>{
  const db=await copy();t.after(()=>db.close());
  const row=db.prepare("SELECT content_json FROM sources WHERE id='original/philadelphia-evidence-ledger.json'").get();const data=JSON.parse(row.content_json);data.runs[14].results.items[0].markdown='Unreviewed replacement retaining old import checksum.';
  db.prepare("UPDATE sources SET content_json=? WHERE id='original/philadelphia-evidence-ledger.json'").run(JSON.stringify(data));
  assert.throws(()=>saved.prepareSavedWritingReviews(db,'2026-11-16T22:00:00Z'),/SOURCE|evidence|excerpt/i);
 });
 test('upstream source changes after packet creation make the writing binding stale immediately',async t=>{
  const db=await copy();t.after(()=>db.close());
  saved.prepareSavedWritingReviews(db,'2026-11-16T22:00:00Z');
  const row=db.prepare("SELECT content_json FROM sources WHERE id='original/philadelphia-evidence-ledger.json'").get();const data=JSON.parse(row.content_json);data.runs[14].results.items[0].markdown+=' Material later correction.';
  db.prepare("UPDATE sources SET content_json=? WHERE id='original/philadelphia-evidence-ledger.json'").run(JSON.stringify(data));
  assert.ok(evaluateWritingReview(db,'PHL-12-writing-v2',null,'2026-11-16T22:01:00Z').reasons.includes('WRITING_STALE_BINDINGS'));
 });
 test('offline CLI prepares review packets only and reports both held contacts without granting approval',async t=>{
  const db=await copy();const path=db.location();db.close();
  const r=childProcess.spawnSync(process.execPath,['src/cli.mjs','review-writing','--as-of','2026-11-16T22:00:00Z','--db',path],{encoding:'utf8'});
  assert.equal(r.status,0,r.stderr);const report=JSON.parse(r.stdout);
  assert.equal(report.packets.length,2);assert.equal(report.liveCalls,0);assert.equal(report.controls.stopped,true);assert.equal(report.controls.launchAuthorized,false);
  assert.ok(report.packets.every(p=>p.contentApproved===false&&p.contactEligible===false));
 });
}
