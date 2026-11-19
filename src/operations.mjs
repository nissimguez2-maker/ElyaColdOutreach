import { canonical, digest, decimal, addMoney, compareMoney, calculate, required } from './values.mjs';
import { transaction, journal, now, controls } from './store.mjs';
import { evaluateRelease, latestBatch } from './batches.mjs';
import { permitsHistoricalDiagnostic } from './diagnostic-policy.mjs';

export function createBudget(db, id, limit, baseline, fixed, basis = 'explicit local authorization') {
  required(id); decimal(limit); decimal(baseline); if (fixed !== null) decimal(fixed); required(basis);
  const old = db.prepare('SELECT * FROM budgets WHERE id=?').get(id);
  if (old) {
    if (old.limit_usd !== limit || old.baseline_usd !== baseline || old.fixed_usd !== fixed || old.basis !== basis) throw new Error('Budget already exists with different settings');
    return;
  }
  db.prepare('INSERT INTO budgets VALUES(?,?,?,?,?,0)').run(id, limit, baseline, fixed, basis);
}
export function budgetStatus(db, id) {
  const b = db.prepare('SELECT * FROM budgets WHERE id=?').get(id); if (!b) throw new Error('Unknown budget');
  let actual = '0', reserved = '0';
  for (const row of db.prepare('SELECT * FROM operations WHERE budget_id=?').all(id)) {
    if (row.actual_usd !== null) actual = addMoney(actual, row.actual_usd);
    if (!['CANCELLED'].includes(row.status) && row.actual_usd === null) reserved = addMoney(reserved, row.reservation_usd);
  }
  const committed = b.fixed_usd === null ? null : [b.baseline_usd, b.fixed_usd, actual, reserved].reduce(addMoney, '0');
  return { limit: b.limit_usd, baseline: b.baseline_usd, fixed: b.fixed_usd, actual, reserved, committed, remaining: committed === null ? null : calculate(b.limit_usd, committed, true), blocked: !!b.blocked || committed === null || compareMoney(committed, b.limit_usd) > 0 };
}
export const operation = (db, id) => db.prepare('SELECT * FROM operations WHERE id=?').get(id);
export function reserveOperation(db, intent) {
  required(intent.id); required(intent.authorizationRef); decimal(intent.reservation);
  if (!['COLLECT', 'VERIFY', 'RELEASE', 'NOTIFY', 'READ', 'DRAFT'].includes(intent.kind) || !intent.payload || typeof intent.payload !== 'object') throw new Error('Invalid operation intent');
  const serialized = canonical(intent), hash = digest(serialized);
  const commit = () => {
    const old = operation(db, intent.id);
    if (old) { if (old.intent_hash !== hash) throw new Error('Operation intent mismatch'); return old; }
    let action = { kind: intent.kind, payload: intent.payload };
    if (intent.kind === 'RELEASE') {
      if (controls(db).stopped) throw new Error('System stopped');
      required(intent.payload.batchId); required(intent.payload.approvalId);
      const batch = latestBatch(db, intent.payload.batchId);
      if (!batch) throw new Error('Unknown batch');
      action = { kind: 'RELEASE', batchId: batch.batch_id, version: batch.version, hash: batch.hash, campaignId: JSON.parse(batch.content_json).campaignId };
    }
    const blockers = db.prepare("SELECT * FROM operations WHERE status IN ('DISPATCHING','RECONCILIATION')").all();
    if (blockers.length && !permitsHistoricalDiagnostic(db, intent, blockers)) throw new Error('Outstanding operation requires reconciliation before another operation');
    const b = budgetStatus(db, intent.budgetId);
    if (b.blocked || compareMoney(addMoney(b.committed, intent.reservation), b.limit) > 0) throw new Error('Budget exceeded or fixed costs unresolved');
    const actionKey = digest(canonical(action));
    if (db.prepare("SELECT id FROM operations WHERE action_key=? AND status<>'CANCELLED'").get(actionKey)) throw new Error('Duplicate action: inspect the existing operation; completed work cannot be replayed');
    db.prepare('INSERT INTO operations VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)').run(intent.id, intent.kind, intent.budgetId, hash, serialized, 'PREPARED', intent.reservation, null, null, null, now(), now(), actionKey);
    journal(db, 'RESERVED', intent.id, { amount: intent.reservation, budgetId: intent.budgetId }); return operation(db, intent.id);
  };
  return db.isTransaction ? commit() : transaction(db, commit);
}
export function beginOperation(db, id, at = now(), validateBoundary = () => {}, options = {}) {
  return transaction(db, () => {
    const op = operation(db, id); if (!op || op.status !== 'PREPARED') throw new Error('Operation state requires reconciliation or is terminal; no retry');
    const blockers = db.prepare("SELECT * FROM operations WHERE id<>? AND status IN ('DISPATCHING','RECONCILIATION')").all(id);
    if (blockers.length && !permitsHistoricalDiagnostic(db, JSON.parse(op.intent_json), blockers)) throw new Error('Reconciliation required');
    if (budgetStatus(db, op.budget_id).blocked) throw new Error('Budget blocked');
    const intent = JSON.parse(op.intent_json);
    if (op.kind === 'RELEASE') {
      const gate = evaluateRelease(db, intent.payload.batchId, intent.payload.approvalId, at, options);
      if (!gate.allowed) throw new Error(gate.reasons.join('; '));
    }
    // Adapter-specific authority is rechecked in the same transaction as dispatch intent.
    validateBoundary();
    db.prepare("UPDATE operations SET status='DISPATCHING',updated_at=? WHERE id=?").run(at, id);
    journal(db, 'DISPATCH_INTENT', id); return intent;
  });
}
export function cancelOperation(db, id, reason) {
  required(reason); transaction(db, () => {
    if (operation(db, id)?.status !== 'PREPARED') throw new Error('Cannot cancel dispatched or terminal operation state');
    db.prepare("UPDATE operations SET status='CANCELLED',evidence=?,updated_at=? WHERE id=?").run(reason, now(), id);
    journal(db, 'CANCELLED_BEFORE_DISPATCH', id, { reason });
  });
}
function outcome(db, id, receipt, reconciliation) {
  canonical(receipt); required(receipt.evidence);
  if (!['SUCCEEDED','FAILED','AMBIGUOUS'].includes(receipt.status)) throw new Error('Invalid outcome');
  if (receipt.actual !== null) decimal(receipt.actual);
  const commit = () => {
    const op = operation(db, id);
    if (!op || op.status !== (reconciliation ? 'RECONCILIATION' : 'DISPATCHING')) throw new Error('Invalid outcome state');
    const status = receipt.status === 'AMBIGUOUS' || receipt.actual === null ? 'RECONCILIATION' : receipt.status;
    // Ambiguous execution retains the full reservation even when a partial charge is known.
    const actual = receipt.status === 'AMBIGUOUS' ? null : receipt.actual;
    db.prepare('UPDATE operations SET status=?,actual_usd=?,remote_id=?,evidence=?,updated_at=? WHERE id=?').run(status, actual, receipt.remoteId ?? null, receipt.evidence, now(), id);
    if (receipt.actual !== null && compareMoney(receipt.actual, op.reservation_usd) > 0) {
      db.prepare('UPDATE budgets SET blocked=1 WHERE id=?').run(op.budget_id);
      if (receipt.status === 'AMBIGUOUS') db.prepare('UPDATE operations SET reservation_usd=? WHERE id=?').run(receipt.actual, id);
    }
    journal(db, reconciliation ? 'RECONCILED' : 'OUTCOME', id, receipt); return operation(db, id);
  };
  return db.isTransaction ? commit() : transaction(db, commit);
}
export const recordOutcome = (db, id, receipt) => outcome(db, id, receipt, false);
export const reconcileOperation = (db, id, receipt) => outcome(db, id, receipt, true);
export function recoverOperations(db) {
  return transaction(db, () => {
    const interrupted = db.prepare("SELECT id FROM operations WHERE status='DISPATCHING'").all();
    for (const { id } of interrupted) {
      db.prepare("UPDATE operations SET status='RECONCILIATION',updated_at=? WHERE id=?").run(now(), id);
      journal(db, 'INTERRUPTED_REQUIRES_RECONCILIATION', id);
    }
    return db.prepare("SELECT id,status,remote_id FROM operations WHERE status IN ('PREPARED','RECONCILIATION')").all();
  });
}
// Replaceable boundary: only an explicitly supplied offline adapter can execute in this build.
export async function executeOffline(db, id, adapter, at = now()) {
  if (adapter?.mode !== 'offline' || typeof adapter.execute !== 'function') throw new Error('Only offline adapters supported');
  const intent = beginOperation(db, id, at);
  try { return recordOutcome(db, id, await adapter.execute(intent)); }
  catch { return recordOutcome(db, id, { status: 'AMBIGUOUS', actual: null, evidence: 'Offline adapter failure; reconcile before retry' }); }
}
