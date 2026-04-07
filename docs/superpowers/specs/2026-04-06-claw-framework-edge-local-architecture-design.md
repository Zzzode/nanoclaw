# Claw Framework Edge/Local Architecture Design

Date: 2026-04-06
Status: Approved for implementation planning
Audience: Product owner / framework builder
Scope: Define the target architecture for evolving NanoClaw and Edge-Claw into a broader Claw Framework with edge-first execution and heavy-runtime fallback

## Summary

This design proposes that `Edge-Claw` become the lightweight execution tier inside a larger `Claw Framework`, while a central control plane remains the only source of truth for planning, routing, execution state, workspace commit, and fallback decisions.

The framework should prefer edge execution for the majority of tasks that can be expressed through constrained tools and recoverable writes. A smaller heavy-runtime tier should handle browser automation, shell access, app execution, privileged local resources, and other tasks that depend on strong local state or high-permission capabilities.

The design does not route by vague task “complexity”. It routes by required capabilities, risk, state coupling, and recovery behavior.

## Goals

- Make `Edge-Claw` a first-class lightweight execution pool inside a broader Claw architecture.
- Keep a single control-plane truth for sessions, task graphs, execution state, and workspace commits.
- Allow large-scale parallel fan-out of edge-suitable work.
- Reserve local or heavy runtimes for the smaller subset of tasks that require shell, browser, app, or privileged local execution.
- Preserve fallback, retry, and auditability across both execution tiers.
- Let the architecture evolve incrementally from the current NanoClaw and Edge-Claw baseline.

## Non-Goals

- Route tasks purely by subjective complexity.
- Make edge workers authoritative for final state.
- Let workers commit final side effects independently.
- Introduce a hierarchical multi-control-plane platform in the first architecture.
- Preserve Claude Code semantics or OpenClaw behavior exactly.

## Why This Architecture Exists

The desired product shape is not “an agent that can sometimes run at the edge.” It is a framework in which a single orchestration brain can dispatch many lightweight tasks to edge workers at scale, while retaining a smaller heavy-runtime path for tasks that fundamentally depend on richer local execution.

The key product belief is:

> Most agent work does not actually require a heavy local runtime.

Many tasks only need bounded workspace access, structured patching, HTTP access, message/task control, and lightweight computation. Those tasks can benefit from edge-style execution because they are easier to parallelize, cheaper to retry, and safer to constrain.

The remaining tasks are still important, but they should be treated as a distinct execution class rather than as the default runtime for everything.

## Recommended Control-Plane Shape

The framework should use a logically single control plane.

This means:

- one authoritative orchestrator,
- one routing and policy engine,
- one source of truth for task graphs and execution state,
- one commit authority for workspace and side effects.

This does not require a single process forever. It means the architecture has one logical coordinator per shard, workspace group, or deployment slice. Execution pools may scale independently, but they do not own product truth.

### Why Single Control Plane Is Recommended

This architecture best supports:

- explicit fallback,
- edge and heavy comparison,
- centralized workspace arbitration,
- durable retries,
- unified observability,
- user-visible product continuity.

If multiple control planes make conflicting routing or commit decisions, the system becomes much harder to reason about. The framework would gain platform complexity before it has proven its runtime split.

### Future Evolution

If scale eventually requires it, the architecture can evolve into sharded single control planes. That is preferred over introducing nested autonomous control planes early.

## Layered Architecture

The framework should be organized into five logical layers.

### 1. Control Plane

The control plane is the only authoritative product brain.

It is responsible for:

- receiving inbound requests,
- maintaining logical sessions,
- creating and tracking task graphs,
- choosing execution placement,
- handling retries and fallback,
- accepting or rejecting execution results,
- committing workspace and side effects,
- exposing observability and policy control.

The control plane does not do heavy execution itself.

### 2. Planner

The planner translates a user request into an executable graph.

It should determine:

- whether the request is decomposable,
- what sub-tasks exist,
- which dependencies are required,
- which sub-tasks can run in parallel,
- what capabilities each node requires,
- what aggregation or validation steps are needed.

The planner may use model assistance, but it must not become the final routing authority.

### 3. Edge Pool

The edge pool is the default lightweight execution tier.

It is intended for:

- bounded workspace operations,
- search and summarization,
- patch generation,
- controlled HTTP access,
- task and message operations,
- lightweight JavaScript transforms,
- large fan-out across independent sub-tasks.

It should remain constrained, recoverable, and easy to discard.

### 4. Heavy Pool

The heavy pool is the specialized execution tier for tasks that exceed edge boundaries.

It is intended for:

- shell execution,
- browser automation,
- app automation,
- privileged local resource access,
- richer long-lived local state,
- high-risk or strongly coupled environment interactions.

The heavy pool may later contain multiple runtime classes such as `local-shell`, `browser-worker`, or `app-worker`, but they are still worker classes under the same control plane.

### 5. Commit Plane

The commit plane may be implemented inside the control plane, but it should be treated as a distinct responsibility.

It is responsible for:

- workspace version validation,
- overlay commit,
- side-effect deduplication,
- idempotency enforcement,
- conflict detection,
- final acceptance of execution outputs.

No worker should bypass this layer.

## Routing Model

The framework should route by:

1. required capabilities,
2. failure risk,
3. state coupling,
4. side-effect safety,
5. parallelization benefit.

It should not route by a vague “simple versus complex” heuristic.

### Capability-First Routing

Each planned task node should carry capability tags such as:

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

Routing should follow explicit policy:

- nodes requiring only bounded edge capabilities go to `edge`,
- nodes requiring shell, browser, app, or privileged local access go to `heavy`,
- nodes with unknown or disallowed capabilities default to `heavy`,
- nodes that are user-pinned or policy-pinned obey that override.

### Risk and State Coupling

Even capability-compatible tasks should avoid edge placement when they have:

- strong dependency on long-lived local interactive state,
- high-value irreversible side effects,
- stateful coupling that is hard to replay safely.

Edge is preferred for work that is:

- short-lived,
- independent,
- recoverable,
- idempotent,
- easy to checkpoint or discard.

### Decomposition and Parallel Fan-Out

Planner output should allow:

- `edge.single`
- `edge.fanout`
- `heavy.single`
- `hybrid.pipeline`

`hybrid.pipeline` is a key framework mode. A workflow may use edge workers for parallel light work, then heavy workers for a smaller set of high-permission actions or validation steps.

### Fallback

Fallback should be explicit state, not hidden behavior.

Task nodes should record:

- fallback eligibility,
- fallback target,
- fallback reason.

Reasons should be structured, for example:

- `unsupported_capability`
- `policy_denied`
- `edge_timeout`
- `edge_runtime_unhealthy`
- `state_conflict_requires_heavy`
- `human_review_required`

## Execution Contract

Both edge and heavy workers should share a common execution contract.

Worker differences should primarily appear through:

- capability budget,
- policy,
- runtime class,
- tool availability.

### Core Contract Objects

#### `ExecutionRequest`

The control plane sends a worker a bounded task description containing at least:

- `executionId`
- `taskId`
- `parentTaskId`
- `logicalSessionId`
- `workspaceRef`
- `capabilityBudget`
- `deadline`
- `idempotencyKey`
- `planFragment`
- `policy`

#### `ExecutionEvent`

Workers stream structured events such as:

- `ack`
- `heartbeat`
- `progress`
- `tool_call`
- `tool_result`
- `checkpoint`
- `warning`
- `needs_fallback`
- `final`

#### `ExecutionResult`

Workers return a final candidate result containing:

- `status`
- `summary`
- `structuredOutput`
- `artifacts`
- `overlayCandidate`
- `sideEffectRequests`
- `fallbackHints`

#### `CommitDecision`

Only the control plane can create the final commit decision:

- accept result,
- reject result,
- retry,
- fallback,
- commit overlay,
- emit side effects,
- request human review.

### Two-Stage Side Effects

Workers should not directly perform final side effects.

Instead:

- workers emit `sideEffectRequests`,
- the control plane validates and commits them.

This applies to:

- workspace writes,
- outbound messages,
- task creation or updates,
- other persistent side effects.

## State Model

The architecture should distinguish product continuity, planning state, runtime state, and committed truth.

### 1. LogicalSession

Represents the user-facing continuous context.

It is not a provider session token. It holds product continuity across retries, backend changes, and provider changes.

### 2. TaskGraph

Represents the plan for a request.

A graph may contain:

- a root task,
- many edge child tasks,
- heavy validation tasks,
- aggregation tasks.

Each node should record:

- `taskId`
- `graphId`
- `parentTaskId`
- `dependencies`
- `placement`
- `retryPolicy`
- `status`

### 3. ExecutionState

Represents one concrete attempt to execute one task node.

This distinction is essential:

- a task node is the logical unit of work,
- an execution is one attempt to perform it.

One task node may have multiple executions because of retry or fallback.

### 4. WorkspaceState

Workspace truth should be versioned.

Workers operate against a base version and return overlay candidates. The control plane validates and commits a new workspace version only after acceptance.

### 5. CommitLog

Commit log records what the framework actually accepted:

- accepted execution result,
- committed workspace version,
- committed message send,
- committed task mutation,
- deduplicated operation records.

This is the audit and recovery foundation.

## Error Handling and Recovery

Failures should be treated as routine system states rather than exceptional edge cases.

### Failure Classes

#### Routing Failure

The task was sent to the wrong runtime class. The system should convert this quickly into explicit fallback rather than forcing the worker to improvise unsupported behavior.

#### Execution Failure

The execution attempt failed because of timeout, runtime error, tool error, network issue, cancellation, or lost heartbeat.

This does not automatically mean the logical task failed.

#### Commit Failure

The worker produced a candidate result, but the framework could not safely accept it. This includes version conflicts, dedupe issues, or commit-store problems.

This must be tracked separately from execution failure.

#### Semantic Failure

The execution completed, but the result was not good enough or did not satisfy the intent. This may require retry, re-plan, validation, or human review.

### Recovery Layers

#### Execution Recovery

Handle worker-level issues:

- timeout,
- lost heartbeat,
- runtime crash,
- cancellation.

The control plane decides whether to retry, fallback, or fail the task node.

#### Task Recovery

Handle one logical task node across multiple execution attempts:

- edge retry,
- heavy fallback,
- selective node replay,
- degraded completion if policy allows.

#### Workflow Recovery

Handle the whole graph:

- partial fan-out success,
- aggregate-with-gaps behavior,
- re-plan after commit conflict,
- validation loops after heavy verification failure.

### Partial Success Policies

Task graphs should support multiple aggregation modes:

- `strict`
- `quorum`
- `best_effort`

This is especially important for large edge fan-out.

### Idempotency

All side effects and commits should use idempotency keys or equivalent operation identifiers so duplicate execution results or retries do not create duplicate committed effects.

## Observability and Governance

The framework must expose decision-level observability, not just raw logs.

### Routing Observability

Each routing decision should record:

- placement,
- capability tags,
- policy version,
- fallback eligibility,
- decision reason,
- planner confidence if relevant.

### Execution Observability

Track metrics such as:

- queue delay,
- runtime duration,
- heartbeat health,
- timeout rate,
- tool call counts,
- output size,
- overlay size,
- final execution status.

### Commit Observability

Track separately:

- execution completion rate,
- accepted-result rate,
- commit success rate,
- commit conflict rate,
- dedupe rate,
- fallback-after-success rate.

### Product Observability

Track user-impacting metrics such as:

- edge-first routing rate,
- heavy-first routing rate,
- edge-only completion rate,
- edge-to-heavy fallback rate,
- end-to-end latency,
- visible failure rate,
- average fan-out width,
- cost per completed workflow.

### Governance

Governance should operate at three levels:

- policy governance,
- runtime governance,
- adaptive governance.

Examples include:

- restricting edge write capabilities on high-conflict workspaces,
- lowering max fan-out when the edge pool is degraded,
- switching certain task types to heavy-first if fallback rates become too high.

## Recommended Evolution Path

The architecture should be implemented incrementally.

### Phase 1: Harden Edge-Claw as a Reliable Light Runtime

Finish runtime hardening and prove that edge execution is trustworthy for bounded tasks.

### Phase 2: Add TaskGraph and Controlled Fan-Out

Introduce graph-based planning and limited parallel edge execution for clearly decomposable tasks.

### Phase 3: Formalize Heavy Workers

Promote local or heavy execution from a legacy path into a formal worker class with the same execution contract.

### Phase 4: Add Capability Router

Introduce explicit route policy and structured fallback behavior.

### Phase 5: Add Hybrid Pipelines

Support workflows where edge performs broad parallel work and heavy workers perform narrower high-permission steps.

### Phase 6: Close the Governance Loop

Use routing, execution, and commit metrics to tune placement policies and limit unsafe edge expansion.

### Phase 7: Shard the Control Plane if Scale Demands It

Only after the core framework proves itself should the system evolve into sharded single-control-plane deployments.

## Expected Product Outcome

If successful, the framework evolves into a system where:

- most agent work runs on edge-first lightweight workers,
- heavy runtimes handle only the minority of high-permission or strongly coupled tasks,
- all execution remains centrally orchestrated,
- writes and side effects are centrally committed,
- edge fan-out becomes a performance and cost advantage rather than a source of chaos.

The desired long-term outcome is not “replace heavy runtimes entirely.” It is “treat heavy runtimes as specialized exceptions while edge becomes the default execution substrate for the majority of safe, parallelizable, recoverable work.”
