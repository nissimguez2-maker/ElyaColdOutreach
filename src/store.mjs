import { DatabaseSync, backup } from 'node:sqlite';
import { readFileSync, writeFileSync, mkdirSync, existsSync, openSync, closeSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { canonical, digest, required } from './values.mjs';

export const now = () => new Date().toISOString();
export function openStore(path) {
  if (path !== ':memory:') mkdirSync(dirname(resolve(path)), { recursive: true });
  const db = new DatabaseSync(path);
  try {
    db.exec('PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;');
    const meta = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='metadata'").get();
    if (meta && db.prepare("SELECT value FROM metadata WHERE key='schema_version'").get()?.value !== '1') throw new Error('Unsupported schema version');
    db.exec(readFileSync(new URL('./schema.sql', import.meta.url), 'utf8'));
    return db;
  } catch (error) { db.close(); throw error; }
}
export function transaction(db, fn) {
  db.exec('BEGIN IMMEDIATE');
  try { const result = fn(); db.exec('COMMIT'); return result; }
  catch (error) { db.exec('ROLLBACK'); throw error; }
}
export function journal(db, event, subject, details = {}) {
  db.prepare('INSERT INTO journal(event,subject,details_json,recorded_at) VALUES(?,?,?,?)').run(required(event), required(subject), canonical(details), now());
}
export function putRecord(db, kind, id, data, basis = 'assessment', sourceId = null, pointer = null) {
  if (!['confirmed','provider_result','user_reported','estimate','unresolved','assessment','configuration'].includes(basis)) throw new Error('Unsupported provenance basis');
  if (!db.isTransaction) return transaction(db, () => putRecord(db, kind, id, data, basis, sourceId, pointer));
  const encoded = canonical(data); required(kind); required(id);
  if (kind === 'draft') {
    const old = db.prepare("SELECT data_json FROM records WHERE kind='draft' AND id=?").get(id);
    if (old && old.data_json !== encoded) throw new Error('Draft version is immutable; use a new version ID');
  }
  db.prepare('INSERT OR IGNORE INTO record_history VALUES(?,?,?,?,?,?,?,?)').run(kind, id, digest(canonical({ data, basis, sourceId, pointer })), encoded, basis, sourceId, pointer, now());
  db.prepare(`INSERT INTO records VALUES(?,?,?,?,?,?,?) ON CONFLICT(kind,id) DO UPDATE SET
    data_json=excluded.data_json,basis=excluded.basis,source_id=excluded.source_id,pointer=excluded.pointer,updated_at=excluded.updated_at
    WHERE records.data_json<>excluded.data_json OR records.basis<>excluded.basis OR records.source_id IS NOT excluded.source_id OR records.pointer IS NOT excluded.pointer`).run(kind, id, encoded, basis, sourceId, pointer, now());
}
export function getRecord(db, kind, id) { const row = db.prepare('SELECT data_json FROM records WHERE kind=? AND id=?').get(kind, id); return row ? JSON.parse(row.data_json) : null; }
export function controls(db) { const r = db.prepare('SELECT * FROM controls WHERE singleton=1').get(); return { stopped: !!r.stopped, launchAuthorized: !!r.launch_authorized, reason: r.reason, updatedAt: r.updated_at }; }
function updateControl(db, key, value, reason, at = now()) {
  if (typeof value !== 'boolean') throw new Error('Boolean control required'); required(reason);
  transaction(db, () => { db.prepare(`UPDATE controls SET ${key}=?,reason=?,updated_at=? WHERE singleton=1`).run(Number(value), reason, at); journal(db, key, 'system', { value, reason }); });
}
export const setStopped = (db, value, reason, at) => updateControl(db, 'stopped', value, reason, at);
export const setLaunch = (db, value, reason, at) => updateControl(db, 'launch_authorized', value, reason, at);
function exclusiveDestination(path) { mkdirSync(dirname(resolve(path)), { recursive: true }); closeSync(openSync(path, 'wx')); }
export async function backupStore(db, path) {
  if (existsSync(path) || existsSync(`${path}.manifest.json`)) throw new Error('Backup destination already exists');
  exclusiveDestination(path);
  await backup(db, path);
  const snapshot = new DatabaseSync(path);
  try {
    // The newly created snapshot must be self-contained, without WAL sidecars.
    snapshot.exec('PRAGMA journal_mode=DELETE;');
    if (snapshot.prepare('PRAGMA integrity_check').get().integrity_check !== 'ok' || snapshot.prepare("SELECT value FROM metadata WHERE key='schema_version'").get()?.value !== '1') throw new Error('Backup integrity/schema failure');
    if (snapshot.prepare('PRAGMA foreign_key_check').all().length) throw new Error('Backup foreign key failure');
  } finally { snapshot.close(); }
  const manifest = { schemaVersion: 1, sha256: digest(readFileSync(path)), createdAt: now(), integrity: 'ok', foreignKeyViolations: 0 };
  writeFileSync(`${path}.manifest.json`, JSON.stringify(manifest, null, 2), { flag: 'wx' }); return manifest;
}
export async function restoreStore(path, destination) {
  if (existsSync(destination)) throw new Error('Restore destination already exists');
  const manifest = JSON.parse(readFileSync(`${path}.manifest.json`, 'utf8'));
  if (manifest.schemaVersion !== 1 || digest(readFileSync(path)) !== manifest.sha256) throw new Error('Backup checksum or schema mismatch');
  const source = new DatabaseSync(path, { readOnly: true });
  try {
    if (source.prepare('PRAGMA integrity_check').get().integrity_check !== 'ok' || source.prepare("SELECT value FROM metadata WHERE key='schema_version'").get()?.value !== '1') throw new Error('Backup integrity/schema failure');
    if (source.prepare('PRAGMA foreign_key_check').all().length) throw new Error('Backup foreign key failure');
    exclusiveDestination(destination); await backup(source, destination);
  } finally { source.close(); }
  const restored = openStore(destination);
  try {
    transaction(restored, () => {
      restored.prepare("UPDATE controls SET stopped=1,launch_authorized=0,reason='Restored: explicit reauthorization required',updated_at=? WHERE singleton=1").run(now());
      restored.prepare("UPDATE operations SET status='RECONCILIATION',updated_at=? WHERE status='DISPATCHING'").run(now());
      journal(restored, 'RESTORED_STOPPED', 'system', { backupHash: manifest.sha256 });
    });
  } finally { restored.close(); }
}
