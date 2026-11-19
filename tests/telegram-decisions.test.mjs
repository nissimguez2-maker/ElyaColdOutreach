import test from 'node:test';import assert from 'node:assert/strict';
import {mkdtempSync} from 'node:fs';import {tmpdir} from 'node:os';import {join} from 'node:path';
import {openStore,putRecord,controls,getRecord,setStopped,setLaunch} from '../src/store.mjs';
import {latestBatch,evaluateRelease,createBatch} from '../src/batches.mjs';
const mod=await import('../src/telegram-decisions.mjs').catch(()=>null);
test('offline synthetic decision flow exists',()=>assert.ok(mod));
const at='2026-11-16T17:00:00.000Z',expires='2026-11-16T17:05:00.000Z';
function fixture(path=':memory:'){const db=openStore(path);putRecord(db,'telegram_binding','primary',{confirmed:true,testOnly:true,userId:42,chatId:42,botId:777},'configuration');mod.createSyntheticBatch(db,'QA-TG-01',1);mod.issueSyntheticReview(db,'qa-tg-01-v1','QA-TG-01',expires,at);return db;}
function update(text,id=1,user=42,chat=42,type='private'){return{update_id:id,message:{message_id:id,date:1794848400,from:{id:user,is_bot:false},chat:{id:chat,type},text}};}
if(mod){
 test('approve binds exact version/hash but cannot authorize any release even if other controls change',()=>{
  const db=fixture(),before=controls(db),r=mod.handleSyntheticControl(db,update('/approve qa-tg-01-v1'),at);assert.equal(r.status,'APPROVED');
  const a=db.prepare('SELECT * FROM approvals WHERE id=?').get(r.approvalId),b=latestBatch(db,'QA-TG-01');assert.equal(a.hash,b.hash);assert.equal(a.version,1);assert.equal(a.batch_id,'QA-TG-01');assert.deepEqual(controls(db),before);
  setStopped(db,false,'fixture');setLaunch(db,true,'fixture');assert.ok(evaluateRelease(db,'QA-TG-01',r.approvalId,at).reasons.includes('Synthetic batches cannot be released'));db.close();
 });
 test('revisions invalidate approvals and old review commands; rejection records only the new version',()=>{
  const db=fixture();const first=mod.handleSyntheticControl(db,update('/approve qa-tg-01-v1'),at);mod.createSyntheticBatch(db,'QA-TG-01',2);
  assert.equal(db.prepare('SELECT decision FROM approvals WHERE id=?').get(first.approvalId).decision,'INVALIDATED');
  assert.equal(mod.handleSyntheticControl(db,update('/approve qa-tg-01-v1',2),at).status,'STALE_REVIEW');
  mod.issueSyntheticReview(db,'qa-tg-01-v2','QA-TG-01',expires,at);assert.equal(mod.handleSyntheticControl(db,update('/reject qa-tg-01-v2',3),at).status,'REJECTED');db.close();
 });
 test('unauthorized users, chats, groups, forwards and edited messages cannot decide or stop',()=>{
  const db=fixture();setStopped(db,false,'fixture: unauthorized stop must not change this');const before=controls(db);let n=0;for(const u of [update('/approve qa-tg-01-v1',++n,43),update('/reject qa-tg-01-v1',++n,42,43),update('/stop',++n,42,42,'group'),{...update('/approve qa-tg-01-v1',++n),message:{...update('x').message,text:'/approve qa-tg-01-v1',forward_origin:{type:'user'}}},{update_id:++n,edited_message:update('/stop').message}])assert.ok(['UNAUTHORIZED','INVALID_MESSAGE'].includes(mod.handleSyntheticControl(db,u,at).status));
  assert.deepEqual(controls(db),before);
  assert.equal(db.prepare('SELECT count(*) n FROM approvals').get().n,0);assert.equal(getRecord(db,'telegram_review','qa-tg-01-v1').status,'PENDING');db.close();
 });
 test('duplicate updates and repeated actions with new update IDs have no duplicate decisions',()=>{
  const db=fixture(),u=update('/approve qa-tg-01-v1');assert.equal(mod.handleSyntheticControl(db,u,at).status,'APPROVED');
  assert.equal(mod.handleSyntheticControl(db,u,at).status,'DUPLICATE_UPDATE');assert.equal(mod.handleSyntheticControl(db,update('/reject qa-tg-01-v1',2),at).status,'DUPLICATE_ACTION');assert.equal(db.prepare('SELECT count(*) n FROM approvals').get().n,1);db.close();
 });
 test('expired review, pre-issue message, changed binding, tampered hash and unknown command fail closed',()=>{
  for(const kind of ['expired','old-message','binding','hash','command']){const db=fixture();let u=update('/approve qa-tg-01-v1'),time=at;
   if(kind==='expired')time=expires;if(kind==='old-message')u.message.date=1;
   if(kind==='binding'){putRecord(db,'telegram_binding','primary',{confirmed:true,testOnly:true,userId:43,chatId:43,botId:777},'configuration');u=update('/approve qa-tg-01-v1',1,43,43);}
   if(kind==='hash'){const r=getRecord(db,'telegram_review','qa-tg-01-v1');putRecord(db,'telegram_review',r.id,{...r,hash:'0'.repeat(64)},'configuration');}
   if(kind==='command')u.message.text='/launch';
   const result=mod.handleSyntheticControl(db,u,time);assert.notEqual(result.status,'APPROVED');if(kind==='binding')assert.equal(result.status,'PAIRING_CHANGED');assert.equal(db.prepare('SELECT count(*) n FROM approvals').get().n,0);db.close();
  }
 });
 test('stop is authenticated, idempotent and cannot grant launch authorization',()=>{
  const db=fixture();setStopped(db,false,'fixture');assert.equal(mod.handleSyntheticControl(db,update('/stop'),at).status,'STOPPED');assert.equal(controls(db).stopped,true);assert.equal(controls(db).launchAuthorized,false);
  assert.equal(mod.handleSyntheticControl(db,update('/stop'),at).status,'DUPLICATE_UPDATE');assert.equal(mod.handleSyntheticControl(db,update('/stop',2),at).status,'STOPPED');db.close();
 });
 test('synthetic builder never accepts prospect data or arbitrary copy; existing real batches cannot be reviewed',()=>{
  const db=fixture();assert.throws(()=>mod.createSyntheticBatch(db,'real-campaign',1));assert.throws(()=>mod.createSyntheticBatch(db,'QA-TG-01','business copy'));
  assert.throws(()=>mod.issueSyntheticReview(db,'qa-other','missing',expires,at));assert.throws(()=>mod.issueSyntheticReview(db,'qa-tg-01-v1','QA-TG-01',expires,at));
  createBatch(db,'QA-TG-NOT-SYNTHETIC',{campaignId:'fixture-real-campaign',recipients:[{candidateId:'fixture-only',email:'fixture@example.invalid',messages:[{subject:'Fixture',body:'Offline fixture'}]}],sequence:{steps:1},settings:{}});
  assert.throws(()=>mod.issueSyntheticReview(db,'qa-real','QA-TG-NOT-SYNTHETIC',expires,at),/SYNTHETIC/);
  assert.throws(()=>mod.issueSyntheticReview(db,'qa-alternative','QA-TG-01',expires,at));db.close();
 });
 test('decision and update receipt commit atomically and survive database restart',()=>{
  const path=join(mkdtempSync(join(tmpdir(),'elya-decision-')),'state.sqlite'),db=fixture(path);
  db.exec("CREATE TRIGGER fail_decision BEFORE INSERT ON approvals BEGIN SELECT RAISE(ABORT,'fixture failure'); END;");
  assert.throws(()=>mod.handleSyntheticControl(db,update('/approve qa-tg-01-v1'),at));assert.equal(getRecord(db,'telegram_review','qa-tg-01-v1').status,'PENDING');assert.equal(db.prepare("SELECT count(*) n FROM records WHERE kind='telegram_control_receipt'").get().n,0);
  db.exec('DROP TRIGGER fail_decision');mod.handleSyntheticControl(db,update('/approve qa-tg-01-v1'),at);db.close();
  const reopened=openStore(path);assert.equal(mod.handleSyntheticControl(reopened,update('/approve qa-tg-01-v1'),at).status,'DUPLICATE_UPDATE');assert.equal(reopened.prepare('SELECT count(*) n FROM approvals').get().n,1);reopened.close();
 });
 test('receipt failure after approval insertion rolls back decision, review and journal',()=>{
  const db=fixture(),before=db.prepare('SELECT count(*) n FROM journal').get().n;
  db.exec("CREATE TRIGGER fail_receipt BEFORE INSERT ON records WHEN NEW.kind='telegram_control_receipt' BEGIN SELECT RAISE(ABORT,'fixture receipt failure'); END;");
  assert.throws(()=>mod.handleSyntheticControl(db,update('/approve qa-tg-01-v1'),at));assert.equal(db.prepare('SELECT count(*) n FROM approvals').get().n,0);assert.equal(db.prepare('SELECT count(*) n FROM journal').get().n,before);assert.equal(getRecord(db,'telegram_review','qa-tg-01-v1').status,'PENDING');db.close();
 });
}
