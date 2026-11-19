# ElyaColdOutreach

Local, operator-controlled preparation and review of business outreach. This repository contains the existing Node/SQLite application, synthetic tests and a sanitized evidence summary. It excludes the operator's database, raw contact lists, private replies, credentials and live authorization files. Some fixed historical resource identifiers, business references and mailboxes remain in source and assertions; the operator explicitly approved public publication of this reviewed boundary on November 19, 2026.

**Current safeguards:** business stopped; launch and general dispatch disabled; real contacts held; real drafts unapproved. The internal pilot and editorial evaluation are closed. Cloning, testing or publishing this code does not enable any provider operation.

Current truth: [PROJECT_STATUS.md](PROJECT_STATUS.md). Prioritized remaining work: [TASKS.md](TASKS.md). Architecture and entry points: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

## Safe reviewer setup

Use Node 24 or later with built-in `node:sqlite`. No dependency installation, credentials, import or database setup is needed for the portable tests. From the repository root:

```powershell
node --version
node scripts/test-offline.mjs
```

`npm test` runs the same command. The suite uses explicit synthetic inputs and isolated databases. A Node network-denial preload also reaches Node child fixtures; it is not an OS firewall. Windows containment tests use local PowerShell/C# fixture processes, not live Codex/provider access. See [test scope and limitations](docs/TESTING.md).

The historical full suite additionally needs deliberately excluded private evidence. Its latest full run has failures, documented in PROJECT_STATUS.md. Do not import production data to make a reviewer checkout pass. No build or linter is configured; no dependency lockfile is required because there are no third-party packages.

## What exists

- SQLite records, source provenance, immutable batch versions, exact-content approvals, separate launch authority, exact decimal accounting and reconciliation.
- Evidence-based refinement, external assisted-drafting packets and reviews, deterministic style checks, side-effect-free previews and CSV formatting with separate export eligibility.
- First-touch-only contract: one message, one remote step/variant, two variables, no automatic follow-up.
- Paired Telegram review and durable decisions; scoped deterministic Instantly handoff and contained process execution.
- Normalized reply ingestion, notification/report outboxes, bounded workflow jobs, local backup/restore and manual response records.

Some interfaces are implemented and offline-tested but not connected for unattended production. The status document names these explicitly. No new scheduler, external monitoring service or dashboard has been enabled.

## Entry points and cautions

`src/cli.mjs` is the local state CLI; `src/operator.mjs` handles local preparation; `src/workflow-runner-cli.mjs` is the disabled foreground worker entry. Module APIs support preview/formatting without release. [Configuration](docs/CONFIGURATION.md) lists names and safe defaults without secrets.

Historical `*-cli.mjs` acceptance tools are retained for review, not instructions to rerun closed tests. Their exact private manifests and authorizations are excluded. Never run import, arm, setup, recovery adoption or dispatch against the operator database without the applicable authority. Tests changing stops/approvals do so only in isolated fixtures.

Publication boundary and retained-history limitations: [docs/PUBLICATION.md](docs/PUBLICATION.md). Sanitized live evidence: [docs/ACCEPTANCE-EVIDENCE.md](docs/ACCEPTANCE-EVIDENCE.md).
