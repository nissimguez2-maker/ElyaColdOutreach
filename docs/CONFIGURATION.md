# Configuration boundary

No credential values or live configuration are distributed. `package.json` has no third-party dependencies, lockfile or install hooks. Node 24 supplies SQLite. PowerShell and Windows Job Objects are needed only for Windows containment paths.

Existing runtime settings live in local typed records, not an automatically loaded `.env` file:

| Record or option | Purpose | Safe baseline |
|---|---|---|
| `settings/workflow-runtime.enabled` | Permit foreground production entry | absent/false |
| `settings/workflow-runtime.generalDispatchEnabled` | Permit production service wiring | absent/false |
| `settings/handoff-runtime` | Reviewed executable and contract reference | not distributed |
| `controls.stopped` | Block new business release | true |
| `controls.launch_authorized` | Separate launch authorization | false |
| `--db` / runtime `--database` | Explicit local SQLite path | isolated fixture only during review |
| `NODE_OPTIONS` | Offline test preload | set by `scripts/test-offline.mjs` |

The contained CLI passes only required existing environment names: `SystemRoot`, `WINDIR`, `COMSPEC`, `PATH`, `USERPROFILE`, `HOME`, `APPDATA`, `LOCALAPPDATA`, `CODEX_HOME`, `TEMP`, `TMP`. Values and credential files are not copied to the repository. Existing authentication belongs to the local runtime; chat connectors are not assumed inherited by Node.

Telegram uses user-scoped Windows-protected storage locally. Do not put tokens in source, Git, command arguments, fixtures or reports. No credential setup is necessary for the portable offline suite.

Historical importer paths and fixed test target identifiers remain in source for auditability. Referenced private files are intentionally absent. The importer and old one-use live CLIs are not clean-checkout setup steps and must not be run to populate reviewer data.
