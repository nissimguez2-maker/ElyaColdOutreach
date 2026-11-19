import { randomUUID } from 'node:crypto';
import { canonical, digest, required, timestamp } from './values.mjs';
import { transaction, journal, now, getRecord, controls } from './store.mjs';
import { evaluateWritingBatch } from './writing.mjs';
import { permitsIsolatedHandoff } from './handoff-isolation.mjs';
import { evaluateManualContactGate } from './manual-response.mjs';

function validateBatch(content) {
  canonical(content); required(content.campaignId, 'campaign');
  if (!content.sequence || Object.getPrototypeOf(content.sequence) !== Object.prototype || !content.settings || Object.getPrototypeOf(content.settings) !== Object.prototype || !Array.isArray(content.recipients) || !content.recipients.length) throw new Error('Recipients and plain sequence/settings objects required');
  const emails = new Set();
  for (const r of content.recipients) {
    required(r.candidateId); required(r.email);
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(r.email) || r.email !== r.email.toLowerCase() || emails.has(r.email)) throw new Error('Invalid or duplicate recipient');
    emails.add(r.email);
    if (!Array.isArray(r.messages) || !r.messages.length) throw new Error('Messages required');
    for (const m of r.messages) { required(m.subject); required(m.body); }
  }
}
export function hashBatch(content) { validateBatch(content); return digest(canonical(content)); }
export const latestBatch = (db, id) => db.prepare('SELECT * FROM batches WHERE batch_id=? ORDER BY version DESC LIMIT 1').get(id);
function bindings(db, recipients) {
  return recipients.map(r => ({ candidateId: r.candidateId, email: r.email,
    candidateHash: digest(canonical(getRecord(db, 'candidate', r.candidateId))),
    contactHash: digest(canonical(getRecord(db, 'contact', r.email))),
    ...(getRecord(db,'refinement_current',r.candidateId)?{refinementHash:getRecord(db,'refinement_current',r.candidateId).semanticHash}:{}) }));
}
// Can be used inside an import transaction; public caller wraps it below.
export function insertBatch(db, id, content) {
  required(id); validateBatch(content);
  content = { ...content, eligibilityBindings: bindings(db, content.recipients) };
  const hash = hashBatch(content), existing = latestBatch(db, id);
  if (existing?.hash === hash) return { version: existing.version, hash };
  const version = (existing?.version ?? 0) + 1;
  db.prepare('INSERT INTO batches VALUES(?,?,?,?,?)').run(id, version, hash, canonical(content), now());
  db.prepare("UPDATE approvals SET decision='INVALIDATED',reason='Material revision' WHERE batch_id=? AND decision='APPROVED'").run(id);
  journal(db, 'BATCH_VERSION', id, { version, hash }); return { version, hash };
}
export const createBatch = (db, id, content) => transaction(db, () => insertBatch(db, id, content));
export function decideApproval(db, batchId, version, hash, decision, actor, expiresAt, at = now()) {
  return transaction(db, () => insertApproval(db, batchId, version, hash, decision, actor, expiresAt, at));
}
// For authenticated adapters that must commit the decision and event receipt together.
export function insertApproval(db, batchId, version, hash, decision, actor, expiresAt, at = now()) {
  if (!db.isTransaction) throw new Error('Approval insert requires a transaction');
  if (!['APPROVED', 'REJECTED', 'REVISION_REQUESTED'].includes(decision)) throw new Error('Invalid approval decision');
  required(actor); if (timestamp(expiresAt) <= timestamp(at)) throw new Error('Approval already expired');
    const b = latestBatch(db, batchId);
    if (!b || b.version !== version) throw new Error('Stale batch version');
    if (b.hash !== hash) throw new Error('Approval hash mismatch');
    db.prepare("UPDATE approvals SET decision='REVOKED',reason='Superseded decision' WHERE batch_id=? AND decision='APPROVED'").run(batchId);
    const id = randomUUID();
    db.prepare('INSERT INTO approvals VALUES(?,?,?,?,?,?,?,?,?)').run(id, batchId, version, hash, decision, actor, expiresAt, at, null);
    journal(db, 'APPROVAL_DECISION', batchId, { id, version, hash, decision, actor }); return { id, decision };
}
export function revokeApproval(db, id, reason) {
  required(reason); transaction(db, () => {
    const r = db.prepare("UPDATE approvals SET decision='REVOKED',reason=? WHERE id=? AND decision='APPROVED'").run(reason, id);
    if (!r.changes) throw new Error('Active approval not found'); journal(db, 'APPROVAL_REVOKED', id, { reason });
  });
}
export function inSendingWindow(at) {
  timestamp(at);
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', weekday: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(new Date(at)).map(x => [x.type, x.value]));
  return ['Mon', 'Tue', 'Wed', 'Thu', 'Fri'].includes(p.weekday) && Number(p.hour) >= 9 && Number(p.hour) < 19;
}
export function evaluateRelease(db, batchId, approvalId, at = now(), options = {}) {
  const isolated = permitsIsolatedHandoff(db, options.fixtureAdapter);
  timestamp(at); const reasons = []; const c = controls(db);
  if (c.stopped) reasons.push('System stopped');
  if (!c.launchAuthorized) reasons.push('System launch not authorized');
  if (!inSendingWindow(at)) reasons.push('Outside New York sending window');
  const b = latestBatch(db, batchId), a = db.prepare('SELECT * FROM approvals WHERE id=?').get(approvalId);
  if (!b || !a || a.decision !== 'APPROVED' || a.batch_id !== batchId || a.version !== b.version || a.hash !== b.hash || timestamp(a.expires_at) <= timestamp(at) || timestamp(a.created_at) > timestamp(at)) reasons.push('Missing, stale, revoked, expired or mismatched approval');
  if (b) {
    const content = JSON.parse(b.content_json);
    if (!isolated && (content.settings?.syntheticOnly === true || content.campaignId === 'SYNTHETIC-ONLY-NO-CAMPAIGN')) reasons.push('Synthetic batches cannot be released');
    if (hashBatch(content) !== b.hash) reasons.push('Batch integrity failure');
    if (canonical(bindings(db, content.recipients)) !== canonical(content.eligibilityBindings)) reasons.push('Eligibility or attribution changed; new batch review required');
    // Known prospect campaigns require the writing contract even for historical batches.
    // Standalone legacy foundation fixtures remain scoped to their original local tests.
    if (getRecord(db,'campaign',content.campaignId)?.purpose==='prospect' || getRecord(db,'writing_policy',content.campaignId) || content.recipients.some(r=>r.writing)) {
      reasons.push(...evaluateWritingBatch(db,content,at,options).reasons);
    }
    for (const r of content.recipients) {
      reasons.push(...evaluateManualContactGate(db,{email:r.email,candidateId:r.candidateId,at}).reasons);
      const business = getRecord(db, 'candidate', r.candidateId), contact = getRecord(db, 'contact', r.email);
      const refinement=getRecord(db,'refinement_current',r.candidateId);
      if(refinement&&refinement.disposition!=='QUALIFIED_FOR_REVIEW')reasons.push(`Refinement held: ${r.candidateId}`);
      if (business?.qualification !== 'QUALIFIED') reasons.push(`Business held: ${r.candidateId}`);
      if (!contact || contact.candidateId !== r.candidateId || !contact.attribution || contact.verification !== 'PASSED' || contact.suppressed !== false) reasons.push(`Contact held: ${r.email}`);
    }
  }
  return { allowed: reasons.length === 0, reasons };
}
