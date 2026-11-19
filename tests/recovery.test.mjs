import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import * as api from '../src/foundation.mjs';

function fixture() { const dir = mkdtempSync(join(tmpdir(), 'elya-recovery-')); return { dir, db: api.openStore(join(dir, 'state.sqlite')) }; }
const content = { campaignId: 'offline', recipients: [{ candidateId: 'synthetic', email: 'qa@example.test', messages: [{ subject: 'Synthetic', body: 'Do not send' }] }], sequence: { delays: [0] }, settings: { sender: 'none' } };
test('reject and revision-request supersede earlier approvals, and journal writes roll back with failed transactions', () => {
  const { db } = fixture(); const b = api.createBatch(db, 'b', content);
  for (const decision of ['REJECTED', 'REVISION_REQUESTED']) {
    const a = api.decideApproval(db, 'b', b.version, b.hash, 'APPROVED', 'offline', '2026-11-20T00:00:00Z', '2026-11-16T15:00:00Z');
    api.decideApproval(db, 'b', b.version, b.hash, decision, 'offline', '2026-11-20T00:00:00Z', '2026-11-16T15:01:00Z');
    assert.equal(db.prepare('SELECT decision FROM approvals WHERE id=?').get(a.id).decision, 'REVOKED');
  }
  assert.throws(() => api.transaction(db, () => { api.putRecord(db, 'evidence', 'rollback', { fact: 'must rollback' }); api.journal(db, 'ROLLBACK_TEST', 'test'); throw new Error('simulated interruption'); }));
  assert.equal(api.getRecord(db, 'evidence', 'rollback'), null);
  assert.equal(db.prepare("SELECT count(*) n FROM journal WHERE event='ROLLBACK_TEST'").get().n, 0); db.close();
});
test('offline transport ambiguity persists and cannot be retried or mistaken for a successful operation', async () => {
  const { db } = fixture(); api.createBudget(db, 'b', '1', '0', '0');
  api.reserveOperation(db, { id: 'x', kind: 'COLLECT', budgetId: 'b', reservation: '0.1', authorizationRef: 'fixture', payload: {} });
  await assert.rejects(api.executeOffline(db, 'x', { mode: 'production' }), /offline/);
  await api.executeOffline(db, 'x', { mode: 'offline', execute: async () => { throw new Error('unavailable'); } });
  assert.equal(api.operation(db, 'x').status, 'RECONCILIATION');
  await assert.rejects(api.executeOffline(db, 'x', { mode: 'offline', execute: async () => ({}) }));
  assert.equal(api.budgetStatus(db, 'b').reserved, '0.1'); db.close();
});
test('same successful action under a new local ID cannot be executed twice', () => {
  const { db } = fixture(); api.createBudget(db, 'b', '1', '0', '0');
  const intent = { id: 'first', kind: 'COLLECT', budgetId: 'b', reservation: '0.1', authorizationRef: 'fixture', payload: { scope: 'same exact work' } };
  api.reserveOperation(db, intent); api.beginOperation(db, 'first');
  api.recordOutcome(db, 'first', { status: 'SUCCEEDED', actual: '0.05', evidence: 'offline receipt' });
  assert.throws(() => api.reserveOperation(db, { ...intent, id: 'new-id' }), /duplicate|existing/i); db.close();
});
test('ambiguous partial bill above reservation is conservatively counted and blocks new spend', () => {
  const { db } = fixture(); api.createBudget(db, 'b', '1', '0', '0');
  api.reserveOperation(db, { id: 'x', kind: 'COLLECT', budgetId: 'b', reservation: '0.1', authorizationRef: 'fixture', payload: {} }); api.beginOperation(db, 'x');
  api.recordOutcome(db, 'x', { status: 'AMBIGUOUS', actual: '0.2', evidence: 'known partial invoice' });
  assert.equal(api.budgetStatus(db, 'b').blocked, true);
  assert.equal(api.budgetStatus(db, 'b').committed, '0.2'); db.close();
});
test('explicit new intent may replace cancelled-before-dispatch work without replaying the old ID', () => {
  const { db } = fixture(); api.createBudget(db, 'b', '1', '0', '0');
  const intent = { id: 'old', kind: 'COLLECT', budgetId: 'b', reservation: '0.1', authorizationRef: 'fixture', payload: { scope: 'cancel-safe' } };
  api.reserveOperation(db, intent); api.cancelOperation(db, 'old', 'never dispatched');
  assert.equal(api.reserveOperation(db, { ...intent, id: 'new' }).status, 'PREPARED');
  assert.throws(() => api.beginOperation(db, 'old')); db.close();
});
test('competing writer fails closed while a reservation transaction holds the database', () => {
  const { dir, db } = fixture(); api.createBudget(db, 'b', '1', '0', '0');
  const other = api.openStore(join(dir, 'state.sqlite')); other.exec('PRAGMA busy_timeout=30');
  db.exec('BEGIN IMMEDIATE');
  assert.throws(() => api.reserveOperation(other, { id: 'blocked', kind: 'COLLECT', budgetId: 'b', reservation: '0.6', authorizationRef: 'fixture', payload: { scope: 'lock-test' } }), /locked|busy/i);
  db.exec('ROLLBACK');
  assert.equal(api.operation(other, 'blocked'), undefined);
  assert.equal(api.budgetStatus(other, 'b').reserved, '0'); other.close(); db.close();
});
test('invalid record provenance cannot leave a partial history entry', () => {
  const { db } = fixture();
  assert.throws(() => api.putRecord(db, 'evidence', 'bad-basis', { fact: 'fixture' }, 'unsupported'));
  assert.equal(db.prepare("SELECT count(*) n FROM record_history WHERE id='bad-basis'").get().n, 0); db.close();
});
test('CLI import, status, stop, recovery, backup, restore and export operate offline', () => {
  const { dir, db } = fixture(); db.close();
  const database = join(dir, 'state.sqlite');
  function cli(...args) {
    const r = spawnSync(process.execPath, ['src/cli.mjs', ...args, '--db', database], { encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr); return JSON.parse(r.stdout);
  }
  assert.equal(cli('import').counts.candidate, 15);
  assert.equal(cli('import').replayed, true);
  assert.equal(cli('status').controls.stopped, true);
  assert.equal(cli('stop').stopped, true);
  assert.equal(cli('recover')[0].status, 'RECONCILIATION');
  const backup = join(dir, 'backup.sqlite'); cli('backup', backup);
  const restored = join(dir, 'restored.sqlite'); cli('restore', backup, restored);
  const exported = join(dir, 'export.json'); cli('export', exported);
  const result = JSON.parse(readFileSync(exported));
  assert.equal(result.authority, 'Snapshot export; SQLite remains authoritative');
  assert.ok(result.records.some(r => r.kind === 'verification'));
});
