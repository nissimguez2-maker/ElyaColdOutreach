import {readFileSync,readdirSync,existsSync} from 'node:fs';
import {join,resolve,sep,isAbsolute} from 'node:path';
import {canonical,digest} from './values.mjs';
import {transaction} from './store.mjs';
import {armAcceptance} from './acceptance-authority.mjs';
import {assertInstantlyQaDatabasePath,checkInstantlyQaReadiness} from './instantly-qa-readiness.mjs';
import {INSTANTLY_QA_V2_ID,INSTANTLY_QA_V2_MANIFEST_HASH,validateInstantlyQaManifest} from './instantly-qa-contract.mjs';

const directory='work/instantly-qa-acceptance-v2';
const validationPath='work/instantly-qa-v2-offline/offline-validation.json';
const tables=['records','record_history','sources','controls','batches','approvals','budgets','operations','journal'];
const json=path=>JSON.parse(readFileSync(path,'utf8'));
function fingerprint(root,path){return {path,sha256:digest(readFileSync(join(root,path)))};}
function tree(root,path){return readdirSync(join(root,path),{withFileTypes:true}).flatMap(entry=>entry.isDirectory()?tree(root,`${path}/${entry.name}`):/\.(mjs|sql)$/.test(entry.name)?[`${path}/${entry.name}`]:[]);}

// Only project code and explicitly named, non-secret evidence. Never inspect
// credentials, environment values or the user's merged Codex configuration.
export function collectInstantlyQaV2Sources(root){
 const manifest=validateInstantlyQaManifest(json(join(root,directory,'manifest.json')));
 const paths=[...tree(root,'src'),...tree(root,'tests'),'package.json',
  `${directory}/manifest.json`,`${directory}/approval-review.md`,`${directory}/preparation.json`,`${directory}/instantly-worker.mjs`,
  manifest.contracts.baselineSource,manifest.priorEvidence.resultPath,'work/acceptance-continuation-v1/manifest.json',
  'work/instantly-capability-inspection.json','work/connector-compatibility/owner.ps1','work/containment-proof/Job.cs'];
 if(existsSync(join(root,'package-lock.json')))paths.push('package-lock.json');
 return [...new Set(paths)].sort().map(path=>fingerprint(root,path));
}

// Function only: importing this module cannot bind or launch anything. A future
// explicit live approval is required separately from permission to edit/test it.
export function bindInstantlyQaV2({db,root,executionApproval,now=Date.now,atMs=now()}){
 if(executionApproval?.type!=='EXPLICIT_LIVE_EXECUTION_APPROVAL'||executionApproval.manifestHash!==INSTANTLY_QA_V2_MANIFEST_HASH||typeof executionApproval.reference!=='string'||!executionApproval.reference.trim()||!Number.isFinite(Date.parse(executionApproval.approvedAt))||Date.parse(executionApproval.approvedAt)>atMs)throw Error('EXPLICIT_EXECUTION_APPROVAL_REQUIRED');
 assertInstantlyQaDatabasePath(db,root);
 const manifest=validateInstantlyQaManifest(json(join(root,directory,'manifest.json'))),prepared=json(join(root,directory,'preparation.json'));
 if(manifest.id!==INSTANTLY_QA_V2_ID||prepared.manifestHash!==INSTANTLY_QA_V2_MANIFEST_HASH||prepared.manifestFileSha256!==digest(readFileSync(join(root,directory,'manifest.json')))||prepared.reviewSha256!==digest(readFileSync(join(root,directory,'approval-review.md'))))throw Error('APPROVED_SCOPE_FILES_CHANGED');
 if(digest(readFileSync(join(root,manifest.contracts.baselineSource)))!==manifest.contracts.baselineSourceSha256||digest(readFileSync(join(root,manifest.priorEvidence.resultPath)))!==manifest.priorEvidence.resultFileSha256)throw Error('APPROVED_BASELINE_EVIDENCE_CHANGED');
 const validation=json(join(root,validationPath)),sources=collectInstantlyQaV2Sources(root);
 if(validation.status!=='OFFLINE_VALIDATED'||validation.manifestHash!==INSTANTLY_QA_V2_MANIFEST_HASH||!Number.isSafeInteger(validation.passed)||validation.passed<1||validation.failed!==0||validation.cancelled!==0||validation.liveCalls!==0)throw Error('OFFLINE_BINDING_VALIDATION_REQUIRED');
 if(canonical(validation.sourceFingerprints)!==canonical(sources))throw Error('TESTED_SOURCE_FINGERPRINTS_CHANGED');
 const logPath=typeof validation.logPath==='string'?resolve(root,validation.logPath):'';
 if(!logPath.startsWith(resolve(root,'work/instantly-qa-v2-offline')+sep)||isAbsolute(validation.logPath)||digest(readFileSync(logPath))!==validation.logSha256)throw Error('OFFLINE_VALIDATION_EVIDENCE_CHANGED');
 const sourceFingerprints=[...sources,fingerprint(root,validationPath),fingerprint(root,validation.logPath)].sort((a,b)=>a.path.localeCompare(b.path));
 return transaction(db,()=>{
  if(canonical(Object.keys(prepared.tableHashes??{}).sort())!==canonical([...tables].sort()))throw Error('PREPARATION_BASELINE_TABLES_INVALID');
  for(const table of tables)if(digest(JSON.stringify(db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()))!==prepared.tableHashes[table])throw Error('PREPARATION_BASELINE_CHANGED');
  const grant=armAcceptance(db,manifest,sourceFingerprints,atMs,{executionApproval});
  const readiness=checkInstantlyQaReadiness({db,root,authorizationId:INSTANTLY_QA_V2_ID,now});
  return {authorizationId:grant.id,authorizationStatus:grant.status,manifestHash:grant.manifestHash,boundAt:grant.boundAt,expiresAt:grant.expiresAt,startedAt:grant.startedAt,deadlineAt:grant.deadlineAt,sourceFingerprintCount:sourceFingerprints.length,sourceFingerprintsHash:grant.authorizationBinding.sourceFingerprintsHash,readiness};
 });
}
