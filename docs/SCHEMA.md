# SQLite schema v1

Executable DDL: `src/schema.sql`. Authority: `data/elya.sqlite`. There are no external database services. The application checks schema version before use. The separately confirmed `src/drafting-accounting.mjs` upgrade rebuilds only the operations table to add DRAFT after exact schema/row checks; it is implemented and fixture-tested but has not been applied to the authoritative database. It is not run automatically by openStore.

Connections created by `openStore` configure foreign keys, a five-second busy timeout, WAL and `synchronous=FULL` (SQLite memory databases retain their native journal mode). Specialized read-only/CLI connections have their own explicit settings. Multi-row state transitions use `BEGIN IMMEDIATE`: reservation checks and writes serialize. SQLite protects writers; no production background worker is active. A competing writer times out instead of dispatching outside a committed journal entry.

| Table | Key and contract |
|---|---|
| `metadata` | Key/value; schema version and imported manifest hash |
| `sources` | Stable source ID; unique absolute path, original byte SHA-256, sanitized JSON, import time. Brain stores metadata only |
| `records` | `(kind,id)` current typed record; JSON, provenance basis, source foreign key and JSON pointer, update time |
| `record_history` | `(kind,id,hash)` retained versions with payload/provenance. Identical revisions deduplicate |
| `controls` | Single row: stopped boolean, separate launch-authorized boolean, reason and timestamp |
| `batches` | `(batch_id,version)` immutable canonical content and SHA-256; version increases only on material change |
| `approvals` | Decision ID; FK to batch/version, exact hash, actor reference, expiry/time/reason. No imported approvals |
| `budgets` | ID, decimal-text limit/reported baseline/fixed allocation, basis, overrun-block flag. Unknown fixed amount is NULL |
| `operations` | Stable ID; kind, budget FK, full intent/hash, semantic action key, state, decimal reservation/final actual, remote ID, evidence and times |
| `journal` | Append-only event ID, subject, safe canonical details and UTC timestamp |

`records.kind` separates candidate identity, qualification assessment, contact/attribution, raw verification, draft version, evidence, DNS observation, run, campaign, internal QA lead, user-reported rendering, settings, spending observation, validation attempt and import report. This is a document-backed typed record layer: entity shapes are validated/projected by the importer and release gate; it is not a claim of a complete production relational lead schema. Relationships in payloads are checked by the importer/release gate, not all enforced as SQL foreign keys.

Provenance basis values:

- `confirmed`: an independently observed local result, such as DNS lookup or import reconciliation; not proof of deliverability.
- `provider_result`: what a provider returned, including errors and contradictory claims.
- `user_reported`: reported account totals or visual preview outcome.
- `estimate`: explicitly estimated cost.
- `unresolved`: missing/contradictory information, including unknown per-run charges.
- `assessment`: source-grounded qualification/attribution interpretation, not a new independent fact.
- `configuration`: requested limit/settings or unapproved authored content, not an expense or approval.

Source pointers refer to sanitized source JSON using RFC 6901 escaping. Whole original sources retain their byte hashes. Imported numeric tokens are strings, including non-money provider fields, so raw precision does not pass through `Number`. Derived counters and batch versions use safe integers. Money functions accept only nonnegative plain decimal strings, up to 200 characters; unsupported formats fail rather than rounding. Arithmetic uses aligned BigInt coefficients/scales. Remaining budget can be negative to show an overrun.

`operations.actual_usd` is NULL while unresolved. Noncancelled operations with unknown final charges retain their reservation. Once final actual is known, only actual is counted. Historical account reports are a baseline, not summed from repeated monetary observations. A billing overrun permanently blocks that envelope pending future explicit policy work. `weekday-policy.fixed_usd = NULL` prevents capacity/spend claims with unknown subscriptions.

Release action key = SHA-256 of kind + immutable batch ID/version/hash + campaign ID. Other action keys bind kind + canonical payload. A unique partial index excludes only `CANCELLED` rows (which were never dispatched). Historical completed-run accounting holds have no action key and cannot be dispatched. The complete original intent remains stored separately from the semantic key.

Approval expiry is a separate constraint on the exact version/hash. New decisions supersede previous approvals. Material copy/list/sequence/settings changes create a new batch; eligibility hashes detect later qualification or attribution changes. Launch is a separate control. The implemented Telegram adapter validates confirmed numeric pairing and exact message/version binding before recording decisions; a database decision alone is not authenticated Telegram evidence.

Future migrations must preserve source/record history, backup first, test on a separate database and carry explicit version transitions. Never edit the existing evidence to make a migration pass.

## Consolidated workflow record contracts

The completion assignment uses the existing records, operations and journal tables; no second database is introduced. The explicit DRAFT upgrade described above is prepared only. Production rows were preserved during offline validation.

- `business_brief`: immutable content hash, refinement run/assessment hash, supported facts, hypotheses/unknowns, source-linked contact assessment. `evidence_check`: reviewed, dated current assertion with entity/contact/source identity; fetch time is not assertion time.
- Existing `draft`, `writing_packet`, `writing_current`, `writing_decision`, `writing_action`: exact versioned review supports the legacy three-message contract and separate first-touch-only contract. First-touch expiry uses the approved maximum seven calendar days in America/New_York; the legacy contract retains its own expiry shape. Policy also requires actual physicalAddress and approved reply-based optOut text. Material changes invalidate approval; real records were not assigned synthetic policy.
- Existing `telegram_writing_review`, `telegram_writing_action`, `telegram_control_receipt`, `telegram_callback_response`, `telegram_writing_cursor`, `telegram_consumer_owner`: shared by the bounded operational consumer. `telegram_consumer_run` records bounds/outcomes/uncertainty. Exact update fingerprints support duplicate handling; summary-only history requires reconciliation before remote acknowledgment.
- `instantly_handoff_contract`, `handoff_authorization`, `handoff`, `handoff_import`: captured schema hashes, exact batch/approval/recipient/variable bindings, request intents, confirmed remote identities and ambiguous states. Import is separate from activation. Fixture capability is not a stored permission bit.
- `provider_lead_mapping`, `provider_event`, `monitor_page`, `monitor_checkpoint`, `monitor_health`: confirmed import-bound identities and internal normalized events. Provider result decoding is deliberately a separate contract not inferred from empty historical responses.
- `reply_notification`: durable outbox, paired destination, bounded attempts and operation ID. Notification outcome and operation accounting commit atomically. Uncertainty is not retry permission.
- `workflow_job`: immutable action/spec hashes, due time, claim owner, attempts/deadline, evidence and recovery state. Scheduling metadata does not create a background scheduler. Completed imports and notifications remain separately observable from sent/replied events.
