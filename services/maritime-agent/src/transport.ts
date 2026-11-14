import { lookup } from "node:dns";
import { request } from "node:https";
import type { LookupFunction } from "node:net";
import {
  type CoordinationFailure,
  type CoordinationTool,
  coordinationDiagnosticSchema,
  coordinationDraftRequestSchema,
  coordinationEnvelopeSchema,
  coordinationProposalSchema,
} from "../../../packages/shared/maritime-coordination";
import type { AgentConfig } from "./config";

export class ToolFailure extends Error {
  constructor(
    readonly code: CoordinationFailure,
    readonly retryable: boolean,
  ) {
    super(code);
  }
}
export interface MachineTools {
  post(
    tool: CoordinationTool,
    payload: unknown,
    idempotencyKey: string,
  ): Promise<unknown>;
}
const paths: Record<CoordinationTool, string> = {
  fetch_context: "/api/v1/machine/maritime/context",
  request_draft: "/api/v1/machine/maritime/draft",
  propose_review: "/api/v1/machine/maritime/events",
};
function publicAddress(address: string) {
  if (address.includes(":"))
    return (
      /^[23][0-9a-f]{0,3}:/i.test(address) &&
      !address.toLowerCase().startsWith("2001:db8:")
    );
  const [a = 0, b = 0] = address.split(".").map(Number);
  return !(
    a === 0 ||
    a === 10 ||
    a === 127 ||
    a >= 224 ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && [0, 168].includes(b)) ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 198 && [18, 19].includes(b))
  );
}
const publicLookup: LookupFunction = (hostname, options, callback) => {
  lookup(hostname, { all: true }, (error, addresses) => {
    if (
      error ||
      !addresses.length ||
      addresses.some((entry) => !publicAddress(entry.address))
    ) {
      callback(new Error("Address denied"), "", 0);
      return;
    }
    if (options.all) callback(null, addresses);
    else {
      const entry = addresses[0];
      if (entry) callback(null, entry.address, entry.family);
    }
  });
};

/** TLS overrides are dependency injection for local HTTPS tests only. No HTTP
 * message or production env field can set a CA, DNS lookup, path or target URL.
 */
export function createMachineTools(
  config: AgentConfig,
  testTls?: { ca: string; lookup: LookupFunction },
): MachineTools {
  return {
    async post(tool, payload, idempotencyKey) {
      if (!config.origin || !config.machineToken)
        throw new ToolFailure("UPSTREAM_AUTH", false);
      const schema =
        tool === "fetch_context"
          ? coordinationEnvelopeSchema
          : tool === "request_draft"
            ? coordinationDraftRequestSchema
            : coordinationProposalSchema.or(coordinationDiagnosticSchema);
      const parsed = schema.safeParse(payload);
      if (!parsed.success) throw new ToolFailure("UPSTREAM_INVALID", false);
      const body = JSON.stringify(parsed.data);
      if (body.length > 4096 || !/^[a-zA-Z0-9:_-]{1,180}$/.test(idempotencyKey))
        throw new ToolFailure("UPSTREAM_INVALID", false);
      const url = new URL(paths[tool], config.origin);
      if (url.protocol !== "https:" || url.origin !== config.origin)
        throw new ToolFailure("UPSTREAM_REDIRECT", false);
      return new Promise<unknown>((resolve, reject) => {
        const signal = AbortSignal.timeout(config.timeoutMs);
        const req = request(
          url,
          {
            method: "POST",
            signal,
            agent: false,
            lookup: testTls?.lookup ?? publicLookup,
            ca: testTls?.ca,
            headers: {
              Authorization: `Bearer ${config.machineToken}`,
              "Content-Type": "application/json",
              Accept: "application/json",
              "Idempotency-Key": idempotencyKey,
            },
          },
          (response) => {
            const status = response.statusCode ?? 500;
            if (status < 200 || status >= 300) {
              response.resume();
              reject(
                status >= 300 && status < 400
                  ? new ToolFailure("UPSTREAM_REDIRECT", false)
                  : [401, 403].includes(status)
                    ? new ToolFailure("UPSTREAM_AUTH", false)
                    : status === 429
                      ? new ToolFailure("UPSTREAM_BUSY", true)
                      : status >= 500
                        ? new ToolFailure("UPSTREAM_UNAVAILABLE", true)
                        : new ToolFailure("UPSTREAM_REJECTED", false),
              );
              return;
            }
            const chunks: Buffer[] = [];
            let size = 0;
            response.on("data", (chunk: Buffer) => {
              size += chunk.length;
              if (size > 16384) {
                reject(new ToolFailure("UPSTREAM_INVALID", false));
                response.destroy();
                return;
              }
              chunks.push(chunk);
            });
            response.on("error", () =>
              reject(
                new ToolFailure(
                  signal.aborted ? "TOOL_TIMEOUT" : "NETWORK_FAILURE",
                  true,
                ),
              ),
            );
            response.on("end", () => {
              try {
                resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
              } catch {
                reject(new ToolFailure("UPSTREAM_INVALID", false));
              }
            });
          },
        );
        req.on("error", () =>
          reject(
            new ToolFailure(
              signal.aborted ? "TOOL_TIMEOUT" : "NETWORK_FAILURE",
              true,
            ),
          ),
        );
        req.end(body);
      });
    },
  };
}
