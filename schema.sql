-- audit-chain: D1 index table
-- R2 records are the source of truth. This table is a searchable index.

CREATE TABLE IF NOT EXISTS audit_index (
  record_id TEXT PRIMARY KEY,
  namespace TEXT NOT NULL,
  event_type TEXT NOT NULL,
  hash TEXT NOT NULL,
  prev_hash TEXT NOT NULL,
  actor TEXT NOT NULL,
  timestamp TEXT NOT NULL,
  payload_summary TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_audit_namespace ON audit_index(namespace);
CREATE INDEX IF NOT EXISTS idx_audit_event_type ON audit_index(event_type);
CREATE INDEX IF NOT EXISTS idx_audit_actor ON audit_index(actor);
CREATE INDEX IF NOT EXISTS idx_audit_timestamp ON audit_index(timestamp);
CREATE INDEX IF NOT EXISTS idx_audit_ns_ts ON audit_index(namespace, timestamp);
