# EdgeJS Runtime Hardening Follow-Ups

Date: 2026-04-03
Phase: 10
Related spec: `docs/superpowers/specs/2026-04-02-edgejs-edge-claw-design.md`
Related plan: `docs/superpowers/plans/2026-04-02-edgejs-edge-claw-implementation-plan.md`

## Goal

Track the concrete runtime work still needed in `edgejs` to support NanoClaw's Edge backend in production, based on the implementation that now exists in this repository.

This document intentionally does **not** list speculative runtime wishlist items. Every entry below is tied to a real NanoClaw code path, test, or operational assumption.

## Current NanoClaw Baseline

The NanoClaw side now has all planned control-plane pieces for the first edge backend:

- backend selection, fallback, and shadow mode
- execution leases, heartbeats, cancellation, and deadlines
- versioned workspace overlays with centralized commit
- explicit tool allowlists and network restrictions
- local runner and subprocess runner for protocol validation

The remaining work is mostly about proving that the `edgejs` runtime can enforce or preserve the assumptions that NanoClaw already makes.

## Gap Matrix

| Area | NanoClaw dependency | Current status | EdgeJS follow-up | Priority |
| --- | --- | --- | --- | --- |
| Safe-mode filesystem confinement | `src/edge-tool-host.ts` assumes workspace paths cannot escape the assigned root | Guarded at NanoClaw tool layer only | Add runtime-level tests that safe-mode file APIs cannot traverse or mount outside the assigned workspace root | High |
| Safe-mode write semantics | `src/workspace-service.ts` and `src/edge-tool-host.ts` rely on deterministic `mkdir`, `writeFile`, `rm`, and patch-style rewrite flows | Verified only in local Node/dev process | Validate `edgejs --safe` file create/update/delete semantics against NanoClaw overlay workloads | High |
| Network and TLS behavior | `src/edge-tool-host.ts` uses `fetch` and phase 9 shadow mode depends on network disablement | NanoClaw policy blocks hosts in userland | Verify that `edgejs` preserves `fetch`, TLS, headers, redirects, and `AbortSignal` behavior needed for `http.fetch`; add safe-mode egress controls if missing | High |
| Abort propagation | `src/backends/edge-backend.ts`, `src/edge-runner.ts`, and `src/edge-subprocess-runner.ts` rely on `AbortSignal` to stop work on cancel/deadline | Verified in local runner and subprocess shim | Add runtime coverage for aborting in-flight JS tasks, network requests, and timer-driven loops inside `edgejs` | High |
| No-subprocess production path | `src/edge-subprocess-runner.ts` exists only for local development and contract testing | Dev-only shim still uses host subprocesses | Replace the dev-only subprocess assumption with an in-process or remote runner entrypoint suitable for real `edgejs` deployment | Medium |
| Permission model surfacing | NanoClaw currently encodes policy in request payloads such as allowed tools and network profile | Runtime trusts host process policy | Define how `edgejs` safe-mode or permissions API exposes file/network capability boundaries so NanoClaw can map policies to runtime guarantees | High |
| NanoClaw workload regression tests in `edgejs` | Current proofs live in NanoClaw tests such as `src/edge-backend.integration.test.ts` and `src/edge-tool-host.test.ts` | No mirrored runtime-level suite in `edgejs` yet | Add a small runtime fixture suite in `edgejs` that replays NanoClaw-style workspace, fetch, and cancellation cases | Medium |

## Proposed EdgeJS Issues / PRs

These are the concrete cross-repo follow-ups to open in `edgejs`.

### 1. Safe-mode filesystem capability tests

**Suggested issue title**

`edgejs: add safe-mode filesystem confinement tests for NanoClaw workspace workloads`

**Why**

NanoClaw already blocks path traversal in `src/edge-tool-host.ts`, but production safety should not depend only on application-layer string validation.

**Repro anchor in NanoClaw**

- `src/edge-tool-host.ts`
- `src/edge-tool-host.test.ts`

**Expected EdgeJS outcome**

- file APIs cannot read or write outside the configured sandbox root
- relative traversal attempts fail deterministically
- read-only roots cannot be mutated

### 2. Workspace overlay filesystem semantics

**Suggested issue title**

`edgejs: verify safe-mode fs semantics for overlay-style write and patch workloads`

**Why**

NanoClaw commits overlays centrally, but local edge execution still depends on predictable temporary file operations before finalization.

**Repro anchor in NanoClaw**

- `src/workspace-service.ts`
- `src/workspace-service.test.ts`
- `src/edge-tool-host.ts`

**Expected EdgeJS outcome**

- UTF-8 read/write parity with Node behavior
- deterministic directory creation and deletion
- no surprising rename/truncate semantics under safe mode

### 3. Fetch, TLS, and egress restriction coverage

**Suggested issue title**

`edgejs: add fetch/TLS/abort coverage for policy-controlled agent workloads`

**Why**

NanoClaw's `http.fetch` tool and edge shadow mode both depend on stable `fetch` semantics plus enforceable egress controls.

**Repro anchor in NanoClaw**

- `src/edge-tool-host.ts`
- `src/edge-tool-host.test.ts`
- `src/backends/edge-backend.ts`
- `src/shadow-execution.ts`

**Expected EdgeJS outcome**

- `fetch` matches expected status/body behavior
- TLS failures surface as catchable errors
- `AbortSignal` interrupts in-flight requests promptly
- runtime can enforce or expose a path to enforce local-only / no-network modes

### 4. Abort and deadline propagation inside the runtime

**Suggested issue title**

`edgejs: validate AbortSignal handling for long-running edge worker loops`

**Why**

NanoClaw's phase 8 implementation now treats abort as a core correctness path, not just best-effort cleanup.

**Repro anchor in NanoClaw**

- `src/backends/edge-backend.ts`
- `src/backends/edge-backend.test.ts`
- `src/edge-runner.ts`

**Expected EdgeJS outcome**

- aborted timer loops stop promptly
- aborted async work surfaces a consistent error shape
- runtime does not leave zombie work after deadline expiry

### 5. Production runner entrypoint without host subprocesses

**Suggested issue title**

`edgejs: expose a production-ready execution entrypoint for agent runtimes without child_process`

**Why**

NanoClaw currently uses `src/edge-subprocess-runner.ts` only as a local protocol harness. Real edge deployment must not depend on host subprocess support.

**Repro anchor in NanoClaw**

- `src/edge-subprocess-runner.ts`
- `src/edge-backend.integration.test.ts`

**Expected EdgeJS outcome**

- in-process embedding or RPC entrypoint for one-turn execution
- no dependence on `child_process`
- clean request/event streaming model for control-plane orchestration

## Reproducible Validation Cases

The following cases should be mirrored in `edgejs` once runtime-specific tests are added.

### Case A: Workspace confinement

**NanoClaw reference**

- `src/edge-tool-host.test.ts`

**Scenario**

Attempt `workspace.read` on `../outside.txt`.

**Expected**

The runtime or host policy rejects the access deterministically.

### Case B: Overlay write then centralized commit

**NanoClaw reference**

- `src/workspace-service.test.ts`
- `src/edge-backend.integration.test.ts`

**Scenario**

Perform a `workspace.write`, keep the write in overlay form, then commit against the base version.

**Expected**

No partial file mutation before commit; committed output matches the overlay.

### Case C: Local-only / disabled networking

**NanoClaw reference**

- `src/edge-tool-host.test.ts`
- `src/backends/edge-backend.test.ts`

**Scenario**

Run `http.fetch` under local-only and disabled-network policies.

**Expected**

Local-only allows loopback only; disabled mode rejects all requests.

### Case D: Abort during execution

**NanoClaw reference**

- `src/backends/edge-backend.test.ts`

**Scenario**

Start a long-running edge execution and trigger cancel or deadline.

**Expected**

The execution exits quickly, reports a controlled error, and stops emitting further work.

## Exit Criteria For EdgeJS Canary Readiness

NanoClaw can treat the EdgeJS runtime as ready for broader canary traffic once all of the following are true:

- safe-mode filesystem confinement has explicit runtime coverage
- fetch/TLS/abort behavior is validated for NanoClaw's `http.fetch` tool
- a production runner path exists without host subprocess dependency
- NanoClaw-style abort/deadline tests pass in the `edgejs` repo
- any remaining runtime gaps are documented as non-blocking for the chosen canary scope

## Notes

- The local subprocess harness in NanoClaw is still useful for protocol development, but it is not evidence that production `edgejs` execution is fully hardened.
- The right next step after this phase is not more NanoClaw refactoring. It is opening focused `edgejs` issues or PRs backed by the repro cases above.
