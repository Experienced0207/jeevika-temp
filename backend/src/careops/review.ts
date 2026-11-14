import { HTTPException } from "hono/http-exception";
import { z } from "zod";
import { deterministicDraft } from "../../../packages/ai/egressSafetyGate";
import { careopsDraftReviewSchema } from "../../../packages/shared/careops-workflow";
import type { Database } from "../database";
import { tokenHash } from "../security";
import { eligible, type Workflow, workflowRepo } from "./repo";
export async function reviewDraft(
  context: { db: Database; orgId: string },
  taskId: string,
  actorId: string,
  key: string | undefined,
  raw: unknown,
) {
  const input = careopsDraftReviewSchema.parse(raw),
    idempotency = z.uuid().parse(key);
  const repo = workflowRepo(context),
    { db } = repo;
  const hash = await tokenHash(JSON.stringify({ taskId, ...input }));
  const prior = () =>
    db
      .statement(
        `SELECT id,resulting_revision,action,request_hash FROM careops_draft_reviews WHERE org_id = :org AND actor_id=? AND idempotency_key=?`,
        actorId,
        idempotency,
      )
      .first<{
        id: string;
        resulting_revision: number;
        action: string;
        request_hash: string;
      }>();
  const replay = await prior();
  const result = (row: NonNullable<typeof replay>) => {
    if (row.request_hash !== hash)
      throw new HTTPException(409, { message: "Idempotency key conflicts" });
    return {
      reviewId: row.id,
      revision: row.resulting_revision,
      action: row.action,
      messaging: "SIMULATED" as const,
    };
  };
  if (replay) return result(replay);
  const w = await db
    .statement(
      `SELECT w.* FROM careops_workflows w JOIN careops_tasks t ON t.org_id=w.org_id AND t.id=w.task_id
 WHERE w.org_id = :org AND w.task_id=? AND ${eligible}`,
      taskId,
    )
    .first<Workflow>();
  if (!w)
    throw new HTTPException(404, { message: "Reviewable task not found" });
  const d = await repo.draft(w.handoff_id);
  if (
    !d ||
    d.draft_ref !== input.draftRef ||
    d.revision !== input.revision ||
    d.state !== "PENDING_REVIEW"
  )
    throw new HTTPException(409, {
      message: "Draft changed or is not pending review",
    });
  const id = crypto.randomUUID(),
    now = new Date().toISOString(),
    state =
      input.action === "approve"
        ? "APPROVED_TO_SEND"
        : input.action === "reject"
          ? "REJECTED"
          : "PENDING_REVIEW";
  const language = input.language ?? d.language;
  const text =
    input.action === "edit"
      ? deterministicDraft({ workflow: "careops_followup", language })
      : d.text;
  // Revision increments for every human decision. Edits select generic server templates only.
  await db.batch([
    db.statement(
      `INSERT INTO careops_draft_reviews(org_id,id,draft_ref,task_id,base_revision,resulting_revision,action,actor_id,note,request_hash,idempotency_key,created_at,text_snapshot,language)
   SELECT d.org_id,?,d.draft_ref,d.task_id,d.revision,d.revision+1,?,?,?,?,?,?,?,? FROM careops_drafts d
   JOIN careops_workflows w ON w.org_id=d.org_id AND w.handoff_id=d.handoff_id
   JOIN careops_tasks t ON t.org_id=w.org_id AND t.id=w.task_id
   WHERE d.org_id = :org AND d.draft_ref=? AND d.task_id=? AND d.revision=? AND d.state='PENDING_REVIEW' AND w.state='PENDING_REVIEW'
   AND ${eligible} AND EXISTS(SELECT 1 FROM users u WHERE u.org_id=d.org_id AND u.id=? AND u.role IN ('DOCTOR','NURSE')) ON CONFLICT DO NOTHING`,
      id,
      input.action,
      actorId,
      input.note,
      hash,
      idempotency,
      now,
      text,
      language,
      d.draft_ref,
      taskId,
      input.revision,
      actorId,
    ),
    db.statement(
      `UPDATE careops_drafts SET state=?,revision=revision+1,text=?,language=?,text_source=?,communication_state=?,updated_at=?
   WHERE org_id = :org AND draft_ref=? AND revision=? AND EXISTS(SELECT 1 FROM careops_draft_reviews r WHERE r.org_id=careops_drafts.org_id AND r.id=?)`,
      state,
      text,
      language,
      input.action === "edit" ? "HUMAN_TEMPLATE" : d.text_source,
      input.action === "approve" ? "SIMULATED" : "NOT_SENT",
      now,
      d.draft_ref,
      input.revision,
      id,
    ),
    db.statement(
      `UPDATE careops_workflows SET state=?,updated_at=? WHERE org_id = :org AND handoff_id=?
   AND EXISTS(SELECT 1 FROM careops_draft_reviews r WHERE r.org_id=careops_workflows.org_id AND r.id=?)`,
      state,
      now,
      w.handoff_id,
      id,
    ),
    repo.event(
      w,
      `${id}:review`,
      input.action === "edit" ? "EDITED" : state,
      now,
      null,
      null,
      actorId,
      "EXISTS(SELECT 1 FROM careops_draft_reviews r WHERE r.org_id=w.org_id AND r.id=?)",
      [id],
    ),
    ...(input.action === "edit"
      ? []
      : [
          repo.thread(
            w,
            `${id}:review`,
            state,
            now,
            "EXISTS(SELECT 1 FROM careops_draft_reviews r WHERE r.org_id=w.org_id AND r.id=?)",
            [id],
          ),
        ]),
  ]);
  const stored = await prior();
  if (!stored)
    throw new HTTPException(409, {
      message: "Concurrent draft decision; reload",
    });
  return result(stored);
}
