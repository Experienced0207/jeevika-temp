-- Promote the eight clinical compatibility columns previously added only by
-- the local adapter. The local runner checks exact pre-existing legacy columns;
-- a canonical D1 database has none of these additions before this migration.
ALTER TABLE encounters ADD COLUMN tier INTEGER DEFAULT 0;
ALTER TABLE encounters ADD COLUMN token_number INTEGER;
ALTER TABLE patients ADD COLUMN phone_hash TEXT;
ALTER TABLE patients ADD COLUMN dob TEXT;
ALTER TABLE patients ADD COLUMN sex TEXT;
ALTER TABLE patients ADD COLUMN preferred_lang TEXT;
ALTER TABLE patients ADD COLUMN abha_number TEXT;
ALTER TABLE patients ADD COLUMN abha_address TEXT;

-- Human administrative review evidence, separate from drift/vendor receipts.
-- Notes remain internal and are never eligible for external AI egress.
CREATE TABLE IF NOT EXISTS careops_task_reviews (
  org_id TEXT NOT NULL,
  id TEXT NOT NULL,
  task_id TEXT NOT NULL,
  action TEXT NOT NULL CHECK(action IN ('approve','reject','complete')),
  actor_id TEXT NOT NULL,
  note TEXT NOT NULL DEFAULT '' CHECK(length(note) <= 500),
  from_status TEXT NOT NULL CHECK(from_status IN ('open','in_progress')),
  to_status TEXT NOT NULL CHECK(to_status IN ('in_progress','cancelled','completed')),
  created_at TEXT NOT NULL,
  PRIMARY KEY(org_id,id),
  UNIQUE(org_id,task_id,action),
  FOREIGN KEY(org_id,task_id) REFERENCES careops_tasks(org_id,id),
  FOREIGN KEY(org_id,actor_id) REFERENCES users(org_id,id),
  CHECK((action='approve' AND from_status='open' AND to_status='in_progress') OR
        (action='reject' AND to_status='cancelled') OR
        (action='complete' AND from_status='in_progress' AND to_status='completed'))
);
CREATE TRIGGER IF NOT EXISTS careops_review_no_update BEFORE UPDATE ON careops_task_reviews
BEGIN SELECT RAISE(ABORT,'REVIEW_IMMUTABLE'); END;
CREATE TRIGGER IF NOT EXISTS careops_review_no_delete BEFORE DELETE ON careops_task_reviews
BEGIN SELECT RAISE(ABORT,'REVIEW_IMMUTABLE'); END;
