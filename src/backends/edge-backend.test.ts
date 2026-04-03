import { beforeEach, describe, expect, it, vi } from 'vitest';

import { edgeBackend } from './edge-backend.js';
import type { AgentRunInput } from '../agent-backend.js';
import type { RegisteredGroup } from '../types.js';

const group: RegisteredGroup = {
  name: 'Edge Group',
  folder: 'edge-group',
  trigger: '@Andy',
  added_at: '2026-04-03T00:00:00.000Z',
  executionMode: 'edge',
};

const input: AgentRunInput = {
  prompt: 'Summarize pending work items',
  groupFolder: 'edge-group',
  chatJid: 'edge@g.us',
  isMain: false,
};

describe('edgeBackend', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('streams and returns a stub success result', async () => {
    const onOutput = vi.fn(async () => {});
    const onExecutionStarted = vi.fn();

    const result = await edgeBackend.run(
      group,
      input,
      onExecutionStarted,
      onOutput,
    );

    expect(onExecutionStarted).not.toHaveBeenCalled();
    expect(onOutput).toHaveBeenCalledTimes(1);
    expect(onOutput).toHaveBeenCalledWith(result);
    expect(result).toMatchObject({
      status: 'success',
      result: expect.stringContaining('[edge backend stub]'),
    });
  });

  it('returns a controlled error for script-based runs', async () => {
    await expect(
      edgeBackend.run(group, { ...input, script: 'echo 1' }),
    ).resolves.toEqual({
      status: 'error',
      result: null,
      error: 'Edge backend stub does not support scheduled task scripts yet.',
    });
  });
});
