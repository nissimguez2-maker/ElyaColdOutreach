import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openStore, controls, digest, getRecord, putRecord, budgetStatus } from '../src/foundation.mjs';
const importer = await import('../src/import.mjs').catch(() => null);
test('historical importer is available', () => assert.ok(importer, 'Importer not implemented'));
if (importer) {
  test('preserved real sources reconcile, import twice without duplication or overwriting newer state', () => {
    const dir = mkdtempSync(join(tmpdir(), 'elya-import-')); const db = openStore(join(dir, 'state.sqlite'));
    const paths = importer.sourcePaths(process.cwd()); const before = paths.map(p => digest(readFileSync(p.path)));
    const first = importer.importProject(db, process.cwd());
    assert.equal(first.counts.candidate, 15); assert.equal(first.counts.contact, 4);
    assert.equal(first.counts.verification, 2); assert.equal(first.counts.draft, 12);
    assert.equal(first.counts.run, 21); assert.equal(first.counts.campaign, 2); assert.equal(first.counts.qa_lead, 1);
    assert.deepEqual(first.funnel, { qualified: 2, contactsChecked: 2, verificationPassed: 0, latestDrafts: 6, approvedDrafts: 0, prospectUploads: 0, prospectSends: 0 });
    assert.equal(getRecord(db, 'contact', 'main@m2ogroup.com').verification, 'HELD_CONFLICTING_PROVIDER_RESULT_MX_PRESENT');
    assert.equal(getRecord(db, 'contact', 'lindsey@chbrewing.com').verification, 'PROVIDER_RISKY_CATCH_ALL_HELD');
    assert.equal(getRecord(db, 'qa_rendering', 'three-step-preview').status, 'CLOSED_PASSED');
    assert.equal(budgetStatus(db, 'historical-pilot').baseline, '0.2');
    assert.equal(budgetStatus(db, 'historical-pilot').reserved, '0.15');
    assert.equal(budgetStatus(db, 'historical-pilot').actual, '0');
    assert.equal(controls(db).stopped, true); assert.equal(controls(db).launchAuthorized, false);
    const count = () => db.prepare('SELECT count(*) n FROM record_history').get().n;
    putRecord(db, 'candidate', 'PHL-01', { qualification: 'HELD', laterNote: 'Do not reset on replay' });
    const beforeRepeat = count(); const second = importer.importProject(db, process.cwd());
    assert.equal(second.replayed, true); assert.equal(count(), beforeRepeat);
    assert.equal(getRecord(db, 'candidate', 'PHL-01').laterNote, 'Do not reset on replay');
    assert.deepEqual(paths.map(p => digest(readFileSync(p.path))), before);
    assert.equal(db.prepare('SELECT count(*) n FROM approvals').get().n, 0);
    assert.equal(db.prepare('SELECT count(*) n FROM batches').get().n, 2);
    db.close();
  });
  test('source parsing preserves numeric precision and removes credentials including embedded JSON', () => {
    const dir = mkdtempSync(join(tmpdir(), 'elya-source-')); const file = join(dir, 'source.json');
    const generated = ['Bearer', 'fixture-' + Date.now()].join(' ');
    writeFileSync(file, '{"amountUsd":0.123456789012345678901,"nested":' + JSON.stringify(JSON.stringify({ apiKey: generated })) + '}');
    const source = importer.readSource({ id: 'fixture', path: file });
    assert.equal(source.data.amountUsd, '0.123456789012345678901');
    assert.ok(!JSON.stringify(source.data).includes(generated));
    assert.ok(source.redactions > 0);
  });
}
