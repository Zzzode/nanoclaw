# EdgeJS Edge-Claw Implementation Plan

Date: 2026-04-02
Input spec: `docs/superpowers/specs/2026-04-02-edgejs-edge-claw-design.md`
Status: Ready for execution

## Objective

Implement the first production-capable version of NanoClaw's EdgeJS execution backend without breaking the current container backend. The implementation must preserve NanoClaw's current orchestration behavior while introducing a new execution abstraction, centralized execution state, and a constrained JavaScript tool runtime suitable for edge-style deployment.

## Delivery Principles

- Keep the container backend working at every intermediate step.
- Land the new architecture in thin vertical slices rather than a big-bang rewrite.
- Prefer central state first, then backend protocol, then edge execution, then rollout controls.
- Only ship capabilities that can be recovered, retried, and tested end to end.
- Treat unsupported features as explicit fallback triggers, not hidden partial support.

## Current Integration Points

The current execution layer is coupled into NanoClaw in three main places.

- `src/index.ts` uses `runContainerAgent()` for interactive message turns and writes task/group snapshots before execution.
- `src/task-scheduler.ts` uses `runContainerAgent()` again for scheduled tasks and depends on queue process registration and container shutdown semantics.
- `src/container-runner.ts` owns execution input and output types, container spawn lifecycle, task/group snapshot writes, and container-specific isolation setup.

This means the first implementation milestone is not “build EdgeJS runner”. It is “remove container-specific assumptions from the orchestration layer so a second backend can exist”.

## Milestone Overview

1. Extract backend-neutral execution interfaces in NanoClaw.
2. Introduce centralized execution and session state records.
3. Implement a backend-neutral task and group snapshot pipeline.
4. Build a local-development Edge backend stub in NanoClaw.
5. Build the first Edge runner package and protocol.
6. Implement the minimal JS tool host.
7. Add reliability features: idempotency, retries, cancellation, deadlines.
8. Add rollout controls and fallback rules.
9. Run comparison and recovery testing.
10. Prepare initial EdgeJS runtime follow-ups required for hardening.

## Phase 1: Backend-Neutral Execution Abstraction

### Goal

Separate NanoClaw orchestration from container-specific execution semantics.

### NanoClaw Changes

- Add a new module, for example `src/agent-backend.ts`, defining backend-neutral types:
  - `AgentBackend`
  - `ExecutionRequest`
  - `ExecutionResult`
  - `ExecutionStreamEvent`
  - `ExecutionHandle` if cancellation or heartbeats require a runtime token
- Add a container-backed adapter, for example `src/backends/container-backend.ts`, that wraps the current `runContainerAgent()` flow.
- Update `src/index.ts` to call the abstract backend instead of `runContainerAgent()` directly.
- Update `src/task-scheduler.ts` to use the same backend abstraction.
- Keep `src/container-runner.ts` intact as an implementation detail behind the container backend.

### Deliverables

- Backend-neutral interfaces merged.
- Existing tests still pass using the container backend.
- No user-visible behavior change.

### Verification

- `npm test`
- New unit tests for the backend abstraction adapter behavior.

## Phase 2: Centralized Logical Execution State

### Goal

Make execution and session state explicit and durable before Edge execution exists.

### NanoClaw Changes

- Extend `src/db.ts` schema with new tables or records for:
  - `logical_sessions`
  - `execution_state`
  - `workspace_versions` or a minimal workspace manifest table
  - `memory_state` or at minimum versioned references for group memory and summary
- Add migration code to initialize these records without breaking existing `sessions`, `router_state`, and task storage.
- Introduce a new state module, for example `src/execution-state.ts`, for creating and updating execution leases, heartbeats, final commits, and lost-execution recovery.
- Keep current `sessions` support during transition, but treat it as a legacy compatibility field behind a higher-level session service.

### Deliverables

- Durable logical session model independent of container runtime.
- Durable execution records for retry and recovery.
- Recovery logic can reason about “execution committed” versus “execution started”.

### Verification

- Database migration tests for fresh and existing stores.
- Unit tests for execution lease lifecycle and retry-safe commit transitions.

## Phase 3: Snapshot Pipeline Extraction

### Goal

Split snapshot generation from container-specific file IPC so both backends can consume it.

### NanoClaw Changes

- Move `writeTasksSnapshot()` and `writeGroupsSnapshot()` out of `src/container-runner.ts` into a backend-neutral module such as `src/execution-snapshots.ts`.
- Replace direct filesystem-IPC assumptions with snapshot objects first, then keep filesystem writes only in the container adapter.
- Introduce backend-neutral snapshot types:
  - `TaskSnapshot`
  - `GroupSnapshot`
  - `PromptPackage`

### Deliverables

- Orchestrator generates backend-neutral snapshot payloads.
- Container backend still writes them to files for compatibility.
- Edge backend will later receive them directly in the request payload.

### Verification

- Existing behavior unchanged for container execution.
- Snapshot generation covered with unit tests.

## Phase 4: Local Edge Backend Stub

### Goal

Add a second backend path in NanoClaw before implementing real Edge execution.

### NanoClaw Changes

- Add `src/backends/edge-backend.ts` with a temporary in-process or local subprocess stub implementation.
- Add backend selection logic in config and runtime:
  - environment-level default backend
  - per-group execution mode: `container`, `edge`, `auto`
  - per-task override if needed later
- Introduce unsupported-feature fallback rules in `auto` mode.

### Deliverables

- NanoClaw can select between two backends.
- Edge backend initially returns controlled “not implemented” or simple echo outputs for contract testing.

### Verification

- Contract tests proving both backends satisfy the same execution API.
- Unit tests for backend selection and fallback.

## Phase 5: Edge Runner Protocol and Runtime Package

### Goal

Build the first real edge execution target with a stable request and event protocol.

### NanoClaw Changes

- Finalize request and event types in the backend-neutral interface.
- Implement dispatcher logic that can:
  - send `ExecutionRequest`
  - consume stream events
  - persist checkpoints
  - finalize or abandon executions

### Edge Runtime Work

- Create a new runner package or app intended to execute on EdgeJS.
- Implement request decoding, prompt assembly, event emission, and final result packaging.
- Start with local development mode first so NanoClaw can run the Edge backend on one machine before remote deployment exists.

### Deliverables

- A concrete `ExecutionRequest` and `ExecutionEvent` protocol shared by NanoClaw and the Edge runner.
- Edge backend can execute one turn and stream output back to NanoClaw.

### Verification

- End-to-end integration test from NanoClaw dispatcher to Edge runner.
- Replay tests for repeated `final` and repeated `checkpoint` events.

## Phase 6: Minimal JavaScript Tool Host

### Goal

Replace shell-style capabilities with explicit JS tools that can support the first useful workloads.

### First Tool Set

- `workspace.read`
- `workspace.list`
- `workspace.search`
- `workspace.write`
- `workspace.apply_patch`
- `message.send`
- `task.create`
- `task.list`
- `http.fetch`

### NanoClaw Changes

- Implement central tool handlers for control-plane tools such as `message.send` and `task.*`.
- Add operation-id based idempotency storage for all side-effecting tools.
- Add tool policy enforcement and argument validation.

### Edge Runtime Work

- Implement a local tool host for pure workspace and transform tools.
- Add root-constrained path resolution for workspace operations.
- Emit `tool_call` and `tool_result` events in a deterministic format.

### Deliverables

- First edge turns can read and write workspace files, send a message, create tasks, and make controlled HTTP calls.
- No shell access exists in the Edge backend.

### Verification

- Unit tests per tool.
- Path traversal and boundary tests.
- End-to-end scenario tests using the new tool host.

## Phase 7: Workspace Versioning and Overlay Commit

### Goal

Make edge file changes recoverable and centrally committed.

### NanoClaw Changes

- Add workspace manifest or version rows to the central store.
- Add a workspace service to:
  - materialize manifests,
  - accept overlay deltas,
  - validate `baseWorkspaceVersion`,
  - commit a new version,
  - reject stale writes.

### Edge Runtime Work

- Add on-demand workspace hydration from a manifest.
- Track writes as an overlay rather than mutating authoritative state.
- Return file deltas or blobs only on finalization or checkpoint.

### Deliverables

- Edge execution can modify group workspace safely.
- Failed executions do not leave half-written state behind.

### Verification

- Workspace conflict tests.
- Recovery tests where edge succeeds but central commit fails.
- Replay safety tests for duplicate commits.

## Phase 8: Reliability, Cancellation, and Deadlines

### Goal

Make the Edge backend operationally safe for real traffic.

### NanoClaw Changes

- Add heartbeat monitoring to execution leases.
- Add soft-cancel and hard-deadline transitions.
- Requeue uncommitted work after lost execution detection.
- Add explicit “unsupported tool or unsupported feature” fallback classification.

### Edge Runtime Work

- Check for cancel requests at safe boundaries.
- Emit heartbeat events while executing.
- Stop promptly when deadline or cancel is reached.

### Deliverables

- Reliable cancellation semantics.
- Retry-safe recovery from node loss.
- Predictable deadline behavior.

### Verification

- Cancellation race tests.
- Heartbeat loss tests.
- Deadline expiration tests.

## Phase 9: Rollout Controls and Shadow Mode

### Goal

Introduce the backend in a way that is easy to compare and easy to roll back.

### NanoClaw Changes

- Add rollout configuration for default backend choice.
- Add per-group execution mode settings.
- Add shadow-mode execution for comparison without user-facing side effects.
- Add logging and metrics tags by backend and by fallback reason.

### Deliverables

- Safe canary rollout path.
- Observable quality differences between backends.

### Verification

- Shadow-mode comparison tests.
- Manual canary validation on selected groups and scheduled tasks.

## Phase 10: EdgeJS Runtime Hardening Follow-Ups

### Goal

Track the runtime-level work needed in `edgejs` to support the NanoClaw Edge backend cleanly.

### Likely EdgeJS Workstreams

- Verify the permission model and safe-mode behavior needed for workspace and network tools.
- Validate filesystem APIs and any missing semantics needed by the Edge runner.
- Validate HTTP and TLS behavior required by `http.fetch` and external API calls.
- Confirm that the chosen execution model does not depend on unsupported subprocess behavior.
- Add runtime tests tailored to NanoClaw-style workloads where needed.

### Deliverables

- A concrete list of EdgeJS gaps discovered while implementing the Edge backend.
- Targeted runtime issues or PRs in `edgejs` instead of speculative pre-work.

### Verification

- Cross-repo issue tracking from NanoClaw milestones to EdgeJS runtime gaps.
- Reproducible integration cases that fail before runtime fixes and pass after them.

## Recommended Execution Order

This work should be landed in the following order:

1. Phase 1: backend abstraction.
2. Phase 2: centralized execution and session state.
3. Phase 3: snapshot extraction.
4. Phase 4: local Edge backend stub.
5. Phase 5: edge runner protocol.
6. Phase 6: minimal JS tool host.
7. Phase 7: workspace versioning.
8. Phase 8: reliability and cancellation.
9. Phase 9: rollout controls.
10. Phase 10: runtime hardening in EdgeJS as concrete needs appear.

That order is important because it keeps the current backend working while pulling risk forward into explicit seams and tests.

## Initial PR Breakdown

The first set of implementation PRs should be small and reviewable.

### PR 1

- Add backend-neutral execution interfaces.
- Wrap the current container runner behind `ContainerBackend`.
- No behavior change.

### PR 2

- Add centralized execution state schema and service.
- Keep current session behavior via compatibility mapping.

### PR 3

- Extract snapshot generation from `container-runner.ts`.
- Keep container IPC writes in the container adapter only.

### PR 4

- Add backend selection and an Edge backend stub.
- Add tests for `container`, `edge`, and `auto` selection.

### PR 5

- Introduce the first Edge runner plus streaming execution protocol.
- Support a minimal no-op or read-only turn end to end.

### PR 6

- Add the first real tool set and workspace overlay commit.

## Exit Criteria for v1

The EdgeJS backend is ready for real canary traffic when all of the following are true:

- NanoClaw can run either backend via the same orchestration flow.
- Logical sessions and execution leases are centrally durable.
- One-turn edge executions can stream output and commit results.
- Minimal JS tools work end to end with policy checks.
- Workspace mutations are versioned and recoverable.
- Lost edge executions are retried safely.
- Unsupported behavior falls back cleanly to the container backend.
- Comparison tests show parity for the supported feature subset.

## Risks to Watch Closely

- Letting container assumptions leak into the backend abstraction.
- Accidentally creating two sources of truth for sessions during migration.
- Making workspace versioning too ambitious before the tool host is stable.
- Hiding unsupported features instead of routing them to fallback.
- Depending on EdgeJS runtime capabilities before they are validated with real integration tests.

## Recommended Immediate Next Step

Start with PR 1 only: extract the backend-neutral execution interface and move current container execution behind it. This is the smallest change that unlocks every later phase while keeping the system behavior stable.
