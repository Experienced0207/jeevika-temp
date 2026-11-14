-- Clinical schema family only. All external references are opaque UUIDs.
CREATE TABLE IF NOT EXISTS careops_tasks (
  org_id TEXT NOT NULL,
  id TEXT NOT NULL,
  patient_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK(kind IN ('bp_drift')),
  priority TEXT NOT NULL CHECK(priority IN ('review','urgent')),
  status TEXT NOT NULL DEFAULT 'open' CHECK(status IN ('open','in_progress','completed','cancelled')),
  dedupe_key TEXT NOT NULL,
  trigger_day INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY(org_id,id),
  UNIQUE(org_id,dedupe_key),
  FOREIGN KEY(org_id,patient_id) REFERENCES patients(org_id,id)
);
CREATE INDEX IF NOT EXISTS careops_task_queue ON careops_tasks(org_id,status,priority,created_at);

CREATE TABLE IF NOT EXISTS careops_events (
  org_id TEXT NOT NULL,
  id TEXT NOT NULL,
  task_id TEXT NOT NULL,
  event_type TEXT NOT NULL CHECK(event_type IN ('drift_detected','prune_receipt','handoff_received','handoff_completed')),
  created_at TEXT NOT NULL,
  PRIMARY KEY(org_id,id),
  UNIQUE(org_id,task_id,event_type),
  FOREIGN KEY(org_id,task_id) REFERENCES careops_tasks(org_id,id)
);

CREATE TABLE IF NOT EXISTS careops_outbox (
  org_id TEXT NOT NULL,
  id TEXT NOT NULL,
  task_id TEXT NOT NULL,
  event_type TEXT NOT NULL CHECK(event_type = 'careops.trigger'),
  schema_version INTEGER NOT NULL DEFAULT 1 CHECK(schema_version = 1),
  state TEXT NOT NULL DEFAULT 'pending' CHECK(state IN ('pending','delivered','cancelled','dead-letter')),
  attempts INTEGER NOT NULL DEFAULT 0 CHECK(attempts >= 0),
  created_at TEXT NOT NULL,
  PRIMARY KEY(org_id,id),
  UNIQUE(org_id,task_id,event_type),
  FOREIGN KEY(org_id,task_id) REFERENCES careops_tasks(org_id,id)
);
CREATE INDEX IF NOT EXISTS careops_outbox_pending ON careops_outbox(org_id,state,created_at);

CREATE TABLE IF NOT EXISTS prune_receipts (
  org_id TEXT NOT NULL,
  id TEXT NOT NULL,
  trigger_id TEXT NOT NULL,
  decision TEXT NOT NULL CHECK(decision IN ('accepted','rejected','human_review')),
  policy_version TEXT NOT NULL,
  received_at TEXT NOT NULL,
  PRIMARY KEY(org_id,id),
  UNIQUE(org_id,trigger_id),
  FOREIGN KEY(org_id,trigger_id) REFERENCES careops_outbox(org_id,id)
);

CREATE TABLE IF NOT EXISTS maritime_handoffs (
  org_id TEXT NOT NULL,
  id TEXT NOT NULL,
  task_id TEXT NOT NULL,
  receipt_id TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('pending','accepted','completed','failed')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY(org_id,id),
  UNIQUE(org_id,task_id),
  FOREIGN KEY(org_id,task_id) REFERENCES careops_tasks(org_id,id),
  FOREIGN KEY(org_id,receipt_id) REFERENCES prune_receipts(org_id,id)
);
