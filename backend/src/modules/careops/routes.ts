import { Hono, type Context as HonoContext } from "hono";
import { HTTPException } from "hono/http-exception";
import { z } from "zod";
import {
  careopsPageSchema,
  careopsTaskDetailSchema,
  careopsTaskPageSchema,
} from "../../../../packages/shared/careops-workflow";
import type { Principal } from "../../../../packages/shared/integration";
import {
  type CareopsBindings,
  maritimeConfigured,
  requireCareops,
} from "../../careops/config";
import { dispatchCareops } from "../../careops/dispatch";
import { machineAuthenticate } from "../../careops/machineAuth";
import { type Workflow, workflowRepo } from "../../careops/repo";
import { reviewDraft } from "../../careops/review";
import { machineOperations } from "../../careops/tools";
import { jsonBody } from "../../http";

type Context = {
  Bindings: CareopsBindings;
  Variables: { principal: Principal };
};
export const machineRouter = new Hono<Context>();
export const careopsRouter = new Hono<Context>();
export const callbackRouter = new Hono<Context>();
for (const router of [machineRouter, careopsRouter, callbackRouter]) {
  router.onError((error, c) => {
    const status =
      error instanceof z.ZodError
        ? 422
        : error instanceof HTTPException
          ? error.status
          : 500;
    return c.json(
      {
        error: {
          message:
            status === 500
              ? "CareOps persistence unavailable"
              : status === 422
                ? "Invalid coordination fields"
                : error.message,
        },
      },
      status,
    );
  });
  router.use("*", async (c, next) => {
    c.header("Cache-Control", "no-store");
    await next();
  });
}
const machineHandler =
  (operation: "context" | "draft" | "event") =>
  async (c: HonoContext<Context>) => {
    const body = await c.req.text();
    if (body.length > 4096)
      throw new HTTPException(413, { message: "Machine request too large" });
    const orgId = await machineAuthenticate(c.req.raw, c.env, body);
    let raw: unknown;
    try {
      raw = JSON.parse(body);
    } catch {
      throw new HTTPException(422, { message: "Invalid JSON" });
    }
    return c.json(await machineOperations(c.env, orgId)[operation](raw));
  };
machineRouter.post("/context", machineHandler("context"));
machineRouter.post("/draft", machineHandler("draft"));
machineRouter.post("/events", machineHandler("event"));
callbackRouter.post("/maritime/callback", machineHandler("event"));
careopsRouter.use("*", async (c, next) => {
  const p = c.get("principal");
  if (!p) throw new HTTPException(401, { message: "Session required" });
  if (!["NURSE", "DOCTOR", "HOSPITAL_ADMIN"].includes(p.role))
    throw new HTTPException(403, { message: "Clinical role required" });
  requireCareops(c.env, p.orgId);
  await next();
});
careopsRouter.post("/dispatch", async (c) => {
  if (c.get("principal").role !== "HOSPITAL_ADMIN")
    throw new HTTPException(403, { message: "Administrator required" });
  const input = z
    .strictObject({ limit: z.number().int().min(1).max(2).default(1) })
    .parse(await jsonBody(c.req.raw));
  return c.json(
    await dispatchCareops(c.env, c.get("principal").orgId, input.limit),
  );
});
careopsRouter.get("/tasks", async (c) => {
  const input = careopsPageSchema.parse(c.req.query());
  const { db } = workflowRepo({
    db: c.env.DB,
    orgId: c.get("principal").orgId,
  });
  const result = await db
    .statement(
      `SELECT t.id,t.status,t.priority,t.created_at AS createdAt,t.updated_at AS updatedAt,w.state AS workflowState
  FROM careops_tasks t JOIN patients p ON p.org_id=t.org_id AND p.id=t.patient_id AND p.synthetic=1
  LEFT JOIN careops_workflows w ON w.org_id=t.org_id AND w.task_id=t.id
  WHERE t.org_id = :org AND t.patient_id='P-1042' AND t.id>? ORDER BY t.id LIMIT ?`,
      input.cursor ?? "",
      input.limit + 1,
    )
    .all<{ id: string }>();
  return c.json(
    careopsTaskPageSchema.parse({
      items: result.results.slice(0, input.limit),
      nextCursor:
        result.results.length > input.limit
          ? result.results[input.limit - 1]?.id
          : null,
    }),
  );
});
careopsRouter.get("/tasks/:id", async (c) => {
  const id = z.uuid().parse(c.req.param("id"));
  const repo = workflowRepo({ db: c.env.DB, orgId: c.get("principal").orgId }),
    { db } = repo;
  const task = await db
    .statement(
      `SELECT t.id,t.status,t.priority,t.created_at AS createdAt,t.updated_at AS updatedAt FROM careops_tasks t
 JOIN patients p ON p.org_id=t.org_id AND p.id=t.patient_id AND p.synthetic=1
 WHERE t.org_id = :org AND t.id=? AND t.patient_id='P-1042'`,
      id,
    )
    .first();
  if (!task) throw new HTTPException(404, { message: "Task not found" });
  const w = await db
    .statement(
      `SELECT * FROM careops_workflows WHERE org_id = :org AND task_id=?`,
      id,
    )
    .first<Workflow>();
  const events = await db
    .statement(
      `SELECT id,event_type AS eventType,code,http_status AS httpStatus,created_at AS createdAt FROM careops_agent_events WHERE org_id = :org AND task_id=? ORDER BY created_at DESC,id DESC LIMIT 100`,
      id,
    )
    .all();
  const thread = await db
    .statement(
      `SELECT id,outcome,created_at AS createdAt FROM careops_thread_entries WHERE org_id = :org AND task_id=? ORDER BY created_at DESC,id DESC LIMIT 100`,
      id,
    )
    .all();
  const d = w ? await repo.draft(w.handoff_id) : null;
  return c.json(
    careopsTaskDetailSchema.parse({
      task,
      workflow: w
        ? {
            state: w.state,
            handoffId: w.handoff_id,
            updatedAt: w.updated_at,
          }
        : null,
      draft: d
        ? {
            draftRef: d.draft_ref,
            text: d.text,
            textSource: d.text_source,
            pruneAuditAppliesTo: "INITIAL_DRAFT",
            language: d.language,
            state: d.state,
            revision: d.revision,
            provider: d.provider,
            receiptStatus: d.receipt_status,
            communicationState: d.communication_state,
          }
        : null,
      events: events.results,
      thread: thread.results,
      auditTruncated:
        events.results.length === 100 || thread.results.length === 100,
      providerConfigured: maritimeConfigured(c.env),
      cost: null,
      messaging: "SIMULATED",
    }),
  );
});
careopsRouter.post("/tasks/:id/draft/review", async (c) => {
  const p = c.get("principal");
  if (!["NURSE", "DOCTOR"].includes(p.role))
    throw new HTTPException(403, { message: "Nurse or doctor required" });
  return c.json(
    await reviewDraft(
      { db: c.env.DB, orgId: p.orgId },
      z.uuid().parse(c.req.param("id")),
      p.userId,
      c.req.header("Idempotency-Key"),
      await jsonBody(c.req.raw),
    ),
  );
});
