import { z } from "zod";
import {
  pruneMetadataSchema,
  type pruneVerificationStatusSchema,
} from "../shared/contracts";
import {
  assertSafeForExternalEgress,
  buildSafeChatRequest,
  deterministicDraft,
  draftInputSchema,
  type SafeChatRequest,
} from "./egressSafetyGate";

const completionUrl = "https://api.withprune.com/v1/chat/completions";
export const PRUNE_RECEIPT_CAPABILITY = "OFFLINE_MATH_ONLY" as const;
export const PRUNE_RECEIPT_SOURCE_GAP =
  "Exact vendor signed-field defaults and a verified vendor fixture are unavailable";
type VerificationStatus = z.infer<typeof pruneVerificationStatusSchema>;
export type GuardianAudit = {
  id: string;
  eventType:
    | "BLOCKED_EGRESS_GATE"
    | "DISABLED"
    | "REQUESTED"
    | "COMPLETED"
    | "UPSTREAM_FAILED";
  receiptStatus: VerificationStatus;
  networkAttempted: boolean;
  receiptJson: string | null;
};
type VerificationOptions = {
  publicKeyBase64?: string;
  signingKeyId?: string;
  verifyViaApi?: boolean;
  transport?: typeof fetch;
};

/** Local deterministic JSON utility only. Not a verified vendor canonicalizer. */
export function canonicalPruneJson(value: unknown): string {
  if (value === null || typeof value !== "object")
    return JSON.stringify(value) ?? "null";
  if (Array.isArray(value))
    return `[${value.map(canonicalPruneJson).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalPruneJson(record[key])}`)
    .join(",")}}`;
}

/** @deprecated OFFLINE_MATH_ONLY; never use this helper as vendor evidence. */
export async function pruneRequestHash(request: SafeChatRequest) {
  assertSafeForExternalEgress(request);
  // Legacy OFFLINE_MATH_ONLY helper; not used to verify vendor receipts.
  const bytes = new TextEncoder().encode(
    canonicalPruneJson({
      model: request.model,
      messages: request.messages,
      tools: null,
      system: null,
    }),
  );
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
}

async function boundedJson(response: Response): Promise<unknown> {
  if (!response.body) throw new Error("Empty response");
  const reader = response.body.getReader();
  const parts: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      const part = await reader.read();
      if (part.done) break;
      length += part.value.byteLength;
      if (length > 65536) throw new Error("Response too large");
      parts.push(part.value);
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }
  const buffer = new Uint8Array(length);
  let offset = 0;
  for (const part of parts) {
    buffer.set(part, offset);
    offset += part.byteLength;
  }
  return JSON.parse(new TextDecoder().decode(buffer));
}

/** Public docs describe a fixed SIGNED_FIELDS + DEFAULTS contract, not signing
 * every locally parsed key. Neither that exact spec nor a verified vendor
 * fixture is available. A pinned key, local signature, mocked API `valid:true`,
 * or guessed request hash therefore cannot promote a provider receipt.
 * Official API body is {receipt: object}; knowing that alone does not establish
 * signed-field coverage or bind the receipt to this completion.
 * https://www.withprune.com/docs/receipts
 * https://www.withprune.com/verify
 * https://api.withprune.com/openapi.json
 */
export async function verifyPruneReceipt(
  raw: unknown,
  _expectedHash: string,
  _options: VerificationOptions = {},
): Promise<VerificationStatus> {
  return raw === undefined || raw === null ? "MISSING" : "PRESENT_UNVERIFIED";
}

/** Constant-key, boolean-only proof summary. Never retain vendor free text,
 * routing model labels, unknown extensions, notes, signatures or payloads.
 */
export function sanitizedPruneReceiptJson(raw: unknown): string | null {
  if (raw === undefined || raw === null) return null;
  const parsed = pruneMetadataSchema.safeParse(raw);
  return JSON.stringify({
    receiptPresent: true,
    cacheHit: parsed.success && parsed.data.cache_hit === true,
    signaturePresent:
      parsed.success &&
      typeof parsed.data.receipt_signature === "string" &&
      parsed.data.receipt_signature.length > 0,
    verificationCapability: PRUNE_RECEIPT_CAPABILITY,
  });
}

export type GuardianOptions = VerificationOptions & {
  enabled?: boolean;
  key?: string;
  audit: (event: GuardianAudit) => Promise<void>;
};

export function pruneGuardian(options: GuardianOptions) {
  return {
    async draft(raw: unknown) {
      const id = crypto.randomUUID();
      const parsed = draftInputSchema.safeParse(raw);
      const fallbackText = deterministicDraft(
        parsed.success ? parsed.data : undefined,
      );
      const result = (
        receiptStatus: VerificationStatus,
        reason: string,
        auditPersisted: boolean,
        text = fallbackText,
      ) => ({
        text,
        provider:
          reason === "COMPLETED"
            ? ("prune" as const)
            : ("local-template" as const),
        requiresClinicianReview: true as const,
        receiptStatus,
        auditId: id,
        auditPersisted,
        reason,
      });
      const audit = async (
        eventType: GuardianAudit["eventType"],
        receiptStatus: VerificationStatus,
        networkAttempted: boolean,
        receiptJson: string | null = null,
      ) => {
        try {
          await options.audit({
            id,
            eventType,
            receiptStatus,
            networkAttempted,
            receiptJson,
          });
          return true;
        } catch {
          return false;
        }
      };
      let request: SafeChatRequest;
      try {
        if (!parsed.success) throw new Error("Unsafe selector");
        request = buildSafeChatRequest(parsed.data);
        assertSafeForExternalEgress(request);
      } catch {
        const logged = await audit(
          "BLOCKED_EGRESS_GATE",
          "NOT_APPLICABLE_BLOCKED",
          false,
        );
        return result("NOT_APPLICABLE_BLOCKED", "BLOCKED_EGRESS_GATE", logged);
      }
      if (!options.enabled || !options.key) {
        const logged = await audit(
          "DISABLED",
          "NOT_APPLICABLE_DISABLED",
          false,
        );
        return result("NOT_APPLICABLE_DISABLED", "DISABLED", logged);
      }
      if (!(await audit("REQUESTED", "MISSING", true)))
        return result("MISSING", "AUDIT_UNAVAILABLE", false);
      let status: VerificationStatus = "MISSING";
      let receiptJson: string | null = null;
      try {
        // No caller headers/options can override endpoint, cache policy or body.
        assertSafeForExternalEgress(request);
        const response = await (options.transport ?? fetch)(completionUrl, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${options.key}`,
            "Content-Type": "application/json",
            "X-Prune-Cache": "off",
          },
          body: JSON.stringify(request),
          redirect: "error",
          cache: "no-store",
          signal: AbortSignal.timeout(8000),
        });
        if (!response.ok) throw new Error("Upstream unavailable");
        const body = z
          .object({
            choices: z
              .array(
                z.object({
                  message: z.object({ content: z.string().min(1).max(4000) }),
                }),
              )
              .min(1)
              .max(10),
            prune_metadata: z.unknown().optional(),
          })
          .parse(await boundedJson(response));
        const metadata = pruneMetadataSchema.safeParse(body.prune_metadata);
        receiptJson = sanitizedPruneReceiptJson(body.prune_metadata);
        status = await verifyPruneReceipt(
          body.prune_metadata,
          "", // No speculative vendor request canonicalization.
          options,
        );
        if (metadata.success && metadata.data.cache_hit === true)
          throw new Error("Cache-off policy violated");
        if (status !== "VERIFIED_ED25519" && status !== "VERIFIED_API")
          throw new Error("Receipt unverified");
        const logged = await audit("COMPLETED", status, true, receiptJson);
        return logged
          ? result(status, "COMPLETED", true, body.choices[0]?.message.content)
          : result(status, "AUDIT_UNAVAILABLE", false);
      } catch {
        const logged = await audit(
          "UPSTREAM_FAILED",
          status,
          true,
          receiptJson,
        );
        return result(status, "SAFE_FALLBACK", logged);
      }
    },
  };
}
