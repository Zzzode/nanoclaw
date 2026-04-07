# EdgeJS Edge-Claw First Canary Rollout Guide

Date: 2026-04-04
Status: Internal working draft
Audience: Product owner / operator
Scope: Describe how to run the first personal canary of NanoClaw's EdgeJS backend safely

## Purpose

This document is not a general architecture spec.

It is a practical rollout guide for the moment when NanoClaw moves from:

- “the edge backend exists and is promising”

to:

- “I am personally willing to let a very small amount of real traffic be served by the edge backend.”

The goal is to define what “first canary” means in concrete product terms, what switches matter, what to observe, and how to roll back quickly if the edge path behaves incorrectly.

## One-Sentence Rollout Strategy

The first canary should be a deliberately tiny, reversible, observable slice of real traffic where the edge backend is the primary executor for one trusted group or task scope while the container backend remains the operational fallback.

## What Counts As A First Canary

A first canary is **not**:

- a unit test,
- a local demo,
- a subprocess protocol harness,
- shadow mode only,
- or a wide production rollout.

A first canary **is**:

- real production traffic,
- returned to a real chat or task target,
- using the edge backend as the primary execution path,
- for a very small allowlisted scope,
- with immediate fallback and rollback available.

For your use case, the cleanest definition is:

> one trusted group, owned by you, carrying low-risk traffic, intentionally routed to the edge backend while the rest of the product remains on container or auto.

## Rollout Principles

The first canary should follow five principles.

### 1. Small Blast Radius

Use exactly one low-risk group first if possible. Do not start with a broad class of groups or all scheduled tasks.

### 2. Reversible Within Minutes

You should be able to switch the canary group back to `container` fast, without data migration, runtime surgery, or manual cleanup.

### 3. Observable Enough To Build Confidence

You do not need a full metrics platform for the first canary, but you do need enough visibility to answer:

- did edge run,
- did it succeed,
- did it fall back,
- did it time out,
- did it corrupt workspace behavior,
- did it produce obviously wrong output.

### 4. Edge Must Be Primary, Not Merely Observed

Shadow mode is useful before canary, but it is not canary. In a canary, the user-visible result must actually come from the edge backend for the chosen scope.

### 5. Container Remains The Safety Net

The container backend stays alive as the known-good baseline and rollback target until edge proves stable on the supported subset.

## Recommended Rollout Ladder

The intended progression should be:

1. local and integration validation,
2. shadow comparison on real traffic,
3. one-group personal canary,
4. a few trusted groups,
5. selected low-risk scheduled tasks,
6. wider `auto` adoption,
7. broader edge defaulting only after confidence is earned.

This guide only covers step 3.

## Preconditions Before You Start

Do not begin the first canary until these conditions are true.

### Product Preconditions

- backend selection works for `container`, `edge`, and `auto`
- per-group execution mode is configurable
- fallback behavior is explicit, not implicit
- workspace changes are committed centrally rather than trusted to edge-local state
- execution state is durable enough to inspect failures

### Runtime Preconditions

- the edge runtime path used for canary is production-capable, not only a dev subprocess harness
- filesystem confinement assumptions have been validated
- basic write semantics for overlay workloads are validated
- `http.fetch` behavior is validated for the intended network profile
- cancel and deadline behavior are validated enough to avoid zombie executions

### Operational Preconditions

- you know exactly which group is the canary target
- you have a clear rollback action
- logs or execution records are easy for you to inspect
- the canary group does not carry business-critical or high-consequence traffic

If these are not true yet, the right move is to keep using shadow mode and runtime hardening work rather than forcing a premature canary.

## Recommended First Canary Scope

The best first canary scope is usually:

- one personal or founder-controlled group,
- low message volume,
- low urgency,
- no irreversible external side effects,
- limited need for unsupported tools,
- a workspace that is useful but easy to inspect manually.

Avoid these for the very first canary:

- groups with high message volume,
- groups where wrong answers are costly,
- scheduled tasks that mutate many files or external systems,
- flows that rely on shell-like execution semantics,
- anything that depends on runtime features still known to be unproven.

## Execution Modes And Their Job In Rollout

Execution mode should be treated as a rollout control surface.

### `container`

This remains the stable baseline. Use it for:

- default safety,
- rollback,
- unsupported capabilities,
- groups you do not want to risk yet.

### `edge`

This is the direct canary mode. Use it when you want:

- the chosen scope to truly run on edge,
- real user-visible results from edge,
- confidence-building on actual traffic.

### `auto`

This is the adoption expansion mode, not necessarily the best very first canary mode.

It becomes more useful after the first canary succeeds, because it lets NanoClaw:

- prefer edge for supported requests,
- fall back to container when a request needs container-only behavior.

For the very first canary, forcing one group to `edge` is usually cleaner than relying on `auto`, because it makes the experiment easier to reason about.

## Role Of Shadow Mode Around Canary

Shadow mode should be treated as the stage immediately before or alongside first canary.

Use shadow mode to answer:

- are edge outputs roughly aligned,
- are tool calls behaving sensibly,
- do fallbacks happen more than expected,
- are there obvious quality or reliability gaps.

Then use canary mode to answer:

- can edge safely own the user-visible result for a tiny slice of real traffic.

Recommended sequence:

1. keep the target group on `container`,
2. run shadow comparisons for enough real requests to build trust,
3. switch exactly that group to `edge`,
4. continue observing,
5. switch back immediately if needed.

## Recommended First Canary Configuration

The simplest and safest configuration for a first personal canary is:

- global default execution mode remains `container`
- shadow mode may remain enabled for comparison on non-canary traffic
- one specific trusted group is forced to `edge`
- all other groups remain on `container` or `auto`
- fallback to container remains available at the orchestration layer

In product terms, this means:

- the product stays conservative by default,
- the canary scope is explicit,
- success or failure is easy to attribute,
- rollback is a one-setting decision rather than a system-wide event.

## Suggested Rollout Playbook

### Stage 0: Final Readiness Check

Before routing real traffic to edge, confirm:

- the runtime path is the intended one for canary,
- the selected canary group is low-risk,
- logs and execution state are inspectable,
- fallback and rollback behavior are understood.

This is the “am I actually ready to let edge own a reply” gate.

### Stage 1: Put One Group On Edge

Choose one trusted group and set its execution mode to `edge`.

Do not change other groups at the same time.

The desired property here is not scale. It is isolation.

### Stage 2: Exercise Normal Usage

Use the canary group for realistic traffic:

- ordinary conversational prompts,
- low-risk workspace reads,
- limited workspace writes if needed,
- a small amount of task interaction if relevant.

Do not start by stress-testing the hardest edge cases. Start by confirming that normal product use feels normal.

### Stage 3: Watch For Product-Level Failure Signals

During the first canary, monitor for:

- repeated execution failures,
- deadline or cancel anomalies,
- unexpected container fallbacks,
- broken workspace commits,
- clearly degraded output quality,
- missing continuity across turns,
- duplicate or lost messages,
- tool behavior that differs from expectation.

The first canary is successful only if the product still feels coherent to use, not merely if the process exits cleanly.

### Stage 4: Decide Quickly

After a modest set of real interactions, make one of three decisions:

- **continue** because the canary looks healthy,
- **pause and fix** because issues are real but bounded,
- **roll back immediately** because edge is not ready to own visible traffic.

The worst outcome is not a rollback. The worst outcome is dragging out an ambiguous canary while confidence silently erodes.

## What To Observe During The Canary

You should explicitly watch four categories.

### 1. Correctness

Ask:

- are replies coherent,
- is session continuity preserved,
- are task results sensible,
- do workspace reads and writes behave as intended.

### 2. Reliability

Ask:

- are executions completing,
- are deadlines firing too often,
- are cancellations clean,
- are there signs of lost execution or partial commit behavior.

### 3. Fallback Behavior

Ask:

- when the request is unsupported, does NanoClaw route cleanly,
- is fallback explicit and understandable,
- does fallback preserve the user experience rather than breaking it.

### 4. Operability

Ask:

- can you tell what happened after a run,
- can you identify edge vs container execution,
- can you see why a fallback occurred,
- can you decide confidently whether to continue or revert.

If you cannot answer those questions, the canary is under-observed.

## What Should Trigger Immediate Rollback

Rollback should be immediate if any of these occur in the canary scope:

- repeated visible wrongness in normal usage,
- evidence of unsafe workspace mutation behavior,
- inability to explain whether an execution committed,
- repeated deadline or abort path failures,
- inability to distinguish edge failures from orchestration failures,
- user-visible instability that would make you hesitate to keep using the group yourself.

Because this is your personal first canary, your own confidence threshold matters. If you no longer trust what edge is doing, switch the group back to `container` first and investigate second.

## Rollback Strategy

The rollback path should be intentionally boring:

1. switch the canary group from `edge` back to `container`,
2. stop expanding traffic,
3. preserve logs and execution records,
4. classify the failure:
   - runtime gap,
   - tool-host gap,
   - orchestration bug,
   - output-quality issue,
   - observability gap,
5. decide whether the fix belongs in NanoClaw or `edgejs`.

Do not try to rescue a bad canary by broadening fallback rules until you understand the failure. The first rollback goal is safety and clarity, not elegance.

## What Success Looks Like

A successful first canary does **not** mean:

- edge is ready for all traffic,
- container can be removed,
- every capability is proven,
- the runtime hardening list is complete.

A successful first canary **does** mean:

- one real group can use edge as the primary backend,
- the experience is good enough that you would keep using it,
- failures are understandable rather than mysterious,
- fallback remains trustworthy,
- the next step can be a slightly larger canary rather than a retreat to pure theory.

## What To Do After A Successful First Canary

If the first canary is healthy, the next move should be modest expansion, not instant generalization.

Recommended next steps:

1. keep the original canary group on edge a little longer,
2. add one or two more trusted groups,
3. consider low-risk scheduled tasks only after conversational traffic is stable,
4. keep container as the baseline,
5. continue runtime hardening work in parallel,
6. only then consider wider `auto` adoption.

The product should earn broader trust incrementally.

## Relationship To Current Known Gaps

This rollout guide assumes you still respect the known hardening gaps:

- filesystem confinement,
- overlay write semantics,
- network and TLS behavior,
- abort propagation,
- no-subprocess production runner path,
- runtime permission enforcement.

Those are not theoretical details. They are exactly the kinds of issues that can turn a good-looking demo into a bad canary.

So the first canary should be started only after you have a reasonable answer for each blocking gap in the actual path you intend to use.

## Practical Decision Rule

If you want a compact decision rule, use this one:

> I can start my first canary when one trusted group can be forced onto a production-capable edge path, I can observe what happened for every run, container remains an easy fallback, and I would personally be comfortable receiving the edge-produced answer in that group.

If any part of that sentence still feels shaky, stay in shadow mode or pre-canary hardening work a bit longer.

## Final Summary

The first canary is not a proof that the entire edge product is done.

It is a controlled trust exercise:

- tiny scope,
- real traffic,
- real answers,
- fast rollback,
- explicit observation,
- container still standing behind it.

That is the right standard for the first moment when NanoClaw's EdgeJS backend stops being merely an implementation project and starts becoming a real product you are willing to use yourself.
