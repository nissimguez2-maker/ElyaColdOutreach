# Existing local architecture

Node 24 ESM and built-in SQLite; no package dependencies, hosted database or new framework.

| Responsibility | Existing implementation |
|---|---|
| Persistent records and provenance | `src/store.mjs`, `src/schema.sql`, `src/import.mjs` |
| Exact approvals, spending, stop, recovery | `src/batches.mjs`, `src/operations.mjs`, `src/values.mjs` |
| Evidence qualification | `src/refinement*.mjs`, `src/collection*.mjs` |
| External assisted writing and review | `src/drafting-handoff.mjs`, `src/drafting-session.mjs`, `src/draft-style.mjs` |
| Optional disabled generation boundary | `src/drafting-caller.mjs`; requires a separately supplied, approved transport |
| Preview and CSV formatting | `src/outreach-preview.mjs`, `src/outreach-csv.mjs` |
| One-message review and handoff | `src/writing-mode.mjs`, `src/writing.mjs`, `src/handoff*.mjs` |
| Paired Telegram decisions | `src/telegram-writing-*.mjs`, `src/telegram-consumer.mjs` |
| Reply interpretation and notification outbox | `src/instantly-observed-reply.mjs`, `src/instantly-reply-bridge.mjs`, `src/monitoring*.mjs` |
| Disabled foreground workflow | `src/workflow-runtime*.mjs`, `src/workflow-jobs.mjs`, `src/workflow-runner-cli.mjs` |
| Backup, restore and operator events | `src/local-maintenance.mjs`, `src/manual-response.mjs`, `src/operator.mjs` |

The current product is an operator-controlled local workflow, not an always-on service. Preparation, eligibility, content approval, release authority, provider completion and billing reconciliation are distinct states. Unknown completion does not become retryable after restart. A local stop blocks new dispatch; it cannot cancel a request already accepted remotely or pause an existing remote campaign.

The current assisted drafting path exports a complete packet to an operator-selected interface, validates returned exact text and records review provenance. No consumer subscription is treated as API access. An optional caller exists but is not connected to a production model or recurring runner.

The concrete handoff uses exact approved calls through Codex App Server and the existing Windows Job Object launcher. The owner and native wrapper remain at `work/connector-compatibility/owner.ps1` and `work/containment-proof/Job.cs` because their paths are fingerprinted. Those two source files are publication exceptions; the surrounding evidence is excluded.

Collection, recurring reply polling and automated drafting are not fully wired in the production service factory. Their current hard errors remain until the specific contract/transport dependencies are resolved. Do not replace these guards with fixture transports. See the single prioritized [task list](../TASKS.md).
