import { ChildProcess } from 'child_process';

import { beforeEach, describe, expect, it, vi } from 'vitest';

const { ensureContainerRuntimeRunningMock, runContainerAgentMock } = vi.hoisted(
  () => ({
    ensureContainerRuntimeRunningMock: vi.fn(),
    runContainerAgentMock: vi.fn(),
  }),
);

vi.mock('../container-runner.js', () => ({
  runContainerAgent: runContainerAgentMock,
}));

vi.mock('../container-runtime.js', () => ({
  ensureContainerRuntimeRunning: ensureContainerRuntimeRunningMock,
}));

import type { AgentRunInput } from '../agent-backend.js';
import { containerBackend, heavyWorker } from './container-backend.js';
import type { RegisteredGroup } from '../types.js';

const group: RegisteredGroup = {
  name: 'Test Group',
  folder: 'test-group',
  trigger: '@Andy',
  added_at: '2026-04-03T00:00:00.000Z',
};

const input: AgentRunInput = {
  prompt: 'Hello',
  groupFolder: 'test-group',
  chatJid: 'group1@g.us',
  isMain: false,
};

describe('containerBackend', () => {
  beforeEach(() => {
    ensureContainerRuntimeRunningMock.mockReset();
    runContainerAgentMock.mockReset();
  });

  it('delegates to runContainerAgent and adapts execution start metadata', async () => {
    const fakeProcess = {} as ChildProcess;
    const streamedOutput = {
      status: 'success' as const,
      result: 'streamed output',
      newSessionId: 'session-stream',
    };
    const finalOutput = {
      status: 'success' as const,
      result: 'final output',
      newSessionId: 'session-final',
    };

    runContainerAgentMock.mockImplementationOnce(
      async (
        passedGroup,
        passedInput,
        onProcess,
        onOutput,
      ): Promise<typeof finalOutput> => {
        expect(passedGroup).toBe(group);
        expect(passedInput).toBe(input);

        onProcess(fakeProcess, 'nanoclaw-test-1');
        await onOutput?.(streamedOutput);

        return finalOutput;
      },
    );

    const onExecutionStarted = vi.fn();
    const onOutput = vi.fn(async () => {});

    const result = await containerBackend.run(
      group,
      input,
      onExecutionStarted,
      onOutput,
    );

    expect(runContainerAgentMock).toHaveBeenCalledTimes(1);
    expect(ensureContainerRuntimeRunningMock).toHaveBeenCalledTimes(1);
    expect(onExecutionStarted).toHaveBeenCalledWith({
      chatJid: 'group1@g.us',
      process: fakeProcess,
      executionName: 'nanoclaw-test-1',
      groupFolder: 'test-group',
    });
    expect(onOutput).toHaveBeenCalledWith(streamedOutput);
    expect(result).toEqual(finalOutput);
  });

  it('supports runs without an execution-start callback', async () => {
    runContainerAgentMock.mockResolvedValueOnce({
      status: 'success',
      result: 'done',
    });

    await expect(containerBackend.run(group, input)).resolves.toEqual({
      status: 'success',
      result: 'done',
    });
    expect(ensureContainerRuntimeRunningMock).toHaveBeenCalledTimes(1);
  });

  it('exposes the heavy worker contract metadata', () => {
    expect(containerBackend).toBe(heavyWorker);
    expect(heavyWorker).toMatchObject({
      backendId: 'container',
      workerClass: 'heavy',
      runtimeClass: 'container',
      plannedSpecializations: ['local-shell', 'browser-worker', 'app-worker'],
      capabilityEnvelope: [
        'shell.exec',
        'browser.exec',
        'app.exec',
        'local.secret',
        'interactive.longlived',
      ],
    });
  });
});
