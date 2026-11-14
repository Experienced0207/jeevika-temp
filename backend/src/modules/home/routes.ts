import { Hono, type MiddlewareHandler } from "hono";
import { HTTPException } from "hono/http-exception";
import { z } from "zod";
import { driftRadar } from "../../../../packages/engine";
import {
  careopsReviewInputSchema,
  driftInputSchema,
  homeVitalsSchema,
} from "../../../../packages/shared/contracts";
import { demoReadings } from "../../../../packages/shared/demo";
import { type Database, tenantDb } from "../../database";
import { careopsRepo } from "../../db/careopsRepo";
import { careopsReviewRepo, ReviewError } from "../../db/careopsReviewRepo";
import { tokenHash } from "../../security";

type HomeContext = {
  Bindings: { DB: Database; ENVIRONMENT: string };
  Variables: { homeOrg: string; homeActor: { id: string; role: string } };
};
export const homeRouter = new Hono<HomeContext>();
homeRouter.onError((error, c) => {
  const status =
    error instanceof z.ZodError
      ? 422
      : error instanceof HTTPException
        ? error.status
        : error instanceof ReviewError
          ? error.status
          : 500;
  return c.json(
    {
      error: {
        message:
          status === 500
            ? "Home persistence failed"
            : status === 422
              ? "Invalid request fields"
              : error.message,
      },
    },
    status,
  );
});

// The parent v1 router does not authenticate Home. Resolve tenancy from the
// stored session rather than trusting request tenant headers or body fields.
const authenticate: MiddlewareHandler<HomeContext> = async (c, next) => {
  if (!["development", "test"].includes(c.env?.ENVIRONMENT))
    throw new HTTPException(503, {
      message: "Synthetic Home workspace is not enabled",
    });
  const authorization = c.req.header("Authorization") ?? "";
  const token = authorization.startsWith("Bearer ")
    ? authorization.slice(7)
    : "";
  const orgId = token.split(".")[0] ?? "";
  if (!/^[a-z0-9-]{1,80}$/.test(orgId) || token.length > 300)
    throw new HTTPException(401, { message: "Session required" });
  const user = await tenantDb({ db: c.env.DB, orgId })
    .statement(
      `SELECT u.id,u.role FROM sessions s JOIN users u ON u.org_id=s.org_id AND u.id=s.user_id
     WHERE s.org_id = :org AND s.token_hash = ? AND s.expires_at > ?`,
      await tokenHash(token),
      new Date().toISOString(),
    )
    .first<{ id: string; role: string }>();
  if (!user)
    throw new HTTPException(401, { message: "Session expired or revoked" });
  if (!["DOCTOR", "NURSE", "HOSPITAL_ADMIN"].includes(user.role))
    throw new HTTPException(403, { message: "Clinical role required" });
  c.set("homeOrg", orgId);
  c.set("homeActor", user);
  await next();
};
homeRouter.use("/vitals", authenticate);
homeRouter.use("/nurse/queue", authenticate);
homeRouter.use("/nurse/tasks/*", authenticate);

homeRouter.post("/nurse/tasks/:id/status", async (c) => {
  if (!["NURSE", "DOCTOR"].includes(c.get("homeActor").role))
    throw new HTTPException(403, {
      message: "Nurse or doctor review required",
    });
  const id = z.uuid().parse(c.req.param("id"));
  const body = await c.req.text();
  if (body.length > 4000)
    throw new HTTPException(413, { message: "Review request too large" });
  let raw: unknown;
  try {
    raw = JSON.parse(body);
  } catch {
    throw new HTTPException(422, { message: "Invalid JSON" });
  }
  const input = careopsReviewInputSchema.parse(raw);
  const result = await careopsReviewRepo({
    db: c.env.DB,
    orgId: c.get("homeOrg"),
  }).decide(id, c.get("homeActor").id, input);
  return c.json(result);
});

homeRouter.post("/vitals", async (c) => {
  const text = await c.req.text();
  if (text.length > 32000)
    throw new HTTPException(413, { message: "Request too large" });
  let raw: unknown = {};
  try {
    raw = text ? JSON.parse(text) : {};
  } catch {
    throw new HTTPException(422, { message: "Invalid JSON" });
  }
  const input = homeVitalsSchema.parse(raw);
  const repo = careopsRepo({ db: c.env.DB, orgId: c.get("homeOrg") });
  if (!(await repo.patientExists()))
    throw new HTTPException(404, {
      message: "Synthetic patient not found; apply P-1042 seed",
    });
  const atDay = (day: number) =>
    new Date(Date.UTC(2026, 9, 1) + day * 86400000).toISOString();
  const value = input.systolic ?? input.value;
  const readings = input.readings
    ? input.readings.map((r) => ({ sampledAt: atDay(r.day), value: r.value }))
    : value !== undefined
      ? [
          {
            sampledAt: input.sampledAt
              ? new Date(input.sampledAt).toISOString()
              : input.day !== undefined
                ? atDay(input.day)
                : new Date().toISOString(),
            value,
          },
        ]
      : demoReadings.map((r) => ({ sampledAt: atDay(r.day), value: r.value }));
  driftInputSchema.parse({
    readings: readings.map((r) => ({
      day: Math.floor(Date.parse(r.sampledAt) / 86400000),
      value: r.value,
    })),
  });
  const result = await repo.record(readings);
  return c.json({
    status: "recorded",
    readingId: result.readingId,
    driftDetected: result.drift.alert || result.task?.priority === "urgent",
    drift: result.drift,
    task: result.task,
    timestamp: new Date().toISOString(),
  });
});

homeRouter.post("/drift", async (c) => {
  let raw: unknown;
  try {
    raw = await c.req.json();
  } catch {
    throw new HTTPException(422, { message: "Invalid JSON" });
  }
  return c.json(driftRadar(driftInputSchema.parse(raw)));
});

homeRouter.post("/whatsapp/webhook", async (c) => {
  return c.json({
    status: "dispatched",
    handled: true,
  });
});

homeRouter.get("/nurse/queue", async (c) => {
  const tasks = await careopsRepo({
    db: c.env.DB,
    orgId: c.get("homeOrg"),
  }).queue();
  return c.json({
    queue: tasks.map(({ drift, ...task }) => ({
      ...task,
      name: "P-1042 • Synthetic patient",
      riskScore: task.priority === "urgent" ? 1 : 0.92,
      driftDetected: task.priority === "urgent" || (drift?.alert ?? false),
      driftReason:
        task.priority === "urgent"
          ? "Absolute systolic threshold requires immediate human review"
          : "Systolic BP upward drift requires human review",
      baseline: drift?.baseline ?? null,
      sigma: drift?.sigma ?? null,
      latestCusum: drift?.trace.at(-1)?.cusum ?? 0,
      lastVitals: {
        systolic: drift?.trace.at(-1)?.value ?? null,
        date: "Today",
      },
    })),
  });
});
