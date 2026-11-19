// Local, explicitly invoked maintenance. No timer, provider, telemetry or cloud
// destination is configured by importing this module.
import {readFileSync,writeFileSync,appendFileSync,mkdirSync,readdirSync,existsSync,statSync,lstatSync,unlinkSync,openSync,closeSync} from 'node:fs';
import {join,resolve,sep} from 'node:path';import {randomUUID} from 'node:crypto';
import {backupStore,restoreStore,openStore,transaction,putRecord,journal,controls} from './store.mjs';
import {assertSafe,canonical,digest,timestamp} from './values.mjs';

export const LOCAL_BACKUP_POLICY=Object.freeze({daily:7,weekly:4,maxSnapshotBytes:64*1024*1024,maxTotalBytes:512*1024*1024});
export const LOCAL_LOG_POLICY=Object.freeze({maxFileBytes:1024*1024,maxFiles:4});
const pattern=/^snapshot-(\d{13})-[a-f0-9-]{36}\.sqlite$/;
function localDirectory(root,relative){
 const base=resolve(root),path=resolve(base,relative);if(!path.startsWith(base+sep))throw Error('MAINTENANCE_PATH_INVALID');
 let current=base;for(const segment of relative.split('/').filter(Boolean)){current=join(current,segment);if(existsSync(current)&&lstatSync(current).isSymbolicLink())throw Error('MAINTENANCE_SYMLINK_DENIED');}
 mkdirSync(path,{recursive:true});return path;
}
function backupPolicy(policy){
 if(!policy||Object.keys(policy).sort().join()!=='daily,maxSnapshotBytes,maxTotalBytes,weekly'||!Number.isSafeInteger(policy.daily)||policy.daily<1||policy.daily>31||!Number.isSafeInteger(policy.weekly)||policy.weekly<1||policy.weekly>12||!Number.isSafeInteger(policy.maxSnapshotBytes)||policy.maxSnapshotBytes<4096||!Number.isSafeInteger(policy.maxTotalBytes)||policy.maxTotalBytes<policy.maxSnapshotBytes||policy.maxTotalBytes>1024*1024*1024)throw Error('LOCAL_BACKUP_POLICY_INVALID');return policy;
}
function dateKeys(at){
 const parts=Object.fromEntries(new Intl.DateTimeFormat('en-CA',{timeZone:'America/New_York',year:'numeric',month:'2-digit',day:'2-digit'}).formatToParts(new Date(at)).map(p=>[p.type,p.value]));
 const day=`${parts.year}-${parts.month}-${parts.day}`,date=new Date(day+'T00:00:00Z');date.setUTCDate(date.getUTCDate()-((date.getUTCDay()+6)%7));return {day,week:date.toISOString().slice(0,10)};
}
function snapshotFiles(directory){
 const entries=readdirSync(directory).filter(name=>name!=='.maintenance.lock');
 for(const name of entries)if(!pattern.test(name)&&!pattern.test(name.replace(/\.manifest\.json$/,'')))throw Error('UNMANAGED_BACKUP_ENTRY_REQUIRES_REVIEW');
 const snapshots=[];
 for(const name of entries.filter(name=>pattern.test(name))){
  const path=join(directory,name),manifestPath=path+'.manifest.json';
  if(lstatSync(path).isSymbolicLink()||!lstatSync(path).isFile()||!existsSync(manifestPath)||lstatSync(manifestPath).isSymbolicLink())throw Error('INCOMPLETE_OR_UNSAFE_BACKUP_REQUIRES_REVIEW');
  const manifest=JSON.parse(readFileSync(manifestPath,'utf8'));
  if(manifest.maintenanceProfile!=='LOCAL_SNAPSHOT_V1'||manifest.schemaVersion!==1||manifest.integrity!=='ok'||manifest.foreignKeyViolations!==0||digest(readFileSync(path))!==manifest.sha256)throw Error('MANAGED_BACKUP_VERIFICATION_FAILED');
  const at=Number(name.match(pattern)[1]);snapshots.push({name,path,manifestPath,at,bytes:statSync(path).size+statSync(manifestPath).size,...dateKeys(at)});
 }
 if(entries.filter(n=>n.endsWith('.manifest.json')).some(n=>!existsSync(join(directory,n.replace(/\.manifest\.json$/,'')))))throw Error('INCOMPLETE_BACKUP_REQUIRES_REVIEW');
 return snapshots.sort((a,b)=>b.at-a.at);
}
function rotation(snapshots,policy){
 const days=new Set(),weeks=new Set(),keep=new Set();for(const s of snapshots){if(!days.has(s.day)&&days.size<policy.daily){days.add(s.day);keep.add(s.path);}if(!weeks.has(s.week)&&weeks.size<policy.weekly){weeks.add(s.week);keep.add(s.path);}}
 const removed=[];for(const s of snapshots)if(!keep.has(s.path)){unlinkSync(s.path);unlinkSync(s.manifestPath);removed.push(s.name);}return removed;
}
export async function createManagedSnapshot(db,{root,at=new Date().toISOString(),policy=LOCAL_BACKUP_POLICY}={}){
 const atMs=timestamp(at);backupPolicy(policy);const directory=localDirectory(root,'data/local-snapshots'),lock=join(directory,'.maintenance.lock');let handle;
 try{handle=openSync(lock,'wx');}catch{throw Error('MAINTENANCE_ALREADY_RUNNING');}
 try{
  const snapshots=snapshotFiles(directory),today=snapshots.find(s=>s.day===dateKeys(atMs).day);
  if(today)return {status:'ALREADY_BACKED_UP_TODAY',path:today.path,restoreTest:'NOT_TESTED',externalCalls:0};
  const estimate=db.prepare('PRAGMA page_count').get().page_count*db.prepare('PRAGMA page_size').get().page_size;
  if(estimate>policy.maxSnapshotBytes)throw Error('SNAPSHOT_SIZE_CAP');
  // Reserve enough local disk headroom for a maximum-sized snapshot and manifest.
  // This is a retained-file bound, not an OS quota or a claim about peak writes.
  if(snapshots.reduce((n,s)=>n+s.bytes,0)+policy.maxSnapshotBytes+4096>policy.maxTotalBytes)throw Error('BACKUP_DISK_CAP_REQUIRES_REVIEW');
  const path=join(directory,`snapshot-${atMs}-${randomUUID()}.sqlite`),manifest=await backupStore(db,path);
  if(statSync(path).size>policy.maxSnapshotBytes){unlinkSync(path);unlinkSync(path+'.manifest.json');throw Error('SNAPSHOT_SIZE_CAP');}
  writeFileSync(path+'.manifest.json',JSON.stringify({...manifest,maintenanceProfile:'LOCAL_SNAPSHOT_V1',scheduledAt:at,timeZone:'America/New_York'},null,2),{flush:true});
  const removed=rotation(snapshotFiles(directory),policy),retained=snapshotFiles(directory);
  return {status:'BACKUP_VERIFIED',path,sha256:manifest.sha256,createdAt:manifest.createdAt,restoreTest:'NOT_TESTED',retainedSnapshots:retained.length,retainedBytes:retained.reduce((n,s)=>n+s.bytes,0),removed,policy:{...policy},externalCalls:0};
 }finally{closeSync(handle);unlinkSync(lock);}
}

export async function testManagedRestore(options={}){
 const directory=localDirectory(options.root,'data/local-snapshots'),lock=join(directory,'.maintenance.lock');let handle;
 try{handle=openSync(lock,'wx');}catch{throw Error('MAINTENANCE_ALREADY_RUNNING');}
 try{return await restoreManagedSnapshot(options);}finally{closeSync(handle);unlinkSync(lock);}
}
async function restoreManagedSnapshot({root,snapshotPath,at=new Date().toISOString()}={}){
 timestamp(at);const managed=localDirectory(root,'data/local-snapshots'),snapshot=snapshotFiles(managed).find(s=>resolve(s.path)===resolve(snapshotPath??''));
 if(!snapshot)throw Error('MANAGED_SNAPSHOT_REQUIRED');
 const directory=localDirectory(root,'data/restore-tests');
 // Retained inspection copies are never promoted or silently replaced. Once the
 // small local cap is reached, an operator reviews/removes those copies explicitly.
 if(statSync(snapshot.path).size>64*1024*1024||readdirSync(directory).filter(n=>/^restore-[a-f0-9-]{36}\.sqlite$/.test(n)).length>=3)throw Error('RESTORE_TEST_STORAGE_CAP_REQUIRES_REVIEW');
 const path=join(directory,`restore-${randomUUID()}.sqlite`);await restoreStore(snapshot.path,path);
 const restored=openStore(path);
 try{
  transaction(restored,()=>{
   // This copy is for inspection only. Old technical grants and business approvals
   // must not become executable because a historical database was restored.
   for(const row of restored.prepare("SELECT kind,id,data_json FROM records WHERE kind LIKE '%authorization%' OR kind='diagnostic_exception' OR kind='workflow_schedule' OR (kind='settings' AND id='workflow-runtime')").all()){
    const value=JSON.parse(row.data_json);putRecord(restored,row.kind,row.id,{...value,status:'CLOSED',authorizationStatus:'CLOSED',enabled:false,generalDispatchEnabled:false,businessLaunchAuthorized:false,closedAt:at,reason:'ISOLATED_RESTORE_TEST_NOT_AUTHORITY'},'configuration');
   }
   restored.prepare("UPDATE approvals SET decision='REVOKED',reason='Isolated restore test; fresh authority required' WHERE decision='APPROVED'").run();
   for(const row of restored.prepare("SELECT id,data_json FROM records WHERE kind='writing_decision'").all()){
    const value=JSON.parse(row.data_json);if(value.decision==='APPROVED')putRecord(restored,'writing_decision',row.id,{...value,decision:'INVALIDATED',reason:'Isolated restore test; fresh authority required'},'assessment');
   }
   restored.prepare("UPDATE operations SET status='RECONCILIATION',updated_at=? WHERE status IN ('PREPARED','DISPATCHING')").run(at);
   putRecord(restored,'settings','restore-quarantine',{inspectionOnly:true,promotable:false,requiresCurrentSuppressionAndStopReconciliation:true,sourceHash:JSON.parse(readFileSync(snapshot.manifestPath)).sha256},'configuration');
   journal(restored,'ISOLATED_RESTORE_QUARANTINED','system',{sourceHash:JSON.parse(readFileSync(snapshot.manifestPath)).sha256});
  });
  if(!controls(restored).stopped||controls(restored).launchAuthorized||restored.prepare('PRAGMA integrity_check').get().integrity_check!=='ok'||restored.prepare('PRAGMA foreign_key_check').all().length)throw Error('RESTORE_TEST_FAILED');
  const result={status:'RESTORE_TEST_PASSED',path,sourcePath:snapshot.path,at,promoted:false,stopped:true,launchAuthorized:false,newerStateReconciled:false,requiresCurrentSuppressionAndStopReconciliation:true,externalCalls:0};
  writeFileSync(path+'.result.json',JSON.stringify(result,null,2),{flag:'wx',flush:true});return result;
 }finally{restored.close();}
}

export function appendOperationalLog(root,event,{policy=LOCAL_LOG_POLICY}={}){
 if(!policy||Object.keys(policy).sort().join()!=='maxFileBytes,maxFiles'||!Number.isSafeInteger(policy.maxFileBytes)||policy.maxFileBytes<128||policy.maxFileBytes>16*1024*1024||!Number.isSafeInteger(policy.maxFiles)||policy.maxFiles<1||policy.maxFiles>10)throw Error('LOCAL_LOG_POLICY_INVALID');
 assertSafe(event);const line=canonical(event)+'\n';if(Buffer.byteLength(line)>policy.maxFileBytes)throw Error('LOG_EVENT_SIZE_CAP');
 const directory=localDirectory(root,'data/operational-logs'),path=join(directory,'operations-0.jsonl'),lock=join(directory,'.append.lock');let handle;
 try{handle=openSync(lock,'wx');}catch{throw Error('OPERATIONAL_LOG_WRITER_BUSY');}
 try{
 for(const name of readdirSync(directory).filter(n=>n!=='.append.lock')){if(!/^operations-[0-9]\.jsonl$/.test(name)||lstatSync(join(directory,name)).isSymbolicLink())throw Error('UNMANAGED_LOG_ENTRY_REQUIRES_REVIEW');if(Number(name.match(/\d/)[0])>=policy.maxFiles||statSync(join(directory,name)).size>policy.maxFileBytes)throw Error('LOG_STORAGE_CAP_REQUIRES_REVIEW');}
 if(existsSync(path)&&statSync(path).size+Buffer.byteLength(line)>policy.maxFileBytes){
  // Copy bounded generations, then truncate current. An interrupted rotation can
  // duplicate a diagnostic line; it cannot replay a business action.
  for(let n=policy.maxFiles-2;n>=0;n--){const from=join(directory,`operations-${n}.jsonl`);if(existsSync(from))writeFileSync(join(directory,`operations-${n+1}.jsonl`),readFileSync(from),{flush:true});}
  writeFileSync(path,'',{flush:true});
 }
 appendFileSync(path,line,{flush:true});return {written:true,path,externalCalls:0};
 }finally{closeSync(handle);unlinkSync(lock);}
}
