import { DatabaseSync } from 'node:sqlite';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { openStore, getRecord } from './store.mjs';
import { ACCEPTANCE_ID, verifyAcceptanceSources, cancelAcceptance } from './acceptance-authority.mjs';
import { runAcceptanceSequence, acceptanceErrorCode } from './acceptance-controller.mjs';
import { runAcceptanceTelegram } from './acceptance-telegram.mjs';
import { runAcceptanceInstantly } from './acceptance-instantly.mjs';
import { createTelegramConsumerApi } from './telegram-api.mjs';
import { readProtected } from './windows-protected-storage.mjs';
import { formatAcceptanceEvent } from './acceptance-guidance.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const directory = join(root, 'work/acceptance-manifest-v1/live-once');
const manifest = JSON.parse(readFileSync(join(root, 'work/acceptance-manifest-v1/manifest.json'), 'utf8'));
const startedAtMs = Math.floor(performance.timeOrigin);
let db, syntheticDb, legacyDb, cancelled = false;
const cancel = () => {
  cancelled = true;
  try {
    const persisted = db && cancelAcceptance(db);
    console.log(persisted ? 'Cancellation persisted. New dispatch is blocked in parent and worker; waiting for bounded cleanup. Already accepted external actions cannot be recalled.' : 'Cancellation requested before an active launch; no next stage will start.');
  } catch {
    console.log('CANCELLATION_PERSISTENCE_UNCONFIRMED: an active worker may not yet see cancellation. No later phase will start; waiting for bounded cleanup.');
  }
};
function emit(event) {
  if (typeof event === 'string') { console.log(event); return; }
  console.log(formatAcceptanceEvent(event) ?? JSON.stringify(event));
}

try {
  if (process.argv.slice(2).join(' ') !== '--run-once') throw Error('USE_RUN_ONCE_ARGUMENT_ONLY');
  if (process.platform !== 'win32' || !process.stdin.isTTY || !process.stdout.isTTY) throw Error('NORMAL_USER_INTERACTIVE_POWERSHELL_REQUIRED');
  if (existsSync(directory)) throw Error('ACCEPTANCE_DIRECTORY_EXISTS_NO_SECOND_ATTEMPT');
  const dbPath = join(root, 'data/elya.sqlite');
  const legacyPath = join(root, manifest.telegram.knownDetails.receiptStore);
  if (!existsSync(dbPath) || !existsSync(legacyPath)) throw Error('EXISTING_ACCEPTANCE_EVIDENCE_REQUIRED');
  db = new DatabaseSync(dbPath);
  db.exec('PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000; PRAGMA synchronous=FULL;');
  const grant = getRecord(db, 'acceptance_authorization', ACCEPTANCE_ID);
  if (grant?.status !== 'APPROVED') throw Error('FRESH_APPROVED_ONE_USE_AUTHORIZATION_REQUIRED');
  verifyAcceptanceSources(root, grant);
  mkdirSync(directory);
  syntheticDb = openStore(join(directory, 'synthetic.sqlite'));
  legacyDb = new DatabaseSync(legacyPath, { readOnly: true });
  process.on('SIGINT', cancel); process.on('SIGTERM', cancel);
  console.log('Starting the ONE approved acceptance session. Telegram: 10 minutes/40 observable calls; then two contained Instantly launches, at most 7 exact business calls. No business launch or sending.');
  const result = await runAcceptanceSequence({
    db, manifest, root, startedAtMs, startedMono: 0, cancelled: () => cancelled, emit,
    telegram: options => runAcceptanceTelegram({ ...options, db, syntheticDb, legacyDb, manifest,
      loadToken: ms => readProtected(join(root, 'data/private/telegram-token.dpapi'), ms),
      makeApi: createTelegramConsumerApi,
    }),
    instantly: options => runAcceptanceInstantly({ ...options, db, manifest, directory, startedMono: 0, startedWall: startedAtMs }),
  });
  writeFileSync(join(directory, 'result.json'), JSON.stringify(result, null, 2), { flag: 'wx' });
  console.log(JSON.stringify(result, null, 2));
  process.exitCode = result.status === 'PASS' ? 0 : 2;
} catch (error) {
  console.log(JSON.stringify({ status: 'BLOCKED', reason: acceptanceErrorCode(error), noAutomaticRetry: true, evidenceDirectory: directory }));
  process.exitCode = 2;
} finally {
  process.removeListener('SIGINT', cancel); process.removeListener('SIGTERM', cancel);
  legacyDb?.close(); syntheticDb?.close(); db?.close();
}
