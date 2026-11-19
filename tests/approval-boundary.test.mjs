import test from 'node:test';
import assert from 'node:assert/strict';
import * as a from '../src/foundation.mjs';

test('changes to an approved attribution or qualification binding require a new batch review', () => {
  const db = a.openStore(':memory:');
  a.putRecord(db, 'candidate', 'b', { qualification: 'QUALIFIED' });
  a.putRecord(db, 'contact', 'qa@example.test', { candidateId: 'b', attribution: 'Generic inbox', verification: 'PASSED', suppressed: false });
  const content = { campaignId: 'synthetic', recipients: [{ candidateId: 'b', email: 'qa@example.test', messages: [{ subject: 'QA', body: 'Synthetic' }] }], sequence: {}, settings: {} };
  const b = a.createBatch(db, 'batch', content);
  const approval = a.decideApproval(db, 'batch', b.version, b.hash, 'APPROVED', 'fixture', '2026-11-20T00:00:00Z', '2026-11-16T15:00:00Z');
  a.setStopped(db, false, 'fixture'); a.setLaunch(db, true, 'fixture');
  assert.equal(a.evaluateRelease(db, 'batch', approval.id, '2026-11-16T16:00:00Z').allowed, true);
  a.putRecord(db, 'contact', 'qa@example.test', { candidateId: 'b', attribution: 'Now claimed personal owner mailbox', verification: 'PASSED', suppressed: false });
  assert.equal(a.evaluateRelease(db, 'batch', approval.id, '2026-11-16T16:00:00Z').allowed, false);
  assert.equal(a.createBatch(db, 'batch', content).version, 2); db.close();
});
test('draft version IDs cannot be overwritten and material settings must be explicit plain objects', () => {
  const db = a.openStore(':memory:'); a.putRecord(db, 'draft', 'b:v1:step1', { body: 'Original', status: 'UNAPPROVED' });
  assert.throws(() => a.putRecord(db, 'draft', 'b:v1:step1', { body: 'Changed', status: 'UNAPPROVED' }), /immutable|version/i);
  const content = { campaignId: 'synthetic', recipients: [{ candidateId: 'b', email: 'qa@example.test', messages: [{ subject: 'QA', body: 'Synthetic' }] }], sequence: 'unknown', settings: true };
  assert.throws(() => a.hashBatch(content)); db.close();
});
test('reapproving an unchanged batch cannot duplicate a completed release', () => {
  const db = a.openStore(':memory:'); a.createBudget(db, 'b', '1', '0', '0');
  a.putRecord(db, 'candidate', 'b', { qualification: 'QUALIFIED' });
  a.putRecord(db, 'contact', 'qa@example.test', { candidateId: 'b', attribution: 'Synthetic', verification: 'PASSED', suppressed: false });
  const content = { campaignId: 'synthetic', recipients: [{ candidateId: 'b', email: 'qa@example.test', messages: [{ subject: 'QA', body: 'Synthetic' }] }], sequence: {}, settings: {} };
  const b = a.createBatch(db, 'batch', content);
  a.setStopped(db, false, 'fixture'); a.setLaunch(db, true, 'fixture');
  const approve = () => a.decideApproval(db, 'batch', b.version, b.hash, 'APPROVED', 'fixture', '2026-11-20T00:00:00Z', '2026-11-16T15:00:00Z');
  const intent = id => ({ id, kind: 'RELEASE', budgetId: 'b', reservation: '0', authorizationRef: 'fixture', payload: { batchId: 'batch', approvalId: approve().id } });
  a.reserveOperation(db, intent('first')); a.beginOperation(db, 'first', '2026-11-16T16:00:00Z');
  a.recordOutcome(db, 'first', { status: 'SUCCEEDED', actual: '0', evidence: 'offline-only synthetic receipt' });
  assert.throws(() => a.reserveOperation(db, intent('second')), /duplicate/i); db.close();
});
