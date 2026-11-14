-- Forward-only companion state; legacy task/outbox enums and policy FKs unchanged.
CREATE TABLE IF NOT EXISTS careops_machine_credentials (
 org_id TEXT NOT NULL, id TEXT NOT NULL, token_hash TEXT NOT NULL,
 expires_at TEXT NOT NULL, revoked_at TEXT, created_at TEXT NOT NULL,
 PRIMARY KEY(org_id,id), UNIQUE(org_id,token_hash)
);
CREATE TABLE IF NOT EXISTS careops_machine_nonces (
 org_id TEXT NOT NULL, credential_id TEXT NOT NULL, nonce TEXT NOT NULL,
 request_hash TEXT NOT NULL, created_at TEXT NOT NULL,
 PRIMARY KEY(org_id,credential_id,nonce),
 FOREIGN KEY(org_id,credential_id) REFERENCES careops_machine_credentials(org_id,id)
);
CREATE TABLE IF NOT EXISTS careops_workflows (
 org_id TEXT NOT NULL, handoff_id TEXT NOT NULL, task_id TEXT NOT NULL,
 trigger_id TEXT NOT NULL, event_id TEXT NOT NULL, task_ref TEXT NOT NULL,
 state TEXT NOT NULL CHECK(state IN ('OUTBOX_PENDING','DISPATCH_LEASED','WEBHOOK_ACCEPTED','AGENT_RUNNING','DRAFT_READY','PENDING_REVIEW','APPROVED_TO_SEND','REJECTED','COMPLETED','FAILED_RETRY','DEAD_LETTER','CANCELLED')),
 dispatch_claim TEXT, claim_until TEXT, next_attempt_at TEXT NOT NULL,
 lease_id TEXT, lease_expires_at TEXT, draft_claim TEXT, draft_claim_until TEXT,
 draft_started_at TEXT, draft_audit_id TEXT, draft_uncertain INTEGER NOT NULL DEFAULT 0 CHECK(draft_uncertain IN (0,1)),
 created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
 PRIMARY KEY(org_id,handoff_id), UNIQUE(org_id,task_id), UNIQUE(org_id,trigger_id),
 UNIQUE(org_id,event_id), UNIQUE(org_id,task_ref),
 FOREIGN KEY(org_id,handoff_id) REFERENCES maritime_handoffs(org_id,id),
 FOREIGN KEY(org_id,task_id) REFERENCES careops_tasks(org_id,id),
 FOREIGN KEY(org_id,trigger_id) REFERENCES careops_outbox(org_id,id)
);
CREATE INDEX IF NOT EXISTS careops_workflow_due ON careops_workflows(org_id,state,next_attempt_at);
CREATE TABLE IF NOT EXISTS careops_agent_events (
 org_id TEXT NOT NULL,id TEXT NOT NULL,task_id TEXT NOT NULL,handoff_id TEXT NOT NULL,
 event_key TEXT NOT NULL,event_type TEXT NOT NULL CHECK(event_type IN ('INITIALIZED','DISPATCH_CLAIMED','WEBHOOK_ACCEPTED','FAILED_RETRY','DEAD_LETTER','CONTEXT_ISSUED','DRAFT_READY','DRAFT_UNCERTAIN','PENDING_REVIEW','AGENT_RETRYABLE','AGENT_FAILED','APPROVED_TO_SEND','REJECTED','EDITED','COMPLETED','CANCELLED')),
 code TEXT CHECK(code IS NULL OR code IN ('UPSTREAM_AUTH','UPSTREAM_REJECTED','UPSTREAM_BUSY','UPSTREAM_UNAVAILABLE','UPSTREAM_REDIRECT','UPSTREAM_INVALID','TOOL_TIMEOUT','NETWORK_FAILURE','CONTEXT_EXPIRED','REFERENCE_MISMATCH','ATTEMPT_LIMIT','JOURNAL_UNAVAILABLE')),
 http_status INTEGER CHECK(http_status IS NULL OR http_status BETWEEN 100 AND 599),
 actor_id TEXT,created_at TEXT NOT NULL,
 PRIMARY KEY(org_id,id), UNIQUE(org_id,event_key),
 FOREIGN KEY(org_id,handoff_id) REFERENCES careops_workflows(org_id,handoff_id)
);
CREATE TABLE IF NOT EXISTS careops_drafts (
 org_id TEXT NOT NULL,draft_ref TEXT NOT NULL,handoff_id TEXT NOT NULL,task_id TEXT NOT NULL,
 text TEXT NOT NULL CHECK(length(text)<=4000),text_source TEXT NOT NULL DEFAULT 'GUARDIAN' CHECK(text_source IN ('GUARDIAN','HUMAN_TEMPLATE')),language TEXT NOT NULL CHECK(language IN ('en-IN','hi-IN')),
 provider TEXT NOT NULL CHECK(provider IN ('prune','local-template')),
 receipt_status TEXT NOT NULL CHECK(receipt_status IN ('VERIFIED_ED25519','VERIFIED_API','PRESENT_UNVERIFIED','MISSING','NOT_APPLICABLE_BLOCKED','NOT_APPLICABLE_DISABLED')),
 prune_audit_id TEXT NOT NULL,revision INTEGER NOT NULL DEFAULT 1 CHECK(revision>0),
 state TEXT NOT NULL CHECK(state IN ('DRAFT_READY','PENDING_REVIEW','APPROVED_TO_SEND','REJECTED')),
 communication_state TEXT NOT NULL DEFAULT 'NOT_SENT' CHECK(communication_state IN ('NOT_SENT','SIMULATED')),
 created_at TEXT NOT NULL,updated_at TEXT NOT NULL,
 PRIMARY KEY(org_id,draft_ref), UNIQUE(org_id,handoff_id),
 FOREIGN KEY(org_id,handoff_id) REFERENCES careops_workflows(org_id,handoff_id),
 FOREIGN KEY(org_id,prune_audit_id) REFERENCES prune_audit_receipts(org_id,id)
);
CREATE TABLE IF NOT EXISTS careops_draft_reviews (
 org_id TEXT NOT NULL,id TEXT NOT NULL,draft_ref TEXT NOT NULL,task_id TEXT NOT NULL,
 base_revision INTEGER NOT NULL,resulting_revision INTEGER NOT NULL,
 text_snapshot TEXT NOT NULL CHECK(length(text_snapshot)<=4000),language TEXT NOT NULL CHECK(language IN ('en-IN','hi-IN')),
 action TEXT NOT NULL CHECK(action IN ('approve','reject','edit')),actor_id TEXT NOT NULL,
 note TEXT NOT NULL CHECK(length(note)<=500),request_hash TEXT NOT NULL,idempotency_key TEXT NOT NULL,
 created_at TEXT NOT NULL,
 PRIMARY KEY(org_id,id),UNIQUE(org_id,actor_id,idempotency_key),UNIQUE(org_id,draft_ref,base_revision),
 FOREIGN KEY(org_id,draft_ref) REFERENCES careops_drafts(org_id,draft_ref),
 FOREIGN KEY(org_id,actor_id) REFERENCES users(org_id,id)
);
CREATE TABLE IF NOT EXISTS careops_thread_entries (
 org_id TEXT NOT NULL,id TEXT NOT NULL,patient_id TEXT NOT NULL CHECK(patient_id='P-1042'),
 task_id TEXT NOT NULL,handoff_id TEXT NOT NULL,outcome TEXT NOT NULL CHECK(outcome IN ('PENDING_REVIEW','APPROVED_TO_SEND','REJECTED','COMPLETED','CANCELLED')),
 event_key TEXT NOT NULL,created_at TEXT NOT NULL,
 PRIMARY KEY(org_id,id),UNIQUE(org_id,event_key),
 FOREIGN KEY(org_id,patient_id) REFERENCES patients(org_id,id),
 FOREIGN KEY(org_id,handoff_id) REFERENCES careops_workflows(org_id,handoff_id)
);
CREATE TRIGGER IF NOT EXISTS careops_agent_events_no_update BEFORE UPDATE ON careops_agent_events BEGIN SELECT RAISE(ABORT,'EVENT_IMMUTABLE'); END;
CREATE TRIGGER IF NOT EXISTS careops_agent_events_no_delete BEFORE DELETE ON careops_agent_events BEGIN SELECT RAISE(ABORT,'EVENT_IMMUTABLE'); END;
CREATE TRIGGER IF NOT EXISTS careops_draft_reviews_no_update BEFORE UPDATE ON careops_draft_reviews BEGIN SELECT RAISE(ABORT,'REVIEW_IMMUTABLE'); END;
CREATE TRIGGER IF NOT EXISTS careops_draft_reviews_no_delete BEFORE DELETE ON careops_draft_reviews BEGIN SELECT RAISE(ABORT,'REVIEW_IMMUTABLE'); END;
CREATE TRIGGER IF NOT EXISTS careops_thread_no_update BEFORE UPDATE ON careops_thread_entries BEGIN SELECT RAISE(ABORT,'THREAD_IMMUTABLE'); END;
CREATE TRIGGER IF NOT EXISTS careops_thread_no_delete BEFORE DELETE ON careops_thread_entries BEGIN SELECT RAISE(ABORT,'THREAD_IMMUTABLE'); END;
CREATE TRIGGER IF NOT EXISTS careops_completion_guard BEFORE UPDATE OF status ON careops_tasks
 WHEN NEW.status='completed' AND EXISTS(SELECT 1 FROM careops_workflows w WHERE w.org_id=NEW.org_id AND w.task_id=NEW.id AND w.state<>'APPROVED_TO_SEND')
 BEGIN SELECT RAISE(ABORT,'DRAFT_REVIEW_REQUIRED'); END;
CREATE TRIGGER IF NOT EXISTS careops_task_terminal AFTER UPDATE OF status ON careops_tasks
 WHEN NEW.status IN ('completed','cancelled')
 BEGIN
  INSERT INTO careops_agent_events(org_id,id,task_id,handoff_id,event_key,event_type,created_at)
   SELECT w.org_id,lower(hex(randomblob(16))),w.task_id,w.handoff_id,w.handoff_id||':'||NEW.status,
    CASE NEW.status WHEN 'completed' THEN 'COMPLETED' ELSE 'CANCELLED' END,NEW.updated_at
   FROM careops_workflows w WHERE w.org_id=NEW.org_id AND w.task_id=NEW.id ON CONFLICT DO NOTHING;
  INSERT INTO careops_thread_entries(org_id,id,patient_id,task_id,handoff_id,event_key,outcome,created_at)
   SELECT w.org_id,lower(hex(randomblob(16))),NEW.patient_id,w.task_id,w.handoff_id,w.handoff_id||':'||NEW.status,
    CASE NEW.status WHEN 'completed' THEN 'COMPLETED' ELSE 'CANCELLED' END,NEW.updated_at
   FROM careops_workflows w WHERE w.org_id=NEW.org_id AND w.task_id=NEW.id ON CONFLICT DO NOTHING;
  UPDATE careops_workflows SET state=CASE NEW.status WHEN 'completed' THEN 'COMPLETED' ELSE 'CANCELLED' END,
   lease_expires_at=NULL,dispatch_claim=NULL,claim_until=NULL,updated_at=NEW.updated_at
   WHERE org_id=NEW.org_id AND task_id=NEW.id;
 END;

CREATE TRIGGER IF NOT EXISTS careops_urgent_insert AFTER INSERT ON vitalis_observations
 WHEN NEW.patient_id='P-1042' AND NEW.metric_code='8480-6' AND NEW.unit='mm[Hg]' AND NEW.quality='verified' AND NEW.value_numeric>=180
 BEGIN
  INSERT INTO careops_agent_events(org_id,id,task_id,handoff_id,event_key,event_type,created_at)
   SELECT w.org_id,lower(hex(randomblob(16))),w.task_id,w.handoff_id,w.handoff_id||':urgent','CANCELLED',strftime('%Y-%m-%dT%H:%M:%fZ','now')
   FROM careops_workflows w WHERE w.org_id=NEW.org_id AND w.state NOT IN ('COMPLETED','CANCELLED') ON CONFLICT DO NOTHING;
  INSERT INTO careops_thread_entries(org_id,id,patient_id,task_id,handoff_id,event_key,outcome,created_at)
   SELECT w.org_id,lower(hex(randomblob(16))),NEW.patient_id,w.task_id,w.handoff_id,w.handoff_id||':urgent','CANCELLED',strftime('%Y-%m-%dT%H:%M:%fZ','now')
   FROM careops_workflows w WHERE w.org_id=NEW.org_id AND w.state NOT IN ('COMPLETED','CANCELLED') ON CONFLICT DO NOTHING;
  UPDATE careops_workflows SET state='CANCELLED',lease_expires_at=NULL,dispatch_claim=NULL,claim_until=NULL,updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')
   WHERE org_id=NEW.org_id AND task_id IN (SELECT id FROM careops_tasks WHERE org_id=NEW.org_id AND patient_id=NEW.patient_id) AND state<>'COMPLETED';
  UPDATE careops_drafts SET state='REJECTED',communication_state='NOT_SENT'
   WHERE org_id=NEW.org_id AND task_id IN (SELECT id FROM careops_tasks WHERE org_id=NEW.org_id AND patient_id=NEW.patient_id);
  UPDATE careops_outbox SET state='cancelled' WHERE org_id=NEW.org_id AND state='pending'
   AND task_id IN (SELECT id FROM careops_tasks WHERE org_id=NEW.org_id AND patient_id=NEW.patient_id);
 END;

CREATE TRIGGER IF NOT EXISTS careops_urgent_update AFTER UPDATE ON vitalis_observations
 WHEN NEW.patient_id='P-1042' AND NEW.metric_code='8480-6' AND NEW.unit='mm[Hg]' AND NEW.quality='verified' AND NEW.value_numeric>=180
 BEGIN
  INSERT INTO careops_agent_events(org_id,id,task_id,handoff_id,event_key,event_type,created_at)
   SELECT w.org_id,lower(hex(randomblob(16))),w.task_id,w.handoff_id,w.handoff_id||':urgent','CANCELLED',strftime('%Y-%m-%dT%H:%M:%fZ','now')
   FROM careops_workflows w WHERE w.org_id=NEW.org_id AND w.state NOT IN ('COMPLETED','CANCELLED') ON CONFLICT DO NOTHING;
  INSERT INTO careops_thread_entries(org_id,id,patient_id,task_id,handoff_id,event_key,outcome,created_at)
   SELECT w.org_id,lower(hex(randomblob(16))),NEW.patient_id,w.task_id,w.handoff_id,w.handoff_id||':urgent','CANCELLED',strftime('%Y-%m-%dT%H:%M:%fZ','now')
   FROM careops_workflows w WHERE w.org_id=NEW.org_id AND w.state NOT IN ('COMPLETED','CANCELLED') ON CONFLICT DO NOTHING;
  UPDATE careops_workflows SET state='CANCELLED',lease_expires_at=NULL,dispatch_claim=NULL,claim_until=NULL,updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')
   WHERE org_id=NEW.org_id AND task_id IN (SELECT id FROM careops_tasks WHERE org_id=NEW.org_id AND patient_id=NEW.patient_id) AND state<>'COMPLETED';
  UPDATE careops_drafts SET state='REJECTED',communication_state='NOT_SENT'
   WHERE org_id=NEW.org_id AND task_id IN (SELECT id FROM careops_tasks WHERE org_id=NEW.org_id AND patient_id=NEW.patient_id);
  UPDATE careops_outbox SET state='cancelled' WHERE org_id=NEW.org_id AND state='pending'
   AND task_id IN (SELECT id FROM careops_tasks WHERE org_id=NEW.org_id AND patient_id=NEW.patient_id);
 END;
