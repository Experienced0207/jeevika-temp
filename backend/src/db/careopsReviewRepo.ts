import {
  careopsReviewInputSchema,
  careopsReviewResultSchema,
} from "../../../packages/shared/contracts";
import { type Database, tenantDb } from "../database";

type Task = { id: string; status: string; priority: string };
type Review = {
  id: string;
  task_id: string;
  action: string;
  actor_id: string;
  note: string;
  from_status: string;
  to_status: string;
  created_at: string;
};
export class ReviewError extends Error {
  constructor(
    readonly status: 404 | 409,
    message: string,
  ) {
    super(message);
  }
}

/** Internal administrative approval only. C4 must re-read this gate in its own
 * authenticated transaction; an API response or task status is never authority
 * to send a patient message, change treatment or dispatch an external agent.
 */
export function careopsReviewRepo(context: { db: Database; orgId: string }) {
  if (!/^[a-z0-9-]{1,80}$/.test(context.orgId))
    throw new Error("Invalid tenant");
  const db = tenantDb(context);
  const task = (id: string) =>
    db
      .statement(
        `SELECT t.id,t.status,t.priority FROM careops_tasks t
     JOIN patients p ON p.org_id=t.org_id AND p.id=t.patient_id AND p.synthetic=1
     WHERE t.org_id = :org AND t.id = ?`,
        id,
      )
      .first<Task>();
  const prior = (id: string, action: string) =>
    db
      .statement(
        "SELECT * FROM careops_task_reviews WHERE org_id = :org AND task_id = ? AND action = ?",
        id,
        action,
      )
      .first<Review>();
  const authorization = async (id: string) => {
    const current = await task(id);
    if (!current) throw new ReviewError(404, "Task not found");
    return {
      staffReviewApproved:
        current.priority !== "urgent" &&
        current.status === "in_progress" &&
        !!(await prior(id, "approve")),
      clinicianReviewRequired: current.priority === "urgent",
      administrativeDraftPermitted: false as const,
      agentDispatchPermitted: false as const,
      patientMessagingPermitted: false as const,
      medicationChangePermitted: false as const,
    };
  };
  const result = async (row: Review) => ({
    review: careopsReviewResultSchema.parse({
      id: row.id,
      taskId: row.task_id,
      action: row.action,
      actorId: row.actor_id,
      fromStatus: row.from_status,
      toStatus: row.to_status,
      reviewedAt: row.created_at,
    }),
    authorization: await authorization(row.task_id),
  });
  return {
    authorization,
    async decide(id: string, actorId: string, raw: unknown) {
      const input = careopsReviewInputSchema.parse(raw);
      const current = await task(id);
      if (!current) throw new ReviewError(404, "Task not found");
      const existing = await prior(id, input.action);
      const checkReplay = (row: Review) => {
        if (row.actor_id !== actorId || row.note !== input.note)
          throw new ReviewError(
            409,
            "Review already recorded with different input",
          );
      };
      if (existing) {
        checkReplay(existing);
        return result(existing);
      }
      const allowed =
        input.action === "approve"
          ? current.status === "open"
          : input.action === "reject"
            ? ["open", "in_progress"].includes(current.status)
            : current.status === "in_progress" &&
              !!(await prior(id, "approve"));
      if (!allowed)
        throw new ReviewError(409, "Task transition is not permitted");
      const nextStatus =
        input.action === "approve"
          ? "in_progress"
          : input.action === "reject"
            ? "cancelled"
            : "completed";
      const reviewId = crypto.randomUUID();
      const now = new Date().toISOString();
      await db.batch([
        db.statement(
          `INSERT INTO careops_task_reviews (org_id,id,task_id,action,actor_id,note,from_status,to_status,created_at)
           SELECT t.org_id,?,t.id,?,?,?,t.status,?,? FROM careops_tasks t
           WHERE t.org_id = :org AND t.id = ? AND t.status = ?
           AND EXISTS (SELECT 1 FROM patients p WHERE p.org_id=t.org_id AND p.id=t.patient_id AND p.synthetic=1)
           AND EXISTS (SELECT 1 FROM users u WHERE u.org_id=t.org_id AND u.id=? AND u.role IN ('NURSE','DOCTOR'))
           AND (? <> 'complete' OR EXISTS (SELECT 1 FROM careops_task_reviews r WHERE r.org_id=t.org_id AND r.task_id=t.id AND r.action='approve'))
           ON CONFLICT(org_id,task_id,action) DO NOTHING`,
          reviewId,
          input.action,
          actorId,
          input.note,
          nextStatus,
          now,
          id,
          current.status,
          actorId,
          input.action,
        ),
        db.statement(
          `UPDATE careops_tasks SET status=?,updated_at=? WHERE org_id = :org AND id=? AND status=?
           AND EXISTS (SELECT 1 FROM careops_task_reviews r WHERE r.org_id=careops_tasks.org_id AND r.task_id=careops_tasks.id AND r.id=?)`,
          nextStatus,
          now,
          id,
          current.status,
          reviewId,
        ),
        db.statement(
          `UPDATE careops_outbox SET state='cancelled' WHERE org_id = :org AND task_id=? AND state='pending'
           AND EXISTS (SELECT 1 FROM careops_task_reviews r
             JOIN careops_tasks t ON t.org_id=r.org_id AND t.id=r.task_id
             WHERE r.org_id=careops_outbox.org_id AND r.task_id=careops_outbox.task_id AND r.id=?
               AND (r.action IN ('reject','complete') OR t.priority='urgent'))`,
          id,
          reviewId,
        ),
      ]);
      const stored = await prior(id, input.action);
      if (!stored)
        throw new ReviewError(
          409,
          "Concurrent task transition; reload before reviewing",
        );
      checkReplay(stored);
      return result(stored);
    },
  };
}
