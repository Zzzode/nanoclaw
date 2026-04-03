import { beforeEach, describe, expect, it } from 'vitest';

import {
  _initTestDatabase,
  getExecutionState,
  getLogicalSession,
} from './db.js';
import {
  beginExecution,
  commitExecution,
  completeExecution,
  ensureLogicalSession,
  failExecution,
  heartbeatExecution,
  requestExecutionCancel,
} from './execution-state.js';

beforeEach(() => {
  _initTestDatabase();
});

describe('execution state service', () => {
  it('creates logical sessions on demand', () => {
    const session = ensureLogicalSession(
      'group',
      'team_alpha',
      new Date('2026-04-03T00:00:00.000Z'),
    );

    expect(session).toMatchObject({
      id: 'group:team_alpha',
      scopeType: 'group',
      scopeId: 'team_alpha',
      status: 'active',
    });
    expect(getLogicalSession('group', 'team_alpha')).toMatchObject({
      id: 'group:team_alpha',
      status: 'active',
    });
  });

  it('records heartbeat, cancel, commit, and complete transitions', () => {
    const started = beginExecution({
      scopeType: 'group',
      scopeId: 'team_alpha',
      backend: 'container',
      groupJid: 'room@g.us',
      now: new Date('2026-04-03T00:00:00.000Z'),
      leaseMs: 60_000,
    });

    heartbeatExecution(
      started.executionId,
      new Date('2026-04-03T00:00:10.000Z'),
      120_000,
    );
    requestExecutionCancel(
      started.executionId,
      new Date('2026-04-03T00:00:20.000Z'),
    );
    commitExecution(started.executionId, new Date('2026-04-03T00:00:30.000Z'));
    completeExecution(
      started.executionId,
      new Date('2026-04-03T00:00:31.000Z'),
    );

    expect(getExecutionState(started.executionId)).toMatchObject({
      executionId: started.executionId,
      groupJid: 'room@g.us',
      status: 'completed',
      cancelRequestedAt: '2026-04-03T00:00:20.000Z',
      committedAt: '2026-04-03T00:00:30.000Z',
      finishedAt: '2026-04-03T00:00:31.000Z',
      lastHeartbeatAt: '2026-04-03T00:00:10.000Z',
      leaseUntil: '2026-04-03T00:02:10.000Z',
    });
    expect(getLogicalSession('group', 'team_alpha')).toMatchObject({
      lastTurnId: started.turnId,
      status: 'active',
    });
  });

  it('marks failed executions and preserves logical session state', () => {
    const started = beginExecution({
      scopeType: 'task',
      scopeId: 'task-1',
      backend: 'container',
      taskId: 'task-1',
      now: new Date('2026-04-03T00:00:00.000Z'),
    });

    failExecution(
      started.executionId,
      'runner crashed',
      new Date('2026-04-03T00:00:05.000Z'),
    );

    expect(getExecutionState(started.executionId)).toMatchObject({
      executionId: started.executionId,
      status: 'failed',
      error: 'runner crashed',
      finishedAt: '2026-04-03T00:00:05.000Z',
    });
    expect(getLogicalSession('task', 'task-1')).toMatchObject({
      id: 'task:task-1',
      lastTurnId: null,
      status: 'active',
    });
  });
});
