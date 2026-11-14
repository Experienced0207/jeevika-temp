import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { LocalDatabase } from "../backend/local/database";
import { migrateLocal, migrationScripts } from "../backend/local/migrate";
import { seedDemo } from "../backend/local/seed";
import { tenantDb } from "../backend/src/database";
import { careopsRepo } from "../backend/src/db/careopsRepo";
import { app as workerApp } from "../backend/src/index";
import { homeRouter } from "../backend/src/modules/home/routes";
import { tokenHash } from "../backend/src/security";
import { driftRadar } from "../packages/engine";
import {
  careopsTaskSchema,
  careopsTriggerSchema,
  maritimeCallbackSchema,
  maritimeWebhookSchema,
  pruneReceiptSchema,
} from "../packages/shared/contracts";
import { demoReadings } from "../packages/shared/demo";

let directory: string;
let db: LocalDatabase;
let token: string;
const app = new Hono().route("/api/v1/home", homeRouter);
const atDay = (day: number) =>
  new Date(Date.UTC(2026, 9, 1) + day * 86400000).toISOString();
const seed = readFileSync("scripts/seed-demo-p1042.sql", "utf8");

async function session(orgId = "demo", role = "DOCTOR") {
  const value = `${orgId}.${crypto.randomUUID()}`;
  const scoped = tenantDb({ db, orgId });
  const user = await scoped
    .statement(
      "SELECT id FROM users WHERE org_id = :org AND role = ? LIMIT 1",
      role,
    )
    .first<{ id: string }>();
  if (!user) throw new Error("Missing seeded user");
  await scoped
    .statement(
      "INSERT INTO sessions (org_id,token_hash,user_id,expires_at) VALUES (:org,?,?,?)",
      await tokenHash(value),
      user.id,
      "2099-01-01T00:00:00.000Z",
    )
    .run();
  return value;
}
function request(path: string, body?: unknown, bearer = token) {
  return app.request(
    `/api/v1/home${path}`,
    {
      method: body === undefined ? "GET" : "POST",
      headers: {
        Authorization: `Bearer ${bearer}`,
        "Content-Type": "application/json",
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    },
    { DB: db, ENVIRONMENT: "test" },
  );
}
function count(
  table:
    | "careops_tasks"
    | "careops_events"
    | "careops_outbox"
    | "vitalis_observations",
  orgId = "demo",
) {
  return tenantDb({ db, orgId })
    .statement(`SELECT COUNT(*) AS n FROM ${table} WHERE org_id = :org`)
    .first<{ n: number }>();
}
beforeEach(async () => {
  directory = mkdtempSync(join(tmpdir(), "careops-"));
  db = new LocalDatabase(join(directory, "test.sqlite"));
  migrateLocal(db);
  await seedDemo(db);
  db.raw.exec(seed);
  token = await session();
});
afterEach(() => {
  db.close();
  rmSync(directory, { recursive: true, force: true });
});

describe("canonical CareOps persistence", () => {
  it("mounts authenticated persistence through the actual Worker entrypoint", async () => {
    const response = await workerApp.request(
      "/api/v1/home/vitals",
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ value: 180, day: 7 }),
      },
      { DB: db, ENVIRONMENT: "test" },
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      driftDetected: true,
      task: { priority: "urgent" },
    });
    expect((await count("careops_tasks"))?.n).toBe(1);
  });
  it("registers 0007 in both runners and applies the schema and seed repeatedly", () => {
    expect(
      readFileSync("scripts/prepare-integration-migrations.ts", "utf8"),
    ).toContain('"backend/migrations/0007_careops_prune_maritime.sql"');
    expect(migrationScripts().join("\n")).toContain(
      "CREATE TABLE IF NOT EXISTS maritime_handoffs",
    );
    migrateLocal(db);
    db.raw.exec(seed);
    expect(
      db.raw
        .prepare(
          "SELECT count(*) AS n FROM vitalis_observations WHERE org_id='demo' AND patient_id='P-1042'",
        )
        .get(),
    ).toMatchObject({ n: 7 });
    expect(db.raw.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
  });

  it("persists the real engine result, task, audit, and one opaque trigger across concurrent retries and restart", async () => {
    const body = { patientId: "P-1042", readings: demoReadings };
    const responses = await Promise.all(
      Array.from({ length: 5 }, () => request("/vitals", body)),
    );
    expect(responses.map((r) => r.status)).toEqual([200, 200, 200, 200, 200]);
    const result = z
      .object({ drift: z.unknown(), task: careopsTaskSchema })
      .parse(await responses[0]!.clone().json());
    expect(await responses[0]!.json()).toMatchObject({
      status: "recorded",
      driftDetected: true,
      task: { patientId: "P-1042", priority: "review" },
    });
    const expected = driftRadar({
      readings: demoReadings.map((r) => ({
        ...r,
        day: Math.floor(Date.parse(atDay(r.day)) / 86400000),
      })),
    });
    expect(result.drift).toEqual(expected);
    expect((await count("careops_tasks"))?.n).toBe(1);
    expect((await count("careops_events"))?.n).toBe(1);
    expect((await count("careops_outbox"))?.n).toBe(1);
    expect((await count("vitalis_observations"))?.n).toBe(21);
    const outbox = await tenantDb({ db, orgId: "demo" })
      .statement("SELECT * FROM careops_outbox WHERE org_id = :org")
      .first<{ id: string; task_id: string }>();
    const trigger = careopsTriggerSchema.parse({
      schemaVersion: 1,
      triggerId: outbox?.id,
    });
    expect(JSON.stringify(trigger)).not.toMatch(
      /P-1042|Sunita|systolic|mm\[Hg\]|patient/,
    );
    expect(outbox?.task_id).toBe(result.task.id);
    db.close();
    db = new LocalDatabase(join(directory, "test.sqlite"));
    const queue = z
      .object({
        queue: z.array(
          careopsTaskSchema.loose().extend({ driftDetected: z.boolean() }),
        ),
      })
      .parse(await (await request("/nurse/queue")).json());
    expect(queue.queue).toHaveLength(1);
    expect(queue.queue[0]).toMatchObject({
      id: result.task.id,
      patientId: "P-1042",
      driftDetected: true,
    });
  });

  it("does not create tasks for stable readings, including persisted baseline", async () => {
    const response = await request("/vitals", { systolic: 125, day: 7 });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      driftDetected: false,
      task: null,
    });
    expect((await count("careops_tasks"))?.n).toBe(0);
    expect((await count("careops_outbox"))?.n).toBe(0);
    expect(await (await request("/nurse/queue")).json()).toEqual({ queue: [] });
  });

  it("evaluates concurrent distinct ingestions together rather than stale snapshots", async () => {
    const responses = await Promise.all([
      request("/vitals", { value: 140, day: 7 }),
      request("/vitals", { value: 140, day: 8 }),
    ]);
    expect(responses.map((r) => r.status)).toEqual([200, 200]);
    expect((await count("careops_tasks"))?.n).toBe(1);
    expect((await count("careops_events"))?.n).toBe(1);
    expect((await count("careops_outbox"))?.n).toBe(1);
  });

  it.each([180, 185, 250])(
    "routes %i mmHg to urgent human review with no trigger",
    async (value) => {
      const response = await request("/vitals", { value, day: 7 });
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({
        driftDetected: true,
        task: { priority: "urgent" },
      });
      await request("/vitals", { value, day: 7 });
      expect((await count("careops_tasks"))?.n).toBe(1);
      expect((await count("careops_events"))?.n).toBe(1);
      expect((await count("careops_outbox"))?.n).toBe(0);
    },
  );

  it("cancels pending nonurgent triggers when an absolute threshold arrives", async () => {
    await request("/vitals", { readings: demoReadings });
    await request("/vitals", { systolic: 180, day: 21 });
    const rows = db.raw
      .prepare("SELECT state FROM careops_outbox WHERE org_id='demo'")
      .all();
    expect(rows).toEqual([{ state: "cancelled" }]);
  });

  it("cannot enqueue a nonurgent trigger racing with an urgent reading", async () => {
    const responses = await Promise.all([
      request("/vitals", { readings: demoReadings }),
      request("/vitals", { value: 180, day: 21 }),
    ]);
    expect(responses.map((r) => r.status)).toEqual([200, 200]);
    expect(
      db.raw
        .prepare(
          "SELECT COUNT(*) AS n FROM careops_outbox WHERE org_id='demo' AND state='pending'",
        )
        .get(),
    ).toMatchObject({ n: 0 });
  });

  it("normalizes equivalent timestamps to the same immutable observation", async () => {
    const sampledAt = atDay(7);
    expect((await request("/vitals", { value: 125, sampledAt })).status).toBe(
      200,
    );
    expect(
      (
        await request("/vitals", {
          value: 125,
          sampledAt: sampledAt.replace(".000Z", "Z"),
        })
      ).status,
    ).toBe(200);
    expect((await count("vitalis_observations"))?.n).toBe(8);
  });

  it("does not average away an individual urgent reading on a baseline day", async () => {
    const response = await request("/vitals", {
      value: 180,
      sampledAt: "2026-10-01T12:00:00.000Z",
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      driftDetected: true,
      task: { priority: "urgent" },
    });
    expect((await count("careops_outbox"))?.n).toBe(0);
  });

  it("isolates matching patient IDs between organizations and rejects tenant spoofing", async () => {
    await request("/vitals", { readings: demoReadings });
    const other = await session("other-org");
    expect(
      await (await request("/nurse/queue", undefined, other)).json(),
    ).toEqual({ queue: [] });
    expect((await request("/vitals", { systolic: 180 }, other)).status).toBe(
      404,
    );
    db.raw.exec(
      seed
        .replaceAll("'demo'", "'other-org'")
        .replaceAll("demo:careops:", "other-org:careops:"),
    );
    expect(
      (await request("/vitals", { systolic: 125, day: 7 }, other)).status,
    ).toBe(200);
    expect((await count("vitalis_observations", "other-org"))?.n).toBe(8);
    expect((await count("careops_tasks", "other-org"))?.n).toBe(0);
    expect(
      (await request("/vitals", { systolic: 125, orgId: "other-org" })).status,
    ).toBe(422);
    expect(
      (
        await request(
          "/nurse/queue",
          undefined,
          token.replace(/^demo\./, "other-org."),
        )
      ).status,
    ).toBe(401);
    expect(() => careopsRepo({ db, orgId: "" })).toThrow();
  });

  it("rejects missing, expired, cashier sessions and production access", async () => {
    expect((await request("/vitals", {}, "")).status).toBe(401);
    expect(
      (
        await request(
          "/nurse/queue",
          undefined,
          await session("demo", "CASHIER"),
        )
      ).status,
    ).toBe(403);
    db.raw.exec(
      "UPDATE sessions SET expires_at='2000-01-01' WHERE org_id='demo'",
    );
    expect((await request("/vitals", {})).status).toBe(401);
    expect(
      (
        await app.request(
          "/api/v1/home/vitals",
          { method: "POST" },
          { DB: db, ENVIRONMENT: "production" },
        )
      ).status,
    ).toBe(503);
  });

  it.each([
    { systolic: 251 },
    { value: 59 },
    { patientId: "another", value: 125 },
    { readings: [] },
    { systolic: 125, value: 180 },
    { systolic: 125, name: "Identifier" },
  ])("rejects invalid boundary input %j without writes", async (body) => {
    expect((await request("/vitals", body)).status).toBe(422);
    expect((await count("vitalis_observations"))?.n).toBe(7);
  });

  it("rolls back task side effects on event failure and recovers on replay", async () => {
    db.raw.exec(
      "CREATE TRIGGER fail_event BEFORE INSERT ON careops_events BEGIN SELECT RAISE(ABORT,'test failure'); END;",
    );
    expect((await request("/vitals", { readings: demoReadings })).status).toBe(
      500,
    );
    expect((await count("vitalis_observations"))?.n).toBe(21);
    expect((await count("careops_tasks"))?.n).toBe(0);
    expect((await count("careops_outbox"))?.n).toBe(0);
    db.raw.exec("DROP TRIGGER fail_event");
    expect((await request("/vitals", { readings: demoReadings })).status).toBe(
      200,
    );
    expect((await count("careops_tasks"))?.n).toBe(1);
    expect((await count("careops_events"))?.n).toBe(1);
    expect((await count("careops_outbox"))?.n).toBe(1);
  });

  it("keeps existing observations immutable on conflicting replay", async () => {
    expect((await request("/vitals", { value: 180, day: 0 })).status).toBe(500);
    expect((await count("careops_tasks"))?.n).toBe(0);
    expect(
      db.raw
        .prepare(
          "SELECT value_numeric FROM vitalis_observations WHERE org_id='demo' ORDER BY observed_start_utc LIMIT 1",
        )
        .get(),
    ).toMatchObject({ value_numeric: 124 });
  });

  it("preserves empty-body demo fields and pure drift endpoint", async () => {
    expect(await (await request("/vitals", {})).json()).toMatchObject({
      status: "recorded",
      driftDetected: true,
      readingId: expect.any(String),
      timestamp: expect.any(String),
    });
    const response = await request("/drift", { readings: demoReadings }, "");
    expect(await response.json()).toEqual(
      driftRadar({ readings: demoReadings }),
    );
  });

  it("strictly rejects PHI and unknown fields in external contracts", () => {
    const id = crypto.randomUUID();
    const payloads = [
      [careopsTriggerSchema, { schemaVersion: 1, triggerId: id }],
      [
        pruneReceiptSchema,
        {
          schemaVersion: 1,
          receiptId: id,
          triggerId: id,
          decision: "accepted",
          policyVersion: "v1",
          receivedAt: new Date().toISOString(),
        },
      ],
      [
        maritimeWebhookSchema,
        { schemaVersion: 1, handoffId: id, receiptId: id, triggerId: id },
      ],
      [
        maritimeCallbackSchema,
        {
          schemaVersion: 1,
          handoffId: id,
          eventId: id,
          status: "completed",
          occurredAt: new Date().toISOString(),
        },
      ],
    ] as const;
    for (const [schema, payload] of payloads) {
      expect(schema.safeParse(payload).success).toBe(true);
      expect(
        schema.safeParse({ ...payload, patientId: "P-1042" }).success,
      ).toBe(false);
      expect(schema.safeParse({ ...payload, schemaVersion: 2 }).success).toBe(
        false,
      );
    }
  });
});
