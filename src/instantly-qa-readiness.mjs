import {readFileSync,existsSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {getRecord} from './store.mjs';
import {assertFreshAcceptance,verifyAcceptanceSources} from './acceptance-authority.mjs';
import {INSTANTLY_QA_ID,instantlyQaRelativeDirectory,validateInstantlyQaManifest} from './instantly-qa-contract.mjs';

// Lifecycle evidence only; never include the grant's record snapshots or secrets.
export function instantlyQaAuthorizationState(db,authorizationId=INSTANTLY_QA_ID){
 const grant=getRecord(db,'acceptance_authorization',authorizationId);
 return {id:authorizationId,status:grant?.status??'MISSING',approvedAt:grant?.approvedAt??null,boundAt:grant?.boundAt??null,expiresAt:grant?.expiresAt??null,
  startedAt:grant?.startedAt??null,deadlineAt:grant?.deadlineAt??null,closedAt:grant?.closedAt??null,
  manifestHash:grant?.manifestHash??null,previousReason:grant?.reason??null};
}

// A point-in-time read, not an arming operation or a durable promise of readiness.
// The CLI uses this same check and then atomically rechecks/claims in the controller.
export function assertInstantlyQaDatabasePath(db,root){
 const databasePath=db.prepare('PRAGMA database_list').all().find(row=>row.name==='main')?.file??'';
 const expectedDatabasePath=resolve(root,'data/elya.sqlite');
 const normalized=value=>process.platform==='win32'?resolve(value).toLowerCase():resolve(value);
 if(databasePath&&normalized(databasePath)!==normalized(expectedDatabasePath))throw Error('INSTANTLY_QA_DATABASE_PATH_MISMATCH');
 return databasePath||':memory:';
}

export function checkInstantlyQaReadiness({db,root,authorizationId=INSTANTLY_QA_ID,now=Date.now,manifestPath=join(root,instantlyQaRelativeDirectory(authorizationId),'manifest.json')}){
 const databasePath=assertInstantlyQaDatabasePath(db,root);
 // Check lifecycle before manifest I/O so a spent authorization is explicit even
 // if the approved files have subsequently changed or become unavailable.
 const state=instantlyQaAuthorizationState(db,authorizationId);
 const statusErrors={MISSING:'ACCEPTANCE_AUTHORIZATION_MISSING',CLOSED:'ACCEPTANCE_AUTHORIZATION_CLOSED',CLAIMED:'ACCEPTANCE_AUTHORIZATION_CLAIMED'};
 if(state.status!=='APPROVED')throw Error(statusErrors[state.status]??'ACCEPTANCE_AUTHORIZATION_NOT_APPROVED');
 const manifest=validateInstantlyQaManifest(JSON.parse(readFileSync(manifestPath,'utf8')));
 if(manifest.id!==authorizationId)throw Error('INSTANTLY_QA_MANIFEST_MISMATCH');
 const grant=assertFreshAcceptance(db,manifest,now());
 verifyAcceptanceSources(root,grant);
 if(existsSync(join(root,instantlyQaRelativeDirectory(authorizationId),'live-once')))throw Error('INSTANTLY_QA_DIRECTORY_EXISTS_NO_REPLAY');
 return {manifest,authorizationState:instantlyQaAuthorizationState(db,authorizationId),checkedAt:new Date(now()).toISOString(),databasePath,manifestPath:resolve(manifestPath),validity:'POINT_IN_TIME_RECHECK_REQUIRED_AT_LAUNCH'};
}
