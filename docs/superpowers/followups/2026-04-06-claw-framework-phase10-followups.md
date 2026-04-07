# Claw Framework Phase 10 Follow-ups

Date: 2026-04-06
Status: Deferred follow-ups after Phase 10 seam preparation

## Adaptive Routing

- Implement request-kind-specific routing profiles as configurable policy bundles rather than hardcoded defaults.
- Add workspace-level edge write restrictions so edge pools can be read-only for selected groups or repos.
- Introduce adaptive fan-out ceilings driven by recent edge saturation and aggregate-node latency.
- Add automatic heavy-first downgrade based on observed edge fallback rate over a bounded rolling window.

## Runtime Specialization

- Split the current heavy tier into explicit runtime targets:
  - `local-shell`
  - `browser-worker`
  - `app-worker`
- Add capability-to-runtime-target mapping once more than one heavy runtime is production ready.
- Preserve the existing `container` runtime as the compatibility heavy default until specialized runtimes are proven.

## Control Plane Growth

- Define the threshold where a sharded control plane becomes justified:
  - sustained graph concurrency,
  - queue delay inflation,
  - commit contention,
  - cross-group fallback amplification.
- Keep current single control-plane assumptions until observability shows these thresholds are real.
