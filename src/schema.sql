PRAGMA foreign_keys=ON;
CREATE TABLE IF NOT EXISTS metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL);
INSERT OR IGNORE INTO metadata VALUES ('schema_version','1');
CREATE TABLE IF NOT EXISTS sources (
  id TEXT PRIMARY KEY, path TEXT NOT NULL UNIQUE, sha256 TEXT NOT NULL,
  content_json TEXT NOT NULL CHECK(json_valid(content_json)), imported_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS records (
  kind TEXT NOT NULL, id TEXT NOT NULL, data_json TEXT NOT NULL CHECK(json_valid(data_json)),
  basis TEXT NOT NULL CHECK(basis IN ('confirmed','provider_result','user_reported','estimate','unresolved','assessment','configuration')),
  source_id TEXT REFERENCES sources(id), pointer TEXT, updated_at TEXT NOT NULL,
  PRIMARY KEY(kind,id)
);
CREATE TABLE IF NOT EXISTS record_history (
  kind TEXT NOT NULL, id TEXT NOT NULL, hash TEXT NOT NULL, data_json TEXT NOT NULL,
  basis TEXT NOT NULL, source_id TEXT REFERENCES sources(id), pointer TEXT, recorded_at TEXT NOT NULL,
  PRIMARY KEY(kind,id,hash)
);
CREATE TABLE IF NOT EXISTS controls (
  singleton INTEGER PRIMARY KEY CHECK(singleton=1), stopped INTEGER NOT NULL CHECK(stopped IN (0,1)),
  launch_authorized INTEGER NOT NULL CHECK(launch_authorized IN (0,1)), reason TEXT NOT NULL, updated_at TEXT NOT NULL
);
INSERT OR IGNORE INTO controls VALUES(1,1,0,'Initial state: no live release',strftime('%Y-%m-%dT%H:%M:%fZ','now'));
CREATE TABLE IF NOT EXISTS batches (
  batch_id TEXT NOT NULL, version INTEGER NOT NULL CHECK(version>0), hash TEXT NOT NULL,
  content_json TEXT NOT NULL CHECK(json_valid(content_json)), created_at TEXT NOT NULL,
  PRIMARY KEY(batch_id,version)
);
CREATE TRIGGER IF NOT EXISTS batch_immutable_update BEFORE UPDATE ON batches BEGIN SELECT RAISE(ABORT,'Batch versions are immutable'); END;
CREATE TRIGGER IF NOT EXISTS batch_immutable_delete BEFORE DELETE ON batches BEGIN SELECT RAISE(ABORT,'Batch versions are immutable'); END;
CREATE TABLE IF NOT EXISTS approvals (
  id TEXT PRIMARY KEY, batch_id TEXT NOT NULL, version INTEGER NOT NULL, hash TEXT NOT NULL,
  decision TEXT NOT NULL CHECK(decision IN ('APPROVED','REJECTED','REVISION_REQUESTED','INVALIDATED','REVOKED')),
  actor TEXT NOT NULL, expires_at TEXT NOT NULL, created_at TEXT NOT NULL, reason TEXT,
  FOREIGN KEY(batch_id,version) REFERENCES batches(batch_id,version)
);
CREATE TABLE IF NOT EXISTS budgets (
  id TEXT PRIMARY KEY, limit_usd TEXT NOT NULL, baseline_usd TEXT NOT NULL, fixed_usd TEXT,
  basis TEXT NOT NULL, blocked INTEGER NOT NULL DEFAULT 0 CHECK(blocked IN (0,1))
);
CREATE TABLE IF NOT EXISTS operations (
  id TEXT PRIMARY KEY, kind TEXT NOT NULL CHECK(kind IN ('COLLECT','VERIFY','RELEASE','NOTIFY','READ','DRAFT')),
  budget_id TEXT NOT NULL REFERENCES budgets(id), intent_hash TEXT NOT NULL, intent_json TEXT NOT NULL CHECK(json_valid(intent_json)),
  status TEXT NOT NULL CHECK(status IN ('PREPARED','DISPATCHING','RECONCILIATION','SUCCEEDED','FAILED','CANCELLED')),
  reservation_usd TEXT NOT NULL, actual_usd TEXT, remote_id TEXT, evidence TEXT,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL, action_key TEXT
);
CREATE INDEX IF NOT EXISTS operation_budget_status ON operations(budget_id,status);
CREATE UNIQUE INDEX IF NOT EXISTS operation_action_identity ON operations(action_key) WHERE status<>'CANCELLED';
CREATE TABLE IF NOT EXISTS journal (
  id INTEGER PRIMARY KEY, event TEXT NOT NULL, subject TEXT NOT NULL,
  details_json TEXT NOT NULL CHECK(json_valid(details_json)), recorded_at TEXT NOT NULL
);
CREATE TRIGGER IF NOT EXISTS journal_immutable_update BEFORE UPDATE ON journal BEGIN SELECT RAISE(ABORT,'Journal is append only'); END;
CREATE TRIGGER IF NOT EXISTS journal_immutable_delete BEFORE DELETE ON journal BEGIN SELECT RAISE(ABORT,'Journal is append only'); END;
