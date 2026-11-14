import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import {
  type GuardianAudit,
  pruneGuardian,
} from "../../../../packages/ai/pruneGuardian";
import type { Principal } from "../../../../packages/shared/integration";
import { type Database, tenantDb } from "../../database";
import { jsonBody } from "../../http";

export type PruneBindings = {
  PRUNE_API_KEY?: string;
  PRUNE_ENABLED?: string;
  PRUNE_RECEIPT_PUBLIC_KEY?: string;
  PRUNE_RECEIPT_KEY_ID?: string;
  PRUNE_VERIFY_RECEIPTS?: string;
};
type AiContext = {
  Bindings: { DB: Database } & PruneBindings;
  Variables: { principal: Principal };
};
export const aiRouter = new Hono<AiContext>();
aiRouter.use("*", async (c, next) => {
  const principal = c.get("principal");
  if (!principal) throw new HTTPException(401, { message: "Session required" });
  if (!["DOCTOR", "NURSE", "HOSPITAL_ADMIN"].includes(principal.role))
    throw new HTTPException(403, { message: "Clinical role required" });
  c.header("Cache-Control", "no-store");
  await next();
});

aiRouter.post("/draft", async (c) => {
  const db = tenantDb({ db: c.env.DB, orgId: c.get("principal").orgId });
  const audit = async (event: GuardianAudit) => {
    const now = new Date().toISOString();
    await db
      .statement(
        `INSERT INTO prune_audit_receipts
       (org_id,id,event_type,receipt_status,network_attempted,receipt_json,created_at,updated_at)
       VALUES (:org,?,?,?,?,?,?,?) ON CONFLICT(org_id,id) DO UPDATE SET
       event_type=excluded.event_type,receipt_status=excluded.receipt_status,
       network_attempted=excluded.network_attempted,receipt_json=excluded.receipt_json,updated_at=excluded.updated_at`,
        event.id,
        event.eventType,
        event.receiptStatus,
        event.networkAttempted ? 1 : 0,
        event.receiptJson,
        now,
        now,
      )
      .run();
  };
  const guardian = pruneGuardian({
    enabled: c.env.PRUNE_ENABLED === "true",
    key: c.env.PRUNE_API_KEY,
    publicKeyBase64: c.env.PRUNE_RECEIPT_PUBLIC_KEY,
    signingKeyId: c.env.PRUNE_RECEIPT_KEY_ID,
    verifyViaApi: c.env.PRUNE_VERIFY_RECEIPTS !== "false",
    audit,
  });
  const result = await guardian.draft(await jsonBody(c.req.raw));
  return c.json(result, result.auditPersisted ? 200 : 503);
});

aiRouter.get("/usage", async (c) => {
  const db = tenantDb({ db: c.env.DB, orgId: c.get("principal").orgId });
  const summary = await db
    .statement(
      `SELECT event_type AS eventType,receipt_status AS receiptStatus,COUNT(*) AS count,
     SUM(network_attempted) AS networkAttempts FROM prune_audit_receipts
     WHERE org_id = :org GROUP BY event_type,receipt_status ORDER BY event_type,receipt_status`,
    )
    .all<{
      eventType: string;
      receiptStatus: string;
      count: number;
      networkAttempts: number;
    }>();
  return c.json({
    usage: summary.results,
    costClaims: "No verified currency totals are calculated",
  });
});
