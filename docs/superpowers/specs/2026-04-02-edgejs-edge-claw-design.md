# EdgeJS Edge-Claw Design

Date: 2026-04-02
Status: Approved for implementation planning
Scope: Replace NanoClaw's container-based execution layer with an EdgeJS-based execution backend while keeping central orchestration and state authoritative.

## Summary

This design keeps NanoClaw's current control plane centered in the main Node.js process and replaces the container execution layer with a new EdgeJS-backed execution backend. The first implementation targets strong centralized state, one turn per execution, and a constrained JavaScript tool model instead of shell access.

The design intentionally does not attempt to preserve Claude Code or Claude Agent SDK execution semantics. It preserves NanoClaw's product behavior instead: grouped conversations, scheduled tasks, message routing, per-group memory, multi-turn sessions, and recoverable execution state.

## Goals

- Run agent execution on EdgeJS instead of Docker-based container workers.
- Keep the orchestrator, database-backed state, queueing, and scheduler as the source of truth.
- Preserve multi-turn conversations and scheduled tasks.
- Replace Bash-centric tool execution with explicit, policy-controlled JavaScript tools.
- Make execution recoverable when an edge node fails.
- Allow staged rollout alongside the existing container backend.

## Non-Goals

- Preserve Claude Code's exact tool protocol or permission model.
- Support arbitrary shell commands, child processes, or browser automation in v1.
- Make edge nodes the authoritative store for sessions, tasks, or workspace state.
- Support feeding follow-up messages into an already-running execution in v1.
- Solve cross-region consistency in the first design.

## Why This Design

NanoClaw's current execution path is deeply container-oriented. The host process validates a container runtime at startup, constructs `docker run` arguments with bind mounts, and spawns a dedicated container for each agent execution. The container-side runner depends on Claude Agent SDK semantics, filesystem IPC, MCP stdio subprocesses, and optional Bash script execution. That model does not map cleanly to an EdgeJS deployment target.

The recommended path is therefore product-layer compatibility with execution-layer replacement:

- keep the existing orchestration model,
- define an execution backend abstraction,
- implement a new EdgeJS execution backend,
- move tool execution to explicit JavaScript APIs,
- retain the container backend as a fallback during rollout.

## Architecture Overview

```text
Channels / Scheduler / Webhooks
            |
            v
Central Orchestrator
(message ingest, queueing, routing, state transitions)
            |
            v
Execution Dispatcher
(backend selection, execution lease, streaming events)
            |
            v
EdgeRunner on EdgeJS
(LLM loop, JS tool host, temporary workspace overlay)
            |
            v
Central State Store / Object Store / Credential Gateway
```

The central process remains responsible for message ingestion, routing, task scheduling, group registration, and durable state. EdgeJS nodes become stateless or near-stateless execution workers that can be replaced, retried, or drained without losing canonical session state.

## Chosen Approach

The chosen architecture is:

- strong centralized state,
- one execution per turn,
- explicit execution RPC instead of filesystem IPC,
- structured JavaScript tools instead of Bash,
- backend pluggability so `container`, `edge`, and `auto` execution modes can coexist.

This is preferred over trying to port the current container runner directly because the current runner depends on Docker-specific filesystem boundaries and Claude-specific runtime conventions. A direct port would produce a brittle compatibility layer instead of a clean edge-native execution model.

## System Boundaries

### Control Plane

The existing central orchestrator remains authoritative for:

- channel connections and inbound message ingestion,
- message storage and routing state,
- group registration and metadata,
- scheduled task definitions and due-task enqueueing,
- concurrency control and retries,
- execution leases, cancellation, and commit decisions.

The current `src/index.ts`, `src/group-queue.ts`, `src/task-scheduler.ts`, and `src/db.ts` remain the conceptual backbone of the product.

### Execution Plane

The new execution plane is an EdgeJS-based backend that receives one turn at a time, runs the model loop, invokes a bounded set of tools, emits streaming events, and returns a final execution result for central commit.

The edge execution plane is not the source of truth. It may keep a temporary hydrated workspace and temporary provider-specific session material, but it must be safe to lose that state at any time.

## Backend Abstraction

Introduce an execution backend interface so the rest of the orchestrator does not depend on container mechanics.

```ts
interface AgentBackend {
  runTurn(request: ExecutionRequest, hooks: ExecutionHooks): Promise<RunResult>;
  cancel(executionId: string): Promise<void>;
}
```

`GroupQueue` and the orchestrator talk only to this abstraction. The initial implementations are:

- `ContainerBackend`: wraps the current container execution path.
- `EdgeBackend`: dispatches a turn to EdgeJS and consumes its event stream.

Per-group or per-task configuration chooses `container`, `edge`, or `auto`.

## State Model

The first implementation uses strong centralized state. Durable state is committed centrally. Edge nodes only hold recoverable working state.

### LogicalSession

`LogicalSession` is the product-level session record and is independent of any one model provider. It contains:

- `logicalSessionId`
- `groupId` or `taskId`
- `lastTurnId`
- `workspaceVersion`
- `groupMemoryVersion`
- `summaryRef`
- `recentMessagesWindow`
- `providerSessionRef` if available
- `status`

This allows NanoClaw to preserve conversation semantics even if model providers or execution backends change.

### ProviderSession

Provider-specific session resume data is stored separately as an optimization. If a model backend supports resume tokens or conversation identifiers, NanoClaw stores them. If not, the orchestrator reconstructs prompt context from the logical session plus summary and recent history.

### CursorState

Message handling state is centralized and explicit:

- `ingestCursor`: newest message seen by the ingest loop
- `agentCursor`: newest message durably incorporated into an agent turn
- `lastCommittedTurnId`

An inbound message is not considered incorporated into the assistant state until the corresponding turn is durably committed.

### WorkspaceState

Each group gets a versioned workspace manifest stored centrally. The manifest maps paths to immutable blobs and metadata. Edge execution hydrates files on demand into a temporary overlay. Changes are returned as file operations or blobs and committed centrally against a `baseWorkspaceVersion`.

This makes failed executions easy to discard and prevents edge-local workspaces from becoming stateful truth.

### MemoryState

Memory is split into four layers:

- global memory,
- group memory,
- session summary,
- task-scoped memory.

`group memory` may continue to be user-visible in a `CLAUDE.md`-like format, but the authoritative copy is versioned centrally. Session summaries are system-managed artifacts used for compaction and recovery.

### ExecutionState

Every dispatched turn creates a durable execution record with:

- `executionId`
- `logicalSessionId`
- `turnId`
- `groupId`
- `backend`
- `edgeNodeId`
- `baseWorkspaceVersion`
- `leaseUntil`
- `status`
- `lastHeartbeatAt`

No turn is considered committed until central state updates succeed.

## Execution Model

Version one uses one execution per turn. New inbound messages never get injected into an already-running execution. Instead, they are stored, the current turn finishes or is cancelled, and the next turn includes the new context.

This reduces protocol complexity, simplifies retries, and removes the need for the current container model's long-lived IPC input stream.

## Execution Protocol

Replace filesystem IPC with a streaming RPC protocol.

### ExecutionRequest

```ts
type ExecutionRequest = {
  executionId: string;
  logicalSessionId: string;
  groupId: string;
  chatJid: string;
  turnId: string;
  modelProfile: string;
  promptPackage: {
    system: string;
    summary: string | null;
    recentMessages: Array<{ role: 'user' | 'assistant'; content: string }>;
    taskContext?: unknown;
  };
  workspace: {
    baseVersion: string;
    manifestRef: string;
  };
  memory: {
    groupMemoryVersion: string;
    globalMemoryVersion?: string;
  };
  limits: {
    maxToolCalls: number;
    deadlineMs: number;
    maxOutputBytes: number;
  };
  policy: {
    allowedTools: string[];
    networkProfile: string;
  };
};
```

### ExecutionEvent

```ts
type ExecutionEvent =
  | { type: 'ack'; executionId: string; nodeId: string }
  | { type: 'heartbeat'; executionId: string; at: string }
  | { type: 'output_delta'; executionId: string; text: string }
  | { type: 'output_message'; executionId: string; text: string }
  | { type: 'tool_call'; executionId: string; tool: string; args: unknown }
  | { type: 'tool_result'; executionId: string; tool: string; result: unknown }
  | {
      type: 'checkpoint';
      executionId: string;
      providerSession?: unknown;
      summaryDelta?: string;
      workspaceOverlayDigest?: string;
    }
  | { type: 'final'; executionId: string; result: FinalResult }
  | { type: 'error'; executionId: string; code: string; message: string };
```

This protocol removes the need for long-lived mounted IPC directories and makes execution behavior explicit, observable, and backend-agnostic.

## EdgeRunner Responsibilities

`EdgeRunner` runs on EdgeJS and owns:

- prompt assembly from the execution request,
- the model loop,
- structured tool invocation,
- local temporary workspace overlay,
- event emission back to the dispatcher,
- periodic checkpointing,
- clean stop on cancel or deadline.

`EdgeRunner` does not own durable state transitions. It proposes them via events.

## Tool Model

The v1 tool model replaces shell access with explicit JavaScript tools.

### Local Edge Tools

These tools execute entirely inside the EdgeRunner process:

- `workspace.read`
- `workspace.list`
- `workspace.search`
- `workspace.write`
- `workspace.apply_patch`
- `text.diff`
- `json.parse`
- `markdown.render` or similar pure transforms

These tools operate only on the current execution's workspace overlay and visible manifest.

### Control Plane Tools

These tools are executed via the central orchestrator because they mutate system-level state:

- `message.send`
- `task.create`
- `task.list`
- `task.update`
- `group.list`
- `group.register`
- `workspace.commit`
- `memory.update`

### Policy-Controlled External Tools

These tools run through centralized policy and credential gateways:

- `http.fetch`
- `search.web`
- `repo.readonly` or `git.readonly`
- credentialed external API calls

### Explicitly Unsupported in v1

- `Bash`
- `child_process`
- browser automation
- arbitrary MCP sidecars spawned by the agent
- unrestricted filesystem traversal outside the workspace root

## Workspace Design

Each execution receives a `baseWorkspaceVersion` and a manifest reference. The edge node hydrates only what it needs. Writes go to a temporary overlay. On `final`, the edge node returns a set of file operations or blob deltas. The central orchestrator validates that the workspace still matches `baseWorkspaceVersion` and then commits a new version.

Normal per-group serialization means most commits will succeed without conflict, but version checks remain necessary for replay safety and operator-initiated retries.

## Scheduled Tasks

Scheduled tasks remain centrally scheduled.

- `group` context tasks reuse the group's logical session.
- `isolated` context tasks create or resume a dedicated logical session.

Both modes can share group-level memory and workspace subject to policy, but only `group` mode includes recent conversational history by default.

## Failure Handling

Failure handling follows a lease-based model.

- Dispatcher creates an `ExecutionState` with a lease.
- EdgeRunner sends heartbeats.
- If heartbeats stop, the execution is marked lost.
- Uncommitted overlay changes are discarded.
- The group is re-queued based on central state.

This ensures an edge node crash never creates ambiguous partial truth.

## Idempotency

Every side-effecting operation must be idempotent. `message.send`, `task.create`, `task.update`, `workspace.commit`, and memory updates carry stable operation identifiers such as `executionId + stepIndex`.

If the same operation is replayed during retry, the central control plane returns the prior result instead of performing the side effect twice.

## Cancellation and Timeouts

Cancellation has two levels:

- soft cancel: the execution is marked `cancel_requested`; the runner stops at the next safe checkpoint,
- hard deadline: the dispatcher terminates the execution lease when `deadlineMs` is exceeded.

Because v1 uses one execution per turn, cancellation semantics stay simple and do not require a streaming follow-up message protocol.

## Security Model

The container design relied heavily on runtime isolation and explicit mounts. The EdgeJS design shifts that boundary into the tool and policy layers.

The v1 security rules are:

- edge nodes never receive raw long-lived secrets,
- external access uses short-lived execution-scoped credentials or a central gateway,
- the available tool set is an allowlist with no shell fallback,
- workspace tools are root-confined to the assigned group workspace view,
- network access is controlled by a named egress policy.

This preserves the important safety property of the current system: the agent cannot silently escape into unrestricted host access.

## Rollout Strategy

Implement the new backend incrementally.

1. Introduce the `AgentBackend` abstraction and wrap the existing container runner first.
2. Introduce central `LogicalSession`, `WorkspaceState`, and `ExecutionState` records while keeping the container path functional.
3. Implement a local-development `EdgeBackend` that runs on one machine for protocol validation.
4. Launch edge execution with a minimal tool set only.
5. Run shadow-mode comparisons against the container backend.
6. Enable canary rollout by group or task.
7. Support `container`, `edge`, and `auto` execution modes in configuration.
8. Keep the container backend as the operational fallback until the edge backend demonstrates stable parity for the supported tool subset.

## Testing Strategy

The testing plan is part of the design, not a follow-up convenience.

### Backend Contract Tests

Both backends must pass the same suite for:

- starting a turn,
- streaming output,
- final result handling,
- cancellation,
- timeout behavior,
- retry-safe error handling.

### Tool Tests

Test the first-party tool set for:

- correct behavior,
- root confinement,
- path traversal resistance,
- deterministic patch application,
- duplicate operation handling.

### Recovery Tests

Simulate:

- edge heartbeat loss,
- repeated `final` events,
- workspace commit conflicts,
- success at the edge followed by commit failure in the control plane,
- cancellation races.

### Comparison Tests

Run identical scenarios against `container` and `edge` backends and compare:

- user-visible messages,
- final workspace changes,
- task side effects,
- error classes.

The goal is behavioral parity for supported functionality, not identical token-by-token model output.

### Security Tests

Verify:

- secrets are not exposed to edge runners,
- cross-group workspace access is blocked,
- disallowed tools cannot be invoked,
- unauthorized external destinations are denied.

## Operational Modes

Each group or task can choose one of three execution modes:

- `container`: always use the current container backend,
- `edge`: always use the new EdgeJS backend,
- `auto`: select the backend based on feature support and rollout policy.

This keeps rollout safe and gives operators an immediate fallback when unsupported behavior is requested.

## Major Tradeoffs

This design makes three intentional tradeoffs.

First, it gives up shell-level expressiveness in exchange for deterministic, policy-controlled tools. Second, it prefers central durability over maximal edge autonomy, which slightly reduces purity of edge deployment but drastically improves recoverability. Third, it prefers one turn per execution instead of live message injection, which reduces interactivity during long-running tasks but keeps protocol, cancellation, and retry behavior tractable.

These tradeoffs are appropriate for a first edge-native execution backend.

## Implementation Readiness

This design is ready to move into implementation planning. The first implementation milestone is not a full deployment cutover. It is a backend abstraction plus a minimal EdgeJS execution path that supports:

- turn execution,
- centralized logical session recovery,
- workspace read and write via overlay,
- message sending,
- task creation and listing,
- controlled HTTP fetch,
- cancellation and retry.

Everything else remains on the container backend until explicitly ported.
