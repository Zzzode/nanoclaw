import { describe, expect, it } from 'vitest';

import {
  FRAMEWORK_POLICY_VERSION,
  PLANNED_HEAVY_RUNTIME_SPECIALIZATIONS,
  resolveFrameworkAdaptivePolicy,
} from './framework-policy.js';

describe('framework policy seams', () => {
  it('exposes a stable policy version and planned heavy specializations', () => {
    expect(FRAMEWORK_POLICY_VERSION).toBe('2026-04-06.v1');
    expect(PLANNED_HEAVY_RUNTIME_SPECIALIZATIONS).toEqual([
      'local-shell',
      'browser-worker',
      'app-worker',
    ]);
  });

  it('resolves request-kind-specific adaptive policy defaults without changing behavior', () => {
    expect(resolveFrameworkAdaptivePolicy()).toEqual({
      routingProfile: 'default',
      workspaceEdgeWritePolicy: 'inherit',
      adaptiveFanoutLimit: null,
      heavyFirstDowngradeThreshold: null,
      heavyFirstDowngradeWindow: null,
      shardedControlPlaneCandidate: false,
    });
    expect(resolveFrameworkAdaptivePolicy('group_turn')).toEqual({
      routingProfile: 'group_turn_edge_first',
      workspaceEdgeWritePolicy: 'inherit',
      adaptiveFanoutLimit: 8,
      heavyFirstDowngradeThreshold: null,
      heavyFirstDowngradeWindow: null,
      shardedControlPlaneCandidate: false,
    });
    expect(resolveFrameworkAdaptivePolicy('scheduled_task')).toEqual({
      routingProfile: 'scheduled_task_edge_first',
      workspaceEdgeWritePolicy: 'inherit',
      adaptiveFanoutLimit: 4,
      heavyFirstDowngradeThreshold: null,
      heavyFirstDowngradeWindow: null,
      shardedControlPlaneCandidate: false,
    });
  });
});
