import { z } from "zod";
export const careopsWorkflowStateSchema = z.enum([
  "OUTBOX_PENDING",
  "DISPATCH_LEASED",
  "WEBHOOK_ACCEPTED",
  "AGENT_RUNNING",
  "DRAFT_READY",
  "PENDING_REVIEW",
  "APPROVED_TO_SEND",
  "REJECTED",
  "COMPLETED",
  "FAILED_RETRY",
  "DEAD_LETTER",
  "CANCELLED",
]);
export const careopsDraftReviewSchema = z
  .strictObject({
    kind: z.literal("draft_review"),
    draftRef: z.uuid(),
    revision: z.number().int().positive(),
    action: z.enum(["approve", "reject", "edit"]),
    language: z.enum(["en-IN", "hi-IN"]).optional(),
    note: z.string().max(500).default(""),
  })
  .refine((x) => x.action === "edit" || x.language === undefined);
export const careopsPageSchema = z.strictObject({
  limit: z.coerce.number().int().min(1).max(50).default(20),
  cursor: z.uuid().optional(),
});

// C5 read boundary: costs are deliberately unknown and delivery is never claimed.
export const careopsTaskViewSchema = z.strictObject({
  id: z.uuid(),
  status: z.enum(["open", "in_progress", "completed", "cancelled"]),
  priority: z.enum(["review", "urgent"]),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export const careopsTaskPageSchema = z.strictObject({
  items: z
    .array(
      careopsTaskViewSchema.extend({
        workflowState: careopsWorkflowStateSchema.nullable(),
      }),
    )
    .max(50),
  nextCursor: z.uuid().nullable(),
});
export const careopsTaskDetailSchema = z.strictObject({
  task: careopsTaskViewSchema,
  workflow: z
    .strictObject({
      state: careopsWorkflowStateSchema,
      handoffId: z.uuid(),
      updatedAt: z.string(),
    })
    .nullable(),
  draft: z
    .strictObject({
      draftRef: z.uuid(),
      text: z.string().max(4000),
      textSource: z.enum(["GUARDIAN", "HUMAN_TEMPLATE"]),
      pruneAuditAppliesTo: z.literal("INITIAL_DRAFT"),
      language: z.enum(["en-IN", "hi-IN"]),
      state: z.enum([
        "DRAFT_READY",
        "PENDING_REVIEW",
        "APPROVED_TO_SEND",
        "REJECTED",
      ]),
      revision: z.number().int().positive(),
      provider: z.enum(["prune", "local-template"]),
      receiptStatus: z.enum([
        "VERIFIED_ED25519",
        "VERIFIED_API",
        "PRESENT_UNVERIFIED",
        "MISSING",
        "NOT_APPLICABLE_BLOCKED",
        "NOT_APPLICABLE_DISABLED",
      ]),
      communicationState: z.enum(["NOT_SENT", "SIMULATED"]),
    })
    .nullable(),
  events: z
    .array(
      z.strictObject({
        id: z.string(),
        eventType: z.string(),
        code: z.string().nullable(),
        httpStatus: z.number().nullable(),
        createdAt: z.string(),
      }),
    )
    .max(100),
  thread: z
    .array(
      z.strictObject({
        id: z.string(),
        outcome: z.string(),
        createdAt: z.string(),
      }),
    )
    .max(100),
  auditTruncated: z.boolean(),
  providerConfigured: z.boolean(),
  cost: z.null(),
  messaging: z.literal("SIMULATED"),
});
