import test from 'node:test';import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';import {mkdtempSync,mkdirSync,readFileSync,writeFileSync,readdirSync,existsSync,statSync} from 'node:fs';import {join,resolve} from 'node:path';import {tmpdir} from 'node:os';
import {openStore,putRecord,getRecord,controls,backupStore} from '../src/store.mjs';import {blockNetwork} from './helpers/network-block.mjs';
import {createBudget,reserveOperation,beginOperation,recordOutcome,operation} from '../src/operations.mjs';
const module=()=>import('../src/local-maintenance.mjs').catch(()=>null);
function fixture(t){const network=blockNetwork(t),root=mkdtempSync(join(tmpdir(),'elya-maintenance-')),db=openStore(join(root,'data/elya.sqlite'));t.after(()=>db.close());return {root,db,network};}
test('backup success requires SQLite integrity, schema and foreign-key checks before manifest',async t=>{
 const f=fixture(t),path=join(f.root,'bad.sqlite');f.db.exec("PRAGMA foreign_keys=OFF;INSERT INTO records VALUES('fixture','bad','{}','confirmed','missing',NULL,'2026-11-18T00:00:00Z')");
 await assert.rejects(backupStore(f.db,path),/integrity|foreign key/i);assert.equal(existsSync(path+'.manifest.json'),false);
});
test('managed backup captures committed WAL data, retains source state, and records checked integrity',async t=>{
 const f=fixture(t),api=await module();assert.equal(typeof api?.createManagedSnapshot,'function');
 putRecord(f.db,'fixture','wal',{seen:true});const before=controls(f.db),result=await api.createManagedSnapshot(f.db,{root:f.root,at:'2026-11-18T12:00:00Z'});
 assert.equal(result.status,'BACKUP_VERIFIED');assert.equal(result.restoreTest,'NOT_TESTED');assert.deepEqual(controls(f.db),before);
 const snapshot=new DatabaseSync(result.path,{readOnly:true});assert.deepEqual(getRecord(snapshot,'fixture','wal'),{seen:true});snapshot.close();
 const manifest=JSON.parse(readFileSync(result.path+'.manifest.json'));assert.equal(manifest.integrity,'ok');assert.equal(manifest.foreignKeyViolations,0);assert.equal(f.network.attempts,0);
 const again=await api.createManagedSnapshot(f.db,{root:f.root,at:'2026-11-18T18:00:00Z'});assert.equal(again.status,'ALREADY_BACKED_UP_TODAY');assert.equal(again.path,result.path);
});
test('managed retention keeps bounded daily/weekly snapshots and never rotates immutable evidence',async t=>{
 const f=fixture(t),api=await module();assert.equal(typeof api?.createManagedSnapshot,'function');const evidence=join(f.root,'work/original.json');mkdirSync(join(f.root,'work'));writeFileSync(evidence,'preserve');
 const policy={daily:2,weekly:2,maxSnapshotBytes:1024*1024,maxTotalBytes:16*1024*1024};
 for(const day of ['2026-10-28','2026-11-04','2026-11-11','2026-11-17','2026-11-18'])await api.createManagedSnapshot(f.db,{root:f.root,at:day+'T12:00:00Z',policy});
 const dir=join(f.root,'data/local-snapshots'),files=readdirSync(dir).filter(x=>x.endsWith('.sqlite'));assert.ok(files.length<=4);assert.ok(files.length>=2);assert.equal(readFileSync(evidence,'utf8'),'preserve');
 assert.ok(files.every(x=>x.startsWith('snapshot-')));assert.equal(f.network.attempts,0);
});
test('disk cap and existing owner refuse before creating a snapshot',async t=>{
 const f=fixture(t),api=await module();assert.equal(typeof api?.createManagedSnapshot,'function');
 await assert.rejects(api.createManagedSnapshot(f.db,{root:f.root,at:'2026-11-18T12:00:00Z',policy:{daily:1,weekly:1,maxSnapshotBytes:4096,maxTotalBytes:8192}}),/SNAPSHOT_SIZE_CAP/);
 const dir=join(f.root,'data/local-snapshots');mkdirSync(dir,{recursive:true});writeFileSync(join(dir,'.maintenance.lock'),'held');
 await assert.rejects(api.createManagedSnapshot(f.db,{root:f.root,at:'2026-11-18T12:00:00Z'}),/MAINTENANCE_ALREADY_RUNNING/);assert.equal(readFileSync(join(dir,'.maintenance.lock'),'utf8'),'held');
 assert.equal(readdirSync(dir).filter(x=>x.endsWith('.sqlite')).length,0);
});
test('restore test is isolated, stopped, unauthorized and preserves snapshot suppression without rolling current state back',async t=>{
 const f=fixture(t),api=await module();assert.equal(typeof api?.testManagedRestore,'function');
 putRecord(f.db,'contact','old@example.invalid',{suppressed:true});putRecord(f.db,'acceptance_authorization','test-approved',{status:'APPROVED'});putRecord(f.db,'telegram_inspection_authorization','test-active',{authorizationStatus:'CLAIMED'});
 const snapshot=await api.createManagedSnapshot(f.db,{root:f.root,at:'2026-11-18T12:00:00Z'});putRecord(f.db,'contact','new@example.invalid',{suppressed:true});
 const before=f.db.prepare('SELECT * FROM records ORDER BY kind,id').all(),result=await api.testManagedRestore({root:f.root,snapshotPath:snapshot.path,at:'2026-11-18T12:01:00Z'});
 assert.equal(result.status,'RESTORE_TEST_PASSED');assert.equal(result.promoted,false);assert.notEqual(resolve(result.path),resolve(f.root,'data/elya.sqlite'));
 const restored=new DatabaseSync(result.path,{readOnly:true});assert.equal(controls(restored).stopped,true);assert.equal(controls(restored).launchAuthorized,false);assert.equal(getRecord(restored,'acceptance_authorization','test-approved').status,'CLOSED');assert.equal(getRecord(restored,'telegram_inspection_authorization','test-active').authorizationStatus,'CLOSED');assert.equal(getRecord(restored,'contact','old@example.invalid').suppressed,true);restored.close();
 assert.deepEqual(f.db.prepare('SELECT * FROM records ORDER BY kind,id').all(),before);assert.equal(getRecord(f.db,'contact','new@example.invalid').suppressed,true);assert.equal(f.network.attempts,0);
 await assert.rejects(api.testManagedRestore({root:f.root,snapshotPath:join(f.root,'data/elya.sqlite'),at:'2026-11-18T12:01:00Z'}),/MANAGED_SNAPSHOT_REQUIRED/);
});
test('restore inspection copies and logger ownership remain bounded without stealing or replay',async t=>{
 const f=fixture(t),api=await module(),snapshot=await api.createManagedSnapshot(f.db,{root:f.root,at:'2026-11-18T12:00:00Z'});
 for(let i=0;i<3;i++)await api.testManagedRestore({root:f.root,snapshotPath:snapshot.path});
 await assert.rejects(api.testManagedRestore({root:f.root,snapshotPath:snapshot.path}),/RESTORE_TEST_STORAGE_CAP/);
 const dir=join(f.root,'data/operational-logs');mkdirSync(dir,{recursive:true});writeFileSync(join(dir,'.append.lock'),'held');
 assert.throws(()=>api.appendOperationalLog(f.root,{event:'WAIT'}),/WRITER_BUSY/);assert.equal(readFileSync(join(dir,'.append.lock'),'utf8'),'held');
});
test('isolated restore invalidates approved writing decisions without changing source approvals or rejected history',async t=>{
 const f=fixture(t),api=await module();
 const approved={reviewId:'fixture-review',packetHash:'fixture-packet',decision:'APPROVED',reason:'Fixture content decision'},rejected={reviewId:'other-fixture',decision:'REJECTED',reason:'Fixture rejection'};
 putRecord(f.db,'writing_decision','approved',approved,'assessment');putRecord(f.db,'writing_decision','rejected',rejected,'assessment');
 const snapshot=await api.createManagedSnapshot(f.db,{root:f.root,at:'2026-11-18T12:00:00Z'}),result=await api.testManagedRestore({root:f.root,snapshotPath:snapshot.path});
 const restored=new DatabaseSync(result.path,{readOnly:true});try{
  assert.deepEqual(getRecord(restored,'writing_decision','approved'),{...approved,decision:'INVALIDATED',reason:'Isolated restore test; fresh authority required'});
  assert.deepEqual(getRecord(restored,'writing_decision','rejected'),rejected);
 }finally{restored.close();}
 assert.deepEqual(getRecord(f.db,'writing_decision','approved'),approved);assert.deepEqual(getRecord(f.db,'writing_decision','rejected'),rejected);assert.equal(f.network.attempts,0);
});
test('concurrent restore checks share backup ownership and cannot race retention or storage admission',async t=>{
 const f=fixture(t),api=await module(),snapshot=await api.createManagedSnapshot(f.db,{root:f.root,at:'2026-11-18T12:00:00Z'});
 const results=await Promise.allSettled([api.testManagedRestore({root:f.root,snapshotPath:snapshot.path}),api.testManagedRestore({root:f.root,snapshotPath:snapshot.path})]);
 assert.equal(results.filter(x=>x.status==='fulfilled').length,1);assert.equal(results.filter(x=>x.status==='rejected'&&x.reason.message==='MAINTENANCE_ALREADY_RUNNING').length,1);
});
test('restored operation uncertainty and reservations persist; old prepared work cannot dispatch blindly',async t=>{
 const f=fixture(t),api=await module();createBudget(f.db,'fixture-budget','1','0','0');
 for(const [id,reservation]of [['unknown','0.15'],['prepared','0.05']])reserveOperation(f.db,{id,kind:'COLLECT',budgetId:'fixture-budget',reservation,authorizationRef:'offline fixture only',payload:{key:id}});
 beginOperation(f.db,'unknown');recordOutcome(f.db,'unknown',{status:'AMBIGUOUS',actual:null,remoteId:'synthetic-provider-operation',evidence:'Offline ambiguous fixture'});
 const snapshot=await api.createManagedSnapshot(f.db,{root:f.root,at:'2026-11-18T12:00:00Z'}),result=await api.testManagedRestore({root:f.root,snapshotPath:snapshot.path});
 const restored=openStore(result.path);try{
  assert.equal(operation(restored,'unknown').status,'RECONCILIATION');assert.equal(operation(restored,'unknown').reservation_usd,'0.15');assert.equal(operation(restored,'unknown').remote_id,'synthetic-provider-operation');assert.equal(operation(restored,'unknown').actual_usd,null);
  assert.equal(operation(restored,'prepared').status,'RECONCILIATION');assert.equal(operation(restored,'prepared').reservation_usd,'0.05');assert.throws(()=>beginOperation(restored,'prepared'),/reconciliation|state/i);
 }finally{restored.close();}
 assert.equal(operation(f.db,'prepared').status,'PREPARED');assert.equal(f.network.attempts,0);
});
test('operational logs are bounded, secret-checked and do not touch evidence files',async t=>{
 const f=fixture(t),api=await module();assert.equal(typeof api?.appendOperationalLog,'function');const policy={maxFileBytes:200,maxFiles:3};
 for(let i=0;i<30;i++)api.appendOperationalLog(f.root,{event:'OFFLINE_FIXTURE',stage:'test',elapsedMs:i},{policy});
 const dir=join(f.root,'data/operational-logs'),files=readdirSync(dir);assert.ok(files.length<=3);assert.ok(files.every(x=>statSync(join(dir,x)).size<=200));
 assert.throws(()=>api.appendOperationalLog(f.root,{event:'TOKEN',token:'Bearer fixture-secret'},{policy}),/Credential|Secret/);
 assert.throws(()=>api.appendOperationalLog(f.root,{event:'TOO_LARGE',text:'x'.repeat(500)},{policy}),/LOG_EVENT_SIZE_CAP/);assert.equal(f.network.attempts,0);
});
