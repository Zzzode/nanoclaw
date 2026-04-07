# EdgeJS Edge-Claw First Canary Checklist

Date: 2026-04-04
Status: Internal working draft
Audience: Product owner / operator
Scope: Practical preflight and decision checklist before starting the first personal EdgeJS canary

## How To Use This Checklist

Use this document immediately before starting your first real canary.

The rule is simple:

- if a required item is not checked, do not start the canary,
- if a warning item is not checked, start only if you consciously accept the risk,
- if a rollback item is unclear, stop and define it first.

This checklist is for the first personal canary only:

- one trusted group,
- real traffic,
- edge as primary backend,
- container as fallback.

## Go / No-Go Rule

Start the first canary only if:

- all **Required** items are checked,
- no **Blocker** is unresolved,
- and you would personally trust the canary group to receive the edge-produced result.

If that last sentence feels untrue, the answer is still “not yet.”

## 1. Product Readiness

### Required

- [ ] `container`, `edge`, and `auto` execution modes are understood and available
- [ ] I can force one specific group to `edge`
- [ ] I can switch that same group back to `container` quickly
- [ ] Global default execution mode does not need to change for the first canary
- [ ] Fallback to `container` is still available as the safety path
- [ ] Execution results remain centrally orchestrated rather than edge-local only
- [ ] Workspace changes are centrally committed rather than blindly trusted from local runtime state

### Blockers

- [ ] No known product-level ambiguity remains about which backend will serve the canary group
- [ ] No known product-level ambiguity remains about how rollback will happen

## 2. Runtime Readiness

### Required

- [ ] The edge runtime path for canary is production-capable, not just the local subprocess harness
- [ ] Filesystem confinement has been validated for the runtime path I will actually use
- [ ] Overlay-style file write behavior has been validated for that runtime path
- [ ] `http.fetch` behavior is validated for the network profile I intend to allow
- [ ] Cancel and deadline handling have been validated enough to avoid zombie executions
- [ ] The runtime path does not depend on a production assumption I already know is false

### Warning

- [ ] Any remaining runtime gaps are documented and clearly non-blocking for this tiny canary scope

## 3. Canary Scope Selection

### Required

- [ ] I have chosen exactly one trusted canary group
- [ ] That group is controlled by me or directly observable by me
- [ ] Message volume in that group is low enough to inspect manually
- [ ] Traffic in that group is low-risk and reversible
- [ ] The canary group does not carry business-critical or high-consequence interactions
- [ ] The expected workflows in that group do not rely on unsupported shell-like capabilities

### Warning

- [ ] The canary group workspace is simple enough that I can manually inspect file outcomes if needed

## 4. Observability

### Required

- [ ] I can tell whether a run used `edge` or `container`
- [ ] I can inspect execution outcomes after a run
- [ ] I can see visible failures, timeouts, or fallback reasons
- [ ] I can tell whether a workspace write committed successfully
- [ ] I can inspect enough logs or execution records to debug an obvious bad run

### Warning

- [ ] I have at least a lightweight way to count success, failure, timeout, and fallback events during the canary

## 5. Behavioral Expectations

### Required

- [ ] I have defined what “normal behavior” looks like for this canary group
- [ ] I know which prompt types I expect to test first
- [ ] I am not using the first canary to stress the hardest edge cases immediately
- [ ] I will begin with normal conversational behavior before broader task or file mutation patterns

### Warning

- [ ] I have listed the specific unsupported or suspicious behaviors I want to avoid during the first canary

## 6. Shadow Pre-Check

### Recommended

- [ ] I have already used shadow mode on similar traffic for confidence building
- [ ] Shadow comparisons did not reveal obvious output quality or tool behavior problems
- [ ] I am not using canary as the first time edge sees realistic traffic

If these are all unchecked, that does not automatically block the canary, but it means the canary is carrying more discovery risk than ideal.

## 7. Rollback Readiness

### Required

- [ ] I know the exact setting or action needed to move the canary group back to `container`
- [ ] I can perform that rollback in minutes, not hours
- [ ] I know where to look for evidence after a rollback
- [ ] I will stop expanding traffic immediately if the canary shows instability
- [ ] I will preserve logs and execution evidence before making bigger changes

### Blockers

- [ ] There is no part of rollback that depends on improvisation under pressure

## 8. Workspace Safety

### Required

- [ ] Base workspace version validation is working for the canary path
- [ ] Stale writes are rejected safely
- [ ] Duplicate commits are idempotent or otherwise safe
- [ ] I am confident failed runs will not silently leave half-written authoritative state

### Warning

- [ ] I have manually thought through what I would inspect first if the canary produced a suspicious file mutation

## 9. Personal Confidence Check

### Required

- [ ] I would personally be comfortable receiving the edge-produced answer in this canary group
- [ ] I would personally be comfortable with the canary group using the current workspace commit path
- [ ] I am prepared to roll back fast instead of rationalizing a shaky canary

### Decision Gate

- [ ] If the edge backend behaves strangely in the first few real interactions, I will treat that as a real signal, not as noise to ignore

## 10. Start Criteria

You can start the canary if all of these are true:

- [ ] all required items above are checked
- [ ] no blocker above remains unchecked
- [ ] the canary scope is exactly one trusted group
- [ ] rollback is immediate and understood
- [ ] edge is truly primary for that scope
- [ ] container remains available as fallback

## 11. First 10 Interactions Checklist

Use this during the first real canary interactions.

- [ ] interaction 1 behaved normally
- [ ] interaction 2 behaved normally
- [ ] interaction 3 behaved normally
- [ ] interaction 4 behaved normally
- [ ] interaction 5 behaved normally
- [ ] I saw no unexplained fallback
- [ ] I saw no suspicious timeout or deadline behavior
- [ ] I saw no broken continuity across turns
- [ ] I saw no suspicious workspace mutation behavior
- [ ] I still trust the canary enough to continue after these first interactions

If you cannot check the last item honestly, switch the group back to `container`.

## 12. Immediate Rollback Triggers

Rollback immediately if any of the following becomes true:

- [ ] visible wrongness repeats in normal usage
- [ ] I cannot tell whether a run committed safely
- [ ] workspace behavior looks unsafe or surprising
- [ ] timeouts or aborts look unstable
- [ ] fallback behavior is confusing instead of explicit
- [ ] I stop trusting the edge-produced result in this group

Any one of these is enough to justify rollback for a first canary.

## 13. Success Criteria For This First Canary

Treat the first canary as successful only if:

- [ ] one real trusted group can stay on `edge` for a meaningful short period
- [ ] the user-visible experience still feels normal
- [ ] failures, if any, are understandable rather than mysterious
- [ ] rollback remains easy throughout
- [ ] I would be willing to keep this one group on edge while evaluating whether to expand

## Final Decision

### Start Canary

- [ ] I am ready to start the first personal canary now

### Do Not Start Yet

- [ ] I am not ready yet, and I know exactly which missing items must be closed first

## Notes

- A first canary does not need to prove full production readiness.
- A first canary does need to prove that edge can responsibly own a tiny slice of real traffic.
- For the first canary, clarity and reversibility matter more than breadth.
