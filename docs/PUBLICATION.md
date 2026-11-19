# Publication boundary and approval

Designated destination: `nissimguez2-maker/ElyaColdOutreach`. Initial inspection on November 19, 2026 reported **public**, no branches, and an empty repository, so publication was held. The operator then explicitly approved public publication: "I'm fine with it to be public. go ahead". That instruction superseded the private-only condition; it did not change any operational permission.

The exact reviewed baseline `cb8a1e620841e13c1e29ebc5f7a21262abc48824` was published to `codex/review-baseline-2026-11-19` by non-force Git push using existing saved authentication. GitHub's connected read interface confirmed the exact remote commit, branch and tree `710831fb954a3e418dd9a0f59ca9c32437565dab`. The connector's commit-writing tool could not reproduce a parentless local commit with its exact metadata, so Git was used for the transfer. No credentials were extracted, exposed or configured. The repository visibility was not changed.

Local root and Git root coincide. There were no tracked files, branch commits or configured remotes. One internal Codex checkpoint ref exists; it is not a branch commit or a baseline parent and must never be published with `--all` or `--mirror`. No unrelated project was found inside the intended source boundary. Useful local evidence is retained, not deleted.

## Included

- Application ESM/SQL source and retained acceptance source.
- Tests, explicitly synthetic helpers and minimal contract fixtures. Historical tests referencing excluded evidence remain readable but are not part of the portable suite.
- Dependency manifest (no dependencies/lockfile), safe test command, source-status/task documentation.
- Two existing Windows containment source files at their fingerprinted paths.
- Sanitized acceptance summary; no full private provider responses.

Existing fixed resource IDs and limited business/operator identifiers in audited source and historical assertions are retained for traceability. They are not credentials. Their presence was disclosed before the operator approved public publication. That approval does not extend to excluded private records.

## Excluded and preserved locally

All SQLite/WAL/SHM/backups, data and outputs, raw contact/prospect collections, private replies, source research, approval manifests, pairing/session files, actual configuration, tokens/keys, raw logs, generated bulk artifacts and historical work directories. `.gitignore` allowlists only the two source exceptions. Historical detailed documents remain local; current shared truth is README, PROJECT_STATUS and TASKS.

## Inspection and limits

No existing branch history is an ancestor of this root baseline. The reviewed commit tree is the publication unit, not all local refs. Credential-pattern checks cover all intended text, with only intentional secret-redaction fixture strings reviewed as false positives. File/path checks exclude data, log, key, environment and bulk evidence categories. No actual credential was identified in the proposed source boundary. A second bounded check matched all 263 files to the reviewed SHA-256 inventory and identified no new blocker. Pattern inspection cannot prove absence of arbitrary secret prose; future publications still require exact-tree review.

No `.github/workflows` files or Git hooks are included. Remote repository contents were empty, so there were no committed workflows to inspect. The connector rejected the workflow-list endpoint; repository-level/webhook automation configuration was not independently established. After publication, the supported workflow-runs endpoint reported zero runs for the baseline commit. No production automation was enabled. Unobserved external webhooks are not represented as audited.

Future publication must remain limited to reviewed changes, never a force push. Recheck the remote head first; reconcile intervening work without overwriting it. Verify the resulting commit and branch afterward. Permission to publish is not authority for any operational test or external business action.
