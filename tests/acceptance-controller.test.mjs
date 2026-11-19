import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openStore, getRecord } from '../src/store.mjs';
import { digest } from '../src/values.mjs';
import { armAcceptance } from '../src/acceptance-authority.mjs';
import { runAcceptanceSequence } from '../src/acceptance-controller.mjs';

const manifest = { id: 'elya-acceptance-manifest-v1', limits: { sessionTotalMs: 1800000 } };
function setup(t) {
  const root = mkdtempSync(join(tmpdir(), 'elya-controller-'));
  const db = openStore(':memory:');
  writeFileSync(join(root, 'fixture'), 'fixture');
  armAcceptance(db, manifest, [{ path: 'fixture', sha256: digest('fixture') }], 1000);
  t.after(() => { db.close(); rmSync(root, { recursive: true, force: true }); });
  return { db, root, manifest, now: () => 2000 };
}
const pass = { status: 'PASSED', cleanup: { confirmed: true } };

test('only Telegram then two phases execute; consumed approval cannot execute again', async t => {
  const options = setup(t), calls = [];
  const telegram = async ({ assertAuthority }) => { assertAuthority(); calls.push('telegram'); return pass; };
  const instantly = async ({ phase, assertAuthority }) => { assertAuthority(); calls.push(phase); return { ...pass, phase }; };
  const result = await runAcceptanceSequence({ ...options, telegram, instantly });
  assert.equal(result.status, 'PASS');
  assert.deepEqual(calls, ['telegram', 1, 2]);
  assert.equal(getRecord(options.db, 'acceptance_authorization', manifest.id).status, 'CLOSED');
  await assert.rejects(runAcceptanceSequence({ ...options, telegram, instantly }), /ALREADY_USED/);
  assert.deepEqual(calls, ['telegram', 1, 2]);
});

test('failure or unconfirmed cleanup prevents subsequent phases without retry', async t => {
  for (const result of [{ status: 'UNCERTAIN', cleanup: { confirmed: true } }, { status: 'PASSED', cleanup: { confirmed: false } }]) {
    const options = setup(t); let later = 0;
    const run = await runAcceptanceSequence({ ...options, telegram: async () => result, instantly: async () => { later++; return pass; } });
    assert.equal(run.status, 'BLOCKED'); assert.equal(later, 0);
    assert.equal(run.authorizationStatus, 'CLOSED');
  }
});

test('new stop, cancellation and failed first contained phase block remaining dispatch', async t => {
  for (const mode of ['stop', 'cancel', 'phase']) {
    const options = setup(t); let cancelled = false; const calls = [];
    const result = await runAcceptanceSequence({ ...options, cancelled: () => cancelled,
      telegram: async () => {
        if (mode === 'stop') options.db.prepare("UPDATE controls SET updated_at='changed'").run();
        if (mode === 'cancel') cancelled = true;
        return pass;
      }, instantly: async ({ phase }) => { calls.push(phase); return { status: 'UNCERTAIN', cleanup: { confirmed: true }, reason: 'FIXTURE_TIMEOUT' }; },
    });
    assert.equal(result.status, 'BLOCKED');
    assert.deepEqual(calls, mode === 'phase' ? [1] : []);
    assert.equal(options.db.prepare('SELECT stopped FROM controls').get().stopped, 1);
  }
});
