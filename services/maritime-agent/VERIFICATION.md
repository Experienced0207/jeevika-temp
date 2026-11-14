# C3 execution record

Target: `feat/c3-maritime-agent`. Verified fetched parent:
`363cbc41d7cb924fd77c549a8a94fcf944383caf` (`origin/feat/c2r-remediation`).
Origin fetch/push were checked against
`https://github.com/Experienced0207/jeevika-temp.git` before any edits. The target
did not exist. No default branch, existing feature commit or migration was
rewritten. Commit/remote SHA and direct-push outcome are in the execution reply.

## Evidence classification

- **CODE_IMPLEMENTED / IMPLEMENTED_CODE**: one Node/TypeScript custom-container
  agent, explicit versioned C4 interfaces, bounded deterministic coordinator,
  HTTPS machine client, idempotent journal, manifest/lockfile, Dockerfile and
  allowlisted container build script.
- **LOCAL_TESTED / MOCK_TESTED**: actual local agent HTTP and fake C4 HTTPS
  network traffic, compiled-process PORT test, actual Docker image build and curl
  contract checks, full baseline tests and local workerd/D1 smoke.
- **DEPLOYED_LIVE / LIVE_VERIFIED**: **none**. No Maritime provisioning, registry
  push, live invoke, live receipt verification, chargeable Prune call or deployment.
  Public documentation/OpenAPI/image metadata and ordinary build dependencies
  were fetched; those reads are not live workflow verification.
- **BLOCKED downstream**: C4's machine endpoints, scoped credentials and reviewed
  authorization grant do not exist yet. Existing C2R grants remain false. This
  task defines their contract without adding backend routes or bypassing policy.

No A0 audit artifact was found in the repository's docs search. The supplied A0
facts, verified C2R parent, current source, and `docs/C2R_EXECUTION.md` were used.

## Commands and results

| Command/check | Result |
| --- | --- |
| `npx vitest run tests/maritime_agent.test.ts` | 28 service cases included in final full run. Real HTTP/HTTPS; no live vendor mocks counted as live. |
| `npm test` | **19 files, 281 tests passed**. Includes C1/C2/C2R safety, tenant, auth, migration and review regressions. |
| `npm run typecheck` | Passed root/backend/CBC and new service typecheck. |
| Changed TypeScript/MJS Biome checks | Passed using repository rules through `--stdin-file-path=packages/format.ts`; no suppressions. |
| `npm run lint` | **Exit 1**, unchanged inherited **6 errors, 123 warnings, 32 infos**. Same protected-engine and older-test findings documented and excepted in C2R; no new failures introduced. |
| `npm run build` | Passed. Existing install reported 56 audit findings (4 low,24 moderate,26 high,2 critical), package deprecation notices, module-level directive warnings and an npm upgrade notice; versions/lockfile were not upgraded. |
| `npm run integration:build` | Passed; existing module-level directive warnings. |
| `npm run maritime:build` | Passed, self-contained ESM bundle. Generated test bundle was removed after checks. |
| `npm run maritime:container:build` | Final Buildx linux/amd64 build passed with a pinned Node image digest and lockfile. Nine-file context secret scan passed. |
| `npm run integration:worker:build` | Passed, **dry run only**. |
| `npm run integration:worker:smoke` | Passed real local workerd/D1 login, intake, concurrent replay, rollback, review and revocation. |

The first local-builder trial exposed legacy Docker's handling of a
Dockerfile-specific ignore file; the build was replaced with explicit context
staging. A subsequent legacy amd64 attempt failed platform selection. Buildx was
installed temporarily and the final amd64 build/run succeeded. An initial bundled
process test caught macOS `/var` symlink main-module detection; realpath-based
entry detection fixed it. These failed trials are not reported as passing checks.

## Container observations

Final local image ID:
`sha256:6873ac6a03e16de2a062ab7afebc110f66b4ce282325c697b2d8a2b671300e31`.

- Actual architecture: x86_64 (linux/amd64, tested through the temporary runtime).
- Actual UID: 1000; `/data/jeevika` writable.
- Injected PORT: 19087, bound through the image's ordinary exec-form Node CMD.
- Actual curl GET `/health`: 200 `{"ok":true}`.
- Actual curl POST `/chat` with an invalid command: 422 INVALID_INPUT.
- Actual curl POST `/chat` with a valid envelope but missing credentials:
  503 NOT_CONFIGURED, with no egress. This does not claim a live C4 integration.
- The complete context → draft → proposal trace is tested separately over actual
  local HTTP/CA-verified HTTPS against the fake C4 server, including fallback
  provenance `local-template` / `PRESENT_UNVERIFIED`.

Detailed local outputs are `/tmp/jeevika-c3-tests-final.log`,
`/tmp/jeevika-c3-typecheck-final.log`, `/tmp/jeevika-c3-root-build.log`,
`/tmp/jeevika-c3-integration-build.log`, `/tmp/jeevika-c3-worker-build.log`,
`/tmp/jeevika-c3-worker-smoke.log`, `/tmp/jeevika-c3-lint.log`,
`/tmp/jeevika-c3-container-verified-build.log`,
`/tmp/jeevika-c3-container-checks.json`, and `/tmp/jeevika-c3-cleanup.json`.

## Cleanup requested by the user

Before commit/push, the task's container and anonymous volume were removed, the
`jeevika-c3` Colima VM/runtime data (including images/build caches) were deleted,
and only newly installed formulas docker-buildx/docker/colima/lima were
uninstalled. Pre-existing formulas were compared with the pre-install snapshot
and preserved. The newly created Colima home, scoped npm/Homebrew/OS-image caches
and generated service bundle were removed. The container port was confirmed
closed. Test TLS certificates and fake-server fixtures were deleted by the tests.
Docker remains a documented build prerequisite, not an installed leftover.

## Changed paths and C4 handoff

- `services/maritime-agent/src/{config,transport,journal,coordinator,server}.ts`
- `services/maritime-agent/{package.json,package-lock.json,tsconfig.json}`
- `services/maritime-agent/{Dockerfile,Dockerfile.dockerignore,build-container.mjs}`
- `services/maritime-agent/{README.md,VERIFICATION.md}`
- `packages/shared/maritime-coordination.ts` (canonical machine protocol)
- `packages/shared/contracts.ts` (backward-compatible re-exports only)
- `tests/maritime_agent.test.ts`
- `package.json` (three service scripts and required service typecheck)

The README defines exact C4 paths, schemas, idempotency keys, authorization/lease
rules and documented conditional deployment steps. No machine credential can
be sent to the staff AI route directly. C4 must wrap server-side drafting, retain
draft text internally, and return only a draftRef/provenance. Vendor invoke 2xx
is asynchronous acceptance; authenticated C4 event storage is authoritative.
No agent approves tasks, sends patient messages, chooses emergency escalation,
changes medication, accesses D1, or calls Prune/Sarvam/OCR directly.
