import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  _initTestDatabase,
  createTask,
  getExecutionState,
  getTaskById,
} from './db.js';
import { beginExecution } from './execution-state.js';
import {
  deleteScheduledTask,
  registerTaskRuntimeController,
} from './task-control.js';

describe('task control', () => {
  beforeEach(() => {
    _initTestDatabase();
    registerTaskRuntimeController(null);
  });

  it('deletes tasks and requests cancellation for active executions', () => {
    createTask({
      id: 'task-delete-helper',
      group_folder: 'team_alpha',
      chat_jid: 'room@g.us',
      prompt: 'run later',
      schedule_type: 'once',
      schedule_value: '2026-04-07T00:00:00.000Z',
      context_mode: 'isolated',
      next_run: '2026-04-07T00:00:00.000Z',
      status: 'active',
      created_at: '2026-04-07T00:00:00.000Z',
    });
    const execution = beginExecution({
      scopeType: 'task',
      scopeId: 'task-delete-helper',
      backend: 'edge',
      taskId: 'task-delete-helper',
      now: new Date('2026-04-07T00:00:00.000Z'),
    });

    const cancelTask = vi.fn();
    registerTaskRuntimeController({ cancelTask });

    expect(deleteScheduledTask('task-delete-helper')).toEqual({
      deleted: true,
      cancelledExecutionIds: [execution.executionId],
    });
    expect(cancelTask).toHaveBeenCalledWith({
      taskId: 'task-delete-helper',
      chatJid: 'room@g.us',
      groupFolder: 'team_alpha',
    });
    expect(getTaskById('task-delete-helper')).toBeUndefined();
    expect(getExecutionState(execution.executionId)?.status).toBe(
      'cancel_requested',
    );
  });
});
