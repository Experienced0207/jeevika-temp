import { HTTPException } from "hono/http-exception";
import type { CoordinationEnvelope } from "../../../packages/shared/maritime-coordination";
import { type Database, type DbValue, tenantDb } from "../database";

// Correlated to t: one tenant marker per statement, no tenant from request bodies.
export const eligible = `t.patient_id='P-1042' AND t.priority='review' AND t.status='in_progress'
 AND EXISTS(SELECT 1 FROM patients p WHERE p.org_id=t.org_id AND p.id=t.patient_id AND p.synthetic=1)
 AND EXISTS(SELECT 1 FROM careops_task_reviews r WHERE r.org_id=t.org_id AND r.task_id=t.id AND r.action='approve')
 AND NOT EXISTS(SELECT 1 FROM careops_tasks u WHERE u.org_id=t.org_id AND u.patient_id=t.patient_id AND u.priority='urgent' AND u.status IN ('open','in_progress'))
 AND NOT EXISTS(SELECT 1 FROM vitalis_observations v WHERE v.org_id=t.org_id AND v.patient_id=t.patient_id AND v.metric_code='8480-6' AND v.unit='mm[Hg]' AND v.quality='verified' AND v.value_numeric>=180)`;
export type Workflow = {
  handoff_id: string;
  task_id: string;
  trigger_id: string;
  event_id: string;
  task_ref: string;
  state: string;
  updated_at: string;
  dispatch_claim: string | null;
  claim_until: string | null;
  next_attempt_at: string;
  lease_id: string | null;
  lease_expires_at: string | null;
  draft_claim: string | null;
  draft_claim_until: string | null;
  draft_started_at: string | null;
  draft_audit_id: string | null;
  draft_uncertain: number;
};
export type Draft = {
  draft_ref: string;
  task_id: string;
  handoff_id: string;
  text: string;
  text_source: "GUARDIAN" | "HUMAN_TEMPLATE";
  language: "en-IN" | "hi-IN";
  provider: "prune" | "local-template";
  receipt_status:
    | "VERIFIED_ED25519"
    | "VERIFIED_API"
    | "PRESENT_UNVERIFIED"
    | "MISSING"
    | "NOT_APPLICABLE_BLOCKED"
    | "NOT_APPLICABLE_DISABLED";
  prune_audit_id: string;
  revision: number;
  state: string;
  communication_state: string;
};
export function envelope(w: Workflow): CoordinationEnvelope {
  return {
    schemaVersion: 1,
    triggerId: w.trigger_id,
    handoffId: w.handoff_id,
    taskRef: w.task_ref,
    eventId: w.event_id,
    action: "propose_administrative_followup",
  };
}
export function workflowRepo(context: { db: Database; orgId: string }) {
  const db = tenantDb(context);
  const get = (handoff: string) =>
    db
      .statement(
        `SELECT w.* FROM careops_workflows w WHERE w.org_id = :org AND w.handoff_id=?`,
        handoff,
      )
      .first<Workflow>();
  const draft = (handoff: string) =>
    db
      .statement(
        `SELECT draft_ref,task_id,handoff_id,text,text_source,language,provider,receipt_status,prune_audit_id,revision,state,communication_state FROM careops_drafts WHERE org_id = :org AND handoff_id=?`,
        handoff,
      )
      .first<Draft>();
  const event = (
    w: Workflow,
    key: string,
    type: string,
    now: string,
    code: string | null = null,
    status: number | null = null,
    actor: string | null = null,
    condition = "1=1",
    values: DbValue[] = [],
  ) =>
    db.statement(
      `INSERT INTO careops_agent_events(org_id,id,task_id,handoff_id,event_key,event_type,code,http_status,actor_id,created_at)
 SELECT w.org_id,?,?,?,?,?,?,?,?,? FROM careops_workflows w
 WHERE w.org_id = :org AND w.handoff_id=? AND (${condition}) ON CONFLICT(org_id,event_key) DO NOTHING`,
      crypto.randomUUID(),
      w.task_id,
      w.handoff_id,
      key,
      type,
      code,
      status,
      actor,
      now,
      w.handoff_id,
      ...values,
    );
  const thread = (
    w: Workflow,
    key: string,
    outcome: string,
    now: string,
    condition = "1=1",
    values: DbValue[] = [],
  ) =>
    db.statement(
      `INSERT INTO careops_thread_entries(org_id,id,patient_id,task_id,handoff_id,event_key,outcome,created_at)
 SELECT w.org_id,?,'P-1042',?,?,?,?,? FROM careops_workflows w
 WHERE w.org_id = :org AND w.handoff_id=? AND (${condition}) ON CONFLICT(org_id,event_key) DO NOTHING`,
      crypto.randomUUID(),
      w.task_id,
      w.handoff_id,
      key,
      outcome,
      now,
      w.handoff_id,
      ...values,
    );
  const safeSql = `EXISTS(SELECT 1 FROM careops_tasks t WHERE t.org_id=careops_workflows.org_id AND t.id=careops_workflows.task_id AND ${eligible})`;
  async function authorized(
    input: CoordinationEnvelope,
    lease?: string,
    now = new Date().toISOString(),
  ) {
    const w = await get(input.handoffId);
    if (
      !w ||
      Object.entries(envelope(w)).some(
        ([k, v]) => input[k as keyof CoordinationEnvelope] !== v,
      )
    )
      throw new HTTPException(404, {
        message: "Coordination reference not found",
      });
    const allowed = await db
      .statement(
        `SELECT w.handoff_id FROM careops_workflows w
   JOIN careops_tasks t ON t.org_id=w.org_id AND t.id=w.task_id
   JOIN maritime_handoffs h ON h.org_id=w.org_id AND h.id=w.handoff_id
   JOIN prune_receipts p ON p.org_id=h.org_id AND p.id=h.receipt_id AND p.decision='accepted'
   WHERE w.org_id = :org AND w.handoff_id=? AND ${eligible}
   AND w.state NOT IN ('OUTBOX_PENDING','CANCELLED','REJECTED','COMPLETED','DEAD_LETTER')`,
        input.handoffId,
      )
      .first();
    if (!allowed)
      throw new HTTPException(409, {
        message: "Coordination is not permitted",
      });
    if (
      lease &&
      (w.lease_id !== lease || !w.lease_expires_at || w.lease_expires_at <= now)
    )
      throw new HTTPException(409, { message: "Coordination lease expired" });
    return w;
  }
  return { db, get, draft, event, thread, safeSql, authorized };
}
