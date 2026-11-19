import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openStore, putRecord, getRecord } from '../src/store.mjs';
import { digest } from '../src/values.mjs';
import { armAcceptance, claimAcceptance, assertAcceptance, closeAcceptance, cancelAcceptance, verifyAcceptanceSources, ACCEPTANCE_ID } from '../src/acceptance-authority.mjs';

const manifest = { id: 'elya-acceptance-manifest-v1', limits: { sessionTotalMs: 1800000 } };
function fixture(t) {
  const db = openStore(':memory:');
  const root = mkdtempSync(join(tmpdir(), 'elya-authority-'));
  writeFileSync(join(root, 'runner.mjs'), '/* offline fixture */');
  putRecord(db, 'draft', 'original', { approved: false }, 'confirmed');
  putRecord(db, 'telegram_writing_cursor', 'primary', { nextOffset: 64381638 });
  const fingerprints = [{ path: 'runner.mjs', sha256: digest('/* offline fixture */') }];
  t.after(() => { db.close(); rmSync(root, { recursive: true, force: true }); });
  return { db, root, fingerprints };
}

test('one-use approval begins its time allowance at claim; closes without opening business controls', t => {
  const { db, root, fingerprints } = fixture(t);
  armAcceptance(db, manifest, fingerprints, 1000);
  const grant = claimAcceptance(db, manifest, 9000000);
  assert.equal(Date.parse(grant.deadlineAt), 10800000);
  assert.equal(grant.maxDetailsMessages, 0);
  assert.equal(grant.historicalPrefixRetirementApproved, true);
  verifyAcceptanceSources(root, grant);
  assertAcceptance(db, manifest, 9000001);
  assert.throws(() => claimAcceptance(db, manifest, 9000002), /ALREADY_USED/);
  closeAcceptance(db, { status: 'PASS', reason: 'FIXTURE_ONLY' }, 9000003);
  assert.equal(getRecord(db, 'acceptance_authorization', ACCEPTANCE_ID).status, 'CLOSED');
  assert.throws(() => assertAcceptance(db, manifest, 9000004), /NOT_ACTIVE/);
  assert.throws(() => armAcceptance(db, manifest, fingerprints), /ALREADY_EXISTS/);
  assert.equal(db.prepare('SELECT stopped FROM controls').get().stopped, 1);
});

test('missing, changed, expired and concurrent authorizations are denied', t => {
  const { db, fingerprints } = fixture(t);
  assert.throws(() => claimAcceptance(db, manifest), /MISSING/);
  armAcceptance(db, manifest, fingerprints, 1000);
  assert.throws(() => claimAcceptance(db, { ...manifest, changed: true }, 2000), /MANIFEST_CHANGED/);
  claimAcceptance(db, manifest, 2000);
  assert.throws(() => assertAcceptance(db, manifest, 1802000), /DEADLINE/);
  assert.throws(() => claimAcceptance(db, manifest, 3000), /ALREADY_USED/);
});

test('protected business data, budgets, source changes and stop-state changes fail closed', t => {
  const { db, root, fingerprints } = fixture(t);
  armAcceptance(db, manifest, fingerprints);
  const grant = claimAcceptance(db, manifest);
  putRecord(db, 'acceptance_fixture', 'new', { synthetic: true });
  putRecord(db, 'telegram_writing_cursor', 'primary', { nextOffset: 64381642 });
  assertAcceptance(db, manifest);
  writeFileSync(join(root, 'runner.mjs'), 'changed');
  assert.throws(() => verifyAcceptanceSources(root, grant), /SOURCE_CHANGED/);
  db.prepare("UPDATE records SET data_json=? WHERE kind='draft'").run('{"approved":true}');
  assert.throws(() => assertAcceptance(db, manifest), /PROTECTED_STATE_CHANGED/);
});

test('persisted cancellation is visible to a separately reconstructed worker authority and closure remains possible', t => {
  const { db, fingerprints } = fixture(t);
  assert.equal(cancelAcceptance(db), false);
  armAcceptance(db, manifest, fingerprints);
  claimAcceptance(db, manifest);
  assertAcceptance(db, manifest);
  assert.equal(cancelAcceptance(db), true);
  assert.throws(() => assertAcceptance(db, manifest), /ACCEPTANCE_CANCELLED/);
  assert.equal(cancelAcceptance(db), true);
  closeAcceptance(db, { status: 'BLOCKED', reason: 'ACCEPTANCE_CANCELLED' });
  assert.equal(getRecord(db, 'acceptance_authorization', ACCEPTANCE_ID).status, 'CLOSED');
  assert.equal(db.prepare('SELECT stopped FROM controls').get().stopped, 1);
});

test('business stop updates prevent further dispatch and historical budget stays untouched', t => {
  const { db, fingerprints } = fixture(t);
  db.prepare('INSERT INTO budgets VALUES(?,?,?,?,?,?)').run('historical', '3', '0', null, 'user_reported', 0);
  const before = JSON.stringify(db.prepare('SELECT * FROM budgets').all());
  armAcceptance(db, manifest, fingerprints);
  claimAcceptance(db, manifest);
  db.prepare("UPDATE controls SET updated_at='2026-11-17T00:00:00Z'").run();
  assert.throws(() => assertAcceptance(db, manifest), /CONTROLS_CHANGED/);
  closeAcceptance(db, { status: 'BLOCKED', reason: 'STOPPED' });
  assert.equal(JSON.stringify(db.prepare('SELECT * FROM budgets').all()), before);
});
