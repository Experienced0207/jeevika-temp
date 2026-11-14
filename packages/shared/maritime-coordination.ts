import { z } from "zod";

// C3 -> C4 machine protocol. Only opaque references, enums and booleans cross
// this boundary. Tenant is resolved by C4 from the machine credential.
export const coordinationEnvelopeSchema = z.strictObject({
  schemaVersion: z.literal(1),
  triggerId: z.uuid(),
  handoffId: z.uuid(),
  taskRef: z.uuid(),
  eventId: z.uuid(),
  action: z.literal("propose_administrative_followup"),
});
export type CoordinationEnvelope = z.infer<typeof coordinationEnvelopeSchema>;
// Ignore extra platform delivery metadata; the command inside message remains
// strict. Neither source nor ignored metadata is persisted or forwarded.
export const maritimeChatInputSchema = z.object({
  message: z.string().min(1).max(2048),
  source: z.string().min(1).max(128),
});
export const coordinationContextSchema = coordinationEnvelopeSchema.extend({
  leaseId: z.uuid(),
  expiresAt: z.iso.datetime(),
  coordinationPermitted: z.literal(true),
  staffReviewApproved: z.literal(true),
  urgent: z.literal(false),
  language: z.enum(["en-IN", "hi-IN"]),
});
export type CoordinationContext = z.infer<typeof coordinationContextSchema>;
export const coordinationDraftRequestSchema = coordinationEnvelopeSchema.extend(
  {
    leaseId: z.uuid(),
    workflow: z.literal("careops_followup"),
    language: z.enum(["en-IN", "hi-IN"]),
  },
);
export const coordinationDraftSchema = coordinationEnvelopeSchema.extend({
  leaseId: z.uuid(),
  draftRef: z.uuid(),
  provider: z.enum(["prune", "local-template"]),
  receiptStatus: z.enum([
    "VERIFIED_ED25519",
    "VERIFIED_API",
    "PRESENT_UNVERIFIED",
    "MISSING",
    "NOT_APPLICABLE_BLOCKED",
    "NOT_APPLICABLE_DISABLED",
  ]),
  requiresClinicianReview: z.literal(true),
});
export type CoordinationDraft = z.infer<typeof coordinationDraftSchema>;
export const coordinationToolSchema = z.enum([
  "fetch_context",
  "request_draft",
  "propose_review",
]);
export type CoordinationTool = z.infer<typeof coordinationToolSchema>;
export const coordinationFailureSchema = z.enum([
  "UPSTREAM_AUTH",
  "UPSTREAM_REJECTED",
  "UPSTREAM_BUSY",
  "UPSTREAM_UNAVAILABLE",
  "UPSTREAM_REDIRECT",
  "UPSTREAM_INVALID",
  "TOOL_TIMEOUT",
  "NETWORK_FAILURE",
  "CONTEXT_EXPIRED",
  "REFERENCE_MISMATCH",
  "ATTEMPT_LIMIT",
  "JOURNAL_UNAVAILABLE",
]);
export type CoordinationFailure = z.infer<typeof coordinationFailureSchema>;
export const coordinationProposalSchema = coordinationDraftSchema.extend({
  leaseId: z.uuid(),
  state: z.literal("proposed_for_nurse_review"),
});
export const coordinationDiagnosticSchema = coordinationEnvelopeSchema.extend({
  leaseId: z.uuid(),
  state: z.enum(["retryable", "failed"]),
  failedTool: coordinationToolSchema,
  code: coordinationFailureSchema,
});
export const coordinationEventAckSchema = z.discriminatedUnion("state", [
  coordinationEnvelopeSchema.extend({
    leaseId: z.uuid(),
    state: z.literal("accepted_for_review"),
    draftRef: z.uuid(),
  }),
  coordinationEnvelopeSchema.extend({
    leaseId: z.uuid(),
    state: z.literal("diagnostic_recorded"),
  }),
]);
export const coordinationResultSchema = z.strictObject({
  schemaVersion: z.literal(1),
  handoffId: z.uuid(),
  eventId: z.uuid(),
  state: z.enum(["proposed_for_nurse_review", "retryable", "failed"]),
  completedTools: z.array(coordinationToolSchema).max(3),
  failedTool: coordinationToolSchema.optional(),
  code: coordinationFailureSchema.optional(),
  diagnosticRecorded: z.boolean(),
  provider: coordinationDraftSchema.shape.provider.optional(),
  receiptStatus: coordinationDraftSchema.shape.receiptStatus.optional(),
});
export type CoordinationResult = z.infer<typeof coordinationResultSchema>;
