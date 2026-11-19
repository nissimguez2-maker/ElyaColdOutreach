import { getRecord, now } from './store.mjs';
import { reserveOperation, beginOperation, recordOutcome } from './operations.mjs';
import { validateCliJob, checkCliAuthorization, buildCliRequest, cliJobHash } from './cli-jobs.mjs';
import { createEvidenceCollector } from './cli-evidence.mjs';
export * from './cli-jobs.mjs';

/**
 * Replaceable trusted process boundary, currently OFFLINE ONLY.
 * start(request,{line,diagnostic}) -> {closed:Promise<{exitCode,signal}>,terminate:()=>Promise<boolean>}
 * Callers may not obtain this transport from scraped content or job JSON.
 * No native CLI spawner is wired: remote tool/argument restrictions remain unverified.
 */
export async function executeCliJob(db, id, transport, clock = now) {
  if (transport?.mode !== 'offline' || typeof transport.start !== 'function') throw new Error('LIVE_DISPATCH_DISABLED; only trusted offline fixtures supported');
  if (typeof clock !== 'function') throw new Error('CLOCK_FUNCTION_REQUIRED');
  const stored = getRecord(db, 'cli_job', id); if (!stored) throw new Error('UNKNOWN_JOB');
  const job = validateCliJob(stored); checkCliAuthorization(db, job, clock());
  const operationId = `cli:${job.id}`;
  const intent = { id: operationId, kind: 'READ', budgetId: job.budgetId, reservation: job.reservationUsd,
    authorizationRef: `cli_job_authorization:${job.id}`, payload: { provider: job.provider, action: job.action, resourceId: job.resourceId } };
  reserveOperation(db, intent);
  beginOperation(db, operationId, clock(), () => checkCliAuthorization(db, job, clock()));
  const startedAt = clock(), collector = createEvidenceCollector(job); let active = true, handle, timer;
  let terminationConfirmed = null, processResult;
  try {
    handle = transport.start(buildCliRequest(job), {
      line: line => { if (active) collector.line(line); },
      diagnostic: text => { if (active) collector.diagnostic(text); }
    });
    if (!handle?.closed || typeof handle.closed.then !== 'function' || typeof handle.terminate !== 'function') throw new Error('INVALID_PROCESS_HANDLE');
    processResult = await Promise.race([
      handle.closed.then(result => result && typeof result === 'object' ? result : { exitCode: null, interrupted: true }),
      new Promise(resolve => { timer = setTimeout(() => resolve({ exitCode: null, timedOut: true }), job.timeoutMs); })
    ]);
  } catch { processResult = { exitCode: null, interrupted: true }; }
  finally { active = false; clearTimeout(timer); }
  if (processResult.timedOut || processResult.interrupted) {
    if (typeof handle?.terminate === 'function') {
      let terminationTimer;
      try { terminationConfirmed = await Promise.race([Promise.resolve(handle.terminate()).then(value => value === true), new Promise(resolve => { terminationTimer = setTimeout(() => resolve(false), 1000); })]); }
      catch { terminationConfirmed = false; }
      finally { clearTimeout(terminationTimer); }
    } else terminationConfirmed = false;
  }
  const result = { ...collector.finish(processResult), startedAt, finishedAt: clock(), executionMode: 'OFFLINE_FIXTURE', jobHash: cliJobHash(job), terminationConfirmed };
  // Only sanitized evidence updates state. Null billing retains the original reservation.
  recordOutcome(db, operationId, { status: result.readOutcome === 'UNRESOLVED' ? 'AMBIGUOUS' : result.readOutcome,
    actual: null, remoteId: null, evidence: 'Validated CLI event projections; see cliResult in this journal receipt', cliResult: result });
  return result;
}
