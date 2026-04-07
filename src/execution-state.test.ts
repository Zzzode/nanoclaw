import { beforeEach, describe, expect, it } from 'vitest';

import {
  _initTestDatabase,
  createLogicalSession,
  getExecutionState,
  getLogicalSession,
  getTaskGraph,
  getTaskNode,
  listExecutionStatesForTaskNode,
} from './db.js';
import {
  beginExecution,
  commitExecution,
  completeExecution,
  deriveExecutionLeaseMs,
  ensureLogicalSession,
  failExecution,
  heartbeatExecution,
  linkExecutionToTaskNode,
  markExpiredExecutionsLost,
  requestTaskExecutionsCancel,
  requestExecutionCancel,
} from './execution-state.js';
import {
  createRootTaskGraph,
  createTaskNodeInGraph,
  markTaskNodeRunning,
} from './task-graph-state.js';

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

  it('preserves the configured lease window across heartbeats', () => {
    const started = beginExecution({
      scopeType: 'group',
      scopeId: 'team_alpha',
      backend: 'edge',
      groupJid: 'room@g.us',
      now: new Date('2026-04-03T00:00:00.000Z'),
      leaseMs: 305_000,
    });

    heartbeatExecution(
      started.executionId,
      new Date('2026-04-03T00:00:10.000Z'),
    );

    expect(getExecutionState(started.executionId)).toMatchObject({
      lastHeartbeatAt: '2026-04-03T00:00:10.000Z',
      leaseUntil: '2026-04-03T00:05:15.000Z',
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

  it('tracks multiple execution attempts against one logical task node', () => {
    const taskNodeId = 'task:turn-retry:root';

    const edgeAttempt = beginExecution({
      scopeType: 'task',
      scopeId: 'task-retry',
      backend: 'edge',
      taskId: 'task-retry',
      taskNodeId,
      now: new Date('2026-04-03T00:00:00.000Z'),
    });
    failExecution(
      edgeAttempt.executionId,
      'edge timeout',
      new Date('2026-04-03T00:00:05.000Z'),
    );

    const containerAttempt = beginExecution({
      scopeType: 'task',
      scopeId: 'task-retry',
      backend: 'container',
      taskId: 'task-retry',
      now: new Date('2026-04-03T00:00:06.000Z'),
    });
    linkExecutionToTaskNode(
      containerAttempt.executionId,
      taskNodeId,
      new Date('2026-04-03T00:00:06.000Z'),
    );

    const attempts = listExecutionStatesForTaskNode(taskNodeId);
    expect(attempts).toHaveLength(2);
    expect(attempts[0]).toMatchObject({
      executionId: edgeAttempt.executionId,
      taskNodeId,
      backend: 'edge',
      taskId: 'task-retry',
      status: 'failed',
    });
    expect(attempts[1]).toMatchObject({
      executionId: containerAttempt.executionId,
      taskNodeId,
      backend: 'container',
      taskId: 'task-retry',
      status: 'running',
    });
  });

  it('marks expired running executions as lost', () => {
    const started = beginExecution({
      scopeType: 'task',
      scopeId: 'task-expired',
      backend: 'edge',
      taskId: 'task-expired',
      now: new Date('2026-04-03T00:00:00.000Z'),
      leaseMs: 60_000,
    });

    expect(
      markExpiredExecutionsLost(new Date('2026-04-03T00:01:01.000Z')),
    ).toEqual([started.executionId]);
    expect(getExecutionState(started.executionId)).toMatchObject({
      executionId: started.executionId,
      status: 'lost',
      error: 'Execution lease expired at 2026-04-03T00:01:00.000Z',
      finishedAt: '2026-04-03T00:01:01.000Z',
    });
  });

  it('derives leases from execution deadlines with a small grace window', () => {
    expect(deriveExecutionLeaseMs(300000)).toBe(305000);
    expect(deriveExecutionLeaseMs(100)).toBe(5100);
  });

  it('requests cancellation for all active executions belonging to a task', () => {
    const first = beginExecution({
      scopeType: 'task',
      scopeId: 'task-cancel',
      backend: 'edge',
      taskId: 'task-cancel',
      now: new Date('2026-04-03T00:00:00.000Z'),
    });
    const second = beginExecution({
      scopeType: 'task',
      scopeId: 'task-cancel',
      backend: 'container',
      taskId: 'task-cancel',
      now: new Date('2026-04-03T00:00:01.000Z'),
    });

    expect(
      requestTaskExecutionsCancel(
        'task-cancel',
        new Date('2026-04-03T00:00:02.000Z'),
      ),
    ).toEqual([first.executionId, second.executionId]);
    expect(getExecutionState(first.executionId)?.status).toBe(
      'cancel_requested',
    );
    expect(getExecutionState(second.executionId)?.status).toBe(
      'cancel_requested',
    );
  });

  it('reconciles expired root executions into failed task graph state', () => {
    createLogicalSession({
      id: 'task:expired-root',
      scopeType: 'task',
      scopeId: 'expired-root',
      providerSessionId: null,
      status: 'active',
      lastTurnId: null,
      workspaceVersion: null,
      groupMemoryVersion: null,
      summaryRef: null,
      recentMessagesWindow: null,
      createdAt: '2026-04-03T00:00:00.000Z',
      updatedAt: '2026-04-03T00:00:00.000Z',
    });
    createRootTaskGraph({
      graphId: 'graph:expired-root',
      rootTaskId: 'task:expired-root:root',
      requestKind: 'scheduled_task',
      scopeType: 'task',
      scopeId: 'expired-root',
      groupFolder: 'team_alpha',
      chatJid: 'room@g.us',
      logicalSessionId: 'task:expired-root',
      workerClass: 'edge',
      backendId: 'edge',
      now: new Date('2026-04-03T00:00:00.000Z'),
    });
    markTaskNodeRunning('graph:expired-root', 'task:expired-root:root');

    const execution = beginExecution({
      scopeType: 'task',
      scopeId: 'expired-root',
      backend: 'edge',
      taskNodeId: 'task:expired-root:root',
      taskId: 'task-expired-root',
      now: new Date('2026-04-03T00:00:00.000Z'),
      leaseMs: 60_000,
    });

    expect(
      markExpiredExecutionsLost(new Date('2026-04-03T00:01:01.000Z')),
    ).toEqual([execution.executionId]);
    expect(getTaskNode('task:expired-root:root')).toMatchObject({
      status: 'failed',
      error: 'Execution lease expired at 2026-04-03T00:01:00.000Z',
    });
    expect(getTaskGraph('graph:expired-root')).toMatchObject({
      status: 'failed',
      error: 'Execution lease expired at 2026-04-03T00:01:00.000Z',
    });
  });

  it('fails the whole graph when a child execution lease expires', () => {
    createLogicalSession({
      id: 'task:expired-child',
      scopeType: 'task',
      scopeId: 'expired-child',
      providerSessionId: null,
      status: 'active',
      lastTurnId: null,
      workspaceVersion: null,
      groupMemoryVersion: null,
      summaryRef: null,
      recentMessagesWindow: null,
      createdAt: '2026-04-03T00:00:00.000Z',
      updatedAt: '2026-04-03T00:00:00.000Z',
    });
    createRootTaskGraph({
      graphId: 'graph:expired-child',
      rootTaskId: 'task:expired-child:root',
      requestKind: 'group_turn',
      scopeType: 'task',
      scopeId: 'expired-child',
      groupFolder: 'team_alpha',
      chatJid: 'room@g.us',
      logicalSessionId: 'task:expired-child',
      workerClass: 'edge',
      backendId: 'edge',
      now: new Date('2026-04-03T00:00:00.000Z'),
    });
    createTaskNodeInGraph({
      taskId: 'task:expired-child:child-1',
      graphId: 'graph:expired-child',
      parentTaskId: 'task:expired-child:root',
      nodeKind: 'fanout_child',
      workerClass: 'edge',
      backendId: 'edge',
      now: new Date('2026-04-03T00:00:01.000Z'),
    });
    markTaskNodeRunning('graph:expired-child', 'task:expired-child:root');
    markTaskNodeRunning('graph:expired-child', 'task:expired-child:child-1');

    const execution = beginExecution({
      scopeType: 'task',
      scopeId: 'expired-child',
      backend: 'edge',
      taskNodeId: 'task:expired-child:child-1',
      taskId: 'task-expired-child',
      now: new Date('2026-04-03T00:00:00.000Z'),
      leaseMs: 60_000,
    });

    expect(
      markExpiredExecutionsLost(new Date('2026-04-03T00:01:01.000Z')),
    ).toEqual([execution.executionId]);
    expect(getTaskNode('task:expired-child:child-1')).toMatchObject({
      status: 'failed',
    });
    expect(getTaskNode('task:expired-child:root')).toMatchObject({
      status: 'failed',
      error: 'Execution lease expired at 2026-04-03T00:01:00.000Z',
    });
    expect(getTaskGraph('graph:expired-child')).toMatchObject({
      status: 'failed',
    });
  });
});
