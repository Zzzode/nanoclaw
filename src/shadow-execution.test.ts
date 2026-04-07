import { afterEach, describe, expect, it, vi } from 'vitest';

import type { AgentBackend, AgentRunOutput } from './agent-backend.js';
import { logger } from './logger.js';
import {
  resolveShadowExecutionMode,
  runShadowExecutionComparison,
  selectShadowExecution,
} from './shadow-execution.js';
import type { RegisteredGroup } from './types.js';

const group: RegisteredGroup = {
  name: 'Shadow Group',
  folder: 'shadow-group',
  trigger: '@Andy',
  added_at: '2026-04-03T00:00:00.000Z',
};

describe('shadow execution selection', () => {
  it('defaults invalid values to off', () => {
    expect(resolveShadowExecutionMode(undefined)).toBe('off');
    expect(resolveShadowExecutionMode('bad')).toBe('off');
    expect(resolveShadowExecutionMode('edge')).toBe('edge');
  });

  it('enables edge shadow only for safe container-primary prompts', () => {
    expect(
      selectShadowExecution(
        'container',
        { prompt: 'hello', script: undefined },
        'edge',
      ),
    ).toEqual({
      enabled: true,
      backendId: 'edge',
      reason: 'shadow_disabled',
    });
    expect(
      selectShadowExecution(
        'edge',
        { prompt: 'hello', script: undefined },
        'edge',
      ),
    ).toEqual({
      enabled: false,
      reason: 'primary_is_edge',
    });
    expect(
      selectShadowExecution(
        'container',
        { prompt: 'hello', script: 'echo 1' },
        'edge',
      ),
    ).toEqual({
      enabled: false,
      reason: 'script_requires_container',
    });
    expect(
      selectShadowExecution(
        'container',
        {
          prompt: 'EDGE_TOOL {"tool":"workspace.write","args":{}}',
          script: undefined,
        },
        'edge',
      ),
    ).toEqual({
      enabled: false,
      reason: 'explicit_tool_prompt',
    });
  });
});

describe('shadow execution comparison', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('runs the shadow backend and logs comparison output', async () => {
    const backendRun = vi.fn<AgentBackend['run']>(
      async (_group, _input, _started, onOutput) => {
        await onOutput?.({ status: 'success', result: 'shadow stream' });
        return { status: 'success', result: 'shadow final' };
      },
    );
    const infoSpy = vi.spyOn(logger, 'info').mockImplementation(() => {});

    await runShadowExecutionComparison({
      selection: {
        enabled: true,
        backendId: 'edge',
        reason: 'shadow_disabled',
      },
      backends: {
        container: { run: vi.fn() } as AgentBackend,
        edge: { run: backendRun } as AgentBackend,
      },
      group,
      input: {
        prompt: 'hello',
        groupFolder: group.folder,
        chatJid: 'room@g.us',
        isMain: false,
      },
      primaryBackendId: 'container',
      primaryOutput: { status: 'success', result: 'primary final' },
      scope: 'group',
      scopeId: group.folder,
    });

    expect(backendRun).toHaveBeenCalledTimes(1);
    expect(infoSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        primaryBackendId: 'container',
        shadowBackendId: 'edge',
        primaryStatus: 'success',
        shadowStatus: 'success',
        shadowStreamCount: 1,
        diverged: true,
      }),
      'Shadow execution comparison completed',
    );
  });

  it('skips disabled shadow runs with a debug log', async () => {
    const debugSpy = vi.spyOn(logger, 'debug').mockImplementation(() => {});

    await runShadowExecutionComparison({
      selection: {
        enabled: false,
        reason: 'shadow_disabled',
      },
      backends: {
        container: { run: vi.fn() } as AgentBackend,
        edge: { run: vi.fn() } as AgentBackend,
      },
      group,
      input: {
        prompt: 'hello',
        groupFolder: group.folder,
        chatJid: 'room@g.us',
        isMain: false,
      },
      primaryBackendId: 'container',
      primaryOutput: { status: 'success', result: 'primary final' },
      scope: 'task',
      scopeId: 'task-1',
    });

    expect(debugSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        scope: 'task',
        scopeId: 'task-1',
        shadowEnabled: false,
        shadowReason: 'shadow_disabled',
      }),
      'Shadow execution skipped',
    );
  });
});
