import { coordinationEnvelopeSchema } from "../../../packages/shared/maritime-coordination";
import {
  type CareopsBindings,
  maritimeConfigured,
  requireCareops,
} from "./config";
import { eligible, envelope, type Workflow, workflowRepo } from "./repo";

export function retryAt(now: number, attempt: number, header: string | null) {
  const backoff =
    Math.min(300000, 1000 * 2 ** Math.min(attempt, 8)) +
    ((crypto.getRandomValues(new Uint16Array(1))[0] ?? 0) % 1000);
  let delay = backoff;
  if (header) {
    const value = /^\d+$/.test(header.trim())
      ? Number(header) * 1000
      : Date.parse(header) - now;
    if (Number.isFinite(value)) delay = Math.max(delay, value);
  }
  return delay > 604800000 ? null : new Date(now + delay).toISOString();
}
/** No external call unless explicitly configured. Injected transports are local test only. */
export async function dispatchCareops(
  env: CareopsBindings,
  orgId: string,
  limit = 1,
  options: { transport?: typeof fetch; now?: () => number } = {},
) {
  requireCareops(env, orgId);
  if (!maritimeConfigured(env)) return { configured: false, attempted: 0 };
  const clock = options.now ?? Date.now;
  const repo = workflowRepo({ db: env.DB, orgId });
  const { db } = repo;
  const now = new Date(clock()).toISOString();
  await db
    .statement(
      `DELETE FROM careops_machine_nonces WHERE org_id = :org AND created_at<?`,
      new Date(clock() - 86400000).toISOString(),
    )
    .run();
  const pending = await db
    .statement(
      `SELECT o.id,o.task_id FROM careops_outbox o JOIN careops_tasks t ON t.org_id=o.org_id AND t.id=o.task_id
 WHERE o.org_id = :org AND o.state='pending' AND ${eligible}
 AND NOT EXISTS(SELECT 1 FROM careops_workflows w WHERE w.org_id=o.org_id AND w.task_id=o.task_id)
 ORDER BY o.created_at,o.id LIMIT ?`,
      Math.min(2, Math.max(1, limit)),
    )
    .all<{ id: string; task_id: string }>();
  for (const item of pending.results) {
    const receipt = crypto.randomUUID(),
      handoff = crypto.randomUUID();
    await db.batch([
      db.statement(
        `INSERT INTO prune_receipts(org_id,id,trigger_id,decision,policy_version,received_at)
    SELECT o.org_id,?,o.id,'accepted','c4-synthetic-staff-approved-v1',? FROM careops_outbox o
    JOIN careops_tasks t ON t.org_id=o.org_id AND t.id=o.task_id
    WHERE o.org_id = :org AND o.id=? AND o.state='pending' AND ${eligible} ON CONFLICT DO NOTHING`,
        receipt,
        now,
        item.id,
      ),
      db.statement(
        `INSERT INTO maritime_handoffs(org_id,id,task_id,receipt_id,status,created_at,updated_at)
    SELECT p.org_id,?,?,p.id,'pending',?,? FROM prune_receipts p
    JOIN careops_outbox o ON o.org_id=p.org_id AND o.id=p.trigger_id
    JOIN careops_tasks t ON t.org_id=o.org_id AND t.id=o.task_id
    WHERE p.org_id = :org AND p.trigger_id=? AND p.decision='accepted' AND ${eligible} ON CONFLICT DO NOTHING`,
        handoff,
        item.task_id,
        now,
        now,
        item.id,
      ),
      db.statement(
        `INSERT INTO careops_workflows(org_id,handoff_id,task_id,trigger_id,event_id,task_ref,state,next_attempt_at,created_at,updated_at)
    SELECT h.org_id,h.id,h.task_id,?, ?,?,'OUTBOX_PENDING',?,?,? FROM maritime_handoffs h
    JOIN careops_tasks t ON t.org_id=h.org_id AND t.id=h.task_id
    WHERE h.org_id = :org AND h.task_id=? AND ${eligible} ON CONFLICT DO NOTHING`,
        item.id,
        crypto.randomUUID(),
        crypto.randomUUID(),
        now,
        now,
        now,
        item.task_id,
      ),
    ]);
  }
  const due = await db
    .statement(
      `SELECT w.* FROM careops_workflows w
 JOIN careops_outbox o ON o.org_id=w.org_id AND o.id=w.trigger_id
 JOIN careops_tasks t ON t.org_id=w.org_id AND t.id=w.task_id
 WHERE w.org_id = :org AND ${eligible} AND w.next_attempt_at<=?
 AND w.state IN ('OUTBOX_PENDING','FAILED_RETRY','DISPATCH_LEASED','WEBHOOK_ACCEPTED','AGENT_RUNNING','DRAFT_READY')
 AND (w.claim_until IS NULL OR w.claim_until<=?) AND (w.lease_expires_at IS NULL OR w.lease_expires_at<=?)
 AND o.state IN ('pending','delivered') ORDER BY w.next_attempt_at,w.handoff_id LIMIT ?`,
      now,
      now,
      now,
      Math.min(2, Math.max(1, limit)),
    )
    .all<Workflow>();
  let attempted = 0;
  const start = clock();
  for (const row of due.results) {
    if (clock() - start > 18000) break;
    const claim = crypto.randomUUID(),
      at = new Date(clock()).toISOString();
    await db.batch([
      db.statement(
        `UPDATE careops_workflows SET dispatch_claim=?,claim_until=?,state='DISPATCH_LEASED',updated_at=?
    WHERE org_id = :org AND handoff_id=? AND next_attempt_at<=? AND (claim_until IS NULL OR claim_until<=?)
    AND (lease_expires_at IS NULL OR lease_expires_at<=?) AND state IN ('OUTBOX_PENDING','FAILED_RETRY','DISPATCH_LEASED','WEBHOOK_ACCEPTED','AGENT_RUNNING','DRAFT_READY')
    AND ${repo.safeSql}`,
        claim,
        new Date(clock() + 30000).toISOString(),
        at,
        row.handoff_id,
        at,
        at,
        at,
      ),
      db.statement(
        `UPDATE careops_outbox SET attempts=attempts+1 WHERE org_id = :org AND id=?
    AND EXISTS(SELECT 1 FROM careops_workflows w WHERE w.org_id=careops_outbox.org_id AND w.trigger_id=careops_outbox.id AND w.dispatch_claim=?)`,
        row.trigger_id,
        claim,
      ),
    ]);
    const owned = await repo.get(row.handoff_id);
    if (!owned || owned.dispatch_claim !== claim) continue;
    const count = await db
      .statement(
        `SELECT attempts FROM careops_outbox WHERE org_id = :org AND id=?`,
        row.trigger_id,
      )
      .first<{ attempts: number }>();
    const attempts = count?.attempts ?? 6;
    await repo.event(row, `${claim}:claim`, "DISPATCH_CLAIMED", at).run();
    let status: number | null = null,
      code: string | null = null,
      next: string | null = null;
    if (attempts <= 5) {
      // Repeat policy immediately before egress; urgent-trigger invalidation wins a prior race.
      const safe = await repo
        .authorized(envelope(row), undefined, at)
        .catch(() => null);
      if (!safe || safe.dispatch_claim !== claim) continue;
      attempted++;
      try {
        const payload = coordinationEnvelopeSchema.parse(envelope(row));
        const response = await (options.transport ?? fetch)(
          `https://api.maritime.sh/api/webhooks/${env.MARITIME_AGENT_ID}`,
          {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              "X-Maritime-Webhook-Token": env.MARITIME_WEBHOOK_TOKEN ?? "",
            },
            body: JSON.stringify(payload),
            redirect: "manual",
            signal: AbortSignal.timeout(8000),
            cache: "no-store",
          },
        );
        status = response.status;
        if (!response.ok) {
          code =
            status === 429
              ? "UPSTREAM_BUSY"
              : status >= 500
                ? "UPSTREAM_UNAVAILABLE"
                : status === 401 || status === 403
                  ? "UPSTREAM_AUTH"
                  : "UPSTREAM_REJECTED";
          if (status === 429 || status >= 500)
            next = retryAt(
              clock(),
              attempts,
              response.headers.get("Retry-After"),
            );
        }
        // Never parse/log provider bodies, including error payloads.
        await response.body?.cancel();
      } catch {
        code = "NETWORK_FAILURE";
        next = retryAt(clock(), attempts, null);
      }
    } else code = "ATTEMPT_LIMIT";
    const success = status !== null && status >= 200 && status < 300;
    if (attempts >= 5) next = null;
    const state = success
      ? "WEBHOOK_ACCEPTED"
      : next
        ? "FAILED_RETRY"
        : "DEAD_LETTER";
    const finished = new Date(clock()).toISOString();
    await db.batch([
      db.statement(
        `UPDATE careops_workflows SET state=?,dispatch_claim=NULL,claim_until=NULL,next_attempt_at=?,updated_at=?
    WHERE org_id = :org AND handoff_id=? AND dispatch_claim=? AND state='DISPATCH_LEASED' AND ${repo.safeSql}`,
        state,
        success ? new Date(clock() + 120000).toISOString() : (next ?? finished),
        finished,
        row.handoff_id,
        claim,
      ),
      db.statement(
        `UPDATE careops_outbox SET state=? WHERE org_id = :org AND id=?
    AND EXISTS(SELECT 1 FROM careops_workflows w WHERE w.org_id=careops_outbox.org_id AND w.trigger_id=careops_outbox.id AND w.state=?)`,
        success ? "delivered" : next ? "pending" : "dead-letter",
        row.trigger_id,
        state,
      ),
      repo.event(row, `${claim}:result`, state, finished, code, status),
    ]);
  }
  return { configured: true, attempted };
}
