# C4 implementation and verification record

Branch: `feat/c4-handoff-orchestration`.
Verified remote parent: `origin/feat/c3-maritime-agent`,
`9de70ff915090ccad88957a94396526e573427b5`.
Origin fetch and push: `https://github.com/Experienced0207/jeevika-temp.git`.
Before edits: clean working tree, absent target branch, matching remote parent,
explicit fetch and successful `git merge-base --is-ancestor` verification.
No PR, deployment, credential provisioning, paid calls or live vendor workflow.
Commit and final remote SHA are reported in the task completion message.

## Implemented behavior

See [frozen workflow and C5 contracts](C4_WORKFLOW.md). Shared strict Zod input,
read-output and C3 schemas are the API contract. No raw measurements, patient
identifiers, names or free notes enter vendor payloads. Machine credentials are
separate from staff sessions and Maritime invocation tokens. Tenant scope comes
from the matching stored credential/session, never a callback body org field.

0010 adds durable workflow/lease state, hash-only machine credentials, nonce
bindings, append-only events/reviews/thread entries and generic drafts. It does
not alter old CHECK enums or repoint policy receipt FKs. The shared canonical
array in prepare-integration-migrations.ts is also imported by
backend/local/migrate.ts, so adding 0010 registers both runners without duplicating
or changing the local runner. Fresh, C2 legacy and C3 data-preserving upgrades,
repeat local startup and actual D1 SQL were exercised.

Staff coordination approval precedes dispatch. Draft proposal enters
PENDING_REVIEW; a separate nurse/doctor decision selects an administrative
language template, approves or rejects. Human edits have immutable snapshots;
Prune status applies to the initial draft only. Approval is APPROVED_TO_SEND with
SIMULATED communication. Only a separate authenticated C2R action completes the
task. No messaging provider, diagnosis, prescribing, medication modification or
autonomous emergency decision was added. Urgent raw observations invalidate
future coordination, leases, reviews and pending dispatch atomically.

## Exact gates and results

Final root run:

```text
npm test
Test Files  20 passed (20)
Tests       300 passed (300)
```

This includes existing engine, safety, tenant, integration, language, auth,
persistence, nurse review, Prune and C3 tests; 17 new workflow tests; one new C3
migration upgrade test; and one new Prune redirect regression. No skipped tests.

```text
npm test --prefix frontend/website
Test Suites: 4 passed, 4 total
Tests:       12 passed, 12 total
npm run typecheck
PASS root/backend/CBC/C3 TypeScript checks
npm run build
PASS lockfile-respecting frontend npm ci, TypeScript, Vite and API esbuild
npm run integration:build
PASS TypeScript and integration Vite build
npm run integration:worker:build
PASS Wrangler --dry-run; no deployment
npm run integration:worker:smoke
PASS real local workerd/D1 login, atomic intake, concurrent replay,
batch rollback, review and revocation
node --import tsx scripts/careops-worker-smoke.ts
PASS LOCAL_TESTED: compiled Worker/D1 nonurgent drift -> opaque intercepted
webhook -> machine tools -> intercepted cache-off Prune/unverified fallback ->
replayed callback -> PENDING_REVIEW -> human simulated approval/completion;
urgent no dispatch; no live vendors
```

The root build's existing dependency audit reports **56 vulnerabilities: 4 low,
24 moderate, 26 high, 2 critical**. npm warns about deprecated inflight, glob,
source-map beta and node-domexception packages. Both Vite builds emit the native
config warning, chunk-size warning and 80 MODULE_LEVEL_DIRECTIVE warnings
(including dependencies' `use client`). These were not suppressed or repaired in
this backend scope. Frontend Jest emits existing dotenv informational messages.

```text
npm run lint
FAIL (exit 1): 6 errors, 123 warnings, 32 infos
```

This is the inherited, explicitly user-approved baseline lint exception; protected
engine/old test formatting was not changed. No claim that whole-repo lint passes.
For the scoped check, a temporary external Biome configuration enabled recommended
rules and existing two-space/double-quote formatting for backend/service files
that the repository's root includes omit:

```sh
npx biome check --config-path=/tmp/c4-biome \
 backend/src/careops backend/src/modules/careops backend/src/context.ts \
 backend/src/db/careopsReviewRepo.ts backend/src/modules/home/routes.ts \
 services/maritime-agent/src/transport.ts packages/shared/careops-workflow.ts \
 packages/shared/contracts.ts packages/ai/pruneGuardian.ts \
 scripts/prepare-integration-migrations.ts scripts/careops-worker-smoke.ts \
 tests/careops_workflow.test.ts tests/migration_safety.test.ts tests/prune_guardian.test.ts
```

Result: **19 files checked, no fixes or diagnostics**. Existing index.ts was kept
narrow: separate `biome lint --config-path=/tmp/c4-biome backend/src/index.ts`
reports 6 warnings/2 infos, matching the unchanged C3 parent file checked with the
same rules. Whole-index inherited formatting was preserved. `git diff --check`
passes. Temporary lint configuration/parent copy are removed after verification.
No container runtime or other temporary tooling was downloaded for C4.

## Local trace and boundaries exercised

- Exactly one task/policy decision/outbox/draft in the nonurgent trace. C3
  context/draft/proposal over actual local HTTP reaches pending review; a new C3
  process replays its durable journal without repeating tools.
- Concurrent dispatchers (including real D1) claim one logical request. Disk-backed
  database close/reopen preserves claims and retries the same opaque envelope.
  429 Retry-After, 500, auth failures, 5-attempt limit and long delays are checked.
- Separate machine auth, stale timestamp, nonce conflict, revoked credential,
  browser Origin, tenant mismatch, changed references, forged receipt provenance,
  wrong staff roles and expired leases fail closed.
- Draft/proposal replay, competing human decisions, idempotency conflict and SQL
  audit failure rollback are tested. Urgent input blocks subsequent dispatch,
  tools/proposals and human draft approval.
- External request captures validate exact opaque Maritime envelopes and Prune's
  positive template allowlist/cache-off header. Disabled Prune never fetches;
  provider metadata remains PRESENT_UNVERIFIED and uses a deterministic fallback.
  Crash uncertainty avoids a second Prune call. Redirects are not followed.
- Production defaults are closed; explicit demo flag, tenant allowlist and stored
  role auth are required. No synthetic workflow is enabled by deployment config.

Initial local failures were corrected, not counted as passing evidence: repeat
migration startup needed IF NOT EXISTS; the HTTP test needed typed server cleanup;
actual workerd exposed unsupported redirect="error". The reused Guardian's one
line was changed to redirect="manual", retaining non-2xx rejection, with a
regression test. New smoke script and existing migration/Guardian tests are the
smallest directly required verification scope additions. C3's only change adds
independent timestamp/nonce headers; payload schemas remain unchanged.

Evidence: **IMPLEMENTED_CODE**, **MOCK_TESTED**, **LOCAL_TESTED** (actual local
HTTP + compiled Worker/workerd/D1). **LIVE_VERIFIED: none**. Real Maritime
execution, receipt verification fixtures, deployment and patient messaging remain
unverified/unprovisioned. No clinical, certified or production readiness claim.

## Changed files

- backend/migrations/0010_careops_workflow.sql
- backend/src/careops/config.ts
- backend/src/careops/dispatch.ts
- backend/src/careops/machineAuth.ts
- backend/src/careops/repo.ts
- backend/src/careops/review.ts
- backend/src/careops/tools.ts
- backend/src/context.ts
- backend/src/db/careopsReviewRepo.ts
- backend/src/index.ts
- backend/src/modules/careops/routes.ts
- backend/src/modules/home/routes.ts
- packages/ai/pruneGuardian.ts
- packages/shared/careops-workflow.ts
- packages/shared/contracts.ts
- scripts/careops-worker-smoke.ts
- scripts/prepare-integration-migrations.ts
- services/maritime-agent/src/transport.ts
- tests/careops_workflow.test.ts
- tests/migration_safety.test.ts
- tests/prune_guardian.test.ts
- docs/C4_WORKFLOW.md
- docs/C4_VERIFICATION.md

Engine, intake, Ops/pharmacy/paise accounting and frontend source are unchanged.
