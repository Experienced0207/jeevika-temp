import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { serve } from "@hono/node-server";
import { convertV4MiniflareOptions, Miniflare } from "miniflare";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { LocalDatabase } from "../backend/local/database";
import {
  migrateLocal,
  migrationScripts,
  splitSqlScript,
} from "../backend/local/migrate";
import { seedDemo } from "../backend/local/seed";
import type { CareopsBindings } from "../backend/src/careops/config";
import { dispatchCareops, retryAt } from "../backend/src/careops/dispatch";
import { envelope, type Workflow } from "../backend/src/careops/repo";
import { reviewDraft } from "../backend/src/careops/review";
import { machineOperations } from "../backend/src/careops/tools";
import type { Database } from "../backend/src/database";
import { careopsRepo } from "../backend/src/db/careopsRepo";
import { careopsReviewRepo } from "../backend/src/db/careopsReviewRepo";
import { app } from "../backend/src/index";
import { tokenHash } from "../backend/src/security";
import {
  coordinationContextSchema,
  coordinationDraftSchema,
  coordinationEnvelopeSchema,
} from "../packages/shared/maritime-coordination";
import { Coordinator } from "../services/maritime-agent/src/coordinator";
import {
  type MachineTools,
  ToolFailure,
} from "../services/maritime-agent/src/transport";

let db: LocalDatabase,
  env: CareopsBindings,
  task: string,
  staff: string,
  machine: string;
const seed = readFileSync("scripts/seed-demo-p1042.sql", "utf8");
async function setup(value: Database) {
  await seedDemo(value);
  await value.batch(splitSqlScript(seed).map((sql) => value.prepare(sql)));
  const result = await careopsRepo({ db: value, orgId: "demo" }).record([
    { sampledAt: "2026-10-08T00:00:00.000Z", value: 150 },
  ]);
  if (!result.task) throw new Error("Missing synthetic task");
  await careopsReviewRepo({ db: value, orgId: "demo" }).decide(
    result.task.id,
    "nurse",
    { action: "approve" },
  );
  return result.task.id;
}
async function session(user = "nurse", org = "demo") {
  const token = `${org}.${crypto.randomUUID()}`;
  await db
    .prepare(
      `INSERT INTO sessions(org_id,token_hash,user_id,expires_at) VALUES(?,?,?,'2099-01-01T00:00:00.000Z')`,
    )
    .bind(org, await tokenHash(token), user)
    .run();
  return token;
}
async function workflow(database: Database = db) {
  const row = await database
    .prepare("SELECT * FROM careops_workflows WHERE org_id='demo'")
    .first<Workflow>();
  if (!row) throw new Error("Missing workflow");
  return row;
}
async function dispatch(options: Parameters<typeof dispatchCareops>[3] = {}) {
  const transport = vi.fn<typeof fetch>(
    async () => new Response(null, { status: 202 }),
  );
  await dispatchCareops(env, "demo", 1, { transport, ...options });
  return transport;
}
function req(
  path: string,
  body?: unknown,
  token = staff,
  headers: Record<string, string> = {},
) {
  return app.request(
    path,
    {
      method: body === undefined ? "GET" : "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
        ...headers,
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    },
    env,
  );
}
function machineHeaders(nonce = crypto.randomUUID()) {
  return {
    "X-Jeevika-Timestamp": String(Math.floor(Date.now() / 1000)),
    "X-Jeevika-Nonce": nonce,
  };
}
async function pending() {
  await dispatch();
  const w = await workflow(),
    base = envelope(w),
    ops = machineOperations(env, "demo");
  const context = await ops.context(base);
  const draft = await ops.draft({
    ...base,
    leaseId: context.leaseId,
    workflow: "careops_followup",
    language: "en-IN",
  });
  await ops.event({ ...draft, state: "proposed_for_nurse_review" });
  return { w, base, context, draft, ops };
}
beforeEach(async () => {
  db = new LocalDatabase();
  migrateLocal(db);
  task = await setup(db);
  env = {
    DB: db,
    ENVIRONMENT: "test",
    ENABLE_SYNTHETIC_CAREOPS_DEMO: "true",
    CAREOPS_SYNTHETIC_ORGS: "demo",
    CAREOPS_EXTERNAL_DISPATCH_ENABLED: "true",
    MARITIME_AGENT_ID: "synthetic-agent",
    MARITIME_WEBHOOK_TOKEN: "local-test-token",
  };
  staff = await session();
  machine = `demo.mch_${crypto.randomUUID().replaceAll("-", "")}`;
  await db
    .prepare(
      `INSERT INTO careops_machine_credentials(org_id,id,token_hash,expires_at,created_at) VALUES('demo',?,?,'2099-01-01T00:00:00.000Z',?)`,
    )
    .bind(
      crypto.randomUUID(),
      await tokenHash(machine),
      new Date().toISOString(),
    )
    .run();
});
afterEach(() => {
  vi.unstubAllGlobals();
  db.close();
});

describe("durable synthetic CareOps workflow", () => {
  it("runs the actual Worker routes: opaque dispatch -> machine context/draft/callback -> human edit/approve -> human completion", async () => {
    const outgoing = await dispatch();
    expect(outgoing).toHaveBeenCalledTimes(1);
    const call = outgoing.mock.calls[0];
    if (!call) throw new Error("Missing outbound request");
    const [url, init] = call;
    expect(url).toBe("https://api.maritime.sh/api/webhooks/synthetic-agent");
    expect(init?.headers).toEqual({
      "Content-Type": "application/json",
      "X-Maritime-Webhook-Token": "local-test-token",
    });
    const base = coordinationEnvelopeSchema.parse(
      JSON.parse(String(init?.body)),
    );
    expect(String(init?.body)).not.toMatch(
      /P-1042|nurse|patient|mmHg|note|org_id/,
    );
    let response = await req(
      "/api/v1/machine/maritime/context",
      base,
      machine,
      machineHeaders(),
    );
    expect(response.status).toBe(200);
    const context = coordinationContextSchema.parse(await response.json());
    const draftBody = {
      ...base,
      leaseId: context.leaseId,
      workflow: "careops_followup",
      language: "en-IN",
    };
    response = await req(
      "/api/v1/machine/maritime/draft",
      draftBody,
      machine,
      machineHeaders(),
    );
    expect(response.status).toBe(200);
    const draft = coordinationDraftSchema.parse(await response.json());
    expect(draft.receiptStatus).toBe("NOT_APPLICABLE_DISABLED");
    const proposal = { ...draft, state: "proposed_for_nurse_review" },
      headers = machineHeaders();
    response = await req(
      "/api/v1/careops/maritime/callback",
      proposal,
      machine,
      headers,
    );
    expect(response.status).toBe(200);
    expect(
      (
        await req(
          "/api/v1/careops/maritime/callback",
          proposal,
          machine,
          headers,
        )
      ).status,
    ).toBe(200);
    expect((await workflow()).state).toBe("PENDING_REVIEW");
    await expect(
      careopsReviewRepo({ db, orgId: "demo" }).decide(task, "nurse", {
        action: "complete",
      }),
    ).rejects.toThrow("draft review");
    response = await req(`/api/v1/careops/tasks/${task}`);
    expect(response.status).toBe(200);
    const detail = z
      .object({ cost: z.null(), draft: z.object({ state: z.string() }) })
      .parse(await response.json());
    expect(detail.cost).toBeNull();
    expect(detail.draft.state).toBe("PENDING_REVIEW");
    const edit = {
      kind: "draft_review",
      draftRef: draft.draftRef,
      revision: 1,
      action: "edit",
      language: "hi-IN",
    };
    response = await req(
      `/api/v1/home/nurse/tasks/${task}/status`,
      edit,
      staff,
      { "Idempotency-Key": crypto.randomUUID() },
    );
    expect(response.status).toBe(200);
    const approval = {
        kind: "draft_review",
        draftRef: draft.draftRef,
        revision: 2,
        action: "approve",
      },
      key = crypto.randomUUID();
    response = await req(
      `/api/v1/careops/tasks/${task}/draft/review`,
      approval,
      staff,
      { "Idempotency-Key": key },
    );
    expect(response.status).toBe(200);
    const first = z
      .object({
        reviewId: z.string(),
        revision: z.number(),
        action: z.string(),
        messaging: z.string(),
      })
      .parse(await response.json());
    expect(first.messaging).toBe("SIMULATED");
    expect(
      await (
        await req(
          `/api/v1/careops/tasks/${task}/draft/review`,
          approval,
          staff,
          { "Idempotency-Key": key },
        )
      ).json(),
    ).toEqual(first);
    expect(
      (
        await req(
          `/api/v1/careops/tasks/${task}/draft/review`,
          { ...approval, action: "reject" },
          staff,
          { "Idempotency-Key": key },
        )
      ).status,
    ).toBe(409);
    expect((await workflow()).state).toBe("APPROVED_TO_SEND");
    await careopsReviewRepo({ db, orgId: "demo" }).decide(task, "nurse", {
      action: "complete",
    });
    expect((await workflow()).state).toBe("COMPLETED");
    for (const table of [
      "careops_tasks",
      "prune_receipts",
      "careops_outbox",
      "careops_drafts",
    ])
      expect(
        await db.prepare(`SELECT COUNT(*) n FROM ${table}`).first(),
      ).toEqual({ n: 1 });
    expect(
      await db.prepare("SELECT state,attempts FROM careops_outbox").first(),
    ).toEqual({ state: "delivered", attempts: 1 });
  });
  it("claims atomically across dispatchers and reuses IDs after a worker restart mid-lease", async () => {
    const send = vi.fn<typeof fetch>(
      async () => new Response(null, { status: 202 }),
    );
    await Promise.all(
      Array.from({ length: 4 }, () =>
        dispatchCareops(env, "demo", 1, { transport: send }),
      ),
    );
    expect(send).toHaveBeenCalledTimes(1);
    const original = JSON.parse(String(send.mock.calls[0]?.[1]?.body));
    await db
      .prepare(
        "UPDATE careops_workflows SET state='DISPATCH_LEASED',dispatch_claim='lost',claim_until=?,next_attempt_at=?",
      )
      .bind(
        new Date(Date.now() + 30000).toISOString(),
        new Date(0).toISOString(),
      )
      .run();
    await dispatchCareops(env, "demo", 1, { transport: send });
    expect(send).toHaveBeenCalledTimes(1);
    await dispatchCareops({ ...env }, "demo", 1, {
      transport: send,
      now: () => Date.now() + 31000,
    });
    expect(send).toHaveBeenCalledTimes(2);
    expect(JSON.parse(String(send.mock.calls[1]?.[1]?.body))).toEqual(original);
  });
  it("honors 429 Retry-After, retries 500 and dead-letters auth failures and attempt limit", async () => {
    const now = Date.now();
    const busy = vi.fn<typeof fetch>(
      async () =>
        new Response(null, { status: 429, headers: { "Retry-After": "120" } }),
    );
    await dispatch({ transport: busy, now: () => now });
    expect(
      Date.parse((await workflow()).next_attempt_at),
    ).toBeGreaterThanOrEqual(now + 120000);
    await dispatch({ transport: busy, now: () => now + 100000 });
    expect(busy).toHaveBeenCalledTimes(1);
    await dispatch({
      transport: async () => new Response(null, { status: 500 }),
      now: () => now + 130000,
    });
    expect((await workflow()).state).toBe("FAILED_RETRY");
    await dispatch({
      transport: async () => new Response(null, { status: 401 }),
      now: () => now + 1000000,
    });
    expect((await workflow()).state).toBe("DEAD_LETTER");
    expect(retryAt(now, 1, "999999999")).toBeNull();
  });
  it("bounds repeated failures at five network attempts", async () => {
    const send = vi.fn<typeof fetch>(async () => {
      throw new Error("synthetic failure");
    });
    const now = Date.now();
    for (let i = 0; i < 8; i++)
      await dispatchCareops(env, "demo", 1, {
        transport: send,
        now: () => now + i * 400000,
      });
    expect(send).toHaveBeenCalledTimes(5);
    expect((await workflow()).state).toBe("DEAD_LETTER");
  });
  it("requires staff preapproval and configuration; production defaults cannot egress", async () => {
    const send = vi.fn<typeof fetch>();
    await expect(
      dispatchCareops(
        { ...env, ENABLE_SYNTHETIC_CAREOPS_DEMO: undefined },
        "demo",
        1,
        { transport: send },
      ),
    ).rejects.toThrow();
    expect(
      (await req("/api/v1/careops/tasks", undefined, await session("cashier")))
        .status,
    ).toBe(403);
    expect((await req("/api/v1/careops/dispatch", { limit: 1 })).status).toBe(
      403,
    );
    expect(
      (
        await dispatchCareops(
          { ...env, MARITIME_WEBHOOK_TOKEN: undefined },
          "demo",
          1,
          { transport: send },
        )
      ).configured,
    ).toBe(false);
    await db.prepare("UPDATE careops_tasks SET status='open'").run();
    await dispatchCareops(env, "demo", 1, { transport: send });
    expect(send).not.toHaveBeenCalled();
    const response = await app.request(
      "/api/v1/careops/tasks",
      { headers: { Authorization: `Bearer ${staff}` } },
      {
        ...env,
        ENVIRONMENT: "production",
        ENABLE_SYNTHETIC_CAREOPS_DEMO: undefined,
      },
    );
    expect(response.status).toBe(503);
  });
  it("rejects staff credentials on machine APIs, machine credentials on staff APIs, changed nonce and stale timestamp", async () => {
    await dispatch();
    const base = envelope(await workflow()),
      path = "/api/v1/machine/maritime/context";
    expect((await req(path, base, staff, machineHeaders())).status).toBe(401);
    expect(
      (await req("/api/v1/careops/tasks", undefined, machine)).status,
    ).toBe(401);
    const headers = machineHeaders();
    expect((await req(path, base, machine, headers)).status).toBe(200);
    expect(
      (
        await req(
          path,
          { ...base, eventId: crypto.randomUUID() },
          machine,
          headers,
        )
      ).status,
    ).toBe(409);
    expect(
      (
        await req(path, base, machine, {
          ...machineHeaders(),
          "X-Jeevika-Timestamp": "1000000000",
        })
      ).status,
    ).toBe(401);
    expect(
      (
        await req(path, base, machine, {
          ...machineHeaders(),
          Origin: "https://example.com",
        })
      ).status,
    ).toBe(403);
    await db
      .prepare("UPDATE careops_machine_credentials SET revoked_at='now'")
      .run();
    expect((await req(path, base, machine, machineHeaders())).status).toBe(401);
  });
  it("isolates tenants, paginates task reads and rejects fabricated callback references/proof", async () => {
    const { draft, ops } = await pending();
    expect(
      (
        await req(
          `/api/v1/careops/tasks/${task}`,
          undefined,
          await session("east-doctor", "other-org"),
        )
      ).status,
    ).toBe(503);
    const otherEnv = { ...env, CAREOPS_SYNTHETIC_ORGS: "demo,other-org" };
    const response = await app.request(
      `/api/v1/careops/tasks/${task}`,
      {
        headers: {
          Authorization: `Bearer ${await session("east-doctor", "other-org")}`,
        },
      },
      otherEnv,
    );
    expect(response.status).toBe(404);
    const page = z
      .object({
        items: z.array(z.unknown()),
        nextCursor: z.string().nullable(),
      })
      .parse(await (await req("/api/v1/careops/tasks?limit=1")).json());
    expect(page.items).toHaveLength(1);
    expect(page.nextCursor).toBeNull();
    expect((await req(`/api/v1/careops/tasks?cursor=${task}`)).status).toBe(
      200,
    );
    await expect(
      ops.event({
        ...draft,
        state: "proposed_for_nurse_review",
        receiptStatus: "VERIFIED_API",
      }),
    ).rejects.toThrow("provenance");
    await expect(
      ops.context({
        ...envelope(await workflow()),
        eventId: crypto.randomUUID(),
      }),
    ).rejects.toThrow("reference");
    await expect(
      ops.draft({
        ...envelope(await workflow()),
        leaseId: crypto.randomUUID(),
        workflow: "careops_followup",
        language: "en-IN",
      }),
    ).rejects.toThrow("lease");
  });
  it("invalidates pending review and tool leases immediately on raw urgent input; no further vendor calls", async () => {
    const { draft, ops } = await pending();
    const send = vi.fn<typeof fetch>();
    await careopsRepo({ db, orgId: "demo" }).record([
      { sampledAt: "2026-10-09T00:00:00.000Z", value: 180 },
    ]);
    expect((await workflow()).state).toBe("CANCELLED");
    await dispatchCareops(env, "demo", 1, { transport: send });
    expect(send).not.toHaveBeenCalled();
    await expect(
      ops.event({ ...draft, state: "proposed_for_nurse_review" }),
    ).rejects.toThrow("not permitted");
    await expect(
      reviewDraft({ db, orgId: "demo" }, task, "nurse", crypto.randomUUID(), {
        kind: "draft_review",
        draftRef: draft.draftRef,
        revision: 1,
        action: "approve",
      }),
    ).rejects.toThrow();
  });
  it("deduplicates concurrent draft calls and proposal races, then allows only one competing human decision", async () => {
    const { draft, ops, base, context } = await pending();
    const values = await Promise.all(
      Array.from({ length: 4 }, () =>
        ops.draft({
          ...base,
          leaseId: context.leaseId,
          workflow: "careops_followup",
          language: "en-IN",
        }),
      ),
    );
    expect(new Set(values.map((x) => x.draftRef)).size).toBe(1);
    await Promise.all(
      Array.from({ length: 4 }, () =>
        ops.event({ ...draft, state: "proposed_for_nurse_review" }),
      ),
    );
    expect(
      await db
        .prepare(
          "SELECT COUNT(*) n FROM careops_thread_entries WHERE outcome='PENDING_REVIEW'",
        )
        .first(),
    ).toEqual({ n: 1 });
    const results = await Promise.allSettled(
      ["approve", "reject"].map((action) =>
        reviewDraft({ db, orgId: "demo" }, task, "nurse", crypto.randomUUID(), {
          kind: "draft_review",
          draftRef: draft.draftRef,
          revision: 1,
          action,
        }),
      ),
    );
    expect(results.filter((x) => x.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((x) => x.status === "rejected")).toHaveLength(1);
    await expect(
      db
        .prepare("UPDATE careops_agent_events SET event_type='CANCELLED'")
        .run(),
    ).rejects.toThrow("IMMUTABLE");
  });
  it("uses Prune gate/cache-off with only static templates and preserves unverified receipt status", async () => {
    env.PRUNE_ENABLED = "true";
    env.PRUNE_API_KEY = "local-test-key";
    await dispatch();
    const send = vi.fn<typeof fetch>(async () =>
      Response.json({
        choices: [
          { message: { content: "untrusted synthetic provider output" } },
        ],
        prune_metadata: { receipt_signature: "not-proof" },
      }),
    );
    const ops = machineOperations(env, "demo", send),
      base = envelope(await workflow()),
      context = await ops.context(base);
    const draft = await ops.draft({
      ...base,
      leaseId: context.leaseId,
      workflow: "careops_followup",
      language: "en-IN",
    });
    expect(send).toHaveBeenCalledTimes(1);
    expect(send.mock.calls[0]?.[0]).toBe(
      "https://api.withprune.com/v1/chat/completions",
    );
    expect(
      new Headers(send.mock.calls[0]?.[1]?.headers).get("X-Prune-Cache"),
    ).toBe("off");
    expect(String(send.mock.calls[0]?.[1]?.body)).not.toMatch(
      /P-1042|150|mmHg|nurse|org_id/,
    );
    expect(draft.receiptStatus).toBe("PRESENT_UNVERIFIED");
    expect(draft.provider).toBe("local-template");
    await expect(
      ops.draft({
        ...base,
        leaseId: context.leaseId,
        workflow: "careops_followup",
        language: "en-IN",
        text: "synthetic PHI 180",
      }),
    ).rejects.toThrow();
    expect(send).toHaveBeenCalledTimes(1);
  });
  it("degrades a crash after Prune intent to a local template without a second external attempt", async () => {
    await dispatch();
    const base = envelope(await workflow());
    const ops = machineOperations(
      { ...env, PRUNE_ENABLED: "true", PRUNE_API_KEY: "local-test" },
      "demo",
      vi.fn(),
    );
    const context = await ops.context(base);
    await db
      .prepare(
        "UPDATE careops_workflows SET draft_started_at=?,draft_audit_id=?,draft_claim='crashed',draft_claim_until=?",
      )
      .bind(
        new Date().toISOString(),
        crypto.randomUUID(),
        new Date(0).toISOString(),
      )
      .run();
    const send = vi.fn<typeof fetch>();
    const safeOps = machineOperations(
      { ...env, PRUNE_ENABLED: "true", PRUNE_API_KEY: "local-test" },
      "demo",
      send,
    );
    const draft = await safeOps.draft({
      ...base,
      leaseId: context.leaseId,
      workflow: "careops_followup",
      language: "en-IN",
    });
    expect(send).not.toHaveBeenCalled();
    expect(draft.receiptStatus).toBe("MISSING");
    expect(draft.provider).toBe("local-template");
    expect(
      await db
        .prepare("SELECT network_attempted FROM prune_audit_receipts")
        .first(),
    ).toEqual({ network_attempted: 0 });
    // A persisted disabled audit is evidence of no egress, even if draft storage crashed.
    await db
      .prepare(
        "UPDATE prune_audit_receipts SET event_type='DISABLED',receipt_status='NOT_APPLICABLE_DISABLED'",
      )
      .run();
    await db.prepare("DELETE FROM careops_drafts").run();
    await db
      .prepare(
        "UPDATE careops_workflows SET state='AGENT_RUNNING',draft_claim_until=NULL",
      )
      .run();
    const recovered = await safeOps.draft({
      ...base,
      leaseId: context.leaseId,
      workflow: "careops_followup",
      language: "en-IN",
    });
    expect(recovered.receiptStatus).toBe("NOT_APPLICABLE_DISABLED");
    expect(send).not.toHaveBeenCalled();
  });
  it("completes the workflow on real local workerd/D1 with concurrent dispatch claims", async () => {
    const worker = new Miniflare(
      convertV4MiniflareOptions({
        modules: true,
        script: 'export default {fetch(){return new Response("ok")}}',
        compatibilityDate: "2026-10-17",
        d1Databases: ["DB"],
      }),
    );
    try {
      const cloud = await worker.getD1Database("DB");
      for (const script of migrationScripts())
        await cloud.batch(
          splitSqlScript(script)
            .filter((sql) => !/^\s*PRAGMA/i.test(sql))
            .map((sql) => cloud.prepare(sql)),
        );
      const cloudTask = await setup(cloud),
        cloudEnv = { ...env, DB: cloud };
      const send = vi.fn<typeof fetch>(
        async () => new Response(null, { status: 202 }),
      );
      await Promise.all(
        Array.from({ length: 3 }, () =>
          dispatchCareops(cloudEnv, "demo", 1, { transport: send }),
        ),
      );
      expect(send).toHaveBeenCalledTimes(1);
      const w = await workflow(cloud),
        base = envelope(w),
        ops = machineOperations(cloudEnv, "demo");
      const context = await ops.context(base),
        draft = await ops.draft({
          ...base,
          leaseId: context.leaseId,
          workflow: "careops_followup",
          language: "en-IN",
        });
      await ops.event({ ...draft, state: "proposed_for_nurse_review" });
      expect((await workflow(cloud)).state).toBe("PENDING_REVIEW");
      await reviewDraft(
        { db: cloud, orgId: "demo" },
        cloudTask,
        "nurse",
        crypto.randomUUID(),
        {
          kind: "draft_review",
          draftRef: draft.draftRef,
          revision: 1,
          action: "approve",
        },
      );
      await careopsReviewRepo({ db: cloud, orgId: "demo" }).decide(
        cloudTask,
        "nurse",
        { action: "complete" },
      );
      expect((await workflow(cloud)).state).toBe("COMPLETED");
    } finally {
      await worker.dispose();
    }
  });
  it("runs the unchanged C3 Coordinator over real local HTTP into C4 and replays from its durable journal", async () => {
    await dispatch();
    const base = envelope(await workflow());
    const directory = mkdtempSync(join(tmpdir(), "c4-agent-"));
    const server = serve({
      fetch: (request) => app.fetch(request, env),
      hostname: "127.0.0.1",
      port: 0,
    });
    try {
      if (!server.listening)
        await new Promise<void>((resolve) => server.once("listening", resolve));
      const address = server.address();
      if (!address || typeof address === "string")
        throw new Error("Local HTTP unavailable");
      const calls: string[] = [];
      const tools: MachineTools = {
        async post(tool, payload, key) {
          const path =
            tool === "fetch_context"
              ? "context"
              : tool === "request_draft"
                ? "draft"
                : "events";
          calls.push(path);
          const response = await fetch(
            `http://127.0.0.1:${address.port}/api/v1/machine/maritime/${path}`,
            {
              method: "POST",
              headers: {
                Authorization: `Bearer ${machine}`,
                "Content-Type": "application/json",
                "Idempotency-Key": key,
                ...machineHeaders(),
              },
              body: JSON.stringify(payload),
            },
          );
          if (!response.ok) throw new ToolFailure("UPSTREAM_REJECTED", false);
          return response.json();
        },
      };
      const config = {
        port: 3000,
        origin: "https://local-test.invalid",
        machineToken: machine,
        dataDir: directory,
        timeoutMs: 3000,
      };
      const result = await new Coordinator(config, tools).run(base);
      expect(result.state).toBe("proposed_for_nurse_review");
      expect(calls).toEqual(["context", "draft", "events"]);
      expect((await workflow()).state).toBe("PENDING_REVIEW");
      expect(await new Coordinator(config, tools).run(base)).toEqual(result);
      expect(calls).toHaveLength(3);
    } finally {
      if ("closeAllConnections" in server) server.closeAllConnections();
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
      rmSync(directory, { recursive: true, force: true });
    }
  });
  it("blocks initially urgent tasks, expired leases, wrong review roles and altered machine inputs without egress", async () => {
    const { base, context, draft, ops } = await pending();
    const send = vi.fn<typeof fetch>();
    await db
      .prepare("UPDATE careops_workflows SET lease_expires_at=?")
      .bind(new Date(0).toISOString())
      .run();
    await expect(
      ops.event({ ...draft, state: "proposed_for_nurse_review" }),
    ).rejects.toThrow("lease");
    await expect(
      ops.draft({
        ...base,
        leaseId: context.leaseId,
        workflow: "careops_followup",
        language: "en-IN",
        model: "arbitrary",
      }),
    ).rejects.toThrow();
    expect(
      (
        await req(
          `/api/v1/careops/tasks/${task}/draft/review`,
          {
            kind: "draft_review",
            draftRef: draft.draftRef,
            revision: 1,
            action: "approve",
          },
          await session("admin"),
          { "Idempotency-Key": crypto.randomUUID() },
        )
      ).status,
    ).toBe(403);
    await careopsRepo({ db, orgId: "demo" }).record([
      { sampledAt: "2026-10-09T00:00:00.000Z", value: 185 },
    ]);
    await dispatchCareops(env, "demo", 1, { transport: send });
    expect(send).not.toHaveBeenCalled();
  });
  it("rolls back proposal and human review transitions when their append-only audit write fails", async () => {
    await dispatch();
    const base = envelope(await workflow()),
      ops = machineOperations(env, "demo"),
      context = await ops.context(base);
    const draft = await ops.draft({
      ...base,
      leaseId: context.leaseId,
      workflow: "careops_followup",
      language: "en-IN",
    });
    db.raw.exec(
      "CREATE TRIGGER fail_agent_audit BEFORE INSERT ON careops_agent_events WHEN NEW.event_type='PENDING_REVIEW' BEGIN SELECT RAISE(ABORT,'synthetic failure'); END;",
    );
    await expect(
      ops.event({ ...draft, state: "proposed_for_nurse_review" }),
    ).rejects.toThrow("synthetic failure");
    expect((await workflow()).state).toBe("DRAFT_READY");
    db.raw.exec("DROP TRIGGER fail_agent_audit;");
    await ops.event({ ...draft, state: "proposed_for_nurse_review" });
    db.raw.exec(
      "CREATE TRIGGER fail_review_audit BEFORE INSERT ON careops_agent_events WHEN NEW.event_type='APPROVED_TO_SEND' BEGIN SELECT RAISE(ABORT,'synthetic failure'); END;",
    );
    await expect(
      reviewDraft({ db, orgId: "demo" }, task, "nurse", crypto.randomUUID(), {
        kind: "draft_review",
        draftRef: draft.draftRef,
        revision: 1,
        action: "approve",
      }),
    ).rejects.toThrow("synthetic failure");
    expect((await workflow()).state).toBe("PENDING_REVIEW");
    expect(
      await db.prepare("SELECT COUNT(*) n FROM careops_draft_reviews").first(),
    ).toEqual({ n: 0 });
  });
  it("derives machine tenancy from its stored credential and hides another tenant's references", async () => {
    await dispatch();
    const base = envelope(await workflow()),
      other = `other-org.mch_${crypto.randomUUID().replaceAll("-", "")}`;
    await db
      .prepare(
        "INSERT INTO careops_machine_credentials(org_id,id,token_hash,expires_at,created_at) VALUES('other-org',?,?,'2099-01-01T00:00:00.000Z',?)",
      )
      .bind(
        crypto.randomUUID(),
        await tokenHash(other),
        new Date().toISOString(),
      )
      .run();
    const response = await app.request(
      "/api/v1/machine/maritime/context",
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${other}`,
          "Content-Type": "application/json",
          ...machineHeaders(),
        },
        body: JSON.stringify(base),
      },
      { ...env, CAREOPS_SYNTHETIC_ORGS: "demo,other-org" },
    );
    expect(response.status).toBe(404);
  });
  it("reopens a persisted database after an uncertain send and retries the same envelope", async () => {
    const directory = mkdtempSync(join(tmpdir(), "c4-restart-")),
      path = join(directory, "state.sqlite");
    let durable = new LocalDatabase(path);
    try {
      migrateLocal(durable);
      await setup(durable);
      const now = Date.now(),
        send = vi.fn<typeof fetch>(
          async () => new Response(null, { status: 202 }),
        );
      await dispatchCareops({ ...env, DB: durable }, "demo", 1, {
        transport: send,
        now: () => now,
      });
      const original = send.mock.calls[0]?.[1]?.body;
      await durable
        .prepare(
          "UPDATE careops_workflows SET state='DISPATCH_LEASED',dispatch_claim='crashed',claim_until=?,next_attempt_at=?",
        )
        .bind(new Date(now + 30000).toISOString(), new Date(now).toISOString())
        .run();
      durable.close();
      durable = new LocalDatabase(path);
      await dispatchCareops({ ...env, DB: durable }, "demo", 1, {
        transport: send,
        now: () => now + 31000,
      });
      expect(send).toHaveBeenCalledTimes(2);
      expect(send.mock.calls[1]?.[1]?.body).toBe(original);
      expect(
        await durable
          .prepare("SELECT COUNT(*) n FROM careops_workflows")
          .first(),
      ).toEqual({ n: 1 });
    } finally {
      durable.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
