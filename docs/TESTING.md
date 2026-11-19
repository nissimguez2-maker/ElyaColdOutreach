# Safe tests and actual results

Node 24, no dependencies or credential setup. From the project root:

```powershell
node scripts/test-offline.mjs
```

This explicit portable suite selects 61 test files and excludes 49 historical/private-evidence files, listed with reasons in `tests/offline-suite.json`. It creates only scratch fixture parents and isolated test state. A network-denial preload intercepts Node network APIs and is inherited by Node children. It is not an OS network boundary for arbitrary executables. The Windows containment case runs generated local fixture workers; no live provider or model is invoked.

## Results on November 19, 2026

| Run | Actual result | Scope |
|---|---|---|
| Final clean source copy without private data, portable suite | 670 tests: 669 passed, 0 failed, 1 skipped; exit 0; 21,479.1402 ms | Synthetic, reviewable checkout coverage. Junction creation not supported by this sandbox. |
| Full local suite before review fixes | 1,341 tests: 1,320 passed, 20 failed, 1 skipped; exit 1 | Includes preserved private fixtures. All 20 failures in historical Telegram acceptance fixtures; not hidden by the portable subset. |
| Reply metadata regression and related suites | 47 passed, 0 failed | Duplicate legacy event can gain attributable metadata without notifying again; conflicts still rejected. |
| Runtime ownership correction | 27 passed, 0 failed | Pending handlers retain singleton ownership after timeout/cancellation; no second job can overlap. |
| Stable observation cohort regressions | 2 new + 3 existing filtered tests passed | Later reconciliation stays within the creation cohort; late reply enrichment preserves original receipt counts. |
| Historical-path portability adjustment | 38 passed, 0 failed | Import, acceptance and discovery fixture paths preserve behavior after replacing hardcoded username with OS home directory. |

The full suite was not rerun after these narrow fixes. The final portable suite covers the integrated current local paths and the path-only adjustment. Do not add these counts together as unique tests. Syntax checks passed for all 119 source ESM modules. A byte-preserving Git whitespace check reports one pre-existing blank line at the end of a fixture helper; it was not reformatted merely for publication.

The first full-suite command had a preload URL syntax error; the corrected command produced the substantive full result above. The first clean-copy check exposed missing private dependencies and empty fixture parent directories; those remain documented exclusions or are now explicitly created. Original logs remain locally under `work/repository-consolidation-v1` and `work/operational-completion-v1` and are not published.

No build or linter is configured. No paid service, live connector, real send, reboot recovery, all-response-variant support or persuasive writing performance is established by these tests.

## Historical suite

`npm run test:local-evidence` retains the original full suite for the operator workspace. It is not the reviewer setup command: it needs private source files and original evidence, and currently has the known failures above. Do not copy private evidence into Git to satisfy it. Each test must remain isolated from production writes.
