import { readFileSync } from "node:fs";
import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LocalDatabase } from "../backend/local/database";
import { migrateLocal } from "../backend/local/migrate";
import { seedDemo } from "../backend/local/seed";
import { tenantDb } from "../backend/src/database";
import { careopsRepo } from "../backend/src/db/careopsRepo";
import {
  careopsReviewRepo,
  ReviewError,
} from "../backend/src/db/careopsReviewRepo";
import { app as workerApp } from "../backend/src/index";
import { homeRouter } from "../backend/src/modules/home/routes";
import { tokenHash } from "../backend/src/security";

let db: LocalDatabase;
let token: string;
let taskId: string;
const app = new Hono().route("/api/v1/home", homeRouter);
async function session(orgId = "demo", user = "nurse") {
  const value = `${orgId}.${crypto.randomUUID()}`;
  await tenantDb({ db, orgId })
    .statement(
      "INSERT INTO sessions (org_id,token_hash,user_id,expires_at) VALUES (:org,?,?,?)",
      await tokenHash(value),
      user,
      "2099-01-01T00:00:00.000Z",
    )
    .run();
  return value;
}
const request = (body: unknown, bearer = token, id = taskId) =>
  app.request(
    `/api/v1/home/nurse/tasks/${id}/status`,
    {
      method: "POST",
      headers: { Authorization: `Bearer ${bearer}` },
      body: JSON.stringify(body),
    },
    { DB: db, ENVIRONMENT: "test" },
  );
const reviewRows = () =>
  db.raw
    .prepare(
      "SELECT * FROM careops_task_reviews WHERE org_id='demo' ORDER BY created_at,id",
    )
    .all();
beforeEach(async () => {
  db = new LocalDatabase();
  migrateLocal(db);
  await seedDemo(db);
  db.raw.exec(readFileSync("scripts/seed-demo-p1042.sql", "utf8"));
  const result = await careopsRepo({ db, orgId: "demo" }).record([
    { sampledAt: "2026-10-08T00:00:00.000Z", value: 150 },
  ]);
  if (!result.task) throw new Error("Missing drift task");
  taskId = result.task.id;
  token = await session();
});
afterEach(() => {
  db.close();
  vi.unstubAllGlobals();
});
describe("authenticated nurse administrative review", () => {
  it("approves and completes with immutable evidence and no vendor calls", async () => {
    const fetchMock = vi.fn<typeof fetch>();
    vi.stubGlobal("fetch", fetchMock);
    const approved = await request({
      action: "approve",
      note: "Synthetic administrative review",
    });
    expect(approved.status).toBe(200);
    expect(await approved.json()).toMatchObject({
      review: {
        action: "approve",
        actorId: "nurse",
        fromStatus: "open",
        toStatus: "in_progress",
      },
      authorization: {
        staffReviewApproved: true,
        administrativeDraftPermitted: false,
        agentDispatchPermitted: false,
        patientMessagingPermitted: false,
        medicationChangePermitted: false,
      },
    });
    const completed = await request({ action: "complete" });
    expect(completed.status).toBe(200);
    expect(await completed.json()).toMatchObject({
      review: {
        action: "complete",
        fromStatus: "in_progress",
        toStatus: "completed",
      },
      authorization: {
        staffReviewApproved: false,
        agentDispatchPermitted: false,
      },
    });
    expect(reviewRows()).toHaveLength(2);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(() =>
      db.raw.exec(
        "UPDATE careops_task_reviews SET note='changed' WHERE org_id='demo'",
      ),
    ).toThrow("REVIEW_IMMUTABLE");
    expect(() =>
      db.raw.exec("DELETE FROM careops_task_reviews WHERE org_id='demo'"),
    ).toThrow("REVIEW_IMMUTABLE");
    expect(
      db.raw
        .prepare("SELECT state FROM careops_outbox WHERE org_id='demo'")
        .get(),
    ).toMatchObject({ state: "cancelled" });
  });
  it("rejects an open task, records the note internally and cancels pending triggers", async () => {
    const response = await request({
      action: "reject",
      note: "Synthetic review declined",
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      review: { toStatus: "cancelled" },
      authorization: { agentDispatchPermitted: false },
    });
    expect(reviewRows()[0]).toMatchObject({
      action: "reject",
      note: "Synthetic review declined",
    });
    expect((await request({ action: "approve" })).status).toBe(409);
  });
  it("requires recorded approval before completion, then allows rejection from in-progress", async () => {
    expect((await request({ action: "complete" })).status).toBe(409);
    expect((await request({ action: "approve" })).status).toBe(200);
    expect((await request({ action: "reject" })).status).toBe(200);
    expect((await request({ action: "complete" })).status).toBe(409);
  });
  it("returns the same review for concurrent identical decisions and rejects changed replay", async () => {
    const responses = await Promise.all(
      Array.from({ length: 6 }, () =>
        request({ action: "approve", note: "Same review" }),
      ),
    );
    expect(responses.map((r) => r.status)).toEqual([
      200, 200, 200, 200, 200, 200,
    ]);
    const bodies = await Promise.all(responses.map((r) => r.json()));
    expect(
      bodies.every(
        (body) => JSON.stringify(body) === JSON.stringify(bodies[0]),
      ),
    ).toBe(true);
    expect(reviewRows()).toHaveLength(1);
    expect((await request({ action: "approve", note: "Changed" })).status).toBe(
      409,
    );
    expect(
      (
        await request(
          { action: "approve", note: "Same review" },
          await session("demo", "doctor"),
        )
      ).status,
    ).toBe(409);
  });
  it("permits only one racing transition from the same optimistic snapshot", async () => {
    let arrivals = 0;
    let release = () => {};
    const barrier = new Promise<void>((resolve) => {
      release = resolve;
    });
    const repository = careopsReviewRepo({
      orgId: "demo",
      db: {
        prepare: db.prepare.bind(db),
        batch: async (statements) => {
          arrivals++;
          if (arrivals === 2) release();
          await barrier;
          return db.batch(statements);
        },
      },
    });
    const statuses = await Promise.all(
      ["approve", "reject"].map((action) =>
        repository.decide(taskId, "nurse", { action }).then(
          () => 200,
          (error: unknown) => {
            if (!(error instanceof ReviewError)) throw error;
            return error.status;
          },
        ),
      ),
    );
    expect(statuses.sort()).toEqual([200, 409]);
    expect(reviewRows()).toHaveLength(1);
  });
  it("rolls back evidence when the task update fails", async () => {
    db.raw.exec(
      "CREATE TRIGGER fail_task_update BEFORE UPDATE ON careops_tasks BEGIN SELECT RAISE(ABORT,'test failure'); END;",
    );
    expect((await request({ action: "approve" })).status).toBe(500);
    expect(reviewRows()).toHaveLength(0);
    expect(
      db.raw
        .prepare("SELECT status FROM careops_tasks WHERE org_id='demo'")
        .get(),
    ).toMatchObject({ status: "open" });
  });
  it("denies anonymous, expired, wrong-role and cross-tenant access", async () => {
    expect((await request({ action: "approve" }, "")).status).toBe(401);
    for (const user of ["cashier", "admin"])
      expect(
        (await request({ action: "approve" }, await session("demo", user)))
          .status,
      ).toBe(403);
    expect(
      (await request({ action: "approve" }, await session("other-org"))).status,
    ).toBe(404);
    expect(
      (
        await request(
          { action: "approve" },
          token.replace(/^demo\./, "other-org."),
        )
      ).status,
    ).toBe(401);
    db.raw.exec(
      "UPDATE sessions SET expires_at='2000-01-01' WHERE org_id='demo'",
    );
    expect((await request({ action: "approve" })).status).toBe(401);
    expect(reviewRows()).toHaveLength(0);
  });
  it.each([
    { action: "APPROVED" },
    { status: "completed" },
    { action: "approve", note: "x".repeat(501) },
    { action: "approve", orgId: "other-org" },
  ])("validates request %j", async (body) => {
    expect((await request(body)).status).toBe(422);
    expect(reviewRows()).toHaveLength(0);
  });
  it("rejects malformed and missing IDs", async () => {
    expect(
      (await request({ action: "approve" }, token, "not-a-uuid")).status,
    ).toBe(422);
    expect(
      (await request({ action: "approve" }, token, crypto.randomUUID())).status,
    ).toBe(404);
  });
  it("keeps urgent tasks clinician-only even after approval and completion", async () => {
    const urgent = await careopsRepo({ db, orgId: "demo" }).record([
      { sampledAt: "2026-10-09T00:00:00.000Z", value: 180 },
    ]);
    if (!urgent.task) throw new Error("Missing urgent task");
    // Defensive legacy case: even an erroneously pending urgent trigger is
    // cancelled by acknowledgement, never made dispatchable by approval.
    await tenantDb({ db, orgId: "demo" })
      .statement(
        "INSERT INTO careops_outbox (org_id,id,task_id,event_type,created_at) VALUES (:org,?,?,'careops.trigger',?)",
        crypto.randomUUID(),
        urgent.task.id,
        new Date().toISOString(),
      )
      .run();
    for (const action of ["approve", "complete"]) {
      const response = await request({ action }, token, urgent.task.id);
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({
        authorization: {
          staffReviewApproved: false,
          clinicianReviewRequired: true,
          administrativeDraftPermitted: false,
          agentDispatchPermitted: false,
          patientMessagingPermitted: false,
        },
      });
    }
    expect(
      await careopsReviewRepo({ db, orgId: "demo" }).authorization(
        urgent.task.id,
      ),
    ).toMatchObject({ agentDispatchPermitted: false });
    expect(
      db.raw
        .prepare(
          "SELECT COUNT(*) AS n FROM careops_outbox WHERE org_id='demo' AND state='pending'",
        )
        .get(),
    ).toMatchObject({ n: 0 });
  });
  it("uses the same guard through the actual Worker entrypoint", async () => {
    const path = `/api/v1/home/nurse/tasks/${taskId}/status`;
    expect(
      (
        await workerApp.request(
          path,
          { method: "POST" },
          { DB: db, ENVIRONMENT: "test" },
        )
      ).status,
    ).toBe(401);
    const response = await workerApp.request(
      path,
      {
        method: "POST",
        headers: { Authorization: `Bearer ${token}` },
        body: JSON.stringify({ action: "approve" }),
      },
      { DB: db, ENVIRONMENT: "test" },
    );
    expect(response.status).toBe(200);
  });
});
