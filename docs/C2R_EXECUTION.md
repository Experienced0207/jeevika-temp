# C2R remediation and downstream contract

Branch: `feat/c2r-remediation`. Verified parent and fetched remote C2 anchor:
`1d60766f2839c199193a17ace8a40dbec639ea61`.
Origin fetch and push: `https://github.com/Experienced0207/jeevika-temp.git`.
No default-branch changes, PR, deployment, chargeable vendor request, or live
Prune/Maritime workflow was performed.

## Nurse API and C3/C4 semantics

`POST /api/v1/home/nurse/tasks/:id/status` requires an unexpired stored session
in development/test and a current NURSE or DOCTOR role in the task's organization.
The task ID is a UUID. A body must have an `action` of `approve`, `reject`, or
`complete`; optional `note` is trimmed and bounded to 500 characters. Notes
remain internal. Organization and actor are taken from the authenticated session.

Sanitized example, using an existing synthetic task UUID:

```http
POST /api/v1/home/nurse/tasks/11111111-1111-4111-8111-111111111111/status
Content-Type: application/json
Authorization: Bearer <staff-session>

{"action":"approve","note":"Synthetic administrative review"}
```

Representative response (generated UUIDs/timestamps vary):

```json
{
  "review": {
    "id": "22222222-2222-4222-8222-222222222222",
    "taskId": "11111111-1111-4111-8111-111111111111",
    "action": "approve",
    "actorId": "nurse",
    "fromStatus": "open",
    "toStatus": "in_progress",
    "reviewedAt": "2026-11-15T00:00:00.000Z"
  },
  "authorization": {
    "staffReviewApproved": true,
    "clinicianReviewRequired": false,
    "administrativeDraftPermitted": false,
    "agentDispatchPermitted": false,
    "patientMessagingPermitted": false,
    "medicationChangePermitted": false
  }
}
```

Approval is an administrative state change only; it does not enqueue a draft or
call a sponsor. Rejection maps open/in_progress to cancelled. Completion maps
in_progress to completed only with recorded approval evidence. Both cancellation
and completion cancel still-pending CareOps triggers. Urgent tasks can be
acknowledged/reviewed by staff, but `staffReviewApproved` stays false,
`clinicianReviewRequired` stays true, and all dispatch/action permissions stay
false, including after completion. Completion does not certify clinical resolution.

`careops_task_reviews` is append-only evidence, separate from `careops_events`.
Each row records actor, action, internal note, observed prior status, resulting
status, and timestamp. A unique (org_id,task_id,action) prevents duplicate review
evidence. Same actor/action/normalized-note replays return the same review;
changed input or actor returns 409. The review snapshot is immutable; the
authorization portion is recomputed from current state and can change after a
later action. Concurrent stale transitions cannot overwrite the winning status.
Evidence, status update, and pending-trigger cancellation use one atomic batch.
Any legacy pending trigger on an urgent task is cancelled even on approval.

C3 may render the existing queue and submit this action contract. C4 must call
`careopsReviewRepo(...).authorization(taskId)` in authenticated server context
and check current evidence again inside any future effect transaction. Neither
an old HTTP response nor `status=in_progress` authorizes external dispatch.
C2R grants no agent, patient-message, or medication-change permission. A separate
reviewed milestone must define such permissions. Do not export review notes.

## Migration safety

Both runners now use the exported explicit `integrationMigrationFiles` whitelist
from `scripts/prepare-integration-migrations.ts`. It includes clinical 0001,
pharmacy 0002, HER 0002, Vitalis 0003, **0005 token sequences**, CBC 0006, 0007,
0008, and new **0009_careops_reviews.sql**, in that order. Operational initial
schema/identity/patient-auth families remain excluded. Preparation rejects stray
SQL files rather than silently mixing schema families.

0007 and 0008 are unchanged. 0009 adds review evidence and promotes the eight
compatibility columns previously added only by the local adapter (encounters:
tier/token_number; patients: phone_hash/dob/sex/preferred_lang/abha_number/
abha_address). The local runner executes transactionally and rolls back on any
SQL failure. Missing files are fatal. Only those exact 0009 ALTER statements may
be skipped after introspection confirms the legacy column's type, nullability,
and default; incompatible definitions fail. There is no catch-and-ignore SQL path.

Fresh prepared and local schemas are compared including tables, indexes and
triggers. Legacy C2 upgrades preserve data. Invalid SQL is tested for rollback.
Canonical SQL and concurrent review writes are also exercised on local workerd/D1.
If a D1 installation was manually given some compatibility columns outside its
migration ledger, stop for a reviewed bridge before applying 0009 with Wrangler;
the plain D1 migration intentionally does not mask duplicate-column errors.

## Prune proof and privacy boundary

Capability: **OFFLINE_MATH_ONLY**, not COMPATIBLE_WITH_VERIFIED_VENDOR_FIXTURE.
The local mathematical JSON/hash helpers are retained for compatibility and
explicitly marked as non-vendor evidence. Ephemeral-key tests demonstrate local
Ed25519 math only. No current provider receipt is promoted to VERIFIED_ED25519
or VERIFIED_API; those public statuses are reserved for a future proven path.
Present metadata stays PRESENT_UNVERIFIED, null/missing metadata stays MISSING,
and blocked/disabled states retain their existing distinct meanings. Existing
C2 audit rows/labels are not evidence of a live vendor verification either.

Sources inspected:

- https://www.withprune.com/docs/receipts
- https://www.withprune.com/verify
- https://www.withprune.com/docs/hackathon
- https://www.withprune.com/docs/errors
- https://api.withprune.com/openapi.json

The official OpenAPI publishes POST `/v1/receipts/verify` with a body containing
`receipt: object`. This alone does not specify all signed fields, defaults, and
request canonicalization. The documentation references SIGNED_FIELDS + DEFAULTS
and SDK >=0.3.3; the public package index inspected exposes 0.3.1, and the linked
repository's `docs/RECEIPT_SPEC.md` was unavailable. No verified vendor fixture
was available. The former guessed canonicalization is therefore removed from the
active verification path, and verifier transport is not called while this gap
remains. A mocked `valid:true` cannot establish compatibility or live proof.

Ingress metadata tolerates routing-model changes, optional/null signed fields,
and unknown extensions. That ingress schema is NOT an egress or storage schema.
The receipt egress allowlist remains strict and is not widened. Audit receipt_json
contains only fixed keys, boolean presence/cache indicators, and the static
capability label; unknown fields, model labels, signatures and arbitrary free
text are never retained. Unverified receipts cause a deterministic local draft.
Existing server-owned outbound templates and X-Prune-Cache: off remain enforced.
`redact` and `sourceSummary` remain unchanged.

`prune_receipts` / `careopsPrunePolicyReceiptSchema` mean an internal CareOps
trigger policy decision. `prune_audit_receipts` means the sanitized provider-call
audit. They are not interchangeable cryptographic proof stores.

## Verification record

- `npm test`: 18 files and 253 tests passed.
  Includes C1/C2 regressions, safety/tenant/auth, fresh/upgrade/invalid migrations,
  idempotency, compare-and-set races, rollback, and urgent-task action restrictions.
- `npm run typecheck`: passing (root/backend/CBC).
- Changed TypeScript files: Biome check through stdin with the repository rules;
  no lint suppressions and no protected engine edits.
- `npm run lint`: **fails inherited gate**, 6 errors, 123 warnings, 32 infos.
  Untouched C2 anchor independently reproduces 7 errors, 123 warnings, 32 infos.
  The associated CareOps test import-order error was corrected; remaining errors
  are in protected engine formatting and older ambient/safety tests. No unrelated
  formatting fixes or configuration exclusions were introduced.
- `npm run build`: passed. Existing dependency installation reported 56 audit
  findings (4 low,24 moderate,26 high,2 critical), deprecated packages, and bundler
  module-level `use client` warnings. Lockfiles and dependency versions unchanged.
- `npm run integration:build`: initial attempt overlapped the root build's
  dependency reinstall and failed module resolution; sequential rerun passed
  with module-level directive warnings.
- `npm run integration:worker:build`: passed **dry run only**; no deployment.
- `npm run integration:worker:smoke`: passed local workerd/D1 login, intake,
  concurrent replay, rollback, review and revocation.

Full local outputs: `/tmp/jeevika-c2r-{tests,build,integration-build-retry,
worker-build,smoke,lint-final,anchor-lint}.log`.

Evidence: IMPLEMENTED_CODE and MOCK_TESTED/offline local-runtime checks.
LIVE_VERIFIED: none. BLOCKED: vendor compatibility fixture/spec; inherited full
lint gate has an explicit user-approved exception for this task: "Allow push with
the documented baseline lint exception". Branch commit and remote SHA/push outcome
are reported in the execution response. Vendor compatibility remains BLOCKED.

Scope notes: the small review repository, forward migration, associated tests,
and this downstream contract record are directly required by C2R. The one-line
egress schema selection preserves its original strict boundary while allowing
tolerant ingress. No engine, Ops, Intake, frontend, old migration, CI, dependency,
or Worker entrypoint source was changed.

Changed files:

- `scripts/prepare-integration-migrations.ts`
- `backend/local/migrate.ts`
- `backend/migrations/0009_careops_reviews.sql`
- `backend/src/db/careopsReviewRepo.ts`
- `backend/src/modules/home/routes.ts`
- `packages/shared/contracts.ts`
- `packages/ai/egressSafetyGate.ts`
- `packages/ai/pruneGuardian.ts`
- `tests/careops_persistence.test.ts`
- `tests/prune_guardian.test.ts`
- `tests/migration_safety.test.ts`
- `tests/careops_review.test.ts`
- `docs/C2R_EXECUTION.md`
