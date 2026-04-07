# EdgeJS Edge-Claw Product Shape

Date: 2026-04-04
Status: Internal working draft
Audience: Product owner / builder
Scope: Describe the target product shape NanoClaw is evolving toward with the EdgeJS execution backend

## One-Sentence Product Definition

NanoClaw is evolving from a container-only agent orchestrator into a dual-backend agent product that can run the same group conversations and scheduled tasks through either a container runtime or an EdgeJS runtime, with centralized state, explicit fallbacks, recoverable workspace changes, and safe canary rollout.

## What This Product Is

This product is not “an agent that happens to use EdgeJS.”

It is a full execution product shape with four tightly related properties:

1. a central control plane remains the source of truth,
2. execution can happen on more than one backend,
3. the edge backend is constrained, explicit, and recoverable rather than shell-like,
4. rollout can happen gradually with comparison, fallback, and rollback.

In practical terms, the product keeps NanoClaw’s current user-facing behavior:

- group-based assistant conversations,
- scheduled task execution,
- shared workspace access per group,
- multi-turn continuity,
- central routing and orchestration,
- recoverable state after failures.

But it changes the execution model underneath:

- from container-bound execution,
- to backend-pluggable execution,
- with EdgeJS as a first-class runtime.

## What This Product Is Not

This target product is explicitly not:

- a direct port of the current container runner into EdgeJS,
- a shell-compatible edge sandbox,
- an attempt to preserve Claude Code or Claude Agent SDK behavior exactly,
- a design where edge workers become the system of record,
- a big-bang rewrite that replaces the container backend in one step,
- a product that hides unsupported features behind partial or ambiguous behavior.

If an action is not safely supported by the edge backend, the product should make that explicit and route the execution to the container backend when policy allows.

## Why This Product Exists

The current NanoClaw execution path is powerful, but it is strongly shaped by container assumptions:

- execution is tied to container lifecycle,
- filesystem IPC is used for snapshots,
- the execution environment assumes process-level isolation,
- tool behavior is closer to a shell-style model than an explicit application-level tool model.

That model works, but it creates several product limits.

### Problem 1: Execution Is Too Tightly Coupled To One Runtime

When orchestration logic assumes container execution everywhere, every future runtime change becomes expensive. The product cannot easily compare execution backends, fall back between them, or gradually roll out a new runtime.

### Problem 2: State Recovery Is Harder Than It Should Be

If the runtime owns too much implicit state, it becomes harder to answer simple operational questions:

- did the execution really start,
- did it checkpoint,
- did it commit,
- did it get lost,
- can it be retried safely,
- did it partially change workspace state.

The new product shape solves this by moving durable state decisions into the central control plane.

### Problem 3: Edge-Style Deployment Needs A Different Capability Model

A container model naturally tolerates shell-like capabilities. An edge-style runtime should not. It needs:

- explicit tools,
- bounded policies,
- deterministic input and output contracts,
- recoverable writes,
- clear network controls.

This is not just a technical rewrite. It is a product behavior upgrade.

### Problem 4: Rollout Risk Is Too High Without A Dual-Backend Model

If the only way to adopt a new runtime is full replacement, the risk is too high. The product needs a safe rollout ladder:

- compare silently,
- canary on small traffic,
- fall back when unsupported,
- expand only when stable.

## Core Product Idea

The core idea is simple:

> NanoClaw should behave like one product with one orchestration brain, even though execution may happen through different runtimes underneath.

From the operator’s point of view, there is still one NanoClaw product:

- groups are registered once,
- tasks are defined once,
- messages are routed once,
- state is stored centrally,
- workspaces are owned centrally,
- execution mode is a configuration choice, not a product fork.

The edge backend is therefore not a separate product. It is a new execution shape inside the same product.

## Target Product Shape

When this design is fully realized, the product looks like this.

### 1. One Control Plane, Multiple Execution Backends

NanoClaw has one authoritative control plane responsible for:

- ingesting user messages,
- storing message history,
- scheduling tasks,
- tracking sessions,
- creating execution records,
- choosing the backend,
- committing final state,
- deciding fallback and recovery behavior.

Below that control plane, execution can happen through:

- `container`,
- `edge`,
- `auto` mode that chooses between them.

The product should feel operationally unified even when the backend differs per group or per task.

### 2. Durable Logical Sessions

The product’s real session model is not “whatever session token a runtime happens to return.”

Instead, the product owns a durable logical session per conversation or task scope. Provider-specific session identifiers are optional optimization hints, not the canonical truth.

This gives the product a stable user-facing identity even if:

- the runtime changes,
- the model provider changes,
- an execution crashes,
- retries happen,
- a canary is rolled back.

### 3. Explicit Execution Lifecycle

Every turn becomes a durable execution object with visible lifecycle state, including concepts like:

- started,
- heartbeat updated,
- cancel requested,
- checkpoint persisted,
- committed,
- completed,
- failed,
- lost.

This makes the product operable. It becomes possible to reason about live executions as product entities, not only as logs or child processes.

### 4. Backend-Neutral Prompt And Snapshot Packaging

The product should prepare task context, group context, and prompt context in a backend-neutral form first. Container-specific file IPC becomes just one adapter path. The edge backend receives structured payloads directly.

This is important because it means the product speaks one internal execution language regardless of runtime.

### 5. Edge Execution Uses Structured JS Tools

The edge backend does not expose arbitrary shell execution in v1. Instead, it uses a deliberate JavaScript tool set such as:

- `workspace.read`
- `workspace.list`
- `workspace.search`
- `workspace.write`
- `workspace.apply_patch`
- `message.send`
- `task.create`
- `task.list`
- `http.fetch`

These tools are product capabilities, not low-level runtime escape hatches.

### 6. Workspace Writes Become Overlay Commits

The product should treat workspace mutation as a recoverable transaction-like flow:

1. execute against a base workspace version,
2. collect overlay changes,
3. validate that the base version is still current,
4. commit a new workspace version centrally,
5. reject stale writes safely.

This changes workspace mutation from “the runtime wrote some files” to “the product accepted and committed a new workspace version.”

### 7. Rollout Becomes A First-Class Product Capability

The product should allow operators to:

- choose default backend behavior,
- force a group to `container`,
- force a group to `edge`,
- let a group run in `auto`,
- enable shadow comparison,
- canary on selected traffic,
- roll back quickly.

This is part of the intended product shape, not an afterthought.

## What Problems The Product Solves

At maturity, this product solves six concrete problems.

### Stable Orchestration With Runtime Flexibility

It lets NanoClaw change execution runtime without changing the surrounding product contract. The operator no longer has to choose between “keep everything container-only forever” and “rewrite the product around a new runtime.”

### Safer Edge-Native Execution

It introduces an edge-friendly execution model built on:

- structured requests,
- structured events,
- bounded tools,
- explicit policies,
- central commit control.

That is much safer and easier to reason about than trying to approximate a general shell environment at the edge.

### Better Failure Recovery

Because execution state and workspace versions are durable, the product can handle failure in a controlled way. This is crucial for real traffic, not only demos.

### Clear Fallback Behavior

Unsupported capabilities do not have to become silent bugs. They can become explicit fallback triggers. That gives the product a safer path to gradual adoption.

### Lower Rollout Risk

Shadow mode, canary traffic, and backend selection make it possible to validate the new runtime against real workloads before trusting it broadly.

### Cleaner Long-Term Product Architecture

The product becomes less dependent on any one execution implementation. That reduces future lock-in and makes the execution layer easier to evolve.

## Who The Product Is For

There are three useful user lenses for this product.

### 1. Primary Builder / Operator

This is the current main audience. You need a product that:

- keeps the current system working,
- opens a path to edge execution,
- lets you test safely on real workloads,
- gives you confidence about failure and rollback,
- avoids a brittle compatibility layer.

### 2. Internal Operator Or Future Team Member

A future teammate should be able to understand:

- what execution modes exist,
- why some runs use edge and others use container,
- what fallback means,
- what counts as committed state,
- what can be canaried safely.

### 3. End User Of NanoClaw

The end user should not need to understand the backend most of the time.

Their product experience should still be:

- message the assistant in a group,
- get a response,
- rely on continuity,
- receive scheduled task output,
- trust that the system does not randomly lose context or corrupt workspace state.

The backend choice should mainly matter when it changes latency, reliability, supported capabilities, or rollout safety.

## How Users Will Use The Product

The intended usage model is operationally simple even if the internals are sophisticated.

### Group Conversation Flow

1. A group is registered with NanoClaw.
2. The group has an execution mode:
   - `container`
   - `edge`
   - `auto`
3. A user sends a message.
4. NanoClaw ingests the message and builds a new execution turn.
5. The control plane selects the backend.
6. The backend runs the turn.
7. Output is streamed back to the group.
8. Session and workspace state are committed centrally.

From the user’s point of view, they are simply talking to the same assistant. From the product’s point of view, the runtime path may differ.

### Scheduled Task Flow

1. A task is created for a group.
2. The scheduler enqueues the task at the due time.
3. NanoClaw creates a new execution record.
4. The backend runs the task according to execution mode and fallback rules.
5. Result messages are sent back to the group when appropriate.
6. Final state is committed centrally.

The key product property is that scheduled tasks use the same backend abstraction and state discipline as conversational turns.

### Workspace Tool Flow

When an execution needs to inspect or modify workspace files:

1. it reads against the current workspace version,
2. edge writes are captured as overlay changes,
3. the control plane validates the base version,
4. the control plane commits a new version if valid,
5. stale or duplicate writes are rejected or replayed idempotently.

This gives the operator much clearer guarantees than direct mutable runtime-local state.

## How The Product Should Feel To Use

The intended product feel is:

- operationally boring,
- architecturally flexible,
- safe to compare,
- safe to roll back,
- explicit about unsupported behavior,
- consistent across group turns and scheduled tasks.

The ideal operator experience is not “the edge backend is exciting.” It is “changing backend no longer feels dangerous.”

## Product Modes And Operational Meaning

Execution mode is one of the most important product-facing concepts.

### `container`

Use the established execution path. This is the safe baseline and compatibility fallback.

### `edge`

Force the new edge execution path. This is appropriate when the supported capability set is sufficient and the operator intentionally wants to test or adopt the edge backend.

### `auto`

Let NanoClaw choose edge when the requested behavior is supported and fall back to container when it is not.

This mode is important because it turns backend choice into a product routing decision rather than a manual all-or-nothing switch.

## Shadow Mode And Canary Mode In Product Terms

These two concepts serve different product jobs.

### Shadow Mode

Shadow mode means:

- the primary backend still determines the user-visible result,
- the edge backend runs the same turn in parallel for comparison,
- the comparison is used for logging, validation, and confidence building,
- user-visible side effects should remain controlled.

Shadow mode answers: “How close are we before we trust edge on real traffic?”

### Canary Mode

Canary mode means:

- a small subset of real production traffic is actually served by the edge backend,
- results are real and user-visible,
- traffic scope is intentionally limited,
- rollback to container remains easy.

Canary mode answers: “Can edge safely take responsibility for real traffic at small scale?”

The target product should support both.

## How The System Works Internally

The target internal flow looks like this:

1. message or task enters the control plane,
2. NanoClaw resolves the relevant logical session,
3. NanoClaw creates a durable execution record,
4. NanoClaw packages prompt, memory, workspace, and policy into an execution request,
5. NanoClaw selects `container`, `edge`, or fallback behavior,
6. the backend emits explicit events such as `ack`, `heartbeat`, `output`, `checkpoint`, `final`, or `error`,
7. NanoClaw persists execution progress centrally,
8. workspace overlays are validated and committed centrally,
9. the logical session is updated,
10. the execution is finalized as committed, completed, failed, or lost.

This is the key architectural promise of the product: edge execution can be transient because the product-level truth is stored elsewhere.

## Product Boundaries In Version One

The design intentionally keeps v1 constrained.

### Supported v1 Direction

The target v1 product should support:

- one execution per turn,
- durable execution state,
- structured event streaming,
- minimal JS tool host,
- versioned workspace commits,
- explicit fallback for unsupported capabilities,
- shadow comparison,
- small-scope canary rollout.

### Explicit Non-Goals For v1

The target v1 product does not need to support:

- arbitrary shell access on edge,
- long-lived interactive execution sessions with mid-run message injection,
- perfect parity with container semantics in all edge cases,
- making edge workers the system of record,
- solving every cross-runtime capability gap before the first canary.

The point of v1 is safe product evolution, not maximum feature surface.

## What “Ready For My First Canary” Means

For you personally, the product should count as ready for a first real canary only when all of the following are true:

- there is a real production-capable edge runner path rather than only a dev harness,
- critical runtime assumptions for filesystem, network, and abort behavior are validated,
- a small group-level allowlist can force selected traffic to edge,
- fallback to container is proven and operationally easy,
- execution outcomes are observable enough to detect success, timeout, fallback, and corruption risk,
- workspace commits are recoverable and stale writes are rejected safely.

That bar is lower than “full production rollout,” but higher than “the code compiles and local tests pass.”

## Example User Story For The Final Product

The clearest mental model is this:

> I register a group with NanoClaw, choose how aggressively I want to adopt edge execution, and then keep using the assistant normally while NanoClaw handles backend choice, fallback, state safety, and rollout controls for me.

A likely real progression would look like:

1. keep most groups on `container`,
2. enable shadow comparison for edge,
3. force one trusted group to `edge`,
4. observe logs and behavior,
5. expand to a slightly larger canary,
6. eventually move suitable traffic to `auto` or `edge` by default.

That is the intended product journey.

## Product Success Criteria

This target product shape is successful when NanoClaw can honestly claim all of the following:

- the same product behavior can run through either backend,
- central state remains authoritative,
- edge execution is explicit and policy-bounded,
- workspace mutations are recoverable,
- unsupported behavior falls back cleanly,
- shadow mode and canary rollout are both practical,
- adopting the edge backend feels like a controlled product decision rather than a risky infrastructure bet.

## Final Summary

The target product is best understood as a safer, more operable, runtime-flexible NanoClaw.

Its value is not only that it can run on EdgeJS. Its deeper value is that it turns execution into a controlled product surface:

- pluggable,
- observable,
- recoverable,
- policy-bounded,
- canaried gradually,
- and reversible when needed.

That is the concrete product shape this design is trying to create.
