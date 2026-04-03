import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { AgentBackend } from './agent-backend.js';
import {
  _initTestDatabase,
  createTask,
  getLogicalSession,
  getTaskById,
  listExecutionStates,
} from './db.js';
import {
  _resetSchedulerLoopForTests,
  computeNextRun,
  startSchedulerLoop,
} from './task-scheduler.js';

const backendRun = vi.fn();
const backendStub: AgentBackend = {
  run: backendRun,
};

describe('task scheduler', () => {
  beforeEach(() => {
    _initTestDatabase();
    _resetSchedulerLoopForTests();
    backendRun.mockReset();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('pauses due tasks with invalid group folders to prevent retry churn', async () => {
    createTask({
      id: 'task-invalid-folder',
      group_folder: '../../outside',
      chat_jid: 'bad@g.us',
      prompt: 'run',
      schedule_type: 'once',
      schedule_value: '2026-02-22T00:00:00.000Z',
      context_mode: 'isolated',
      next_run: new Date(Date.now() - 60_000).toISOString(),
      status: 'active',
      created_at: '2026-02-22T00:00:00.000Z',
    });

    const enqueueTask = vi.fn(
      (_groupJid: string, _taskId: string, fn: () => Promise<void>) => {
        void fn();
      },
    );

    startSchedulerLoop({
      backend: backendStub,
      registeredGroups: () => ({}),
      getSessions: () => ({}),
      queue: { enqueueTask } as any,
      sendMessage: async () => {},
    });

    await vi.advanceTimersByTimeAsync(10);

    const task = getTaskById('task-invalid-folder');
    expect(task?.status).toBe('paused');
  });

  it('computeNextRun anchors interval tasks to scheduled time to prevent drift', () => {
    const scheduledTime = new Date(Date.now() - 2000).toISOString(); // 2s ago
    const task = {
      id: 'drift-test',
      group_folder: 'test',
      chat_jid: 'test@g.us',
      prompt: 'test',
      schedule_type: 'interval' as const,
      schedule_value: '60000', // 1 minute
      context_mode: 'isolated' as const,
      next_run: scheduledTime,
      last_run: null,
      last_result: null,
      status: 'active' as const,
      created_at: '2026-01-01T00:00:00.000Z',
    };

    const nextRun = computeNextRun(task);
    expect(nextRun).not.toBeNull();

    // Should be anchored to scheduledTime + 60s, NOT Date.now() + 60s
    const expected = new Date(scheduledTime).getTime() + 60000;
    expect(new Date(nextRun!).getTime()).toBe(expected);
  });

  it('computeNextRun returns null for once-tasks', () => {
    const task = {
      id: 'once-test',
      group_folder: 'test',
      chat_jid: 'test@g.us',
      prompt: 'test',
      schedule_type: 'once' as const,
      schedule_value: '2026-01-01T00:00:00.000Z',
      context_mode: 'isolated' as const,
      next_run: new Date(Date.now() - 1000).toISOString(),
      last_run: null,
      last_result: null,
      status: 'active' as const,
      created_at: '2026-01-01T00:00:00.000Z',
    };

    expect(computeNextRun(task)).toBeNull();
  });

  it('computeNextRun skips missed intervals without infinite loop', () => {
    // Task was due 10 intervals ago (missed)
    const ms = 60000;
    const missedBy = ms * 10;
    const scheduledTime = new Date(Date.now() - missedBy).toISOString();

    const task = {
      id: 'skip-test',
      group_folder: 'test',
      chat_jid: 'test@g.us',
      prompt: 'test',
      schedule_type: 'interval' as const,
      schedule_value: String(ms),
      context_mode: 'isolated' as const,
      next_run: scheduledTime,
      last_run: null,
      last_result: null,
      status: 'active' as const,
      created_at: '2026-01-01T00:00:00.000Z',
    };

    const nextRun = computeNextRun(task);
    expect(nextRun).not.toBeNull();
    // Must be in the future
    expect(new Date(nextRun!).getTime()).toBeGreaterThan(Date.now());
    // Must be aligned to the original schedule grid
    const offset =
      (new Date(nextRun!).getTime() - new Date(scheduledTime).getTime()) % ms;
    expect(offset).toBe(0);
  });

  it('records group-context task executions against the group logical session', async () => {
    createTask({
      id: 'task-group-context',
      group_folder: 'team_alpha',
      chat_jid: 'room@g.us',
      prompt: 'summarize the group backlog',
      schedule_type: 'once',
      schedule_value: '2026-04-03T00:00:00.000Z',
      context_mode: 'group',
      next_run: new Date(Date.now() - 60_000).toISOString(),
      status: 'active',
      created_at: '2026-04-03T00:00:00.000Z',
    });

    backendRun.mockImplementation(async (_group, input, _started, onOutput) => {
      expect(input.sessionId).toBe('session-group-1');
      await onOutput?.({
        newSessionId: 'session-group-2',
        result: 'scheduled reply',
        status: 'success',
      });
      return {
        newSessionId: 'session-group-2',
        result: 'scheduled reply',
        status: 'success',
      };
    });

    const enqueueTask = vi.fn(
      async (_groupJid: string, _taskId: string, fn: () => Promise<void>) => {
        await fn();
      },
    );
    const queue = {
      closeStdin: vi.fn(),
      enqueueTask,
      notifyIdle: vi.fn(),
    } as any;
    const sendMessage = vi.fn(async () => {});

    startSchedulerLoop({
      backend: backendStub,
      registeredGroups: () => ({
        'room@g.us': {
          name: 'Team Alpha',
          folder: 'team_alpha',
          trigger: '@Andy',
          added_at: '2026-04-03T00:00:00.000Z',
        },
      }),
      getSessions: () => ({ team_alpha: 'session-group-1' }),
      queue,
      sendMessage,
    });

    await vi.advanceTimersByTimeAsync(10);

    expect(sendMessage).toHaveBeenCalledWith('room@g.us', 'scheduled reply');
    expect(getLogicalSession('group', 'team_alpha')).toMatchObject({
      id: 'group:team_alpha',
      lastTurnId: expect.any(String),
      providerSessionId: 'session-group-2',
      status: 'active',
    });

    const executions = listExecutionStates();
    expect(executions).toHaveLength(1);
    expect(executions[0]).toMatchObject({
      groupJid: 'room@g.us',
      logicalSessionId: 'group:team_alpha',
      status: 'completed',
      taskId: 'task-group-context',
    });
  });

  it('records isolated task executions with a dedicated logical session', async () => {
    createTask({
      id: 'task-isolated-context',
      group_folder: 'team_alpha',
      chat_jid: 'room@g.us',
      prompt: 'run a private maintenance turn',
      schedule_type: 'once',
      schedule_value: '2026-04-03T00:00:00.000Z',
      context_mode: 'isolated',
      next_run: new Date(Date.now() - 60_000).toISOString(),
      status: 'active',
      created_at: '2026-04-03T00:00:00.000Z',
    });

    backendRun.mockImplementation(async (_group, input, _started, onOutput) => {
      expect(input.sessionId).toBeUndefined();
      await onOutput?.({ status: 'success', result: null });
      return { status: 'success', result: null };
    });

    const enqueueTask = vi.fn(
      async (_groupJid: string, _taskId: string, fn: () => Promise<void>) => {
        await fn();
      },
    );
    const queue = {
      closeStdin: vi.fn(),
      enqueueTask,
      notifyIdle: vi.fn(),
    } as any;
    const sendMessage = vi.fn(async () => {});

    startSchedulerLoop({
      backend: backendStub,
      registeredGroups: () => ({
        'room@g.us': {
          name: 'Team Alpha',
          folder: 'team_alpha',
          trigger: '@Andy',
          added_at: '2026-04-03T00:00:00.000Z',
        },
      }),
      getSessions: () => ({ team_alpha: 'session-group-1' }),
      queue,
      sendMessage,
    });

    await vi.advanceTimersByTimeAsync(10);

    expect(sendMessage).not.toHaveBeenCalled();
    expect(getLogicalSession('task', 'task-isolated-context')).toMatchObject({
      id: 'task:task-isolated-context',
      lastTurnId: expect.any(String),
      providerSessionId: null,
      status: 'active',
    });

    const executions = listExecutionStates();
    expect(executions).toHaveLength(1);
    expect(executions[0]).toMatchObject({
      groupJid: 'room@g.us',
      logicalSessionId: 'task:task-isolated-context',
      status: 'completed',
      taskId: 'task-isolated-context',
    });
  });
});
