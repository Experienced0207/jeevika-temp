import { realpathSync } from "node:fs";
import { createServer, type IncomingMessage } from "node:http";
import { pathToFileURL } from "node:url";
import {
  coordinationEnvelopeSchema,
  coordinationResultSchema,
  maritimeChatInputSchema,
} from "../../../packages/shared/maritime-coordination";
import { type AgentConfig, loadAgentConfig } from "./config";
import { AgentFailure, Coordinator } from "./coordinator";
import { createMachineTools, type MachineTools } from "./transport";

class InputFailure extends Error {
  constructor(readonly status: number) {
    super("INVALID_INPUT");
  }
}
async function chatBody(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const value of request) {
    const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value);
    bytes += chunk.length;
    if (bytes <= 8192) chunks.push(chunk);
  }
  if (bytes > 8192) throw new InputFailure(413);
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new InputFailure(400);
  }
}
export function createAgentServer(
  config: AgentConfig,
  tools: MachineTools = createMachineTools(config),
) {
  const coordinator = new Coordinator(config, tools);
  let active = 0;
  let windowStart = Date.now();
  let requests = 0;
  const server = createServer(async (request, response) => {
    response.setHeader("Content-Type", "application/json");
    response.setHeader("Cache-Control", "no-store");
    const send = (status: number, body: unknown) => {
      response.statusCode = status;
      response.end(JSON.stringify(body));
    };
    if (request.method === "GET" && request.url === "/health") {
      send(200, { ok: true });
      return;
    }
    if (request.method !== "POST" || request.url !== "/chat") {
      send(404, { response: "NOT_FOUND" });
      return;
    }
    if (Date.now() - windowStart >= 60000) {
      requests = 0;
      windowStart = Date.now();
    }
    if (++requests > 60 || active >= 8) {
      send(429, { response: "CAPACITY_LIMIT" });
      return;
    }
    active++;
    const readTimeout = setTimeout(() => request.destroy(), 5000);
    readTimeout.unref();
    try {
      const body = maritimeChatInputSchema.safeParse(await chatBody(request));
      clearTimeout(readTimeout);
      if (!body.success) throw new InputFailure(400);
      let raw: unknown;
      try {
        raw = JSON.parse(body.data.message);
      } catch {
        throw new InputFailure(422);
      }
      const envelope = coordinationEnvelopeSchema.safeParse(raw);
      if (!envelope.success) throw new InputFailure(422);
      // Source is intentionally not an enum, an authority signal, a log field,
      // or part of any outbound payload. Only validated references proceed.
      const result = coordinationResultSchema.parse(
        await coordinator.run(envelope.data),
      );
      send(200, { response: JSON.stringify(result) });
    } catch (error) {
      if (error instanceof InputFailure)
        send(error.status, { response: "INVALID_INPUT" });
      else if (error instanceof AgentFailure)
        send(error.status, { response: error.code });
      else send(503, { response: "SAFE_FAILURE" });
    } finally {
      clearTimeout(readTimeout);
      active--;
    }
  });
  server.headersTimeout = 5000;
  server.requestTimeout = 27000;
  server.keepAliveTimeout = 1000;
  return server;
}
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href
) {
  try {
    const config = loadAgentConfig(process.env);
    createAgentServer(config).listen(config.port, "0.0.0.0");
  } catch {
    console.error("Agent startup failed: invalid configuration");
    process.exitCode = 1;
  }
}
