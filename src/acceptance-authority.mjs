import { readFileSync } from 'node:fs';
import { resolve, sep, isAbsolute } from 'node:path';
import { canonical, digest } from './values.mjs';
import { controls, getRecord, putRecord, journal, transaction } from './store.mjs';
import { CONTINUATION_ID, validateContinuationManifest } from './acceptance-continuation-contract.mjs';
import { INSTANTLY_QA_ID, INSTANTLY_QA_V2_ID, isInstantlyQaId, validateInstantlyQaManifest } from './instantly-qa-contract.mjs';
import {DISCOVERY_CAPTURE_ID,DISCOVERY_DIRECTORY,validateDiscoveryManifest} from './instantly-discovery-profile.mjs';
import {INACTIVE_SETUP_ID,INACTIVE_SETUP_SOURCES,validateInactiveSetupManifest,INACTIVE_LEAD_COPY_ID,INACTIVE_LEAD_COPY_V2_ID,isInactiveLeadCopyId,INACTIVE_LEAD_COPY_SOURCES,validateInactiveLeadCopyManifest} from './instantly-pilot-scope.mjs';
import {INTERNAL_PILOT_ID,INTERNAL_PILOT_SOURCES,validateInternalPilotManifest} from './instantly-internal-pilot.mjs';

export const ACCEPTANCE_ID = 'elya-acceptance-manifest-v1';
const immutableTables = ['sources', 'batches', 'approvals', 'budgets', 'operations'];
const mutableOriginalRecords = new Set(['telegram_consumer_owner:primary', 'telegram_writing_cursor:primary']);
const hashRow = row => digest(JSON.stringify(row));
const manifestHash = manifest => digest(canonical(manifest));
const iso = value => new Date(value).toISOString();
const operatorBound=id=>id===INSTANTLY_QA_V2_ID||id===DISCOVERY_CAPTURE_ID;
const inactivePilot=id=>id===INACTIVE_SETUP_ID||isInactiveLeadCopyId(id);
// Direct-plugin setup shares the bounded one-use lifecycle, not a CLI entry.
const boundedGrant=id=>operatorBound(id)||inactivePilot(id)||id===INTERNAL_PILOT_ID;

function scope(manifest) {
  if(manifest?.id===INTERNAL_PILOT_ID){validateInternalPilotManifest(manifest);return {id:manifest.id,totalMs:null,historicalPrefixRetirementApproved:false};}
  if(isInactiveLeadCopyId(manifest?.id)){validateInactiveLeadCopyManifest(manifest);return {id:manifest.id,totalMs:120000,historicalPrefixRetirementApproved:false};}
  if(manifest?.id===INACTIVE_SETUP_ID){validateInactiveSetupManifest(manifest);return {id:manifest.id,totalMs:60000,historicalPrefixRetirementApproved:false};}
  if(manifest?.id===DISCOVERY_CAPTURE_ID){validateDiscoveryManifest(manifest);return {id:manifest.id,totalMs:60000,historicalPrefixRetirementApproved:false};}
  if (isInstantlyQaId(manifest?.id)) {
    validateInstantlyQaManifest(manifest);
    return { id: manifest.id, totalMs: 150000, historicalPrefixRetirementApproved: false };
  }
  if (manifest?.id === CONTINUATION_ID) {
    validateContinuationManifest(manifest);
    return { id: CONTINUATION_ID, totalMs: 480000, historicalPrefixRetirementApproved: false };
  }
  if (manifest?.id !== ACCEPTANCE_ID || manifest.limits?.sessionTotalMs !== 1800000) throw Error('ACCEPTANCE_MANIFEST_UNSUPPORTED');
  return { id: ACCEPTANCE_ID, totalMs: 1800000, historicalPrefixRetirementApproved: true };
}

function snapshot(db, preserveAllRecords = false) {
  return {
    rows: db.prepare('SELECT * FROM records ORDER BY kind,id').all()
      .filter(row => preserveAllRecords || !mutableOriginalRecords.has(`${row.kind}:${row.id}`))
      .map(row => ({ kind: row.kind, id: row.id, hash: hashRow(row) })),
    tables: Object.fromEntries(immutableTables.map(table => [table, digest(JSON.stringify(db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()))])),
    controls: controls(db),
  };
}

function assertProtected(db, grant) {
  const current = controls(db);
  if (!current.stopped || current.launchAuthorized || canonical(current) !== canonical(grant.protectedState.controls)) throw Error('ACCEPTANCE_CONTROLS_CHANGED');
  for (const row of grant.protectedState.rows) {
    const currentRow = db.prepare('SELECT * FROM records WHERE kind=? AND id=?').get(row.kind, row.id);
    if (!currentRow || hashRow(currentRow) !== row.hash) throw Error('ACCEPTANCE_PROTECTED_STATE_CHANGED');
  }
  for (const [table, hash] of Object.entries(grant.protectedState.tables)) {
    if (!immutableTables.includes(table) || digest(JSON.stringify(db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all())) !== hash) throw Error('ACCEPTANCE_PROTECTED_STATE_CHANGED');
  }
}

function v2Binding(manifest, sources) {
  if(manifest.id===INTERNAL_PILOT_ID)return {profileHash:manifestHash(manifest),callSequenceHash:digest(canonical(manifest.calls)),sourceFingerprintsHash:digest(canonical(sources))};
  if(inactivePilot(manifest.id))return {profileHash:manifestHash(manifest),callSequenceHash:digest(canonical(manifest.calls)),sourceFingerprintsHash:digest(canonical(sources))};
  if(manifest.id===DISCOVERY_CAPTURE_ID)return {selectedContractsHash:digest(canonical(manifest.targets)),profileHash:manifestHash(manifest),sourceFingerprintsHash:digest(canonical(sources))};
  return {contractBaselineSha256:manifest.contracts.baselineSourceSha256, contractPinsHash:digest(canonical(manifest.contracts.approvedContracts)), callSequenceHash:digest(canonical(manifest.calls)), writeArgumentsHash:digest(canonical(manifest.instantly.writeArguments)), sourceFingerprintsHash:digest(canonical(sources))};
}
function assertV2Binding(grant, manifest, atMs, fresh) {
  const bound=Date.parse(grant.boundAt),expires=Date.parse(grant.expiresAt);
  if (!Number.isSafeInteger(atMs)||!Number.isFinite(bound)||!Number.isFinite(expires)||grant.boundAt!==grant.approvedAt||expires-bound!==86400000||atMs<bound) throw Error('ACCEPTANCE_VALIDITY_TIME_INVALID');
  if(atMs>=expires)throw Error('ACCEPTANCE_VALIDITY_EXPIRED');
  if(fresh&&expires-atMs<150000)throw Error('ACCEPTANCE_VALIDITY_INSUFFICIENT');
  if(canonical(grant.authorizationBinding??null)!==canonical(v2Binding(manifest,grant.sourceFingerprints)))throw Error('ACCEPTANCE_BINDING_MISMATCH');
  const approval=grant.executionApproval;
  if(approval?.type!=='EXPLICIT_LIVE_EXECUTION_APPROVAL'||approval.manifestHash!==manifestHash(manifest)||typeof approval.reference!=='string'||!approval.reference.trim()||typeof approval.approvedAt!=='string'||!Number.isFinite(Date.parse(approval.approvedAt))||Date.parse(approval.approvedAt)>bound)throw Error('EXPLICIT_EXECUTION_APPROVAL_REQUIRED');
}

export function armAcceptance(db, manifest, sourceFingerprints, atMs = Date.now(), options = {}) {
  const arm = () => {
    const approvedScope = scope(manifest), id = approvedScope.id;
    if (getRecord(db, 'acceptance_authorization', id)) throw Error('ACCEPTANCE_AUTHORIZATION_ALREADY_EXISTS');
    if(id===INTERNAL_PILOT_ID&&['elya-internal-send-pilot-v1','elya-internal-send-pilot-v2'].some(previous=>getRecord(db,'acceptance_authorization',previous)?.status!=='CLOSED'||getRecord(db,'acceptance_result',previous)?.authorizationStatus!=='CLOSED'))throw Error('INTERNAL_PILOT_PRIOR_CLOSED_AUTHORIZATION_REQUIRED');
    if(isInactiveLeadCopyId(id)){
      if(id===INACTIVE_LEAD_COPY_V2_ID&&getRecord(db,'acceptance_authorization',INACTIVE_LEAD_COPY_ID)?.status!=='CLOSED')throw Error('INACTIVE_SETUP_PREVIOUS_USER_ATTEMPT_MUST_BE_CLOSED');
      const previous=getRecord(db,'acceptance_result',INACTIVE_SETUP_ID);
      if(getRecord(db,'acceptance_authorization',INACTIVE_SETUP_ID)?.status!=='CLOSED'||previous?.authorizationStatus!=='CLOSED'||previous?.campaignReadback!=='VERIFIED')throw Error('INACTIVE_SETUP_PRIOR_EVIDENCE_REQUIRED');
    }
    if (id === CONTINUATION_ID) {
      const previous = getRecord(db, 'acceptance_telegram', ACCEPTANCE_ID);
      if (getRecord(db, 'acceptance_authorization', ACCEPTANCE_ID)?.status !== 'CLOSED' || previous?.cleanup?.confirmed !== true || previous.finalCursor !== 64381646 || previous.remoteAcknowledgment?.lastApiConfirmedOffset !== 64381646 || getRecord(db, 'telegram_writing_cursor', 'primary')?.nextOffset !== 64381646) throw Error('CONTINUATION_PRIOR_STATE_MISMATCH');
    }
    if (isInstantlyQaId(id)) {
      const previous = getRecord(db, 'acceptance_result', CONTINUATION_ID);
      if (getRecord(db, 'acceptance_authorization', CONTINUATION_ID)?.status !== 'CLOSED' || previous?.authorizationStatus !== 'CLOSED' || previous?.telegram?.status !== 'PASSED' || previous.telegram.cleanup?.confirmed !== true || ['staleVersion', 'requestChanges'].some(key => previous.telegram.scenarios?.[key]?.status !== 'PASS')) throw Error('INSTANTLY_QA_PRIOR_EVIDENCE_REQUIRED');
    }
    if(id===INSTANTLY_QA_V2_ID&&getRecord(db,'acceptance_authorization',INSTANTLY_QA_ID)?.status!=='CLOSED')throw Error('INSTANTLY_QA_V1_MUST_REMAIN_CLOSED');
    if (!sourceFingerprints?.length || sourceFingerprints.some(item => typeof item.path !== 'string' || !/^[a-f0-9]{64}$/.test(item.sha256))) throw Error('ACCEPTANCE_SOURCE_FINGERPRINTS_REQUIRED');
    if(id===INSTANTLY_QA_V2_ID&&[manifest.contracts.baselineSource,'work/instantly-qa-acceptance-v2/manifest.json'].some(path=>!sourceFingerprints.some(source=>source.path===path)))throw Error('ACCEPTANCE_BOUND_ARTIFACT_FINGERPRINTS_REQUIRED');
    if(id===DISCOVERY_CAPTURE_ID&&!sourceFingerprints.some(source=>source.path===`${DISCOVERY_DIRECTORY}/manifest.json`))throw Error('ACCEPTANCE_BOUND_ARTIFACT_FINGERPRINTS_REQUIRED');
    if(id===INACTIVE_SETUP_ID&&INACTIVE_SETUP_SOURCES.some(path=>!sourceFingerprints.some(source=>source.path===path)))throw Error('ACCEPTANCE_BOUND_ARTIFACT_FINGERPRINTS_REQUIRED');
    if(isInactiveLeadCopyId(id)&&INACTIVE_LEAD_COPY_SOURCES.some(path=>!sourceFingerprints.some(source=>source.path===path)))throw Error('ACCEPTANCE_BOUND_ARTIFACT_FINGERPRINTS_REQUIRED');
    if(id===INTERNAL_PILOT_ID&&INTERNAL_PILOT_SOURCES.some(path=>!sourceFingerprints.some(source=>source.path===path)))throw Error('ACCEPTANCE_BOUND_ARTIFACT_FINGERPRINTS_REQUIRED');
    const protectedState = snapshot(db, isInstantlyQaId(id)||id===DISCOVERY_CAPTURE_ID||inactivePilot(id)||id===INTERNAL_PILOT_ID);
    if (!protectedState.controls.stopped || protectedState.controls.launchAuthorized) throw Error('ACCEPTANCE_CONTROLS_CHANGED');
    const grant = {
      id, status: 'APPROVED', approvedAt: iso(atMs), approvedBy: 'Daniel Rosen',
      basis: id===INTERNAL_PILOT_ID?'Explicit supervised one-use internal pilot: fixed dated schedule, one activation, safety pause, bounded reply capture; no production launch or monetary reservation':isInactiveLeadCopyId(id)?'Explicit one-use remaining inactive QA lead-copy update; three targeted reads and one exact update; no activation, sending or monetary reservation':id===INACTIVE_SETUP_ID?'Explicit one-use inactive QA setup; four targeted reads and two exact updates; no activation, sending or monetary reservation':id===DISCOVERY_CAPTURE_ID?'Explicit one-use selected Instantly contract discovery only; zero business tools and no monetary reservation':isInstantlyQaId(id) ? 'Explicit one-use Instantly-only exact existing-lead variable-update authorization; no Telegram operations' : 'Explicit one-use Telegram acceptance and exact existing-lead variable-update authorization',
      manifestHash: manifestHash(manifest), sourceFingerprints, protectedState,
      protectedHash: digest(canonical(protectedState)), historicalPrefixRetirementApproved: approvedScope.historicalPrefixRetirementApproved,
      maxDetailsMessages: 0, businessLaunchAuthorized: false, generalDispatchEnabled: false,
      startedAt: null, deadlineAt: null, closedAt: null, cancellationRequestedAt: null,
    };
    if(boundedGrant(id)){
      grant.boundAt=iso(atMs);grant.expiresAt=iso(atMs+86400000);grant.executionApproval=options.executionApproval??null;grant.authorizationBinding=v2Binding(manifest,sourceFingerprints);
      assertV2Binding(grant,manifest,atMs,true);
    }
    putRecord(db, 'acceptance_authorization', id, grant, 'user_reported');
    journal(db, 'ACCEPTANCE_APPROVED_NOT_STARTED', id, { manifestHash: grant.manifestHash, maxDetailsMessages: 0 });
    return grant;
  };
  // The local binder may hold the same write transaction across its baseline
  // comparison and post-insert preservation checks. Never commit its transaction.
  return db.isTransaction ? arm() : transaction(db, arm);
}

// Shared by the read-only readiness check and the atomic one-use claim.
// An APPROVED grant has no execution deadline until claimed; a used/expired
// grant never becomes fresh again merely because time passed.
export function assertFreshAcceptance(db, manifest, atMs = Date.now()) {
  const approvedScope = scope(manifest), grant = getRecord(db, 'acceptance_authorization', approvedScope.id);
  if (!grant) throw Error('ACCEPTANCE_AUTHORIZATION_MISSING');
  if(grant.id!==approvedScope.id)throw Error('ACCEPTANCE_AUTHORIZATION_ID_MISMATCH');
  if (grant.status === 'CLOSED') throw Error('ACCEPTANCE_AUTHORIZATION_CLOSED');
  if (grant.status === 'CLAIMED') throw Error('ACCEPTANCE_AUTHORIZATION_CLAIMED');
  if (grant.status !== 'APPROVED') throw Error('ACCEPTANCE_AUTHORIZATION_NOT_APPROVED');
  if (grant.cancellationRequestedAt !== null) throw Error('ACCEPTANCE_CANCELLED');
  if ([grant.startedAt, grant.deadlineAt, grant.closedAt].some(value => value !== null)) throw Error('ACCEPTANCE_UNSTARTED_LIFECYCLE_INVALID');
  if (grant.manifestHash !== manifestHash(manifest)) throw Error('ACCEPTANCE_MANIFEST_CHANGED');
  if(boundedGrant(grant.id))assertV2Binding(grant,manifest,atMs,true);
  if (grant.maxDetailsMessages !== 0 || grant.historicalPrefixRetirementApproved !== approvedScope.historicalPrefixRetirementApproved || grant.businessLaunchAuthorized !== false || grant.generalDispatchEnabled !== false) throw Error('ACCEPTANCE_SCOPE_CHANGED');
  if (digest(canonical(grant.protectedState)) !== grant.protectedHash) throw Error('ACCEPTANCE_PRESERVATION_CONTRACT_CHANGED');
  assertProtected(db, grant);
  return grant;
}

export function claimAcceptance(db, manifest, atMs = Date.now(), options = {}) {
  const claim = () => {
    const approvedScope = scope(manifest), id = approvedScope.id;
    if(operatorBound(id)){
      if(typeof options.entryCheck!=='function'||options.entryCheck()!==true)throw Error('OPERATOR_ENTRY_ELIGIBILITY_REQUIRED');
    }
    if(boundedGrant(id)){
      if(typeof options.now!=='function'||typeof options.root!=='string')throw Error(inactivePilot(id)?'ACCEPTANCE_LAUNCH_CONTEXT_REQUIRED':'OPERATOR_LAUNCH_CONTEXT_REQUIRED');
      if(typeof options.invocationId!=='string'||!options.invocationId.trim())throw Error(inactivePilot(id)?'ACCEPTANCE_INVOCATION_ID_REQUIRED':'OPERATOR_INVOCATION_ID_REQUIRED');
    }
    const checkedAt=boundedGrant(id)?options.now():atMs;
    const grant = isInstantlyQaId(id)||id===DISCOVERY_CAPTURE_ID||inactivePilot(id)||id===INTERNAL_PILOT_ID ? assertFreshAcceptance(db, manifest, checkedAt) : getRecord(db, 'acceptance_authorization', id);
    if (!grant) throw Error('ACCEPTANCE_AUTHORIZATION_MISSING');
    if (grant.status !== 'APPROVED') throw Error('ACCEPTANCE_AUTHORIZATION_ALREADY_USED');
    if (grant.manifestHash !== manifestHash(manifest)) throw Error('ACCEPTANCE_MANIFEST_CHANGED');
    assertProtected(db, grant);
    if(boundedGrant(id)){
      verifyAcceptanceSources(options.root,grant);
      const current=options.now();assertFreshAcceptance(db,manifest,current);
      const deadline=id===INTERNAL_PILOT_ID?Date.parse(grant.expiresAt):atMs+approvedScope.totalMs;
      if(!Number.isSafeInteger(atMs)||atMs<Date.parse(grant.boundAt)||atMs>current||current>=deadline||deadline>Date.parse(grant.expiresAt))throw Error(inactivePilot(id)?'ACCEPTANCE_EXECUTION_TIME_INVALID':'OPERATOR_EXECUTION_TIME_INVALID');
    }
    // This supervised profile waits for user receipt/reply reports without a
    // live worker. Its fixed main window and 30-minute reply window are enforced
    // by its controller; no call is permitted merely by this outer expiry.
    const claimed = { ...grant, status: 'CLAIMED', startedAt: iso(atMs), deadlineAt: id===INTERNAL_PILOT_ID?grant.expiresAt:iso(atMs + approvedScope.totalMs) };
    if(boundedGrant(id))claimed.claimInvocationId=options.invocationId;
    putRecord(db, 'acceptance_authorization', id, claimed, 'user_reported');
    journal(db, 'ACCEPTANCE_LAUNCHED_ONCE', id, { startedAt: claimed.startedAt, deadlineAt: claimed.deadlineAt });
    return claimed;
  };
  return db.isTransaction ? claim() : transaction(db, claim);
}

export function assertAcceptance(db, manifest, atMs = Date.now()) {
  const approvedScope = scope(manifest);
  const grant = getRecord(db, 'acceptance_authorization', approvedScope.id);
  if (!grant || grant.status !== 'CLAIMED') throw Error('ACCEPTANCE_AUTHORIZATION_NOT_ACTIVE');
  if(grant.id!==approvedScope.id)throw Error('ACCEPTANCE_AUTHORIZATION_ID_MISMATCH');
  if (grant.cancellationRequestedAt !== null) throw Error('ACCEPTANCE_CANCELLED');
  if (grant.manifestHash !== manifestHash(manifest)) throw Error('ACCEPTANCE_MANIFEST_CHANGED');
  if(boundedGrant(grant.id)){
    assertV2Binding(grant,manifest,atMs,false);
    const start=Date.parse(grant.startedAt),deadline=Date.parse(grant.deadlineAt);
    const expected=grant.id===INTERNAL_PILOT_ID?Date.parse(grant.expiresAt):start+approvedScope.totalMs;
    if(!Number.isFinite(start)||!Number.isFinite(deadline)||deadline!==expected||start<Date.parse(grant.boundAt)||deadline>Date.parse(grant.expiresAt))throw Error('ACCEPTANCE_DEADLINE');
  }
  if (!Number.isFinite(atMs) || atMs < Date.parse(grant.startedAt) || atMs >= Date.parse(grant.deadlineAt)) throw Error('ACCEPTANCE_DEADLINE');
  if (grant.maxDetailsMessages !== 0 || grant.historicalPrefixRetirementApproved !== approvedScope.historicalPrefixRetirementApproved || grant.businessLaunchAuthorized !== false || grant.generalDispatchEnabled !== false) throw Error('ACCEPTANCE_SCOPE_CHANGED');
  if (digest(canonical(grant.protectedState)) !== grant.protectedHash) throw Error('ACCEPTANCE_PRESERVATION_CONTRACT_CHANGED');
  assertProtected(db, grant);
  return grant;
}

export function cancelAcceptance(db, atMs = Date.now(), id = ACCEPTANCE_ID, invocationId = null) {
  return transaction(db, () => {
    if (![ACCEPTANCE_ID, CONTINUATION_ID, INSTANTLY_QA_ID, INSTANTLY_QA_V2_ID,DISCOVERY_CAPTURE_ID,INACTIVE_SETUP_ID,INACTIVE_LEAD_COPY_ID,INACTIVE_LEAD_COPY_V2_ID,INTERNAL_PILOT_ID].includes(id)) throw Error('ACCEPTANCE_MANIFEST_UNSUPPORTED');
    const grant = getRecord(db, 'acceptance_authorization', id);
    if (!grant || grant.status !== 'CLAIMED') return false;
    if(boundedGrant(id)&&(!invocationId||grant.claimInvocationId!==invocationId))throw Error('ACCEPTANCE_CANCELLATION_NOT_OWNER');
    if (grant.cancellationRequestedAt !== null) return true;
    putRecord(db, 'acceptance_authorization', id, { ...grant, cancellationRequestedAt: iso(atMs) }, 'confirmed');
    journal(db, 'ACCEPTANCE_CANCEL_REQUESTED', id, { at: iso(atMs), acceptedExternalActionsCannotBeRecalled: true });
    return true;
  });
}

export function verifyAcceptanceSources(root, grant) {
  const base = resolve(root);
  for (const source of grant.sourceFingerprints) {
    const path = resolve(base, source.path);
    if (isAbsolute(source.path) || !path.startsWith(base + sep)) throw Error('ACCEPTANCE_SOURCE_PATH_INVALID');
    let current;
    try { current = digest(readFileSync(path)); } catch { throw Error('ACCEPTANCE_SOURCE_UNAVAILABLE'); }
    if (current !== source.sha256) throw Error('ACCEPTANCE_SOURCE_CHANGED');
  }
  return true;
}

export function closeAcceptance(db, result, atMs = Date.now()) {
  const close = () => {
    const id = result.id ?? ACCEPTANCE_ID;
    if (![ACCEPTANCE_ID, CONTINUATION_ID, INSTANTLY_QA_ID, INSTANTLY_QA_V2_ID,DISCOVERY_CAPTURE_ID,INACTIVE_SETUP_ID,INACTIVE_LEAD_COPY_ID,INACTIVE_LEAD_COPY_V2_ID,INTERNAL_PILOT_ID].includes(id)) throw Error('ACCEPTANCE_MANIFEST_UNSUPPORTED');
    const grant = getRecord(db, 'acceptance_authorization', id);
    if (result.notLaunched === true && grant?.status !== 'APPROVED') throw Error('ACCEPTANCE_UNSTARTED_CLOSURE_LOST_OWNERSHIP');
    if (boundedGrant(id) && grant?.status === 'CLAIMED' && (!result.claimInvocationId || result.claimInvocationId !== grant.claimInvocationId)) throw Error('ACCEPTANCE_CLOSURE_NOT_OWNER');
    const unstartedContinuation = [CONTINUATION_ID, INSTANTLY_QA_ID, INSTANTLY_QA_V2_ID,INACTIVE_SETUP_ID,INACTIVE_LEAD_COPY_ID,INACTIVE_LEAD_COPY_V2_ID,INTERNAL_PILOT_ID].includes(id) && grant?.status === 'APPROVED' && result.status === 'BLOCKED' && result.notLaunched === true;
    if (!grant || (grant.status !== 'CLAIMED' && !unstartedContinuation)) throw Error('ACCEPTANCE_CLOSURE_NOT_OWNER');
    putRecord(db, 'acceptance_result', id, result, 'confirmed');
    putRecord(db, 'acceptance_authorization', id, { ...grant, status: 'CLOSED', closedAt: iso(atMs), outcome: result.status, reason: result.reason }, 'confirmed');
    journal(db, 'ACCEPTANCE_CLOSED', id, { status: result.status, reason: result.reason });
  };
  return db.isTransaction ? close() : transaction(db, close);
}
