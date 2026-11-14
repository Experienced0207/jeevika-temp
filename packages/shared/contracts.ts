import { z } from "zod";

export const patientSchema = z.object({
  id: z
    .string()
    .regex(/^[a-zA-Z0-9-]+$/)
    .max(80),
  name: z.string().min(1).max(120),
  gender: z.enum(["female", "male", "other", "unknown"]),
  birthDate: z.iso.date(),
  language: z.enum(["en-IN", "hi-IN", "pa-IN", "ta-IN", "te-IN"]),
});
export type Patient = z.infer<typeof patientSchema>;
export const observationSchema = z.object({
  id: z.string().min(1).max(100),
  patientId: z.string().min(1),
  code: z.enum(["8480-6", "8867-4", "59408-5", "41950-7"]),
  value: z.number().finite(),
  unit: z.enum(["mm[Hg]", "/min", "%", "{steps}"]),
  sampledAt: z.iso.datetime(),
  source: z.enum(["project-1", "project-2", "ble-simulator", "manual"]),
});
export type Observation = z.infer<typeof observationSchema>;
export const prescriptionSchema = z.object({
  salt: z.string().min(1).max(100),
  strengthMg: z.number().int().positive().max(5000),
  form: z.enum(["tablet", "capsule"]),
  units: z.number().int().positive().max(1000),
  courseEnd: z.iso.date(),
});
export const batchSchema = z.object({
  id: z.string().min(1),
  clinic: z.string().min(1),
  salt: z.string().min(1),
  strengthMg: z.number().int().positive(),
  form: z.enum(["tablet", "capsule"]),
  stock: z.number().int().nonnegative(),
  pricePaise: z.number().int().nonnegative().max(10000000),
  expiry: z.iso.date(),
});
export const planInputSchema = z
  .object({
    prescription: prescriptionSchema,
    batches: z.array(batchSchema).max(200),
    allergies: z.array(z.string().max(100)).max(30).default([]),
    homeClinic: z.string().max(100),
    transferPaise: z.number().int().nonnegative().max(100000).default(0),
  })
  .superRefine((input, ctx) => {
    const ids = new Set<string>();
    for (const [index, batch] of input.batches.entries()) {
      if (ids.has(batch.id))
        ctx.addIssue({
          code: "custom",
          message: "Batch IDs must be unique",
          path: ["batches", index, "id"],
        });
      ids.add(batch.id);
    }
  });
export type PlanInput = z.infer<typeof planInputSchema>;
export type Batch = z.infer<typeof batchSchema>;
export const sentinelInputSchema = z.object({
  answers: z.partialRecord(
    z.enum([
      "chestPain",
      "breathless",
      "fainting",
      "fever",
      "cough",
      "fatigue",
      "thirst",
    ]),
    z.enum(["yes", "no", "unsure"]),
  ),
});
export const driftInputSchema = z.object({
  readings: z
    .array(
      z.object({
        day: z.number().int().min(0).max(36500),
        value: z.number().min(60).max(250),
      }),
    )
    .min(1)
    .max(365),
});
export const demandInputSchema = z.object({
  probabilities: z.array(z.number().min(0).max(1)).max(500),
  stock: z.number().int().nonnegative().max(100000),
  serviceLevel: z.number().min(0.5).max(0.999).default(0.95),
});

// Version 1 CareOps contracts. External payloads accept only opaque references;
// strict objects reject clinical text, identifiers, and arbitrary provider data.
export const careopsTaskStatusSchema = z.enum([
  "open",
  "in_progress",
  "completed",
  "cancelled",
]);
export const careopsTaskSchema = z.strictObject({
  id: z.uuid(),
  patientId: z.literal("P-1042"),
  kind: z.literal("bp_drift"),
  priority: z.enum(["review", "urgent"]),
  status: careopsTaskStatusSchema,
  triggerDay: z.number().int().min(0).max(36500),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});
export type CareopsTask = z.infer<typeof careopsTaskSchema>;
export const careopsEventSchema = z.strictObject({
  id: z.uuid(),
  taskId: z.uuid(),
  eventType: z.enum([
    "drift_detected",
    "prune_receipt",
    "handoff_received",
    "handoff_completed",
  ]),
  createdAt: z.iso.datetime(),
});
export const careopsTriggerSchema = z.strictObject({
  schemaVersion: z.literal(1),
  triggerId: z.uuid(),
});
export const pruneReceiptSchema = z.strictObject({
  schemaVersion: z.literal(1),
  receiptId: z.uuid(),
  triggerId: z.uuid(),
  decision: z.enum(["accepted", "rejected", "human_review"]),
  policyVersion: z.string().regex(/^[a-zA-Z0-9._-]{1,40}$/),
  receivedAt: z.iso.datetime(),
});
export const maritimeWebhookSchema = z.strictObject({
  schemaVersion: z.literal(1),
  handoffId: z.uuid(),
  receiptId: z.uuid(),
  triggerId: z.uuid(),
});
export const maritimeCallbackSchema = z.strictObject({
  schemaVersion: z.literal(1),
  handoffId: z.uuid(),
  eventId: z.uuid(),
  status: z.enum(["accepted", "completed", "failed"]),
  occurredAt: z.iso.datetime(),
});
export type PruneReceipt = z.infer<typeof pruneReceiptSchema>;
export type MaritimeWebhook = z.infer<typeof maritimeWebhookSchema>;
export type MaritimeCallback = z.infer<typeof maritimeCallbackSchema>;

export const homeVitalsSchema = z
  .strictObject({
    patientId: z.literal("P-1042").default("P-1042"),
    readings: driftInputSchema.shape.readings.optional(),
    systolic: z.number().min(60).max(250).optional(),
    value: z.number().min(60).max(250).optional(),
    day: z.number().int().min(0).max(36500).optional(),
    sampledAt: z.iso.datetime().optional(),
  })
  .superRefine((input, ctx) => {
    if (
      (input.readings &&
        (input.systolic !== undefined ||
          input.value !== undefined ||
          input.day !== undefined ||
          input.sampledAt !== undefined)) ||
      (input.systolic !== undefined &&
        input.value !== undefined &&
        input.systolic !== input.value) ||
      (input.day !== undefined && input.sampledAt !== undefined) ||
      ((input.day !== undefined || input.sampledAt !== undefined) &&
        input.systolic === undefined &&
        input.value === undefined)
    ) {
      ctx.addIssue({
        code: "custom",
        message: "Provide one unambiguous reading representation",
      });
    }
  });

/** Collection bundle: FHIR R4 aligned; not an ABDM document or certified profile. */
export function fhirBundle(patient: Patient, observations: Observation[]) {
  patientSchema.parse(patient);
  for (const observation of observations) {
    observationSchema.parse(observation);
    if (observation.patientId !== patient.id)
      throw new Error("Observation patient mismatch");
  }
  return {
    resourceType: "Bundle",
    type: "collection",
    entry: [
      {
        fullUrl: `urn:ayusetu:Patient:${patient.id}`,
        resource: {
          resourceType: "Patient",
          id: patient.id,
          name: [{ text: patient.name }],
          gender: patient.gender,
          birthDate: patient.birthDate,
        },
      },
      ...observations.map((o) => ({
        fullUrl: `urn:ayusetu:Observation:${o.id}`,
        resource: {
          resourceType: "Observation",
          id: o.id,
          status: "final",
          subject: { reference: `urn:ayusetu:Patient:${patient.id}` },
          code: { coding: [{ system: "http://loinc.org", code: o.code }] },
          effectiveDateTime: o.sampledAt,
          valueQuantity: {
            value: o.value,
            unit: o.unit,
            system: "http://unitsofmeasure.org",
            code: o.unit,
          },
          note: [{ text: `Source: ${o.source}; synthetic demonstration data` }],
        },
      })),
    ],
  };
}
