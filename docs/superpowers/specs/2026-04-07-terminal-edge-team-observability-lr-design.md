# Terminal Edge Team Observability LR

Date: 2026-04-07
Status: Internal design draft
Audience: Product owner / builder / dogfooding operator
Scope: Define a dedicated launch review task that validates terminal-visible parallel execution of multiple edge agents in NanoClaw

## One-Sentence Definition

This launch review is a terminal-only acceptance flow that proves one user prompt can trigger a real multi-agent edge fanout, and that the operator can observe that fanout through terminal-native surfaces before, during, and after completion.

## Why This LR Exists

NanoClaw already has two adjacent but different validation shapes:

- general terminal dogfooding for startup, `/status`, light prompts, and task flows,
- edge concurrency review for validating that team fanout exists as a real execution path.

Those two documents are useful, but neither is optimized for the product question you want answered:

> Can an operator stay inside the terminal and directly observe multiple edge agents running in parallel for one LR task?

That question is narrower than general dogfooding and more operator-facing than a backend-only launch review. It requires a dedicated runbook because the acceptance criteria are not just “did the prompt eventually work.” The operator must be able to see the fanout happen through the terminal experience itself.

## Product Question This LR Must Answer

This LR exists to answer one concrete product question:

> When a user sends a terminal prompt that explicitly requests a small edge agent team, does NanoClaw expose enough real-time evidence in terminal-native surfaces to make that parallelism observable and trustworthy?

If the answer is yes, then NanoClaw has crossed an important threshold:

- the system is not only capable of internal fanout,
- the operator can also verify that fanout without leaving the terminal,
- and the terminal experience is beginning to feel like a real multi-agent product rather than a single opaque assistant.

## What This LR Validates

This LR validates the following product behavior as one coherent flow:

1. a fixed launch review prompt triggers edge team orchestration,
2. the terminal front-end acknowledges that fanout has started,
3. `/agents` exposes multiple worker entries while the turn is live,
4. `/graph` exposes the root, child, and aggregate structure for that turn,
5. the final assistant output contains role-specific sections plus a unified summary,
6. the entire turn remains on the edge plane,
7. supporting observability data can confirm what the terminal surfaces showed.

The core acceptance idea is simple:

**parallelism must be visible, not merely inferable after the fact from database rows.**

## What This LR Does Not Validate

This LR is intentionally narrow. It does not validate:

- generic terminal startup and baseline health beyond the minimum needed to run the LR,
- single-agent light prompt quality,
- heavy or container fallback behavior,
- replan / commit-conflict recovery loops,
- browser or app execution,
- non-terminal channels such as WhatsApp, Telegram, or Feishu,
- large swarms or production-scale concurrent rollout.

If one of those areas needs validation, it should remain in the general dogfooding or broader framework launch review documents.

## Recommended Validation Shape

The validation flow should be centered on one fixed prompt and three terminal-visible checkpoints.

### Fixed Prompt

The operator sends one fixed prompt that asks for a `3-agent team` to produce the next terminal-only launch review plan.

The prompt should continue to use the same conceptual split because it naturally maps onto three workers:

- goals and acceptance criteria,
- risks and failure points,
- execution steps and result-recording template.

This keeps the scenario stable across repeated LR runs and makes it easy to compare regressions.

### Checkpoint 1: Front-End Start Signal

The terminal front-end must show a fanout-start acknowledgment before the final answer arrives.

This start signal does not need to expose every worker event as a hard requirement. The minimum product requirement is that the user can tell the system has transitioned from “single opaque turn” to “parallel team execution in progress.”

The recommended acceptance text is the existing style:

- `已启动 3 个 edge agents 并行处理，正在等待汇总结果。`

This is important because it changes the product feel from passive waiting to explicit orchestration.

### Checkpoint 2: Live Team Observability

While the turn is still active, the operator runs:

- `/agents`
- `/graph`

These two commands are the hard observability surfaces for this LR.

`/agents` is the operator’s high-level runtime view. It should make it obvious that there are multiple workers associated with the current team graph. The hard acceptance requirement should be:

- the selected graph is a team graph,
- at least two worker entries are visible,
- the response identifies worker labels such as `worker 1`, `worker 2`, and optionally `aggregate`,
- backend is shown as `edge`,
- status/health data is present.

`/graph` is the operator’s structural view. It should make the orchestration graph explicit. The hard acceptance requirement should be:

- the selected graph is the current turn’s graph,
- the graph contains `root`, `fanout_child`, and `aggregate` nodes,
- route reasons identify team fanout and aggregate behavior,
- execution status is visible per node.

These two commands together are the main proof that multiple edge agents are truly running in parallel for one LR task.

### Checkpoint 3: Final Product Output

After the turn completes, the final assistant message must show that the team fanout converged into one coherent answer.

The final output should include:

- three role-specific sections that correspond to the worker split,
- one concise merged plan or summary,
- optional follow-up task IDs if task creation is included in the scenario.

This output is not only a content check. It is also the product-level confirmation that the user experience did not stop at internal orchestration and reached a usable terminal result.

## Hard Acceptance Criteria

This LR should be considered passing only if all of the following are true for one run:

- the fixed `3-agent team` prompt is accepted and begins execution,
- the terminal front-end shows a fanout-start acknowledgment before the final answer,
- `/agents` shows multiple worker entries for the current team graph,
- `/graph` shows root, fanout child, and aggregate nodes for the same graph,
- the worker/backend information shown by terminal surfaces is `edge`,
- the final assistant output contains role-specific results plus one unified summary,
- the turn does not require heavy/container fallback to pass.

The following are useful but should remain soft checks rather than hard blockers:

- whether every worker emits an individually visible system event,
- whether follow-up tasks are created in the same LR run,
- whether the operator also inspects raw sqlite rows.

Those soft checks add confidence, but they are not the core product question.

## Failure Classes

The runbook should classify failures by what product promise was broken.

### Class 1: No Fanout Trigger

The prompt is treated like an ordinary single-agent request.

Meaning:

- the product failed to expose the team capability at all.

### Class 2: Fanout Exists But Is Not Terminal-Visible

Backend records may show multiple executions, but `/agents` or `/graph` does not make that obvious during the run.

Meaning:

- the orchestration exists,
- but the terminal product surface is too opaque.

This class is especially important because it is the exact gap this LR is designed to catch.

### Class 3: Fanout Is Visible But Final Join Is Poor

The operator can see multiple workers, but the final answer lacks recognizable role sections or lacks a useful summary.

Meaning:

- runtime observability is present,
- but the end-user product shape is not yet coherent.

### Class 4: Edge Team LR Falls Out Of Edge

The run only succeeds by hitting heavy/container fallback.

Meaning:

- the product cannot yet claim terminal-visible edge team execution as a first-class path.

This should be a hard fail for this LR.

## Recommended Runbook Structure

The dedicated runbook derived from this spec should be short and operator-oriented.

Recommended sections:

1. purpose and scope,
2. prerequisites,
3. fixed prompt,
4. live execution steps,
5. `/agents` acceptance checks,
6. `/graph` acceptance checks,
7. final output acceptance checks,
8. optional supporting observability checks,
9. pass/fail template.

The most important design choice is to keep `/agents` and `/graph` near the center of the flow, not as optional appendix steps.

## Relationship To Existing Documents

This new LR should not replace the existing documents.

Instead, the document set should become clearer:

- the general terminal dogfooding runbook remains the baseline health check,
- the edge concurrency launch review remains the broader fanout validation and historical implementation record,
- this new terminal edge team observability LR becomes the product-facing acceptance runbook for “can I observe multiple edge agents from inside terminal?”

This separation reduces confusion because each document answers a different question.

## Design Recommendation

Create a dedicated runbook for terminal edge team observability rather than continuing to overload the current edge concurrency runbook.

This is the right choice because the acceptance target is different:

- not only backend truth,
- not only final answer quality,
- but live operator visibility through terminal-native commands.

That is a distinct product requirement and deserves its own explicit LR.
