import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const api = await import('../src/foundation.mjs').catch(() => null);
test('local foundation is available', () => assert.ok(api, 'Foundation has not been implemented'));
const mon = '2026-11-16T15:00:00Z';
const batch = () => ({ campaignId: 'synthetic-offline', recipients: [{ candidateId: 'test-business', email: 'qa@example.test', messages: [{ subject: 'QA & café', body: "Synthetic only.\n\nIt's a test." }] }], sequence: { delaysDays: [0] }, settings: { timezone: 'America/New_York' } });
function fixture() { const dir = mkdtempSync(join(tmpdir(), 'elya-')); return { dir, db: api.openStore(join(dir, 'test.sqlite')) }; }
function eligible(db) {
  api.putRecord(db, 'candidate', 'test-business', { qualification: 'QUALIFIED' });
  api.putRecord(db, 'contact', 'qa@example.test', { candidateId: 'test-business', attribution: 'Internal synthetic fixture', verification: 'PASSED', suppressed: false });
}
function ready(db) {
  eligible(db); const v = api.createBatch(db, 'b', batch());
  const a = api.decideApproval(db, 'b', v.version, v.hash, 'APPROVED', 'offline-test', '2026-11-17T00:00:00Z', mon);
  api.setLaunch(db, true, 'offline fixture authorization', mon);
  api.setStopped(db, false, 'offline fixture', mon);
  return { v, a };
}
if (api) {
  test('exact decimal math preserves precision and refuses floating point input', () => {
    assert.equal(api.addMoney('0.1', '0.2'), '0.3');
    assert.equal(api.addMoney('0.00000000000000000001', '0.00000000000000000002'), '0.00000000000000000003');
    assert.equal(api.addMoney('9007199254740993', '0.001'), '9007199254740993.001');
    assert.throws(() => api.addMoney(0.1, '0.2'));
    assert.throws(() => api.addMoney('-1', '0'));
  });
  test('batch hashing is canonical, exact, and changes with recipients, copy, sequence or settings', () => {
    const a = batch(); const b = { settings: a.settings, sequence: a.sequence, recipients: a.recipients, campaignId: a.campaignId };
    assert.equal(api.hashBatch(a), api.hashBatch(b));
    for (const change of [x => x.recipients[0].email = 'other@example.test', x => x.recipients[0].messages[0].body += '!', x => x.sequence.delaysDays.push(1), x => x.settings.footer = 'changed']) {
      const c = batch(); change(c); assert.notEqual(api.hashBatch(a), api.hashBatch(c));
    }
    assert.throws(() => api.hashBatch({ ...a, extra: undefined }));
  });
  test('revisions invalidate approval; reimporting identical batch does not create a version', () => {
    const { db } = fixture(); const { v, a } = ready(db);
    assert.equal(api.createBatch(db, 'b', batch()).version, 1);
    assert.equal(api.evaluateRelease(db, 'b', a.id, mon).allowed, true);
    const changed = batch(); changed.recipients[0].messages[0].subject += '!';
    assert.equal(api.createBatch(db, 'b', changed).version, 2);
    assert.equal(api.evaluateRelease(db, 'b', a.id, mon).allowed, false);
    assert.throws(() => api.decideApproval(db, 'b', v.version, v.hash, 'APPROVED', 'test', '2026-11-18T00:00:00Z', mon), /stale/i);
    const current = api.createBatch(db, 'b', changed);
    assert.throws(() => api.decideApproval(db, 'b', current.version, 'wrong', 'APPROVED', 'test', '2026-11-18T00:00:00Z', mon), /mismatch/i);
    db.close();
  });
  test('revoked, expired and other-batch approvals fail; launch is separate and stop persists', () => {
    const { dir, db } = fixture(); const { a } = ready(db);
    api.createBatch(db, 'other', batch());
    assert.equal(api.evaluateRelease(db, 'other', a.id, mon).allowed, false);
    assert.equal(api.evaluateRelease(db, 'b', a.id, '2026-11-17T15:00:00Z').allowed, false);
    api.setLaunch(db, false, 'no live authority', mon);
    assert.equal(api.evaluateRelease(db, 'b', a.id, mon).allowed, false);
    api.setLaunch(db, true, 'fixture only', mon);
    api.revokeApproval(db, a.id, 'revoked by reviewer');
    assert.equal(api.evaluateRelease(db, 'b', a.id, mon).allowed, false);
    api.setStopped(db, true, 'stop test', mon); db.close();
    const reopened = api.openStore(join(dir, 'test.sqlite'));
    assert.equal(api.controls(reopened).stopped, true); reopened.close();
  });
  test('business qualification cannot substitute for contact verification or attribution', () => {
    const { db } = fixture(); const { a } = ready(db);
    for (const verification of ['HELD', 'CATCH_ALL', 'MX_VALID']) {
      api.putRecord(db, 'contact', 'qa@example.test', { candidateId: 'test-business', attribution: 'Generic business inbox', verification, suppressed: false });
      assert.equal(api.evaluateRelease(db, 'b', a.id, mon).allowed, false);
    }
    api.putRecord(db, 'contact', 'qa@example.test', { candidateId: 'test-business', verification: 'PASSED', suppressed: false });
    assert.equal(api.evaluateRelease(db, 'b', a.id, mon).allowed, false); db.close();
  });
  test('New York window is weekday 09 inclusive to 19 exclusive across both DST boundaries', () => {
    for (const [time, expected] of [
      ['2026-03-06T13:59:59Z', false], ['2026-03-06T14:00:00Z', true],
      ['2026-03-09T12:59:59Z', false], ['2026-03-09T13:00:00Z', true],
      ['2026-03-09T22:59:59Z', true], ['2026-03-09T23:00:00Z', false],
      ['2026-03-08T07:00:00Z', false], ['2026-11-01T05:30:00Z', false], ['2026-11-01T06:30:00Z', false],
      ['2026-10-30T13:00:00Z', true], ['2026-11-02T13:00:00Z', false], ['2026-11-02T14:00:00Z', true],
      ['2026-11-17T00:00:00Z', false], ['2026-11-21T15:00:00Z', false]
    ]) assert.equal(api.inSendingWindow(time), expected, time);
    assert.throws(() => api.inSendingWindow('not a date'));
  });
  test('reservations are exact, idempotent, scoped and do not count requested caps as actuals', () => {
    const { db } = fixture(); api.createBudget(db, 'pilot', '1', '0.2', '0');
    const intent = { id: 'op', kind: 'COLLECT', budgetId: 'pilot', reservation: '0.55', authorizationRef: 'specific fixture approval', payload: { websites: ['https://example.test'] } };
    api.reserveOperation(db, intent); api.reserveOperation(db, intent);
    assert.deepEqual(api.budgetStatus(db, 'pilot'), { limit: '1', baseline: '0.2', fixed: '0', actual: '0', reserved: '0.55', committed: '0.75', remaining: '0.25', blocked: false });
    assert.throws(() => api.reserveOperation(db, { ...intent, reservation: '0.5' }), /mismatch/i);
    assert.throws(() => api.reserveOperation(db, { ...intent, id: 'over', reservation: '0.251' }), /budget/i);
    api.cancelOperation(db, 'op', 'not dispatched');
    assert.equal(api.budgetStatus(db, 'pilot').reserved, '0');
    assert.equal(api.reserveOperation(db, intent).status, 'CANCELLED'); db.close();
  });
  test('ambiguous and interrupted operations require reconciliation and retain funds after restart', () => {
    const { dir, db } = fixture(); api.createBudget(db, 'pilot', '1', '0', '0');
    api.reserveOperation(db, { id: 'op', kind: 'COLLECT', budgetId: 'pilot', reservation: '0.5', authorizationRef: 'fixture', payload: {} });
    api.beginOperation(db, 'op', mon); db.close();
    const recovered = api.openStore(join(dir, 'test.sqlite')); api.recoverOperations(recovered);
    assert.equal(api.operation(recovered, 'op').status, 'RECONCILIATION');
    assert.throws(() => api.beginOperation(recovered, 'op', mon), /reconcil|state/i);
    assert.throws(() => api.cancelOperation(recovered, 'op', 'timeout'), /dispatch|state/i);
    assert.equal(api.budgetStatus(recovered, 'pilot').reserved, '0.5');
    api.reconcileOperation(recovered, 'op', { status: 'SUCCEEDED', actual: '0.08', evidence: 'fixture receipt', remoteId: 'fixture-run' });
    assert.equal(api.budgetStatus(recovered, 'pilot').committed, '0.08');
    assert.throws(() => api.beginOperation(recovered, 'op', mon)); recovered.close();
  });
  test('unknown charge remains reserved; overrun records reality and blocks further spending', () => {
    const { db } = fixture(); api.createBudget(db, 'pilot', '1', '0', '0');
    api.reserveOperation(db, { id: 'op', kind: 'COLLECT', budgetId: 'pilot', reservation: '0.5', authorizationRef: 'fixture', payload: {} });
    api.beginOperation(db, 'op', mon);
    api.recordOutcome(db, 'op', { status: 'SUCCEEDED', actual: null, evidence: 'completion only', remoteId: 'fixture' });
    assert.equal(api.budgetStatus(db, 'pilot').reserved, '0.5');
    assert.throws(() => api.reserveOperation(db, { id: 'next', kind: 'COLLECT', budgetId: 'pilot', reservation: '0.1', authorizationRef: 'fixture', payload: {} }), /reconcil/i);
    api.reconcileOperation(db, 'op', { status: 'SUCCEEDED', actual: '1.01', evidence: 'invoice', remoteId: 'fixture' });
    assert.equal(api.budgetStatus(db, 'pilot').actual, '1.01');
    assert.equal(api.budgetStatus(db, 'pilot').blocked, true); db.close();
  });
  test('release dispatch rechecks stop and approval after reservation', () => {
    const { db } = fixture(); const { a } = ready(db); api.createBudget(db, 'pilot', '1', '0', '0');
    api.reserveOperation(db, { id: 'release', kind: 'RELEASE', budgetId: 'pilot', reservation: '0', authorizationRef: 'fixture', payload: { batchId: 'b', approvalId: a.id } });
    api.setStopped(db, true, 'stop before dispatch', mon);
    assert.throws(() => api.beginOperation(db, 'release', mon), /stopped/i);
    api.setStopped(db, false, 'fixture', mon); api.revokeApproval(db, a.id, 'revoked before dispatch');
    assert.throws(() => api.beginOperation(db, 'release', mon), /approval/i); db.close();
  });
  test('unknown fixed costs prevent new spending; separate connections share reservations', () => {
    const { dir, db } = fixture(); api.createBudget(db, 'daily', '20', '0', null);
    assert.throws(() => api.reserveOperation(db, { id: 'a', kind: 'COLLECT', budgetId: 'daily', reservation: '1', authorizationRef: 'fixture', payload: {} }), /fixed|budget/i);
    api.createBudget(db, 'pilot', '1', '0', '0');
    const other = api.openStore(join(dir, 'test.sqlite'));
    api.reserveOperation(db, { id: 'a', kind: 'COLLECT', budgetId: 'pilot', reservation: '0.6', authorizationRef: 'fixture', payload: {} });
    assert.throws(() => api.reserveOperation(other, { id: 'b', kind: 'COLLECT', budgetId: 'pilot', reservation: '0.6', authorizationRef: 'fixture', payload: {} }), /budget/i);
    other.close(); db.close();
  });
  test('credentials are rejected before records or batches can be persisted', () => {
    const { db } = fixture(); const generated = ['Bearer', 'local-fixture-' + Date.now()].join(' ');
    assert.throws(() => api.putRecord(db, 'evidence', 'secret', { note: generated }), /secret|credential/i);
    assert.throws(() => api.putRecord(db, 'evidence', 'secret', { apiKey: 'synthetic runtime value' }), /secret|credential/i);
    assert.equal(db.prepare("SELECT count(*) n FROM records WHERE id='secret'").get().n, 0); db.close();
  });
  test('backup restores into a separate stopped database and refuses overwrite/tampering', async () => {
    const { dir, db } = fixture(); ready(db);
    const path = join(dir, 'backup.sqlite'); await api.backupStore(db, path);
    const restoredPath = join(dir, 'restored.sqlite'); await api.restoreStore(path, restoredPath);
    const restored = api.openStore(restoredPath);
    assert.equal(restored.prepare('SELECT count(*) n FROM batches').get().n, 1);
    assert.equal(api.controls(restored).stopped, true); assert.equal(api.controls(restored).launchAuthorized, false);
    restored.close(); await assert.rejects(api.restoreStore(path, restoredPath), /exist/i);
    writeFileSync(path, 'tampered'); await assert.rejects(api.restoreStore(path, join(dir, 'bad.sqlite')), /hash|checksum/i); db.close();
  });
}
