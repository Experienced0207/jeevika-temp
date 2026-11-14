import { z } from "zod";
import { type PruneMetadata, pruneMetadataSchema } from "../shared/contracts";

export const draftInputSchema = z.strictObject({
  workflow: z.enum(["careops_followup", "clinical_handoff"]),
  language: z.enum(["en-IN", "hi-IN"]).default("en-IN"),
});
export type DraftInput = z.infer<typeof draftInputSchema>;

const system =
  "Translate or format only the approved generic reminder. Add no facts, identifiers, measurements, diagnoses, prescriptions, or clinical decisions. Return only the reminder text.";
const reminders = {
  careops_followup:
    "A clinician review is required. Contact the care team to arrange follow-up. Do not change treatment without a clinician.",
  clinical_handoff:
    "A care handoff awaits human review. The receiving clinician must confirm the handoff before any action.",
} as const;
const hindi = {
  careops_followup:
    "चिकित्सक की समीक्षा आवश्यक है। अनुवर्ती देखभाल के लिए देखभाल टीम से संपर्क करें। चिकित्सक की सलाह के बिना उपचार न बदलें।",
  clinical_handoff:
    "देखभाल हस्तांतरण मानव समीक्षा की प्रतीक्षा में है। किसी भी कार्रवाई से पहले प्राप्तकर्ता चिकित्सक को हस्तांतरण की पुष्टि करनी होगी।",
} as const;

export function deterministicDraft(input?: DraftInput) {
  if (!input)
    return "Human review is required. Contact the care team. Do not change treatment without a clinician.";
  return input.language === "hi-IN"
    ? hindi[input.workflow]
    : reminders[input.workflow];
}

export function buildSafeChatRequest(raw: unknown) {
  const input = draftInputSchema.parse(raw);
  return {
    model: "gpt-4o-mini" as const,
    messages: [
      { role: "system" as const, content: system },
      {
        role: "user" as const,
        content: `Return this reminder in ${input.language === "hi-IN" ? "Hindi" : "English"}: ${reminders[input.workflow]}`,
      },
    ],
    temperature: 0,
    max_tokens: 256,
    stream: false as const,
  };
}
export type SafeChatRequest = ReturnType<typeof buildSafeChatRequest>;

export class BlockedEgressError extends Error {
  constructor() {
    super("BLOCKED_EGRESS_GATE");
  }
}

/** A positive allowlist, not a regex de-identification claim. Only complete,
 * server-owned OpenAI chat templates can cross the external boundary. Unknown
 * fields, free text, tools, clinical values and encoded identifiers are denied.
 */
export function assertSafeForExternalEgress(
  raw: unknown,
): asserts raw is SafeChatRequest;
export function assertSafeForExternalEgress(
  raw: unknown,
  boundary: "receipt",
): asserts raw is PruneMetadata;
export function assertSafeForExternalEgress(
  raw: unknown,
  boundary?: "receipt",
) {
  if (boundary === "receipt") {
    if (!pruneMetadataSchema.safeParse(raw).success)
      throw new BlockedEgressError();
    return;
  }
  const schema = z.strictObject({
    model: z.literal("gpt-4o-mini"),
    messages: z.tuple([
      z.strictObject({ role: z.literal("system"), content: z.literal(system) }),
      z.strictObject({ role: z.literal("user"), content: z.string().max(500) }),
    ]),
    temperature: z.literal(0),
    max_tokens: z.literal(256),
    stream: z.literal(false),
  });
  const parsed = schema.safeParse(raw);
  if (!parsed.success) throw new BlockedEgressError();
  const accepted = (["careops_followup", "clinical_handoff"] as const).some(
    (workflow) =>
      (["en-IN", "hi-IN"] as const).some(
        (language) =>
          parsed.data.messages[1].content ===
          buildSafeChatRequest({ workflow, language }).messages[1]?.content,
      ),
  );
  if (!accepted) throw new BlockedEgressError();
}
