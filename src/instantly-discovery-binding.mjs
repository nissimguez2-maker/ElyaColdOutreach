import {readFileSync,readdirSync,existsSync} from 'node:fs';
import {join,resolve,sep,isAbsolute} from 'node:path';
import {canonical,digest} from './values.mjs';
import {transaction} from './store.mjs';
import {armAcceptance,assertFreshAcceptance,verifyAcceptanceSources} from './acceptance-authority.mjs';
import {assertInstantlyQaDatabasePath,instantlyQaAuthorizationState} from './instantly-qa-readiness.mjs';
import {DISCOVERY_CAPTURE_ID,DISCOVERY_DIRECTORY,DISCOVERY_MANIFEST_HASH,validateDiscoveryManifest} from './instantly-discovery-profile.mjs';

const json=path=>JSON.parse(readFileSync(path,'utf8'));
const tables=['records','record_history','sources','controls','batches','approvals','budgets','operations','journal'];
const validationPath=`${DISCOVERY_DIRECTORY}/offline/validation.json`;
const fingerprint=(root,path)=>({path,sha256:digest(readFileSync(join(root,path)))});
const tree=(root,path)=>readdirSync(join(root,path),{withFileTypes:true}).flatMap(e=>e.isDirectory()?tree(root,`${path}/${e.name}`):/\.(mjs|sql)$/.test(e.name)?[`${path}/${e.name}`]:[]);

export function collectDiscoverySources(root){
 const paths=[...tree(root,'src'),...tree(root,'tests'),'package.json',`${DISCOVERY_DIRECTORY}/manifest.json`,`${DISCOVERY_DIRECTORY}/preparation.json`,`${DISCOVERY_DIRECTORY}/discovery-worker.mjs`,'work/connector-compatibility/owner.ps1','work/containment-proof/Job.cs'];
 if(existsSync(join(root,'package-lock.json')))paths.push('package-lock.json');
 return [...new Set(paths)].sort().map(path=>fingerprint(root,path));
}

// The operator entry calls this same current-state check immediately before its
// atomic claim. Readiness neither consumes the grant nor starts an execution timer.
export function checkDiscoveryReadiness({db,root,now=Date.now,manifestPath=join(root,DISCOVERY_DIRECTORY,'manifest.json')}){
 const databasePath=assertInstantlyQaDatabasePath(db,root),state=instantlyQaAuthorizationState(db,DISCOVERY_CAPTURE_ID);
 const errors={MISSING:'ACCEPTANCE_AUTHORIZATION_MISSING',CLAIMED:'ACCEPTANCE_AUTHORIZATION_CLAIMED',CLOSED:'ACCEPTANCE_AUTHORIZATION_CLOSED'};
 if(state.status!=='APPROVED')throw Error(errors[state.status]??'ACCEPTANCE_AUTHORIZATION_NOT_APPROVED');
 const manifest=validateDiscoveryManifest(json(manifestPath)),grant=assertFreshAcceptance(db,manifest,now());
 verifyAcceptanceSources(root,grant);
 if(existsSync(join(root,DISCOVERY_DIRECTORY,'live-once')))throw Error('DISCOVERY_DIRECTORY_EXISTS_NO_REPLAY');
 return {manifest,authorizationState:instantlyQaAuthorizationState(db,DISCOVERY_CAPTURE_ID),checkedAt:new Date(now()).toISOString(),databasePath,manifestPath:resolve(manifestPath),validity:'POINT_IN_TIME_RECHECK_REQUIRED_AT_LAUNCH'};
}

// Same acceptance lifecycle as v2. Importing this function never binds or runs it.
export function bindDiscoveryCapture({db,root,executionApproval,now=Date.now,atMs=now()}){
 if(executionApproval?.type!=='EXPLICIT_LIVE_EXECUTION_APPROVAL'||executionApproval.manifestHash!==DISCOVERY_MANIFEST_HASH||typeof executionApproval.reference!=='string'||!executionApproval.reference.trim()||!Number.isFinite(Date.parse(executionApproval.approvedAt))||Date.parse(executionApproval.approvedAt)>atMs)throw Error('EXPLICIT_EXECUTION_APPROVAL_REQUIRED');
 assertInstantlyQaDatabasePath(db,root);
 const manifest=validateDiscoveryManifest(json(join(root,DISCOVERY_DIRECTORY,'manifest.json'))),prepared=json(join(root,DISCOVERY_DIRECTORY,'preparation.json'));
 if(prepared.manifestHash!==DISCOVERY_MANIFEST_HASH)throw Error('DISCOVERY_PREPARATION_SCOPE_CHANGED');
 const validation=json(join(root,validationPath)),sources=collectDiscoverySources(root);
 if(validation.status!=='OFFLINE_VALIDATED'||validation.manifestHash!==DISCOVERY_MANIFEST_HASH||!Number.isSafeInteger(validation.passed)||validation.passed<1||validation.failed!==0||validation.cancelled!==0||validation.liveCalls!==0)throw Error('OFFLINE_BINDING_VALIDATION_REQUIRED');
 if(canonical(validation.sourceFingerprints)!==canonical(sources))throw Error('TESTED_SOURCE_FINGERPRINTS_CHANGED');
 const evidencePath=path=>{
  if(typeof path!=='string'||isAbsolute(path)||!resolve(root,path).startsWith(resolve(root,DISCOVERY_DIRECTORY,'offline')+sep))throw Error('OFFLINE_EVIDENCE_PATH_INVALID');
  return resolve(root,path);
 };
 if(digest(readFileSync(evidencePath(validation.logPath)))!==validation.logSha256)throw Error('OFFLINE_VALIDATION_EVIDENCE_CHANGED');
 if(!Array.isArray(validation.reviews)||validation.reviews.length<1||validation.reviews.some(r=>r.status!=='APPROVED'||digest(readFileSync(evidencePath(r.path)))!==r.sha256))throw Error('INDEPENDENT_REVIEW_REQUIRED');
 const sourceFingerprints=[...sources,fingerprint(root,validationPath),fingerprint(root,validation.logPath),...validation.reviews.map(r=>fingerprint(root,r.path))].sort((a,b)=>a.path.localeCompare(b.path));
 return transaction(db,()=>{
  if(canonical(Object.keys(prepared.tableHashes??{}).sort())!==canonical([...tables].sort()))throw Error('PREPARATION_BASELINE_TABLES_INVALID');
  for(const table of tables)if(digest(JSON.stringify(db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()))!==prepared.tableHashes[table])throw Error('PREPARATION_BASELINE_CHANGED');
  const grant=armAcceptance(db,manifest,sourceFingerprints,atMs,{executionApproval});
  const readiness=checkDiscoveryReadiness({db,root,now});
  return {authorizationId:grant.id,authorizationStatus:grant.status,manifestHash:grant.manifestHash,boundAt:grant.boundAt,expiresAt:grant.expiresAt,startedAt:grant.startedAt,deadlineAt:grant.deadlineAt,sourceFingerprintCount:sourceFingerprints.length,sourceFingerprintsHash:grant.authorizationBinding.sourceFingerprintsHash,readiness};
 });
}
