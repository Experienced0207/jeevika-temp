-- Sanitized operational proof only: never persist request/response clinical text.
CREATE TABLE IF NOT EXISTS prune_audit_receipts (
  org_id TEXT NOT NULL,
  id TEXT NOT NULL,
  event_type TEXT NOT NULL CHECK(event_type IN ('BLOCKED_EGRESS_GATE','DISABLED','REQUESTED','COMPLETED','UPSTREAM_FAILED')),
  receipt_status TEXT NOT NULL CHECK(receipt_status IN ('VERIFIED_ED25519','VERIFIED_API','PRESENT_UNVERIFIED','MISSING','NOT_APPLICABLE_BLOCKED','NOT_APPLICABLE_DISABLED')),
  network_attempted INTEGER NOT NULL CHECK(network_attempted IN (0,1)),
  receipt_json TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY(org_id,id),
  CHECK(event_type <> 'BLOCKED_EGRESS_GATE' OR (network_attempted = 0 AND receipt_status = 'NOT_APPLICABLE_BLOCKED' AND receipt_json IS NULL))
);
CREATE INDEX IF NOT EXISTS prune_audit_usage ON prune_audit_receipts(org_id,created_at,event_type,receipt_status);
