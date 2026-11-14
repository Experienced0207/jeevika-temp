// LOCAL_TESTED: actual compiled Worker + D1; every external fetch is intercepted.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  convertV4MiniflareOptions,
  Response as LocalResponse,
  Miniflare,
} from "miniflare";
import { migrationScripts, splitSqlScript } from "../backend/local/migrate";
import { seedDemo } from "../backend/local/seed";
import { tenantDb } from "../backend/src/database";
import { tokenHash } from "../backend/src/security";
import { assertSafeForExternalEgress } from "../packages/ai/egressSafetyGate";
import { careopsTaskDetailSchema } from "../packages/shared/careops-workflow";
import {
  type CoordinationEnvelope,
  coordinationContextSchema,
  coordinationDraftSchema,
  coordinationEnvelopeSchema,
  coordinationEventAckSchema,
} from "../packages/shared/maritime-coordination";

const sent: CoordinationEnvelope[] = [];
let pruneAttempts = 0;
const worker = new Miniflare(
  convertV4MiniflareOptions({
    modules: true,
    scriptPath: "dist/integration-worker/index.js",
    compatibilityDate: "2026-10-17",
    d1Databases: ["DB"],
    bindings: {
      ENVIRONMENT: "test",
      PRUNE_ENABLED: "true",
      PRUNE_API_KEY: "local-smoke-key",
      ENABLE_SYNTHETIC_CAREOPS_DEMO: "true",
      CAREOPS_SYNTHETIC_ORGS: "demo",
      CAREOPS_EXTERNAL_DISPATCH_ENABLED: "true",
      MARITIME_AGENT_ID: "synthetic-agent",
      MARITIME_WEBHOOK_TOKEN: "local-smoke-only",
    },
    outboundService: async (request) => {
      if (request.url === "https://api.withprune.com/v1/chat/completions") {
        pruneAttempts++;
        assert.equal(request.headers.get("X-Prune-Cache"), "off");
        const body = await request.text();
        assert.doesNotMatch(body, /P-1042|150|mmHg|org_id/);
        assertSafeForExternalEgress(JSON.parse(body));
        return LocalResponse.json({
          choices: [{ message: { content: "untrusted synthetic output" } }],
          prune_metadata: { receipt_signature: "local-not-proof" },
        });
      }

      assert.equal(
        request.url,
        "https://api.maritime.sh/api/webhooks/synthetic-agent",
      );
      assert.equal(
        request.headers.get("X-Maritime-Webhook-Token"),
        "local-smoke-only",
      );
      const body = await request.text();
      assert.doesNotMatch(body, /P-1042|patient|mmHg|note|org_id/);
      sent.push(coordinationEnvelopeSchema.parse(JSON.parse(body)));
      return new LocalResponse(null, { status: 202 });
    },
  }),
);
try {
  const db = await worker.getD1Database("DB");
  for (const script of migrationScripts())
    await db.batch(
      splitSqlScript(script)
        .filter((sql) => !/^\s*PRAGMA/i.test(sql))
        .map((sql) => db.prepare(sql)),
    );
  await seedDemo(db);
  await db.batch(
    splitSqlScript(readFileSync("scripts/seed-demo-p1042.sql", "utf8")).map(
      (sql) => db.prepare(sql),
    ),
  );
  const scoped = tenantDb({ db, orgId: "demo" }),
    staff = `demo.${crypto.randomUUID()}`,
    admin = `demo.${crypto.randomUUID()}`;
  for (const [value, user] of [
    [staff, "doctor"],
    [admin, "admin"],
  ]) {
    if (!value || !user) throw new Error("Missing smoke identity");
    await scoped
      .statement(
        "INSERT INTO sessions(org_id,token_hash,user_id,expires_at) VALUES(:org,?,?,?)",
        await tokenHash(value),
        user,
        "2099-01-01T00:00:00.000Z",
      )
      .run();
  }
  const machine = `demo.mch_${crypto.randomUUID().replaceAll("-", "")}`;
  await scoped
    .statement(
      "INSERT INTO careops_machine_credentials(org_id,id,token_hash,expires_at,created_at) VALUES(:org,?,?,?,?)",
      crypto.randomUUID(),
      await tokenHash(machine),
      "2099-01-01T00:00:00.000Z",
      new Date().toISOString(),
    )
    .run();
  const post = async (
    path: string,
    body: unknown,
    token = staff,
    machineCall = false,
  ) => {
    const response = await worker.dispatchFetch(`http://localhost${path}`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
        "Idempotency-Key": crypto.randomUUID(),
        ...(machineCall
          ? {
              "X-Jeevika-Timestamp": String(Math.floor(Date.now() / 1000)),
              "X-Jeevika-Nonce": crypto.randomUUID(),
            }
          : {}),
      },
      body: JSON.stringify(body),
    });
    assert.equal(response.status, 200, `Unexpected status at ${path}`);
    return response;
  };
  await post("/api/v1/home/vitals", { value: 150, day: 7 });
  const task = await scoped
    .statement(
      "SELECT id FROM careops_tasks WHERE org_id = :org AND priority='review'",
    )
    .first<{ id: string }>();
  assert.ok(task);
  await post(`/api/v1/home/nurse/tasks/${task.id}/status`, {
    action: "approve",
  });
  const dispatchResult = await (
    await post("/api/v1/careops/dispatch", { limit: 1 }, admin)
  ).json();
  assert.deepEqual(dispatchResult, { configured: true, attempted: 1 });
  assert.equal(sent.length, 1);
  const base = sent[0];
  assert.ok(base);
  const context = coordinationContextSchema.parse(
    await (
      await post("/api/v1/machine/maritime/context", base, machine, true)
    ).json(),
  );
  const draft = coordinationDraftSchema.parse(
    await (
      await post(
        "/api/v1/machine/maritime/draft",
        {
          ...base,
          leaseId: context.leaseId,
          workflow: "careops_followup",
          language: context.language,
        },
        machine,
        true,
      )
    ).json(),
  );
  assert.equal(draft.receiptStatus, "PRESENT_UNVERIFIED");
  assert.equal(pruneAttempts, 1);
  for (let i = 0; i < 2; i++)
    coordinationEventAckSchema.parse(
      await (
        await post(
          "/api/v1/careops/maritime/callback",
          { ...draft, state: "proposed_for_nurse_review" },
          machine,
          true,
        )
      ).json(),
    );
  const detailResponse = await worker.dispatchFetch(
    `http://localhost/api/v1/careops/tasks/${task.id}`,
    { headers: { Authorization: `Bearer ${staff}` } },
  );
  const detail = careopsTaskDetailSchema.parse(await detailResponse.json());
  assert.equal(detail.workflow?.state, "PENDING_REVIEW");
  assert.equal(detail.cost, null);
  await post(`/api/v1/careops/tasks/${task.id}/draft/review`, {
    kind: "draft_review",
    draftRef: draft.draftRef,
    revision: 1,
    action: "approve",
  });
  await post(`/api/v1/home/nurse/tasks/${task.id}/status`, {
    action: "complete",
  });
  assert.deepEqual(
    await scoped
      .statement(
        "SELECT state FROM careops_workflows WHERE org_id = :org AND task_id=?",
        task.id,
      )
      .first(),
    { state: "COMPLETED" },
  );
  await post("/api/v1/home/vitals", { value: 180, day: 8 });
  await post("/api/v1/careops/dispatch", { limit: 1 }, admin);
  assert.equal(sent.length, 1);
  console.log(
    "PASS LOCAL_TESTED: compiled Worker/D1 nonurgent drift -> opaque intercepted webhook -> machine tools -> intercepted cache-off Prune/unverified fallback -> replayed callback -> PENDING_REVIEW -> human simulated approval/completion; urgent no dispatch; no live vendors",
  );
} finally {
  await worker.dispose();
}
