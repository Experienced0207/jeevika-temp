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
const verificationUrl = "https://api.withprune.com/v1/receipts/verify";
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

/** Sorted compact JSON. The egress template uses ASCII only, so its encoding
 * also agrees with Python's ensure_ascii request-hash canonicalization.
 */
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

export async function pruneRequestHash(request: SafeChatRequest) {
  assertSafeForExternalEgress(request);
  // Prune canonical request version v1 binds model/messages/tools/system.
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

function decodeBase64(value: string) {
  return Uint8Array.from(atob(value), (char) => char.charCodeAt(0));
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

/** Metadata presence is not proof. Pin a trusted Ed25519 key or ask the fixed
 * HTTPS verification endpoint; neither path accepts a caller-selected URL/key.
 * https://www.withprune.com/docs/receipts
 * https://api.withprune.com/openapi.json (ReceiptVerifyRequest)
 */
export async function verifyPruneReceipt(
  raw: unknown,
  expectedHash: string,
  options: VerificationOptions = {},
): Promise<VerificationStatus> {
  if (raw === undefined || raw === null) return "MISSING";
  const parsed = pruneMetadataSchema.safeParse(raw);
  if (!parsed.success) return "PRESENT_UNVERIFIED";
  const metadata = parsed.data;
  if (
    !metadata.receipt_signature ||
    !metadata.receipt_signed_at ||
    metadata.receipt_request_canonical_version !== "v1" ||
    metadata.receipt_request_sha256 !== expectedHash
  )
    return "PRESENT_UNVERIFIED";

  if (
    options.publicKeyBase64 &&
    (!options.signingKeyId ||
      metadata.receipt_signing_key_id === options.signingKeyId)
  ) {
    try {
      const keyBytes = decodeBase64(options.publicKeyBase64);
      if (keyBytes.length !== 32) throw new Error("Invalid public key");
      const key = await crypto.subtle.importKey(
        "raw",
        keyBytes,
        { name: "Ed25519" },
        false,
        ["verify"],
      );
      const {
        receipt_signature,
        receipt_signing_key_id: _keyId,
        ...signed
      } = metadata;
      // signed_at stays signed. If provider defaults/canonicalization differ,
      // verification fails and the documented hosted verifier is the fallback.
      const valid = await crypto.subtle.verify(
        { name: "Ed25519" },
        key,
        decodeBase64(receipt_signature),
        new TextEncoder().encode(canonicalPruneJson(signed)),
      );
      if (valid) return "VERIFIED_ED25519";
    } catch {
      /* Fail closed; never infer authenticity from a signature field. */
    }
  }
  if (!options.verifyViaApi) return "PRESENT_UNVERIFIED";
  try {
    assertSafeForExternalEgress(metadata, "receipt");
    const response = await (options.transport ?? fetch)(verificationUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Prune-Cache": "off" },
      body: JSON.stringify({ receipt: metadata }),
      redirect: "error",
      cache: "no-store",
      signal: AbortSignal.timeout(8000),
    });
    if (!response.ok) return "PRESENT_UNVERIFIED";
    const result = z
      .object({ valid: z.boolean() })
      .safeParse(await boundedJson(response));
    return result.success && result.data.valid === true
      ? "VERIFIED_API"
      : "PRESENT_UNVERIFIED";
  } catch {
    return "PRESENT_UNVERIFIED";
  }
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
        const expectedHash = await pruneRequestHash(request);
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
        receiptJson = metadata.success ? JSON.stringify(metadata.data) : null;
        status = await verifyPruneReceipt(
          body.prune_metadata,
          expectedHash,
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
