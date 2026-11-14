# JEEVIKA administrative coordination agent

Status: **CODE_IMPLEMENTED / LOCAL_TESTED**. Not **DEPLOYED_LIVE**. C4's machine
routes and authorization grant are not implemented by C3. C2R intentionally
grants no external dispatch permission; do not bypass that gate to run this agent.
No Maritime instance, registry publication, paid request, or live Prune call is
created by the build/test commands below.

## Build and local run

Run from the repository root with its lockfile-installed dependencies:

```sh
npm ci --ignore-scripts
npm run maritime:typecheck
npm run maritime:build
PORT=18789 node services/maritime-agent/dist/server.mjs
curl --fail http://127.0.0.1:18789/health
```

The service has its own pinned manifest/lockfile for container builds. It bundles
Zod; no runtime npm install is needed in the final image. No LLM framework, model
key, D1 client, SMS client, or WhatsApp client is installed.

With Docker and its Buildx plugin, build one local image through the
secret-scanned, nine-file staging context:

```sh
npm run maritime:container:build
docker run --rm --platform linux/amd64 -e PORT=18789 \
  -p 127.0.0.1:18789:18789 jeevika-maritime-agent:local
```

The Docker base is pinned by version and multi-architecture digest. The build
defaults to linux/amd64; an account that requires ARM64 can build explicitly:

```sh
npm run maritime:container:build -- jeevika-maritime-agent:local linux/arm64
```

The runtime uses UID/GID 1000 and a writable `/data/jeevika` directory. A mounted
platform volume must allow that user to write there. The image checks its CA
bundle at build time. Its exec-form CMD starts Node directly. The application
requires the injected PORT and binds 0.0.0.0. The local PORT example above is not
a setting to override on Maritime. Dockerfile-specific ignore rules are also
provided, but the staging script is authoritative even with a legacy builder.
Never pass the entire checkout as a build context: the staging script copies
only known regular files and rejects symlinks, oversized contexts and key markers.

## Configuration

Configure values privately; this file intentionally lists names without secrets:

| Name | Meaning |
| --- | --- |
| `PORT` | Required platform-injected listening port. |
| `JEEVIKA_API_ORIGIN` | HTTPS origin only, no path/query/userinfo/fragment. |
| `JEEVIKA_ALLOWED_HOSTNAME` | Exact bare hostname matching the origin; no wildcard/IP. |
| `JEEVIKA_MACHINE_TOKEN` | Dedicated C4 machine credential, 32–512 URL-safe characters. |
| `JEEVIKA_AGENT_DATA_DIR` | Absolute private journal directory; defaults to `/data/jeevika`. |
| `JEEVIKA_TOOL_TIMEOUT_MS` | Per-tool deadline, 100–5000 ms; default 3000. |

Missing upstream credentials disable `/chat` with 503 NOT_CONFIGURED while health
remains available. Invalid supplied configuration fails startup with a fixed,
value-free diagnostic. No request/message/source/tool body or credential is logged.
Default DNS resolution rejects private/link-local/loopback addresses. Only local
tests inject a custom CA and DNS lookup in code; no environment setting disables
TLS validation or enables a local/HTTP production origin.

## Maritime HTTP interface

GET `/health` returns 200 `{"ok":true}` with no tool calls or journal writes.
POST `/chat` accepts JSON with `message` and a **string** `source`. Unknown source
strings and extra delivery metadata are accepted and ignored. Source is not an
authorization signal. The message must encode exactly this application envelope:

```json
{
  "schemaVersion": 1,
  "triggerId": "11111111-1111-4111-8111-111111111111",
  "handoffId": "22222222-2222-4222-8222-222222222222",
  "taskRef": "33333333-3333-4333-8333-333333333333",
  "eventId": "44444444-4444-4444-8444-444444444444",
  "action": "propose_administrative_followup"
}
```

These references must be allocated/registered by C4; a UUID is not authorization.
No tenant, patient identifier, name, phone, measurement, note, URL, tool name,
prompt, or arbitrary free text is accepted inside the envelope. Invalid chat JSON
gets 400; invalid commands get 422; conflicting replay gets 409; capacity gets
429/503. The response has Maritime's `response` string, containing a bounded
JSON result with the original handoff/event IDs, state, completed tools, fixed
error code, diagnostic delivery flag and reported draft provenance.

Example successful **local test** trace:

```text
validate_envelope
fetch_context       -> scoped non-urgent permission + short-lived lease
request_draft       -> opaque draftRef; local-template / PRESENT_UNVERIFIED
propose_review      -> accepted_for_review ACK for the same draftRef
result              -> proposed_for_nurse_review
```

This is an administrative proposal, not a completed clinical handoff or sent
patient message. Tool failures become retryable/failed results; failure to receive
a valid callback ACK never becomes success. Actual Prune usage remains a JEEVIKA
server responsibility; the agent retains reported provider/receipt status without
inventing independent verification or savings.

## Versioned C4 machine protocol

Canonical schemas live in `packages/shared/maritime-coordination.ts` and are
re-exported by `packages/shared/contracts.ts`. Legacy C1 webhook/callback schemas
remain unchanged; C4 must explicitly use these coordination schemas.

Every request uses POST, JSON, a Bearer machine credential in a header and a stable
Idempotency-Key. HTTPS origin and paths are fixed by the client, redirects are
refused, and responses are capped at 16 KiB. No tenant or token is put in a query.
C4 derives the tenant from the credential and checks every reference against that
tenant's registered handoff and current review evidence at **each** endpoint.

| Tool path | Request | Required reply |
| --- | --- | --- |
| `/api/v1/machine/maritime/context` | Envelope; key `<eventId>:context` | Envelope + leaseId/expiresAt/language; coordinationPermitted and staffReviewApproved true; urgent false. |
| `/api/v1/machine/maritime/draft` | Envelope + leaseId + workflow=careops_followup + language; key `<eventId>:draft` | Envelope + leaseId + draftRef + provider + receiptStatus + requiresClinicianReview=true. No text. |
| `/api/v1/machine/maritime/events` | Draft reply + state=proposed_for_nurse_review; key `<eventId>:proposal` | Envelope + leaseId + draftRef + state=accepted_for_review. |
| Same events path, diagnostics | Envelope + leaseId + retryable/failed state + fixed failedTool/code; stable diagnostic key | Envelope + leaseId + state=diagnostic_recorded. |

Leases must expire within five minutes. All returned references must match the
command, lease and proposed draft. Urgent, unapproved, expired, foreign-tenant or
forged contexts are refused before a draft call. C4's draft endpoint must wrap
its authenticated server-side Prune tool and store the generic draft internally;
the current staff-session `/api/v1/ai/draft` is not directly callable with this
machine credential. Only a draft reference and closed provenance enums leave
Cloudflare. Review notes and draft text never enter the Maritime container.

C4 must enforce idempotency by tenant/handoff/event and reject changed replay
payloads, including after agent restarts. Context/draft/proposal retries keep the
same IDs and keys. A diagnostic must not overwrite a previously accepted proposal.
If an ACK is lost, an action might already have been recorded: consult C4's
authoritative event record. Never treat a retryable/failed HTTP result as proof of
rollback. Agent restart caches are an optimization, not the effect ledger.

The local journal is atomically replaced, mode 0600, scoped by credential/origin,
bounded to 128 opaque records and 256 KiB. Identical in-flight handoffs coalesce;
terminal results replay without new tools. At most three attempts per handoff,
four tool calls per attempt, eight active requests and 60 chat requests/minute
are allowed. HTTP body reading has a five-second limit and coordination a
22-second response budget. No scheduler, autonomous patient contact or background
retry loop is installed. Full journals fail closed and require operator review;
do not delete an unresolved record to bypass C4's authoritative retry policy.

## Deployment procedure — documentation verified, NOT executed

Sources checked on 2026-11-15:
[custom container contract](https://maritime.sh/docs/frameworks/custom),
[REST API](https://maritime.sh/docs/api),
[OpenAPI](https://api.maritime.sh/openapi.json),
[CLI](https://maritime.sh/docs/cli), and
[triggers](https://maritime.sh/docs/triggers).

After separate explicit approval and C4 implementation:

1. Build/test the required target architecture, publish this image to an approved
   public registry and record its digest. The monorepo has no root Dockerfile;
   use a prebuilt image rather than an assumed subdirectory GitHub build option.
2. Configure one custom agent in the approved account. The current OpenAPI
   AgentCreate schema requires name and supports framework/custom, imageName,
   initialEnvVars and useMaritimeLlm. A reviewed POST `/api/agents` body can be:

   ```json
   {"name":"jeevika-coordination","framework":"custom","imageName":"<approved-registry/image@sha256:digest>","useMaritimeLlm":false}
   ```

   The narrative REST page recommends a template for ordinary template agents;
   the custom-container guide and structured schema allow this custom image path.
   Provisioning begins immediately, so do not run this as a verification shortcut.
3. Set the six environment names above through the account's secure configuration
   (PORT is supplied by Maritime). Keep the machine token separate from Maritime's
   invoke token. Ensure UID 1000 can write the configured persistent directory.
   A source-verified redeploy command for an approved existing agent is
   `maritime deploy jeevika-coordination --source docker --image <approved-image> --wait`.
4. Have C4 invoke POST `https://api.maritime.sh/api/webhooks/{agent_id}` with
   X-Maritime-Webhook-Token in a header and the registered opaque envelope. Never
   use the documented query-token alternative. A 2xx means asynchronous
   **acceptance**, not completion. Do not assume JEEVIKA HMAC verification at this
   vendor endpoint. C4 validates the separate machine credential on returned tools.
5. Capture account deployment status, image digest, UTC time, opaque handoff/event
   IDs and C4's authenticated proposal record. Keep tokens and private payloads
   out of screenshots/logs. Only that real exchange can support DEPLOYED_LIVE or
   LIVE_VERIFIED; neither is asserted by this task.

No LLM runs in this process. Use one account-approved small instance with idle
sleep and conservative backend request budgets; pricing/caps must be checked in
the actual account. Local tests/builds do not establish vendor billing or uptime.

## Verification and boundaries

`npx vitest run tests/maritime_agent.test.ts` runs actual HTTP against the agent
and actual HTTPS against an ephemeral CA-trusted fake C4 server. It covers health,
input/source handling, the three tools, replay/restart, references/tenant denial,
forged output, redirects/SSRF, callback 401/429/500, timeout, credentials, caps,
injected PORT, and the staged Docker context. Fixtures and test certificates are
generated outside the checkout and deleted. Tests do not disable TLS globally.

Full baseline tests, typecheck, builds and Worker smoke are also run. The C2R
baseline full-lint exceptions remain in protected engine/older tests and must be
reported separately from changed-file lint. No linter rules are disabled here.
An initial legacy-builder trial emitted a deprecation warning and failed the
cross-architecture build; the final script requires Buildx and passed. The staged
context works independently of Dockerfile-ignore support. Test counts, local
container curl results, cleanup and final remote SHA are in `VERIFICATION.md` and
the execution response. Nothing in C3 changes backend routes, D1 migrations,
algorithms, pharmacy, intake, frontend or C2R's authorization policy.
