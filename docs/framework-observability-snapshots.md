# Framework Observability Snapshots

`framework_observability.json` is a read-only IPC snapshot for tooling that needs a stable view of claw-framework routing and execution state without talking to SQLite directly.

## File Location

Per group:

- `data/ipc/<groupFolder>/framework_observability.json`

The path is resolved by `resolveGroupIpcPath(groupFolder)` and stays inside `DATA_DIR/ipc`.

## Current Write Behavior

The snapshot is currently written when:

- a group turn is routed to the heavy runtime,
- a scheduled task is routed to the heavy runtime,
- task snapshot refresh runs through `onTasksChanged`.

This means consumers should treat the file as a best-effort latest snapshot, not as an append-only event log.

## Top-Level Shape

```json
{
  "scope": { "kind": "group", "id": "team_alpha" },
  "generatedAt": "2026-04-07T00:01:00.000Z",
  "governance": {},
  "routes": [],
  "executions": []
}
```

## Fields

### `scope`

- `{ "kind": "group", "id": "<groupFolder>" }` for per-group snapshots
- `{ "kind": "global" }` is reserved for future global exports

### `generatedAt`

- ISO timestamp for snapshot generation time

### `governance`

Roll-up metrics derived from durable graph/task/execution state:

- `totalGraphs`
- `totalExecutions`
- `routeReasonCounts`
- `workerClassCounts`
- `edgeOnlyCompletionRate`
- `edgeToHeavyFallbackRate`
- `averageFanoutWidth`
- `averageGraphCompletionLatencyMs`
- `commitSuccessRate`
- `commitConflictRate`

### `routes`

One entry per task node visible in the snapshot scope:

- `graphId`
- `taskId`
- `nodeKind`
- `workerClass`
- `backendId`
- `requiredCapabilities`
- `routeReason`
- `policyVersion`
- `fallbackEligible`
- `fallbackTarget`
- `fallbackReason`

Useful examples:

- `fallbackTarget: "heavy"` means edge work escalated to container
- `fallbackTarget: "replan"` means execution stopped and control plane requires replanning

### `executions`

One entry per execution attempt in scope:

- `executionId`
- `graphId`
- `taskNodeId`
- `backend`
- `workerClass`
- `routeReason`
- `policyVersion`
- `status`
- `queueDelayMs`
- `durationMs`
- `timedOut`
- `heartbeatHealth`
- `toolCallCount`
- `workspaceChangeCount`
- `workspaceOverlayBytes`
- `commitStatus`

Important values:

- `status: "failed"` with `commitStatus: "conflict"` usually means workspace conflict / replan path
- `backend: "edge"` then `backend: "container"` for the same task node indicates edge→heavy fallback
- `timedOut: true` covers timeout-like failures including deadline errors

## Example Reads

Print the whole snapshot:

```bash
cat data/ipc/team_alpha/framework_observability.json
```

Read only governance summary:

```bash
jq '.governance' data/ipc/team_alpha/framework_observability.json
```

List fallback/replan route outcomes:

```bash
jq '.routes[] | select(.fallbackTarget != null) | {taskId, fallbackTarget, fallbackReason}' \
  data/ipc/team_alpha/framework_observability.json
```

List failed executions:

```bash
jq '.executions[] | select(.status == "failed") | {executionId, backend, commitStatus, timedOut}' \
  data/ipc/team_alpha/framework_observability.json
```

## Consumer Guidance

- Prefer polling the JSON file over scraping logs.
- Treat unknown fields as forward-compatible additions.
- Do not assume the snapshot exists before the first write trigger.
- Do not mutate the file in place; it is owned by NanoClaw.
