# Claw Framework Edge/Local Implementation Plan

Date: 2026-04-06
Input spec: `docs/superpowers/specs/2026-04-06-claw-framework-edge-local-architecture-design.md`
Status: Ready for execution

## Objective

Evolve NanoClaw and the existing Edge-Claw work into the first practical version of a broader `Claw Framework` with:

- a logically single control plane,
- an edge-first lightweight execution pool,
- a formal heavy-runtime execution pool,
- capability-based routing instead of complexity-based routing,
- task-graph execution with limited fan-out,
- centralized commit, fallback, and observability.

The implementation should preserve today’s working NanoClaw behavior while progressively introducing the framework concepts behind a thin compatibility layer.

## Delivery Principles

- Keep current NanoClaw group conversations and scheduled tasks working throughout the rollout.
- Reuse the current Edge-Claw control-plane pieces wherever possible instead of rewriting them.
- Land the framework as thin vertical slices, not a platform rewrite.
- Prefer explicit contracts and durable state before aggressive planner intelligence.
- Make fallback and commit safety first-class from the beginning.
- Route by explicit capability rules before introducing model-assisted routing.
- Do not make heavy runtimes or edge workers authoritative for final state.

## Current Baseline

The repository already contains important foundations for this framework shape:

- backend abstraction and backend selection,
- centralized logical sessions and execution state,
- workspace versioning and overlay commit,
- an edge tool host with explicit bounded tools,
- shadow execution and fallback concepts,
- local and subprocess-backed edge runner flows.

This means the first framework milestone is not “invent distributed routing.” It is “formalize the current Edge-Claw architecture as a reusable control-plane model and add task-graph execution plus a first-class heavy worker contract.”

## Milestone Overview

1. Formalize framework terminology and compatibility boundaries.
2. Introduce task-graph state and graph-aware orchestration.
3. Split logical task nodes from concrete execution attempts.
4. Add a capability tagging and rule-based route engine.
5. Turn the current container path into a formal heavy worker class.
6. Generalize the worker execution protocol across edge and heavy pools.
7. Add limited fan-out and aggregate nodes for edge-first workflows.
8. Add explicit fallback transitions and recovery policies.
9. Add framework-level observability and governance metrics.
10. Prepare later-phase adaptive routing and heavy worker specialization.

## Phase 1: Formalize the Claw Framework Compatibility Layer

### Goal

Introduce framework naming and contracts without breaking existing NanoClaw entry points.

### Changes

- Define a framework vocabulary in code and docs:
  - `LogicalSession`
  - `TaskGraph`
  - `TaskNode`
  - `ExecutionAttempt` or reuse `ExecutionState` terminology explicitly
  - `WorkerClass`
  - `CommitDecision`
- Keep current `index.ts` and `task-scheduler.ts` entry points intact, but route them through a small framework orchestration facade.
- Document how current concepts map into the framework:
  - current group turn -> root task graph with one task node,
  - current scheduled task -> root task graph with one scheduled root node,
  - current backend -> worker class implementation.

### Deliverables

- Framework terminology added without user-visible behavior change.
- A thin orchestration facade wraps current execution flow.
- Existing tests continue to pass.

### Verification

- `npm test`
- Unit tests for compatibility mapping from current flows to framework objects.

## Phase 2: Add TaskGraph State

### Goal

Represent a user request or scheduled task as a graph, even if the first version only contains one root node.

### Changes

- Extend `src/db.ts` with task-graph records, for example:
  - `task_graphs`
  - `task_nodes`
  - optional `task_node_dependencies`
- Add a new module such as `src/task-graph-state.ts` to:
  - create graphs,
  - create root nodes,
  - mark nodes ready/running/completed/failed,
  - list runnable nodes in dependency order.
- Update message-turn and scheduled-task flows so each top-level request creates a graph and root node.

### Deliverables

- Every framework request has a durable graph ID.
- Single-node graphs work end to end before any fan-out exists.
- Current behavior is preserved behind graph state.

### Verification

- Migration tests for new graph tables.
- Unit tests for single-node graph lifecycle.

## Phase 3: Separate TaskNode from Execution Attempt

### Goal

Allow one logical task node to have multiple execution attempts because of retries or fallback.

### Changes

- Extend or wrap `execution_state` so each record references a task node explicitly.
- Clarify state transitions between:
  - task node status,
  - execution attempt status,
  - commit acceptance status.
- Add state helpers so the control plane can:
  - retry the same node on the same worker class,
  - fallback the same node to another worker class,
  - reject stale or duplicate final results safely.

### Deliverables

- Logical work and concrete attempts are distinct.
- One node can run edge first and heavy second without losing audit clarity.

### Verification

- Unit tests for retry and fallback across multiple execution attempts.
- Replay tests for duplicate final results.

## Phase 4: Add Capability Tags and Rule-Based Routing

### Goal

Replace implicit routing with an explicit capability router.

### Changes

- Introduce capability tags such as:
  - `fs.read`
  - `fs.write`
  - `http.fetch`
  - `task.manage`
  - `message.send`
  - `code.exec`
  - `shell.exec`
  - `browser.exec`
  - `app.exec`
  - `local.secret`
  - `interactive.longlived`
- Add a `planner-output` or `task-node-intent` structure containing required capabilities.
- Create a routing module such as `src/policy-router.ts` that decides:
  - `edge`,
  - `heavy`,
  - `hybrid` staging where appropriate later.
- Record route decision reason and fallback eligibility.

### Deliverables

- Deterministic routing decisions.
- Explainable route reasons stored in durable state or logs.
- No dependence on subjective complexity heuristics.

### Verification

- Unit tests for route decisions by capability set.
- Tests for policy overrides and unknown-capability heavy defaults.

## Phase 5: Formalize the Heavy Worker Class

### Goal

Turn the current container-backed path into a formal heavy worker class rather than treating it as legacy infrastructure.

### Changes

- Rename conceptually, and where practical in code, from `container backend` to a heavy worker implementation.
- Keep the current container execution implementation underneath, but expose it through a worker contract aligned with edge.
- Define heavy-only capability groups:
  - shell,
  - browser,
  - app execution,
  - privileged local resources.
- Preserve current container behavior while clarifying it as the default heavy execution tier.

### Deliverables

- Edge and heavy become peer worker classes under one framework contract.
- Current container path remains operational.

### Verification

- Regression tests for existing container behavior.
- Contract tests proving heavy and edge satisfy the same top-level worker interface.

## Phase 6: Unify Worker Execution Protocol

### Goal

Use one request/event/result protocol for all worker classes.

### Changes

- Expand current `ExecutionRequest` and `ExecutionEvent` types into framework-level contracts carrying:
  - graph ID,
  - node ID,
  - parent node ID,
  - worker class,
  - capability budget,
  - deadline,
  - idempotency key,
  - plan fragment.
- Keep edge and heavy differences in policy and allowed tools, not in top-level protocol shape.
- Introduce `ExecutionResult` and `CommitDecision` types explicitly if they are not already separated enough.

### Deliverables

- One execution contract for edge and heavy.
- Fallback and shadow logic become protocol-level instead of backend-specific glue.

### Verification

- Shared contract tests for edge and heavy workers.
- Event replay tests across both worker classes.

## Phase 7: Limited Fan-Out and Aggregate Nodes

### Goal

Add the first controlled graph patterns that justify edge-first execution at scale.

### Scope

Start with narrow, high-confidence patterns only:

- batched workspace search,
- batched file reads,
- patch-candidate generation,
- multi-source information collection,
- aggregate summary nodes.

### Changes

- Extend planner or graph builder with a small set of decomposition templates.
- Add aggregate node support.
- Support graph-level aggregation policies:
  - `strict`
  - `quorum`
  - `best_effort`
- Ensure only edge-suitable independent nodes can fan out broadly.

### Deliverables

- The framework can run one root request as multiple edge child nodes plus one aggregate node.
- Partial success is explicit and policy-driven.

### Verification

- Integration tests for fan-out/fan-in workflows.
- Tests for strict, quorum, and best-effort aggregation.

## Phase 8: Explicit Fallback and Recovery Policies

### Goal

Make failure handling and heavy fallback a first-class graph behavior.

### Changes

- Add explicit fallback fields to task nodes:
  - `fallbackEligible`
  - `fallbackTarget`
  - `fallbackReason`
- Classify failures into:
  - routing failure,
  - execution failure,
  - commit failure,
  - semantic failure.
- Add recovery helpers for:
  - retry same node on same worker class,
  - retry same node on heavy after edge failure,
  - partial graph continuation,
  - re-plan after workspace commit conflict.

### Deliverables

- Fallback no longer appears as implicit backend switching.
- Recovery policy is graph-aware and auditable.

### Verification

- Tests for edge timeout -> heavy fallback.
- Tests for edge success + commit conflict -> re-plan required state.
- Tests for duplicate side-effect requests and commit dedupe.

## Phase 9: Framework Observability and Governance

### Goal

Expose enough route, execution, and commit data to understand whether edge-first execution is actually working.

### Changes

- Record route decision metadata:
  - worker class,
  - capability set,
  - route reason,
  - policy version.
- Record execution metrics:
  - queue delay,
  - duration,
  - timeout,
  - heartbeat health,
  - tool call counts,
  - overlay size.
- Record commit metrics:
  - accepted-result rate,
  - commit success rate,
  - conflict rate,
  - dedupe rate.
- Add initial framework-level reporting or logs for:
  - edge-only completion rate,
  - edge-to-heavy fallback rate,
  - average fan-out width,
  - graph completion latency.

### Deliverables

- Operators can tell whether edge-first routing improves throughput or just creates fallback noise.
- The framework has the minimum governance hooks needed for canary expansion.

### Verification

- Unit tests for metrics tagging and route-reason recording.
- Integration tests that emit expected route and commit metadata.

## Phase 10: Prepare Adaptive Routing and Runtime Specialization

### Goal

Finish the first framework version with the seams needed for later dynamic routing and richer heavy runtime classes.

### Changes

- Reserve policy hooks for:
  - task-type-specific routing profiles,
  - workspace-specific edge write restrictions,
  - adaptive fan-out limits,
  - automatic heavy-first downgrade when edge fallback rates spike.
- Clarify the future path for heavy worker subclasses:
  - `local-shell`
  - `browser-worker`
  - `app-worker`
- Clarify when a later sharded control plane may be justified.

### Deliverables

- The first framework version remains simple, but later growth paths are explicit rather than accidental.

### Verification

- Spec-to-plan traceability review.
- Follow-up issue list for runtime specialization, not in-scope implementation.

## Recommended Execution Order

Implement in this order:

1. Phase 1: compatibility facade.
2. Phase 2: task-graph state.
3. Phase 3: separate task nodes from execution attempts.
4. Phase 4: capability router.
5. Phase 5: heavy worker formalization.
6. Phase 6: unified worker protocol.
7. Phase 7: limited fan-out and aggregate nodes.
8. Phase 8: fallback and recovery.
9. Phase 9: observability and governance.
10. Phase 10: later-growth seams.

That order keeps current behavior working while introducing the minimal state and contract changes needed to support edge-first scaling.

## Initial PR Breakdown

### PR 1

- Add framework terminology and orchestration facade.
- No behavior change.

### PR 2

- Add task-graph schema and root-node lifecycle.
- Map current message turns and scheduled tasks onto single-node graphs.

### PR 3

- Separate task node state from execution attempt state.
- Add retry and fallback-safe state transitions.

### PR 4

- Add capability tags and rule-based route engine.
- Record route reasons.

### PR 5

- Formalize the heavy worker class using the current container path.
- Add shared worker contract tests.

### PR 6

- Expand unified execution request/event/result contracts.
- Add aggregate nodes and first fan-out template.

### PR 7

- Add explicit fallback policies, partial-success handling, and framework metrics.

## Exit Criteria for v1

The first Claw Framework version is ready when all of the following are true:

- current NanoClaw flows still work through the new framework facade,
- every request is represented by a durable task graph,
- a task node can have multiple execution attempts safely,
- routing decisions are capability-based and explainable,
- edge and heavy worker classes share one top-level contract,
- at least one fan-out plus aggregate workflow works end to end,
- edge-to-heavy fallback is explicit and durable,
- workspace and side effects remain centrally committed,
- operators can observe route reasons, fallback rates, and commit safety.

## Risks to Watch Closely

- letting planner output become the final routing authority,
- over-building platform abstractions before fan-out workflows are proven,
- allowing workers to bypass central commit paths,
- mixing task-node and execution-attempt status into one state machine again,
- adding too many decomposition patterns before observability exists,
- expanding edge writes before commit conflict handling is proven.

## Recommended Immediate Next Step

Start with PR 1 only: add the framework vocabulary and compatibility facade while preserving current behavior. That creates a clear architectural seam for every later phase without forcing a disruptive rewrite.
