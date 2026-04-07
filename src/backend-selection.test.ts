import { describe, expect, it } from 'vitest';

import { FRAMEWORK_POLICY_VERSION } from './framework-policy.js';
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
        { script: undefined, prompt: 'hi' },
        'edge',
      ),
    ).toEqual({
      executionMode: 'container',
      backendId: 'container',
      requiredCapabilities: [],
      routeReason: 'group_pinned_heavy',
      policyVersion: FRAMEWORK_POLICY_VERSION,
      fallbackEligible: false,
    });
  });

  it('uses edge backend for edge execution mode', () => {
    expect(
      selectAgentBackend(
        { executionMode: 'edge' },
        { script: undefined, prompt: 'hi' },
        'container',
      ),
    ).toEqual({
      executionMode: 'edge',
      backendId: 'edge',
      requiredCapabilities: [],
      routeReason: 'group_pinned_edge',
      policyVersion: FRAMEWORK_POLICY_VERSION,
      fallbackEligible: true,
    });
  });

  it('falls back to container in auto mode when script is present', () => {
    expect(
      selectAgentBackend(
        { executionMode: 'auto' },
        { script: 'echo 1', prompt: 'hi' },
        'container',
      ),
    ).toEqual({
      executionMode: 'auto',
      backendId: 'container',
      requiredCapabilities: ['shell.exec'],
      routeReason: 'script_requires_heavy',
      policyVersion: FRAMEWORK_POLICY_VERSION,
      fallbackEligible: false,
      fallbackReason: 'script_requires_container',
    });
  });

  it('uses edge in auto mode when no script is present', () => {
    expect(
      selectAgentBackend(
        { executionMode: 'auto' },
        { script: undefined, prompt: 'Summarize' },
        'container',
      ),
    ).toEqual({
      executionMode: 'auto',
      backendId: 'edge',
      requiredCapabilities: [],
      routeReason: 'no_special_capabilities',
      policyVersion: FRAMEWORK_POLICY_VERSION,
      fallbackEligible: true,
    });
  });

  it('falls back to container in auto mode for unsupported edge tools', () => {
    expect(
      selectAgentBackend(
        { executionMode: 'auto' },
        {
          script: undefined,
          prompt: 'EDGE_TOOL {"tool":"bash","args":{"command":"echo 1"}}',
        },
        'container',
      ),
    ).toEqual({
      executionMode: 'auto',
      backendId: 'container',
      requiredCapabilities: ['shell.exec'],
      routeReason: 'unsupported_capability',
      policyVersion: FRAMEWORK_POLICY_VERSION,
      fallbackEligible: false,
      fallbackReason: 'unsupported_edge_tool',
    });
  });

  it('routes supported edge capabilities deterministically in auto mode', () => {
    expect(
      selectAgentBackend(
        { executionMode: 'auto' },
        {
          script: undefined,
          prompt: 'EDGE_TOOL {"tool":"message.send","args":{"text":"hi"}}',
        },
        'container',
      ),
    ).toEqual({
      executionMode: 'auto',
      backendId: 'edge',
      requiredCapabilities: ['message.send'],
      routeReason: 'capability_match_edge',
      policyVersion: FRAMEWORK_POLICY_VERSION,
      fallbackEligible: true,
    });
  });

  it('defaults unknown capabilities to heavy in auto mode', () => {
    expect(
      selectAgentBackend(
        { executionMode: 'auto' },
        {
          script: undefined,
          prompt: 'EDGE_TOOL {"tool":"mystery.exec","args":{}}',
        },
        'container',
      ),
    ).toEqual({
      executionMode: 'auto',
      backendId: 'container',
      requiredCapabilities: ['unknown:mystery.exec'],
      routeReason: 'unknown_capability_default_heavy',
      policyVersion: FRAMEWORK_POLICY_VERSION,
      fallbackEligible: false,
      fallbackReason: 'unsupported_edge_tool',
    });
  });

  it('uses default execution mode when group mode is unset', () => {
    expect(resolveGroupExecutionMode(undefined, 'edge')).toBe('edge');
    expect(
      selectAgentBackend(
        undefined,
        { script: undefined, prompt: 'hello' },
        'container',
      ),
    ).toEqual({
      executionMode: 'container',
      backendId: 'container',
      requiredCapabilities: [],
      routeReason: 'group_pinned_heavy',
      policyVersion: FRAMEWORK_POLICY_VERSION,
      fallbackEligible: false,
    });
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
