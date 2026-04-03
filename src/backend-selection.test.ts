import { describe, expect, it } from 'vitest';

import {
  deploymentRequiresContainerRuntime,
  groupMayUseContainerRuntime,
  resolveGroupExecutionMode,
  selectAgentBackend,
} from './backend-selection.js';

describe('backend selection', () => {
  it('uses container backend for container execution mode', () => {
    expect(
      selectAgentBackend(
        { executionMode: 'container' },
        { script: undefined },
        'edge',
      ),
    ).toEqual({ executionMode: 'container', backendId: 'container' });
  });

  it('uses edge backend for edge execution mode', () => {
    expect(
      selectAgentBackend(
        { executionMode: 'edge' },
        { script: undefined },
        'container',
      ),
    ).toEqual({ executionMode: 'edge', backendId: 'edge' });
  });

  it('falls back to container in auto mode when script is present', () => {
    expect(
      selectAgentBackend(
        { executionMode: 'auto' },
        { script: 'echo 1' },
        'container',
      ),
    ).toEqual({
      executionMode: 'auto',
      backendId: 'container',
      fallbackReason: 'script_requires_container',
    });
  });

  it('uses edge in auto mode when no script is present', () => {
    expect(
      selectAgentBackend(
        { executionMode: 'auto' },
        { script: undefined },
        'container',
      ),
    ).toEqual({ executionMode: 'auto', backendId: 'edge' });
  });

  it('uses default execution mode when group mode is unset', () => {
    expect(resolveGroupExecutionMode(undefined, 'edge')).toBe('edge');
    expect(
      selectAgentBackend(undefined, { script: undefined }, 'container'),
    ).toEqual({ executionMode: 'container', backendId: 'container' });
  });
});

describe('container runtime gating', () => {
  it('marks auto groups as potentially requiring container runtime', () => {
    expect(groupMayUseContainerRuntime({ executionMode: 'auto' }, 'edge')).toBe(
      true,
    );
  });

  it('skips container runtime only for edge-only deployments', () => {
    expect(deploymentRequiresContainerRuntime([], 'edge')).toBe(false);
    expect(
      deploymentRequiresContainerRuntime([{ executionMode: 'edge' }], 'edge'),
    ).toBe(false);
    expect(
      deploymentRequiresContainerRuntime([{ executionMode: 'auto' }], 'edge'),
    ).toBe(true);
    expect(deploymentRequiresContainerRuntime([], 'container')).toBe(true);
  });
});
