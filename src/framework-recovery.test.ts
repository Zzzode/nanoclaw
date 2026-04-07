import { describe, expect, it } from 'vitest';

import { classifyRuntimeRecovery } from './framework-recovery.js';

describe('framework recovery', () => {
  it('classifies edge runtime failures for heavy fallback', () => {
    expect(
      classifyRuntimeRecovery({
        error: 'Edge execution exceeded deadline of 100ms.',
        workerClass: 'edge',
        fallbackEligible: true,
      }),
    ).toEqual({
      kind: 'fallback',
      reason: 'edge_timeout',
    });

    expect(
      classifyRuntimeRecovery({
        error: 'Edge runner finished without a final event.',
        workerClass: 'edge',
        fallbackEligible: true,
      }),
    ).toEqual({
      kind: 'fallback',
      reason: 'edge_runtime_unhealthy',
    });
  });

  it('avoids fallback after visible output and marks commit conflicts for replan', () => {
    expect(
      classifyRuntimeRecovery({
        error: 'Edge execution exceeded deadline of 100ms.',
        workerClass: 'edge',
        fallbackEligible: true,
        visibleOutputEmitted: true,
      }),
    ).toEqual({ kind: 'none' });

    expect(
      classifyRuntimeRecovery({
        error: 'Workspace version conflict: expected a, received b',
        workerClass: 'edge',
        fallbackEligible: true,
      }),
    ).toEqual({
      kind: 'replan',
      reason: 'state_conflict_requires_heavy',
    });
  });
});
