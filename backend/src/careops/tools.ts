import { HTTPException } from "hono/http-exception";
import { deterministicDraft } from "../../../packages/ai/egressSafetyGate";
import {
  type GuardianAudit,
  pruneGuardian,
} from "../../../packages/ai/pruneGuardian";
import {
  type CoordinationEnvelope,
  coordinationContextSchema,
  coordinationDiagnosticSchema,
  coordinationDraftRequestSchema,
  coordinationDraftSchema,
  coordinationEnvelopeSchema,
  coordinationProposalSchema,
} from "../../../packages/shared/maritime-coordination";
import type { CareopsBindings } from "./config";
import { type Draft, workflowRepo } from "./repo";

export function machineOperations(
  env: CareopsBindings,
  orgId: string,
  transport?: typeof fetch,
) {
  const baseEnvelope = (input: CoordinationEnvelope) =>
    coordinationEnvelopeSchema.parse({
      schemaVersion: input.schemaVersion,
      triggerId: input.triggerId,
      handoffId: input.handoffId,
      taskRef: input.taskRef,
      eventId: input.eventId,
      action: input.action,
    });
  const repo = workflowRepo({ db: env.DB, orgId });
  const { db } = repo;
  function meta(input: CoordinationEnvelope, leaseId: string, d: Draft) {
    return coordinationDraftSchema.parse({
      ...input,
      leaseId,
      draftRef: d.draft_ref,
      provider: d.provider,
      receiptStatus: d.receipt_status,
      requiresClinicianReview: true,
    });
  }
  return {
    async context(raw: unknown) {
      const input = coordinationEnvelopeSchema.parse(raw);
      const now = new Date().toISOString();
      const w = await repo.authorized(input);
      // Replays retain the live lease. Renew only after expiry; never extend from tool calls.
      await db
        .statement(
          `UPDATE careops_workflows SET lease_id=?,lease_expires_at=?,state=CASE WHEN state IN ('DRAFT_READY','PENDING_REVIEW','APPROVED_TO_SEND') THEN state ELSE 'AGENT_RUNNING' END,
   dispatch_claim=NULL,claim_until=NULL,updated_at=? WHERE org_id = :org AND handoff_id=?
   AND (lease_expires_at IS NULL OR lease_expires_at<=?) AND ${repo.safeSql}`,
          crypto.randomUUID(),
          new Date(Date.now() + 120000).toISOString(),
          now,
          w.handoff_id,
          now,
        )
        .run();
      const current = await repo.authorized(input);
      if (!current.lease_id || !current.lease_expires_at)
        throw new HTTPException(409, { message: "No tool lease" });
      await db.batch([
        db.statement(
          `UPDATE careops_outbox SET state='delivered' WHERE org_id = :org AND id=? AND state='pending'`,
          w.trigger_id,
        ),
        repo.event(w, `${current.lease_id}:context`, "CONTEXT_ISSUED", now),
      ]);
      return coordinationContextSchema.parse({
        ...input,
        leaseId: current.lease_id,
        expiresAt: current.lease_expires_at,
        coordinationPermitted: true,
        staffReviewApproved: true,
        urgent: false,
        language: "en-IN",
      });
    },
    async draft(raw: unknown) {
      const input = coordinationDraftRequestSchema.parse(raw),
        base = baseEnvelope(input);
      await repo.authorized(base, input.leaseId);
      const cached = await repo.draft(input.handoffId);
      if (cached) return meta(base, input.leaseId, cached);
      const claim = crypto.randomUUID(),
        now = new Date().toISOString(),
        auditId = crypto.randomUUID();
      const result = await db
        .statement(
          `UPDATE careops_workflows SET draft_claim=?,draft_claim_until=?,
   draft_uncertain=CASE WHEN draft_started_at IS NULL THEN 0 ELSE 1 END,
   draft_started_at=COALESCE(draft_started_at,?),draft_audit_id=COALESCE(draft_audit_id,?)
   WHERE org_id = :org AND handoff_id=? AND lease_id=? AND lease_expires_at>?
   AND (draft_claim_until IS NULL OR draft_claim_until<=?) AND state IN ('AGENT_RUNNING','DRAFT_READY')
   AND ${repo.safeSql} AND NOT EXISTS(SELECT 1 FROM careops_drafts d WHERE d.org_id=careops_workflows.org_id AND d.handoff_id=careops_workflows.handoff_id)`,
          claim,
          new Date(Date.now() + 30000).toISOString(),
          now,
          auditId,
          input.handoffId,
          input.leaseId,
          now,
          now,
        )
        .run();
      if (result.meta.changes !== 1) {
        const ready = await repo.draft(input.handoffId);
        if (ready) return meta(base, input.leaseId, ready);
        throw new HTTPException(429, {
          message: "Draft claim is active; retry later",
        });
      }
      const w = await repo.authorized(base, input.leaseId);
      const stableAudit = w.draft_audit_id;
      if (!stableAudit)
        throw new HTTPException(503, { message: "Draft audit unavailable" });
      const audit = async (e: GuardianAudit) => {
        await db
          .statement(
            `INSERT INTO prune_audit_receipts(org_id,id,event_type,receipt_status,network_attempted,receipt_json,created_at,updated_at)
    VALUES(:org,?,?,?,?,?,?,?) ON CONFLICT(org_id,id) DO UPDATE SET event_type=excluded.event_type,receipt_status=excluded.receipt_status,
    network_attempted=excluded.network_attempted,receipt_json=excluded.receipt_json,updated_at=excluded.updated_at`,
            stableAudit,
            e.eventType,
            e.receiptStatus,
            e.networkAttempted ? 1 : 0,
            e.receiptJson,
            now,
            new Date().toISOString(),
          )
          .run();
      };
      const selector = {
        workflow: "careops_followup" as const,
        language: input.language,
      };
      let text: string,
        provider: "prune" | "local-template",
        receiptStatus: Draft["receipt_status"];
      if (w.draft_uncertain) {
        // A crash may have occurred after network send: do not bill again or claim a proof.
        await db
          .statement(
            `INSERT INTO prune_audit_receipts(org_id,id,event_type,receipt_status,network_attempted,receipt_json,created_at,updated_at)
    VALUES(:org,?,'UPSTREAM_FAILED','MISSING',0,NULL,?,?) ON CONFLICT DO NOTHING`,
            stableAudit,
            now,
            now,
          )
          .run();
        text = deterministicDraft(selector);
        provider = "local-template";
        // Guardian persists REQUESTED before fetch. An absent audit proves no
        // Guardian egress started; an existing audit retains its actual status.
        const recorded = await db
          .statement(
            "SELECT receipt_status FROM prune_audit_receipts WHERE org_id = :org AND id=?",
            stableAudit,
          )
          .first<{ receipt_status: Draft["receipt_status"] }>();
        receiptStatus = recorded?.receipt_status ?? "MISSING";
      } else {
        await repo.authorized(base, input.leaseId);
        const drafted = await pruneGuardian({
          enabled: env.PRUNE_ENABLED === "true",
          key: env.PRUNE_API_KEY,
          audit,
          transport,
        }).draft(selector);
        if (!drafted.auditPersisted)
          throw new HTTPException(503, { message: "Prune audit unavailable" });
        text = drafted.text;
        provider = drafted.provider;
        receiptStatus = drafted.receiptStatus;
      }
      const draftRef = crypto.randomUUID(),
        finished = new Date().toISOString();
      await db.batch([
        db.statement(
          `INSERT INTO careops_drafts(org_id,draft_ref,handoff_id,task_id,text,language,provider,receipt_status,prune_audit_id,state,created_at,updated_at)
    SELECT org_id,?,handoff_id,task_id,?,?,?,?,?,'DRAFT_READY',?,? FROM careops_workflows
    WHERE org_id = :org AND handoff_id=? AND draft_claim=? AND lease_id=? AND lease_expires_at>?
    AND state='AGENT_RUNNING' AND ${repo.safeSql} ON CONFLICT DO NOTHING`,
          draftRef,
          text,
          input.language,
          provider,
          receiptStatus,
          stableAudit,
          finished,
          finished,
          w.handoff_id,
          claim,
          input.leaseId,
          finished,
        ),
        db.statement(
          `UPDATE careops_workflows SET state='DRAFT_READY',draft_claim=NULL,draft_claim_until=NULL,updated_at=?
    WHERE org_id = :org AND handoff_id=? AND draft_claim=? AND EXISTS(SELECT 1 FROM careops_drafts d WHERE d.org_id=careops_workflows.org_id AND d.handoff_id=careops_workflows.handoff_id)`,
          finished,
          w.handoff_id,
          claim,
        ),
        repo.event(
          w,
          `${draftRef}:ready`,
          w.draft_uncertain ? "DRAFT_UNCERTAIN" : "DRAFT_READY",
          finished,
          null,
          null,
          null,
          "EXISTS(SELECT 1 FROM careops_drafts d WHERE d.org_id=w.org_id AND d.handoff_id=w.handoff_id AND d.draft_ref=?)",
          [draftRef],
        ),
      ]);
      await repo.authorized(base, input.leaseId);
      const stored = await repo.draft(w.handoff_id);
      if (!stored)
        throw new HTTPException(409, { message: "Draft invalidated" });
      return meta(base, input.leaseId, stored);
    },
    async event(raw: unknown) {
      const input = coordinationProposalSchema
        .or(coordinationDiagnosticSchema)
        .parse(raw);
      const base = baseEnvelope(input),
        now = new Date().toISOString();
      const w = await repo.authorized(base, input.leaseId);
      if (input.state !== "proposed_for_nurse_review") {
        // Diagnostics never downgrade a completed proposal or approval.
        await repo
          .event(
            w,
            `${input.eventId}:${input.state}:${input.failedTool}:${input.code}`,
            input.state === "retryable" ? "AGENT_RETRYABLE" : "AGENT_FAILED",
            now,
            input.code,
          )
          .run();
        return {
          ...base,
          leaseId: input.leaseId,
          state: "diagnostic_recorded" as const,
        };
      }
      const d = await repo.draft(w.handoff_id);
      if (
        !d ||
        d.draft_ref !== input.draftRef ||
        d.provider !== input.provider ||
        d.receipt_status !== input.receiptStatus
      )
        throw new HTTPException(409, { message: "Draft provenance mismatch" });
      if (
        !["DRAFT_READY", "PENDING_REVIEW", "APPROVED_TO_SEND"].includes(w.state)
      )
        throw new HTTPException(409, { message: "Proposal transition denied" });
      await db.batch([
        db.statement(
          `UPDATE careops_workflows SET state='PENDING_REVIEW',updated_at=? WHERE org_id = :org AND handoff_id=? AND state='DRAFT_READY'
    AND lease_id=? AND lease_expires_at>? AND ${repo.safeSql}`,
          now,
          w.handoff_id,
          input.leaseId,
          now,
        ),
        db.statement(
          `UPDATE careops_drafts SET state='PENDING_REVIEW',updated_at=? WHERE org_id = :org AND draft_ref=? AND state='DRAFT_READY'
    AND EXISTS(SELECT 1 FROM careops_workflows w WHERE w.org_id=careops_drafts.org_id AND w.handoff_id=careops_drafts.handoff_id AND w.state='PENDING_REVIEW')`,
          now,
          d.draft_ref,
        ),
        db.statement(
          `UPDATE maritime_handoffs SET status='completed',updated_at=? WHERE org_id = :org AND id=?
    AND EXISTS(SELECT 1 FROM careops_workflows w WHERE w.org_id=maritime_handoffs.org_id AND w.handoff_id=maritime_handoffs.id AND w.state IN ('PENDING_REVIEW','APPROVED_TO_SEND'))`,
          now,
          w.handoff_id,
        ),
        repo.event(
          w,
          `${d.draft_ref}:proposed`,
          "PENDING_REVIEW",
          now,
          null,
          null,
          null,
          "w.state IN ('PENDING_REVIEW','APPROVED_TO_SEND') AND w.lease_id=? AND w.lease_expires_at>?",
          [input.leaseId, now],
        ),
        repo.thread(
          w,
          `${d.draft_ref}:proposed`,
          "PENDING_REVIEW",
          now,
          "w.state IN ('PENDING_REVIEW','APPROVED_TO_SEND') AND w.lease_id=? AND w.lease_expires_at>?",
          [input.leaseId, now],
        ),
      ]);
      const current = await repo.authorized(base, input.leaseId);
      if (!["PENDING_REVIEW", "APPROVED_TO_SEND"].includes(current.state))
        throw new HTTPException(409, { message: "Proposal invalidated" });
      return {
        ...base,
        leaseId: input.leaseId,
        draftRef: d.draft_ref,
        state: "accepted_for_review" as const,
      };
    },
  };
}
