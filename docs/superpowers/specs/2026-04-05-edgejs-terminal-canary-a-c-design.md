# EdgeJS Terminal Canary A+C Design

Date: 2026-04-05
Status: Implemented
Audience: Product owner / operator / implementer
Scope: Improve the local EdgeJS terminal canary experience through output noise reduction and session control

## Purpose

The first EdgeJS terminal canary is already functionally usable:

- real OpenAI-compatible provider calls work,
- `workspace.*`, `task.*`, and `js.exec` are connected,
- scheduled tasks can run through the edge path,
- the product can now be exercised locally in a terminal chat flow.

The next problem is not missing capability. It is user experience instability.

Two issues are currently visible:

- too much intermediate tool chatter reaches the terminal,
- recovery, pending messages, and scheduled tasks can leak into the foreground chat experience.

This design focuses on the smallest product changes that make the terminal canary feel personally usable for ongoing evaluation.

## Goal

Make the terminal canary feel like a coherent chat product:

- foreground questions should normally yield one clear final answer,
- intermediate tool activity should stay mostly hidden,
- scheduled task output should not pollute active terminal conversation,
- restart and recovery should not unexpectedly replay stale content into the live terminal session,
- existing working edge capabilities must remain available.

## Non-Goals

This design does not attempt to:

- redesign the full execution architecture,
- remove scheduled tasks from the shared group model,
- invent a brand new session database schema,
- replace the current tool system,
- solve every concurrency case across every channel.

This is a canary-hardening pass, not a platform rewrite.

## Recommended Approach

The recommended approach is **orchestration-layer convergence first**.

This means the product should rely less on prompt obedience for a clean UX and instead make the host orchestration path responsible for what reaches the terminal.

Why this approach wins now:

- it directly addresses the current failure mode,
- it is more deterministic than prompt-only cleanup,
- it preserves the working tool/runtime path,
- and it can be implemented with targeted changes in the backend, scheduler, terminal channel, and startup flow.

## User Experience Changes

### 1. Foreground chat becomes final-answer first

For terminal chat, the default visible behavior should be:

- show the assistant's final user-facing answer,
- suppress low-value intermediate tool progress lines,
- allow explicit operation receipts only when they are part of the intended user result.

Examples:

- a weather lookup should show the answer, not each internal tool hop,
- a file read should show the requested summary, not the entire tool transcript,
- a task mutation may show one concise receipt plus the final result if the prompt asked for confirmation.

### 2. Scheduled task output becomes background-safe

Scheduled tasks may still emit messages to the same group, but they should not behave like foreground interactive chat.

The product should:

- avoid streaming intermediate tool chatter from scheduled tasks,
- emit only the final task result,
- and keep scheduled task activity from being mistaken for a reply to the user's current terminal question.

### 3. Restart and recovery become quieter

When the app starts and finds pending work, it should avoid surprising the terminal operator with stale outputs from a previous run unless those outputs are still clearly actionable.

For the canary phase, the bias should be toward safety and quietness rather than replay eagerness.

## Architecture Changes

### A. Output filtering in `edge-backend`

`src/backends/edge-backend.ts` becomes the first place that decides whether a model/tool event is user-visible.

It should classify outgoing text into three rough categories:

- final answer,
- concise operation receipt,
- hidden intermediate progress.

The terminal canary should expose only the first category by default, and selectively expose the second category for mutation-style tools such as `task.create`, `task.update`, and `task.delete`.

This keeps the filtering logic close to execution semantics rather than scattering it across callers.

### B. Background task output policy in `task-scheduler`

`src/task-scheduler.ts` should treat scheduled tasks as background runs with an explicit quiet-output policy.

The scheduler should:

- ignore intermediate streamed tool messages,
- keep only the last meaningful final output,
- send at most one terminal-visible completion message per run.

If a task run fails, it should still emit one clear failure result rather than a half-streamed transcript.

### C. Foreground session protection in startup and routing

`src/index.ts` should reduce foreground contamination from recovery and residual pending messages.

The design intention is:

- old pending messages should not unexpectedly masquerade as answers to a fresh terminal prompt,
- recovery should prefer bounded replay behavior,
- one active foreground turn per terminal group should be the working assumption.

This does not require a new global session architecture yet. A light session fence is enough for canary:

- identify active foreground terminal turn,
- avoid sending stale completion output after a newer user turn has already started,
- and avoid replaying obsolete pending messages into the live terminal UX.

### D. Presentation cleanup in `terminal` channel

`src/channels/terminal.ts` should apply a last-mile display cleanup layer:

- ignore exact duplicate consecutive assistant messages,
- avoid rendering empty/noise-only lines,
- shift the terminal from a log console into a chat-first shell,
- preserve a light chat interface with `you`, `andy`, and `system` roles.

This layer should remain intentionally thin. The main semantics should still live upstream.

### E. Terminal product shell

The terminal canary should borrow the good parts of Claude Code's interaction shape without becoming a heavy full-screen TUI.

Default shell behavior:

- the main view is chat-first,
- startup logs are not the main experience,
- a single bottom prompt line carries compact runtime state,
- and only a small number of system events interrupt the conversation.

The shell should provide:

- a compact status line showing execution mode, provider, model, tool state, group, and task counts,
- local slash commands for `/help`, `/status`, `/tasks`, `/clear`, and `/quit`,
- system event rendering for high-value runtime changes such as scheduled task start, completion, failure, and retries,
- and hidden-by-default routine logger noise.

## Data Flow

### Foreground terminal prompt

1. user sends a terminal message,
2. execution starts for the terminal group,
3. edge/backend events stream internally,
4. backend filters intermediate tool chatter,
5. only the current foreground turn's final answer is rendered to terminal,
6. the prompt re-renders with a fresh compact status line.

### Scheduled task run

1. scheduler finds a due task,
2. task runs through the same edge path,
3. intermediate tool chatter is retained internally if needed but not surfaced to terminal,
4. one final result message is emitted if the run completes or fails visibly.

### Startup recovery

1. app starts,
2. recovery identifies pending messages or unfinished work,
3. stale items are bounded or muted for terminal foreground UX,
4. current terminal usage starts from a clean conversational state whenever possible.

## Error Handling

The system should prefer one explicit result over noisy partial traces.

### Tool or runner failure

- do not leak a cascade of repeated progress messages,
- return one concise failure message,
- keep logs and persisted execution state detailed enough for debugging.

### Deadline or cancellation

- terminal user should see one terminal-safe failure result,
- stale completion output arriving later should be ignored if superseded by a newer foreground turn.

### Recovery ambiguity

- if the system cannot confidently determine whether a pending item still belongs in foreground UX, it should bias toward not surfacing it automatically.

## Testing Strategy

The implementation should be validated at three levels.

### Unit / focused tests

- output filtering behavior in `edge-backend`,
- scheduled task output suppression and single-final-message behavior,
- terminal duplicate suppression,
- recovery/session-fence decisions.

### Integration tests

- terminal ask with tool use returns one clean visible answer,
- scheduled task run does not interleave noisy progress into foreground chat,
- restart with pending messages does not replay stale outputs as a new answer.

### Manual canary checks

- ask a normal question and verify only one final answer appears,
- run `workspace.read` and verify no tool-call spam,
- create/update/delete a task and verify concise receipts,
- run `/status` and `/tasks` and verify they return immediately without using the model,
- restart during/after activity and verify stale chatter does not flood terminal,
- let a scheduled task fire while chatting and verify the outputs stay understandable.

## Acceptance Criteria

- terminal interactive prompts no longer spam multiple `正在调用工具` messages by default,
- terminal usually shows a single final answer for one user turn,
- scheduled tasks produce at most one final visible message per run,
- stale recovery output does not surprise the operator after restart,
- working tools (`workspace.*`, `task.*`, `js.exec`) still function,
- terminal UI exposes a clean chat shell with status and slash commands,
- build and targeted edge tests continue to pass.

## Risks And Trade-Offs

### Risk: hiding too much information

If filtering is too aggressive, debugging can become harder.

Mitigation:

- keep detailed logs and persisted execution events,
- keep filtering focused on terminal user-facing output only.

### Risk: light session fencing is imperfect

The canary solution may not solve every future multi-channel concurrency case.

Mitigation:

- intentionally scope this pass to terminal canary stability,
- defer full session isolation to a later deeper design if still needed.

### Risk: duplicated filtering logic

If both backend and terminal channel try to own semantics, behavior may drift.

Mitigation:

- keep semantic filtering in `edge-backend`,
- keep `terminal.ts` limited to last-mile dedupe and display hygiene.

## Implementation Slice

This design is intended to ship as one narrow hardening slice:

1. backend output filtering,
2. scheduler background output cleanup,
3. startup/session guardrails,
4. terminal last-mile dedupe,
5. focused regression coverage.

That is enough to move the canary from “technically works” to “reasonable for personal ongoing use.”
