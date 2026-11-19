import { performance } from 'node:perf_hooks';
import { controls, putRecord } from './store.mjs';
import { claimAcceptance, assertAcceptance, closeAcceptance, verifyAcceptanceSources, ACCEPTANCE_ID } from './acceptance-authority.mjs';
import { CONTINUATION_ID } from './acceptance-continuation-contract.mjs';
import { INSTANTLY_QA_V2_ID, isInstantlyQaId } from './instantly-qa-contract.mjs';

const passed = value => ['PASS', 'PASSED'].includes(value?.status);
const clean = value => value?.cleanup?.confirmed === true || value?.cleanup?.cleanupConfirmed === true;
export const acceptanceErrorCode = error => /^[A-Z][A-Z0-9_:.-]{0,159}$/.test(error?.message ?? '') ? error.message : 'LOCAL_EXECUTION_ERROR_REQUIRES_SAVED_EVIDENCE';

// Dependencies are supplied explicitly. Importing this module cannot open a connection.
export async function runAcceptanceSequence({ db, manifest, root, telegram, instantly, emit = () => {}, now = Date.now, startedAtMs = now(), startedMono = performance.now(), cancelled = () => false, entryCheck, invocationId }) {
  const grant = claimAcceptance(db, manifest, startedAtMs, manifest.id===INSTANTLY_QA_V2_ID?{root,now,entryCheck,invocationId}:{});
  const instantlyOnly = isInstantlyQaId(grant.id);
  const result = {
    id: grant.id, startedAt: grant.startedAt, status: 'BLOCKED', reason: 'NOT_COMPLETED',
    telegram: instantlyOnly ? { status: 'NOT_APPLICABLE', reason: 'PRIOR_ACCEPTANCE_PRESERVED_NO_TELEGRAM_OPERATIONS' } : { status: 'BLOCKED', reason: 'NOT_ATTEMPTED' },
    instantly: [{ phase: 1, status: 'BLOCKED', reason: 'NOT_ATTEMPTED' }, { phase: 2, status: 'BLOCKED', reason: 'NOT_ATTEMPTED' }],
    authenticationCategory: instantlyOnly ? 'Existing Codex connector authentication' : 'Existing protected Telegram credential and existing Codex connector authentication',
    generalDispatchEnabled: false, costs: 'NOT_EXPOSED',
  };
  if(manifest.id===INSTANTLY_QA_V2_ID)result.claimInvocationId=grant.claimInvocationId;
  let stage = 'LOCAL_PRECONDITIONS';
  const assertAuthority = () => {
    if (cancelled()) throw Error('LOCAL_CANCELLATION');
    const active = assertAcceptance(db, manifest, now());
    verifyAcceptanceSources(root, active);
    return instantlyOnly ? active : true;
  };
  const checkpoint = () => putRecord(db, 'acceptance_progress', grant.id, { ...result, currentStage: stage }, 'confirmed');
  try {
    assertAuthority();
    if (!instantlyOnly) {
      stage = 'TELEGRAM'; checkpoint();
      result.telegram = await telegram({ assertAuthority, startedMono, startedWall: grant.startedAt, emit });
      checkpoint();
      if (!passed(result.telegram)) throw Error('TELEGRAM_SEGMENT_NOT_PASSED');
      if (grant.id === CONTINUATION_ID && ['staleVersion', 'requestChanges'].some(key => result.telegram.scenarios?.[key]?.status !== 'PASS')) throw Error('TELEGRAM_REQUIRED_OUTCOMES_INCOMPLETE');
      if (!clean(result.telegram)) throw Error('TELEGRAM_CLEANUP_UNCONFIRMED');
    }
    for (const phase of [1, 2]) {
      if (instantlyOnly) stage = `INSTANTLY_PHASE_${phase}_PREFLIGHT`;
      assertAuthority();
      if (Date.parse(grant.deadlineAt) - now() < 60000 + (instantlyOnly ? 10000 : 0)) throw Error('INSUFFICIENT_SESSION_TIME_FOR_CONTAINED_LAUNCH');
      stage = `INSTANTLY_PHASE_${phase}`; checkpoint();
      emit(instantlyOnly ? `Running authorized Instantly-only phase ${phase} of 2. No operator action is needed.` : `Telegram is complete. Running authorized Instantly phase ${phase} of 2; no Telegram action is needed.`);
      result.instantly[phase - 1] = await instantly({ assertAuthority, phase, emit });
      checkpoint();
      if (!passed(result.instantly[phase - 1])) throw Error(`INSTANTLY_PHASE_${phase}_NOT_PASSED`);
      if (!clean(result.instantly[phase - 1])) throw Error(`INSTANTLY_PHASE_${phase}_CLEANUP_UNCONFIRMED`);
    }
    assertAuthority();
    result.status = 'PASS'; result.reason = 'AUTHORIZED_ACCEPTANCE_SCENARIOS_CONFIRMED';
  } catch (error) {
    result.status = 'BLOCKED';
    result.reason = acceptanceErrorCode(error);
    result.firstFailingStage = stage;
  } finally {
    result.finishedAt = new Date(now()).toISOString();
    result.elapsedMs = Math.max(0, now() - startedAtMs);
    result.finalControls = controls(db);
    result.authorizationStatus = 'CLOSED';
    closeAcceptance(db, result, now());
  }
  return result;
}
