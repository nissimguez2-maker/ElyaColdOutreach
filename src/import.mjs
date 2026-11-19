import { readFileSync } from 'node:fs';
import { resolve, basename } from 'node:path';
import { homedir } from 'node:os';
import { digest, parseLossless, assertSafe, canonical } from './values.mjs';
import { transaction, putRecord, getRecord, journal, now } from './store.mjs';
import { insertBatch } from './batches.mjs';
import { createBudget } from './operations.mjs';

const oldRoot = resolve(homedir(), 'Documents/Codex/2026-11-16/files-pasted-by-the-user-project/outputs');
const localSources = [
  'outputs/benchmark-comparison.json', 'outputs/benchmark-run-record.json', 'outputs/five-site-benchmark-proposal.json',
  'work/recovery-research-and-drafts.json', 'work/draft-revision-2-and-verification.json', 'work/synthetic-qa-created-record.json',
  'work/qa-preview-step3-user-confirmation.json', 'work/two-address-verification-raw.json', 'work/verification-preflight.json',
  'work/instantly-capability-inspection.json', 'work/dns-diagnosis-and-synthetic-qa-proposal.json',
  'work/m2ogroup-dns-diagnosis.json', 'work/m2ogroup-dns-resolver-results.json',
  'work/apify-website-content-crawler-inspection.json', 'work/apify~website-content-crawler.json',
  'work/scrapersdelight-local-business-enricher-inspection.json', 'work/scrapersdelight~local-business-enricher.json',
  'work/vdrmota-contact-info-scraper-inspection.json', 'work/vdrmota~contact-info-scraper.json'
];
export function sourcePaths(root) {
  return [...localSources.map(p => ({ id: p, path: resolve(root, p) })),
    ...['philadelphia-discovery-record.json', 'philadelphia-evidence-summary.json', 'philadelphia-evidence-ledger.json', 'elya-outreach-audit-2026-11-16.json'].map(p => ({ id: `original/${p}`, path: resolve(oldRoot, p) })),
    { id: 'brain', path: resolve(homedir(), 'Downloads/Elya-Partners-Cold-Outreach-Brain.md'), metadataOnly: true }];
}
export function readSource(entry) {
  const bytes = readFileSync(entry.path); let redactions = 0;
  function sanitize(v) {
    if (Array.isArray(v)) return v.map(sanitize);
    if (v && typeof v === 'object') {
      const out = {};
      for (const [k, child] of Object.entries(v)) {
        try { assertSafe({ [k]: typeof child === 'object' ? 'field-type-probe' : child }); out[k] = sanitize(child); }
        catch { out[k] = '[REDACTED]'; redactions++; }
      }
      return out;
    }
    if (typeof v === 'string' && /^\s*[\[{]/.test(v)) {
      try { return JSON.stringify(sanitize(parseLossless(v))); } catch { /* ordinary prose */ }
    }
    try { assertSafe(v); return v; } catch { redactions++; return '[REDACTED]'; }
  }
  const data = entry.metadataOnly ? { fileName: basename(entry.path), preservation: 'External original retained; content not copied', bytes: bytes.length } : sanitize(parseLossless(bytes.toString('utf8')));
  return { ...entry, sha256: digest(bytes), data, redactions };
}
const unwrap = x => x?.structuredContent ?? x;
export function recordCounts(db) { return Object.fromEntries(db.prepare('SELECT kind,count(*) n FROM records GROUP BY kind ORDER BY kind').all().map(r => [r.kind, r.n])); }

export function importProject(db, root) {
  const sources = sourcePaths(root).map(readSource);
  const manifestHash = digest(canonical(sources.map(s => ({ id: s.id, sha256: s.sha256 }))));
  return transaction(db, () => {
    const previous = db.prepare("SELECT value FROM metadata WHERE key='import_manifest_hash'").get();
    if (previous) {
      if (previous.value !== manifestHash) throw new Error('Preserved source changed: explicit migration review required; no partial import');
      return { ...getRecord(db, 'import_report', 'initial'), replayed: true };
    }
    const byId = new Map(sources.map(s => [s.id, s]));
    for (const s of sources) db.prepare('INSERT INTO sources VALUES(?,?,?,?,?)').run(s.id, s.path, s.sha256, canonical(s.data), now());
    const data = id => byId.get(id).data;
    const write = (kind, id, value, basis, sourceId, pointer) => putRecord(db, kind, id, value, basis, sourceId, pointer);
    const discoveryId = 'original/philadelphia-discovery-record.json', summaryId = 'original/philadelphia-evidence-summary.json', ledgerId = 'original/philadelphia-evidence-ledger.json';
    const currentId = 'work/recovery-research-and-drafts.json', verifyId = 'work/two-address-verification-raw.json', benchmarkId = 'outputs/benchmark-run-record.json';
    const discovery = data(discoveryId), summary = data(summaryId), ledger = data(ledgerId), current = data(currentId), verification = data(verifyId), benchmark = data(benchmarkId);
    if (discovery.candidates.length !== 15 || summary.candidates.length !== 15 || current.qualification.length !== 3 || current.drafts.length !== 2 || current.originalDraftsVersion1.length !== 2) throw new Error('Unexpected pilot source shape');
    const candidateMap = new Map();
    for (const [i, c] of discovery.candidates.entries()) {
      const row = { candidateId: c.candidateId, name: c.business, address: c.address, website: c.website, qualification: 'HELD', status: c.status, sourceUrl: c.sourceUrl };
      candidateMap.set(c.candidateId, row);
      write('candidate', c.candidateId, row, 'provider_result', discoveryId, `/candidates/${i}`);
      for (const item of c.emails) {
        const email = typeof item === 'string' ? item : item.email;
        write('contact', email.toLowerCase(), { candidateId: c.candidateId, email, attribution: item.attribution ?? 'Provider-extracted address; identity/authority unconfirmed', verification: 'NOT_RUN', suppressed: null, sources: [item.sourceWebsite ?? c.sourceUrl] }, 'provider_result', discoveryId, `/candidates/${i}/emails`);
      }
    }
    for (const [i, c] of summary.candidates.entries()) {
      const row = candidateMap.get(c.candidateId); if (!row) throw new Error('Unknown historical candidate');
      Object.assign(row, { status: c.status, reason: c.reason });
      write('candidate', c.candidateId, row, 'assessment', summaryId, `/candidates/${i}`);
      write('qualification', c.candidateId, c, 'assessment', summaryId, `/candidates/${i}`);
    }
    for (const [i, c] of summary.contacts.entries()) write('contact', c.email.toLowerCase(), { ...c, verification: 'NOT_RUN', suppressed: null }, 'assessment', summaryId, `/contacts/${i}`);
    for (const [i, c] of current.qualification.entries()) {
      const row = candidateMap.get(c.id); if (!row) throw new Error('Unknown current candidate');
      Object.assign(row, { qualification: c.status === 'BUSINESS_EVIDENCE_QUALIFIED' ? 'QUALIFIED' : 'HELD', status: c.status, reason: c.independence });
      write('candidate', c.id, row, 'assessment', currentId, `/qualification/${i}`);
      write('qualification', c.id, c, 'assessment', currentId, `/qualification/${i}`);
      write('contact', c.email.toLowerCase(), { candidateId: c.id, email: c.email, attribution: c.attribution, verification: c.verification, suppressed: null, sources: c.sources, authorityConfirmed: false }, 'assessment', currentId, `/qualification/${i}`);
      write('attribution', c.email.toLowerCase(), { candidateId: c.id, description: c.attribution, sources: c.sources, mailboxControllerVerified: false }, 'assessment', currentId, `/qualification/${i}/attribution`);
      for (const [j, url] of c.sources.entries()) write('evidence', `${c.id}:research:${j}`, { candidateId: c.id, url, claims: { age: c.age, independence: c.independence, copyFacts: c.copyFacts ?? [], uncertainty: c.accessLimitation ?? c.ownerIdentity ?? null }, note: 'Source-linked research assessment; not a new fetch or blanket confirmation' }, 'assessment', currentId, `/qualification/${i}/sources/${j}`);
    }
    for (const [i, fact] of summary.toskaFacts.entries()) write('evidence', `PHL-12:early-fact:${i}`, fact, 'assessment', summaryId, `/toskaFacts/${i}`);
    function run(runId, result, sourceId, pointer, extras = {}) {
      if (!runId || !result) throw new Error('Run provenance missing');
      write('run', runId, { ...unwrap(result), ...extras, actualChargeUsd: null, runChargeVerified: false }, 'provider_result', sourceId, pointer);
    }
    run(discovery.runId, discovery.finalRunResponse, discoveryId, '/finalRunResponse', { requestedCapUsd: discovery.limits.discoveryRunCapUsd, serverAppliedCapVerified: false });
    for (const [i, r] of ledger.runs.entries()) {
      run(r.runId, r.launchResponse, ledgerId, `/runs/${i}`, { requestedCapUsd: r.request.callOptions.maxTotalChargeUsd, serverAppliedCapVerified: false });
      for (const [j, item] of unwrap(r.results).items.entries()) write('evidence', `${r.runId}:page:${j}`, { candidateId: r.candidateId, url: r.url, runId: r.runId, item }, 'provider_result', ledgerId, `/runs/${i}/results/items/${j}`);
    }
    for (const [i, r] of benchmark.runs.entries()) run(r.runId, r.final, benchmarkId, `/runs/${i}/final`, { requestedCapUsd: r.request.callOptions.maxTotalChargeUsd, serverAppliedCapVerified: false, collectedResults: unwrap(r.results) });
    for (const [i, attempt] of benchmark.validationAttempts.entries()) write('validation_attempt', `benchmark:${i}`, attempt, 'provider_result', benchmarkId, `/validationAttempts/${i}`);
    const verificationRun = unwrap(verification.run);
    run(verificationRun.runId, verification.run, verifyId, '/run', { requestedCapUsd: verification.request.callOptions.maxTotalChargeUsd, serverAppliedCapVerified: false });
    const checked = unwrap(verification.results).items;
    if (checked.length !== 2) throw new Error('Unexpected verification results');
    for (const [i, result] of checked.entries()) write('verification', `${verificationRun.runId}:${result.email}`, result, 'provider_result', verifyId, `/results/structuredContent/items/${i}`);
    write('dns_observation', 'm2ogroup.com', current.independentDnsDiagnosis, 'confirmed', currentId, '/independentDnsDiagnosis');
    const campaignId = current.latestRevision.instantly.campaignId;
    write('campaign', campaignId, { id: campaignId, purpose: 'prospect', snapshot: current.latestRevision.instantly, liveStatus: 'NOT_RECHECKED', mustRemainInactive: true }, 'provider_result', currentId, '/latestRevision/instantly');
    const qa = current.syntheticQaSetup, qaCampaign = unwrap(qa.latestReadOnlyConfirmation.liveReadback.campaign), qaLead = unwrap(qa.leadCreated);
    write('campaign', qaCampaign.id, { ...qaCampaign, purpose: 'synthetic_qa', liveStatus: 'NOT_RECHECKED', mustRemainInactive: true }, 'provider_result', currentId, '/syntheticQaSetup/latestReadOnlyConfirmation/liveReadback/campaign');
    write('qa_lead', qaLead.id, qaLead, 'provider_result', currentId, '/syntheticQaSetup/leadCreated');
    write('qa_rendering', 'three-step-preview', qa.renderingMilestone, 'user_reported', currentId, '/syntheticQaSetup/renderingMilestone');
    function drafts(sequences, version, field) {
      const recipients = [];
      for (const [i, sequence] of sequences.entries()) {
        const c = current.qualification.find(c => c.business === sequence.business || sequence.email && c.email === sequence.email); if (!c) throw new Error('Draft business mismatch');
        const messages = sequence.messages.map(m => ({ subject: m.subject, body: m.body }));
        for (const [j, m] of sequence.messages.entries()) write('draft', `${c.id}:v${version}:step${j + 1}`, { candidateId: c.id, email: c.email, version, step: j + 1, status: 'UNAPPROVED', ...m }, 'configuration', currentId, `/${field}/${i}/messages/${j}`);
        recipients.push({ candidateId: c.id, email: c.email, messages });
      }
      insertBatch(db, 'philadelphia-prospect-drafts', { campaignId, recipients, sequence: { steps: 3, cadence: 'UNAPPROVED' }, settings: { timezone: 'America/New_York', weekdays: [1,2,3,4,5], from: '09:00', to: '19:00', launchAuthorized: false, writingVersion: version } });
    }
    drafts(current.originalDraftsVersion1, 1, 'originalDraftsVersion1'); drafts(current.drafts, 2, 'drafts');
    // Preserve all monetary claims as historical observations, never summed as actual charges.
    for (const s of sources) {
      function visit(value, pointer = '') {
        if (!value || typeof value !== 'object') return;
        for (const [key, child] of Object.entries(value)) {
          const p = `${pointer}/${key.replace(/~/g, '~0').replace(/\//g, '~1')}`;
          if (/Usd$/i.test(key) && (child === null || typeof child === 'string' && /^\d+(?:\.\d+)?$/.test(child))) {
            const basis = child === null ? 'unresolved' : /reported|balanceEvidence/.test(p) ? 'user_reported' : /estimat/i.test(p) ? 'estimate' : /actual/i.test(key) ? 'unresolved' : 'configuration';
            write('spending_observation', `${s.id}:${p}`, { field: key, amountUsd: child, precision: 'Original numeric token retained as decimal text', interpretation: 'Historical observation; not automatically an additive expense' }, basis, s.id, p);
          }
          visit(child, p);
        }
      }
      visit(s.data);
    }
    createBudget(db, 'historical-pilot', current.accounting.pilotCeilingUsd, current.accounting.reportedAccountUsageUsd, '0', 'User-reported rounded account total; not independently verified run billing');
    // Not executable work: retained accounting allowance for an already completed run.
    const held = { historicalRunId: verificationRun.runId, note: 'Execution succeeded; charge unresolved. Reconcile without rerun.' };
    db.prepare('INSERT INTO operations VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)').run(`historical:${verificationRun.runId}`, 'VERIFY', 'historical-pilot', digest(canonical(held)), canonical(held), 'RECONCILIATION', current.accounting.verificationReservationRetainedUsd, null, verificationRun.runId, 'Latest working accounting retained this allowance', now(), now(), null);
    createBudget(db, 'weekday-policy', '20', '0', null, 'User budget policy only; fixed costs unknown; not paid-run authorization');
    write('settings', 'baseline', { timezone: 'America/New_York', sendingWindow: 'Mon-Fri 09:00 inclusive to 19:00 exclusive', dailyBudgetUsd: '20', noNewPaidAuthority: true, brainSha256: byId.get('brain').sha256, reportedAccountTotalUsd: current.accounting.reportedAccountUsageUsd, reportedPrecision: current.accounting.reportedPrecision }, 'configuration', currentId, '/accounting');
    const counts = recordCounts(db);
    const funnel = { qualified: [...candidateMap.values()].filter(c => c.qualification === 'QUALIFIED').length, contactsChecked: checked.length, verificationPassed: 0, latestDrafts: current.drafts.reduce((n, d) => n + d.messages.length, 0), approvedDrafts: 0, prospectUploads: 0, prospectSends: 0 };
    const expected = { candidate: 15, contact: 4, verification: 2, draft: 12, run: 21, campaign: 2, qa_lead: 1 };
    for (const [kind, count] of Object.entries(expected)) if (counts[kind] !== count) throw new Error(`Import reconciliation failed for ${kind}`);
    const report = { importedAt: now(), manifestHash, sourceCount: sources.length, redactedFields: sources.reduce((n, s) => n + s.redactions, 0), counts, funnel, replayed: false,
      ambiguities: ['Account total is rounded user report, not per-run billing; actual sum zero means no independently booked run charges, not free execution.', 'Retained verification allowance 0.15 may overlap reported account total; conservative commitment 0.35.', 'Two benchmark input-validation attempts have no run IDs; retained separately, not counted as completed runs.', 'Verifier run summary said one item; retrieved dataset contains two checked addresses. Dataset rows used.', 'M2O DNS/verifier contradiction unresolved; MX does not verify mailbox. Lindsey catch-all remains held.', 'Historical campaign snapshot and user-reported rendering preserved; no fresh remote audit.', 'Suppression status unknown for imported contacts; all remain release-ineligible.', 'Old qualification snapshots preserved in history; latest working record takes precedence.', 'Brain retained externally by path/hash; schema descriptions and credential-shaped fields may be redacted from sanitized copies.'] };
    write('import_report', 'initial', report, 'confirmed', null, null);
    db.prepare("INSERT INTO metadata VALUES('import_manifest_hash',?)").run(manifestHash);
    journal(db, 'INITIAL_IMPORT', 'project', { manifestHash, sourceCount: sources.length }); return report;
  });
}
