import { type ChildProcess, execFileSync, spawn } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { createServer as httpServer, type Server } from "node:http";
import { createServer as httpsServer } from "node:https";
import type { AddressInfo, LookupFunction } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
} from "vitest";
import {
  type CoordinationEnvelope,
  coordinationDiagnosticSchema,
  coordinationDraftRequestSchema,
  coordinationEnvelopeSchema,
  coordinationProposalSchema,
  coordinationResultSchema,
} from "../packages/shared/maritime-coordination";
import {
  type AgentConfig,
  loadAgentConfig,
} from "../services/maritime-agent/src/config";
import { createAgentServer } from "../services/maritime-agent/src/server";
import { createMachineTools } from "../services/maritime-agent/src/transport";

let fixture: string;
let certificate: string;
let key: string;
let server: Server;
let backend: Server;
let config: AgentConfig;
let base: string;
let envelope: CoordinationEnvelope;
let calls: Array<{ path: string; body: unknown; key: string }>;
let material: Map<string, unknown>;
let drafts: Map<string, string>;
let token: string;
let leaseId: string;
let mode: {
  contextStatus?: number;
  draftStatus?: number;
  callbackStatus?: number;
  delay?: number;
  contextPatch?: Record<string, unknown>;
  draftPatch?: Record<string, unknown>;
  ackPatch?: Record<string, unknown>;
  oversize?: boolean;
};
const lookup: LookupFunction = (_host, options, callback) => {
  if (options.all) callback(null, [{ address: "127.0.0.1", family: 4 }]);
  else callback(null, "127.0.0.1", 4);
};
async function listen(value: Server) {
  await new Promise<void>((done) => value.listen(0, "127.0.0.1", done));
  return (value.address() as AddressInfo).port;
}
async function close(value: Server) {
  value.closeAllConnections();
  await new Promise<void>((done) => value.close(() => done()));
}
function refs(body: unknown) {
  return coordinationEnvelopeSchema.strip().parse(body);
}
async function invoke(
  raw: unknown = envelope,
  source = "unknown_future_maritime_source",
) {
  return fetch(`${base}/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      message: typeof raw === "string" ? raw : JSON.stringify(raw),
      source,
    }),
  });
}
async function result(response: Response) {
  const body = (await response.json()) as { response: string };
  return coordinationResultSchema.parse(JSON.parse(body.response));
}
beforeAll(() => {
  fixture = mkdtempSync(join(tmpdir(), "jeevika-c3-tests-"));
  execFileSync(
    "openssl",
    [
      "req",
      "-x509",
      "-newkey",
      "rsa:2048",
      "-nodes",
      "-keyout",
      join(fixture, "key.pem"),
      "-out",
      join(fixture, "cert.pem"),
      "-days",
      "1",
      "-subj",
      "/CN=api.jeevika.test",
      "-addext",
      "subjectAltName=DNS:api.jeevika.test",
    ],
    { stdio: "ignore" },
  );
  certificate = readFileSync(join(fixture, "cert.pem"), "utf8");
  key = readFileSync(join(fixture, "key.pem"), "utf8");
  execFileSync(
    resolve("node_modules/.bin/esbuild"),
    [
      "services/maritime-agent/src/server.ts",
      "--bundle",
      "--platform=node",
      "--format=esm",
      "--target=node22",
      `--outfile=${join(fixture, "server.mjs")}`,
    ],
    { stdio: "ignore" },
  );
});
afterAll(() => rmSync(fixture, { recursive: true, force: true }));
beforeEach(async () => {
  token = randomBytes(32).toString("hex");
  leaseId = randomUUID();
  calls = [];
  material = new Map();
  drafts = new Map();
  mode = {};
  envelope = {
    schemaVersion: 1,
    triggerId: randomUUID(),
    handoffId: randomUUID(),
    taskRef: randomUUID(),
    eventId: randomUUID(),
    action: "propose_administrative_followup",
  };
  backend = httpsServer(
    { cert: certificate, key },
    async (request, response) => {
      if (request.headers.authorization !== `Bearer ${token}`) {
        response.writeHead(401).end();
        return;
      }
      const buffers: Buffer[] = [];
      for await (const chunk of request) buffers.push(Buffer.from(chunk));
      const raw: unknown = JSON.parse(Buffer.concat(buffers).toString("utf8"));
      const path = request.url ?? "";
      calls.push({
        path,
        body: raw,
        key: String(request.headers["idempotency-key"]),
      });
      response.setHeader("Content-Type", "application/json");
      const send = (body: unknown) => {
        if (!response.destroyed) response.end(JSON.stringify(body));
      };
      const status = path.endsWith("context")
        ? mode.contextStatus
        : path.endsWith("draft")
          ? mode.draftStatus
          : mode.callbackStatus;
      if (status && status !== 200) {
        response.statusCode = status;
        response.setHeader("Location", "https://attacker.invalid/");
        send({ private_detail: "not for agent logs" });
        return;
      }
      if (path.endsWith("context")) {
        if (mode.delay)
          await new Promise((done) => setTimeout(done, mode.delay));
        if (mode.oversize) {
          send({ extra: "x".repeat(17000) });
          return;
        }
        send({
          ...coordinationEnvelopeSchema.parse(raw),
          leaseId,
          expiresAt: new Date(Date.now() + 60000).toISOString(),
          coordinationPermitted: true,
          staffReviewApproved: true,
          urgent: false,
          language: "en-IN",
          ...mode.contextPatch,
        });
      } else if (path.endsWith("draft")) {
        const input = coordinationDraftRequestSchema.parse(raw);
        const draftRef = drafts.get(input.eventId) ?? randomUUID();
        drafts.set(input.eventId, draftRef);
        send({
          ...refs(input),
          leaseId,
          draftRef,
          provider: "local-template",
          receiptStatus: "PRESENT_UNVERIFIED",
          requiresClinicianReview: true,
          ...mode.draftPatch,
        });
      } else if (path.endsWith("events")) {
        const isProposal =
          (raw as { state: string }).state === "proposed_for_nurse_review";
        const input = isProposal
          ? coordinationProposalSchema.parse(raw)
          : coordinationDiagnosticSchema.parse(raw);
        if (isProposal) material.set(input.eventId, input);
        send({
          ...refs(input),
          leaseId,
          state: isProposal ? "accepted_for_review" : "diagnostic_recorded",
          ...(isProposal
            ? { draftRef: (input as { draftRef: string }).draftRef }
            : {}),
          ...mode.ackPatch,
        });
      } else {
        response.statusCode = 404;
        send({});
      }
    },
  );
  const port = await listen(backend);
  config = loadAgentConfig({
    PORT: "18789",
    JEEVIKA_API_ORIGIN: `https://api.jeevika.test:${port}`,
    JEEVIKA_ALLOWED_HOSTNAME: "api.jeevika.test",
    JEEVIKA_MACHINE_TOKEN: token,
    JEEVIKA_AGENT_DATA_DIR: join(fixture, randomUUID()),
    JEEVIKA_TOOL_TIMEOUT_MS: "500",
  });
  server = createAgentServer(
    config,
    createMachineTools(config, { ca: certificate, lookup }),
  );
  base = `http://127.0.0.1:${await listen(server)}`;
});
afterEach(async () => {
  await close(server);
  await close(backend);
});

describe("Maritime custom-container actual HTTP workflow", () => {
  it("serves fast side-effect-free health", async () => {
    const start = performance.now();
    expect(await (await fetch(`${base}/health`)).json()).toEqual({ ok: true });
    expect(performance.now() - start).toBeLessThan(1000);
    expect(calls).toHaveLength(0);
  });
  it.each([
    {},
    { message: 12, source: "cli" },
    { message: "{}" },
    { message: "{}", source: 12 },
  ])("rejects malformed chat body %j", async (body) => {
    expect(
      (
        await fetch(`${base}/chat`, {
          method: "POST",
          body: JSON.stringify(body),
        })
      ).status,
    ).toBe(400);
    expect(calls).toHaveLength(0);
  });
  it("rejects natural language and malformed envelopes without crashing", async () => {
    for (const input of [
      "Diagnose Synthetic Name with BP 180 mmHg",
      "not-json",
      { ...envelope, patientId: "P-1042" },
      { ...envelope, taskRef: "http://169.254.169.254/" },
    ]) {
      expect((await invoke(input)).status).toBe(422);
    }
    expect(calls).toHaveLength(0);
    expect((await fetch(`${base}/health`)).status).toBe(200);
  });
  it("accepts an unknown string source and performs the real three-tool workflow", async () => {
    const start = performance.now();
    const response = await invoke();
    expect(response.status).toBe(200);
    const output = await result(response);
    expect(output).toMatchObject({
      state: "proposed_for_nurse_review",
      handoffId: envelope.handoffId,
      eventId: envelope.eventId,
      completedTools: ["fetch_context", "request_draft", "propose_review"],
      diagnosticRecorded: true,
      provider: "local-template",
      receiptStatus: "PRESENT_UNVERIFIED",
    });
    expect(performance.now() - start).toBeLessThan(3000);
    expect(calls.map((c) => c.path)).toEqual([
      "/api/v1/machine/maritime/context",
      "/api/v1/machine/maritime/draft",
      "/api/v1/machine/maritime/events",
    ]);
    expect(material.size).toBe(1);
    const network = JSON.stringify(calls);
    expect(network).not.toMatch(
      /patientId|P-1042|Synthetic Name|180 mmHg|systolic|phone|unknown_future_maritime_source/,
    );
    expect(network.includes(token)).toBe(false);
    expect(Object.keys(calls[2]?.body as object)).not.toContain("text");
  });
  it("deduplicates concurrent and restarted handoffs without extra material actions", async () => {
    const outputs = await Promise.all(
      Array.from({ length: 5 }, async () => result(await invoke())),
    );
    expect(
      outputs.every(
        (value) => JSON.stringify(value) === JSON.stringify(outputs[0]),
      ),
    ).toBe(true);
    expect(calls).toHaveLength(3);
    await close(server);
    server = createAgentServer(
      config,
      createMachineTools(config, { ca: certificate, lookup }),
    );
    base = `http://127.0.0.1:${await listen(server)}`;
    expect(await result(await invoke())).toEqual(outputs[0]);
    expect(calls).toHaveLength(3);
    expect(material.size).toBe(1);
    expect((await invoke({ ...envelope, taskRef: randomUUID() })).status).toBe(
      409,
    );
  });
  it("rejects tenant/reference mismatch before drafting", async () => {
    mode.contextPatch = { taskRef: randomUUID() };
    expect(await result(await invoke())).toMatchObject({
      state: "failed",
      code: "REFERENCE_MISMATCH",
      completedTools: [],
    });
    expect(calls).toHaveLength(1);
    expect(material.size).toBe(0);
  });
  it("honors C4 credential-scope denial without any draft or callback", async () => {
    mode.contextStatus = 403;
    expect(await result(await invoke())).toMatchObject({
      state: "failed",
      code: "UPSTREAM_AUTH",
      completedTools: [],
    });
    expect(calls).toHaveLength(1);
    expect(drafts.size).toBe(0);
    expect(material.size).toBe(0);
  });
  it("ignores extra platform metadata without forwarding it", async () => {
    const response = await fetch(`${base}/chat`, {
      method: "POST",
      body: JSON.stringify({
        message: JSON.stringify(envelope),
        source: "future_source",
        conversation_id: "platform-only",
        metadata: { patientId: "P-1042" },
      }),
    });
    expect((await result(response)).state).toBe("proposed_for_nurse_review");
    expect(JSON.stringify(calls)).not.toMatch(
      /P-1042|platform-only|conversation_id|future_source/,
    );
  });
  it.each([
    { urgent: true },
    { coordinationPermitted: false },
    { expiresAt: "2000-01-01T00:00:00.000Z" },
    { tenantId: "another-org" },
  ])("refuses context %j", async (patch) => {
    mode.contextPatch = patch;
    expect((await result(await invoke())).state).toBe("failed");
    expect(calls).toHaveLength(1);
    expect(material.size).toBe(0);
  });
  it("rejects forged tool text/URLs and records only a safe diagnostic", async () => {
    mode.draftPatch = {
      text: "Synthetic Name BP 180 mmHg",
      callbackUrl: "http://169.254.169.254/",
    };
    expect(await result(await invoke())).toMatchObject({
      state: "failed",
      code: "UPSTREAM_INVALID",
      diagnosticRecorded: true,
    });
    expect(calls).toHaveLength(3);
    expect(material.size).toBe(0);
    expect(JSON.stringify(calls)).not.toMatch(
      /Synthetic Name|mmHg|169\.254|callbackUrl/,
    );
  });
  it("does not follow redirects or accept a caller callback URL", async () => {
    expect(
      (await invoke({ ...envelope, callbackUrl: "https://attacker.invalid" }))
        .status,
    ).toBe(422);
    mode.contextStatus = 302;
    expect(await result(await invoke())).toMatchObject({
      state: "failed",
      code: "UPSTREAM_REDIRECT",
    });
    expect(calls).toHaveLength(1);
  });
  it.each([
    [401, "failed", "UPSTREAM_AUTH"],
    [429, "retryable", "UPSTREAM_BUSY"],
    [500, "retryable", "UPSTREAM_UNAVAILABLE"],
  ])("reports callback %i truthfully", async (status, state, code) => {
    mode.callbackStatus = Number(status);
    expect(await result(await invoke())).toMatchObject({
      state,
      code,
      diagnosticRecorded: false,
      completedTools: ["fetch_context", "request_draft"],
    });
    expect(calls).toHaveLength(3);
    expect(material.size).toBe(0);
  });
  it("caps retries while keeping handoff/event/idempotency references stable", async () => {
    mode.callbackStatus = 429;
    for (let i = 0; i < 3; i++) await invoke();
    expect(await result(await invoke())).toMatchObject({
      state: "failed",
      code: "ATTEMPT_LIMIT",
    });
    expect(calls).toHaveLength(9);
    expect(drafts.size).toBe(1);
    expect(
      new Set(calls.filter((c) => c.path.endsWith("events")).map((c) => c.key))
        .size,
    ).toBe(1);
  });
  it("times out boundedly and makes no later tool calls", async () => {
    config.timeoutMs = 100;
    mode.delay = 300;
    const start = performance.now();
    expect(await result(await invoke())).toMatchObject({
      state: "retryable",
      code: "TOOL_TIMEOUT",
      completedTools: [],
    });
    expect(performance.now() - start).toBeLessThan(2000);
    expect(calls).toHaveLength(1);
  });
  it("keeps health available with missing machine credentials and performs no egress", async () => {
    await close(server);
    server = createAgentServer({ ...config, machineToken: undefined });
    base = `http://127.0.0.1:${await listen(server)}`;
    expect((await fetch(`${base}/health`)).status).toBe(200);
    expect((await invoke()).status).toBe(503);
    expect(calls).toHaveLength(0);
  });
  it("rejects forged callback acknowledgements and oversized responses", async () => {
    mode.ackPatch = { handoffId: randomUUID() };
    expect(await result(await invoke())).toMatchObject({
      state: "failed",
      code: "REFERENCE_MISMATCH",
      diagnosticRecorded: false,
    });
    mode.ackPatch = undefined;
    mode.oversize = true;
    const other = {
      ...envelope,
      handoffId: randomUUID(),
      eventId: randomUUID(),
    };
    expect(await result(await invoke(other))).toMatchObject({
      state: "failed",
      code: "UPSTREAM_INVALID",
    });
  });
  it("strictly parses origin, hostname, credentials and injected port", () => {
    for (const patch of [
      { PORT: "0" },
      { PORT: undefined },
      { JEEVIKA_API_ORIGIN: "http://api.jeevika.test" },
      { JEEVIKA_API_ORIGIN: "https://user:password@api.jeevika.test" },
      { JEEVIKA_API_ORIGIN: "https://api.jeevika.test/?token=x" },
      { JEEVIKA_API_ORIGIN: "https://169.254.169.254" },
      { JEEVIKA_ALLOWED_HOSTNAME: "*.jeevika.test" },
      { JEEVIKA_MACHINE_TOKEN: "newline\nsecret" },
    ]) {
      expect(() =>
        loadAgentConfig({
          PORT: "18789",
          JEEVIKA_API_ORIGIN: "https://api.jeevika.test",
          JEEVIKA_ALLOWED_HOSTNAME: "api.jeevika.test",
          ...patch,
        }),
      ).toThrow();
    }
  });
  it("bounds inbound bodies and request rate without affecting health", async () => {
    expect(
      (await fetch(`${base}/chat`, { method: "POST", body: "x".repeat(9000) }))
        .status,
    ).toBe(413);
    for (let i = 0; i < 60; i++)
      await fetch(`${base}/chat`, { method: "POST", body: "{}" });
    expect((await invoke()).status).toBe(429);
    expect((await fetch(`${base}/health`)).status).toBe(200);
    expect(calls).toHaveLength(0);
  });
  it("starts the bundled process on the actual injected PORT", async () => {
    const probe = httpServer();
    const port = await listen(probe);
    await close(probe);
    const child: ChildProcess = spawn(
      process.execPath,
      [join(fixture, "server.mjs")],
      {
        env: {
          PATH: process.env.PATH,
          PORT: String(port),
          JEEVIKA_AGENT_DATA_DIR: join(fixture, randomUUID()),
        },
        stdio: "ignore",
      },
    );
    try {
      let ready = false;
      for (let i = 0; i < 40; i++) {
        try {
          ready =
            (await fetch(`http://127.0.0.1:${port}/health`)).status === 200;
          if (ready) break;
        } catch {}
        await new Promise((done) => setTimeout(done, 25));
      }
      expect(ready).toBe(true);
      expect(
        (
          await fetch(`http://127.0.0.1:${port}/chat`, {
            method: "POST",
            body: JSON.stringify({
              message: JSON.stringify(envelope),
              source: "new_source",
            }),
          })
        ).status,
      ).toBe(503);
    } finally {
      if (child.exitCode === null && child.signalCode === null) {
        const exited = new Promise<void>((done) =>
          child.once("exit", () => done()),
        );
        child.kill("SIGTERM");
        await exited;
      }
    }
  });
  it("stages only the explicit secret-scanned Docker context", () => {
    const directory = join(fixture, `context-${randomUUID()}`);
    const script =
      'import { stageContainerContext } from "./services/maritime-agent/build-container.mjs"; console.log(JSON.stringify(stageContainerContext(process.argv[1])));';
    const scan = JSON.parse(
      execFileSync(
        process.execPath,
        ["--input-type=module", "-e", script, directory],
        { encoding: "utf8" },
      ),
    ) as { files: number; bytes: number };
    expect(scan.files).toBe(9);
    expect(scan.bytes).toBeLessThan(100000);
    const files: string[] = [];
    const visit = (path: string) => {
      for (const entry of readdirSync(path, { withFileTypes: true })) {
        if (entry.isDirectory()) visit(join(path, entry.name));
        else files.push(entry.name);
      }
    };
    visit(directory);
    expect(files).not.toContain(".env");
    expect(files).not.toContain("key.pem");
    expect(files).not.toContain("cert.pem");
  });
});
