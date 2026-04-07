import { beforeEach, describe, expect, it } from 'vitest';

import {
  _initTestDatabase,
  createLogicalSession,
  getTaskNode,
  listExecutionStatesForTaskNode,
} from './db.js';
import { beginExecution, failExecution } from './execution-state.js';
import {
  continueTaskGraph,
  completeTaskNode,
  createFanoutTaskGraph,
  createRootTaskGraph,
  fallbackTaskNodeToHeavy,
  recordTaskNodeFailure,
  requireReplanForTaskNode,
  retryTaskNodeOnSameWorker,
} from './task-graph-state.js';

beforeEach(() => {
  _initTestDatabase();
});

describe('task graph recovery', () => {
  it('retries the same node on the same worker class', () => {
    createLogicalSession({
      id: 'task:retry-same-worker',
      scopeType: 'task',
      scopeId: 'retry-same-worker',
      providerSessionId: null,
      status: 'active',
      lastTurnId: null,
      workspaceVersion: null,
      groupMemoryVersion: null,
      summaryRef: null,
      recentMessagesWindow: null,
      createdAt: '2026-04-06T00:00:00.000Z',
      updatedAt: '2026-04-06T00:00:00.000Z',
    });

    createRootTaskGraph({
      graphId: 'graph:retry-same-worker',
      rootTaskId: 'task:retry-same-worker:root',
      requestKind: 'scheduled_task',
      scopeType: 'task',
      scopeId: 'retry-same-worker',
      groupFolder: 'team_retry',
      chatJid: 'retry@g.us',
      logicalSessionId: 'task:retry-same-worker',
      workerClass: 'edge',
      backendId: 'edge',
      fallbackEligible: true,
      now: new Date('2026-04-06T00:00:00.000Z'),
    });

    recordTaskNodeFailure({
      taskId: 'task:retry-same-worker:root',
      error: 'transient edge issue',
      failureClass: 'execution_failure',
      now: new Date('2026-04-06T00:00:01.000Z'),
    });
    retryTaskNodeOnSameWorker(
      'task:retry-same-worker:root',
      new Date('2026-04-06T00:00:02.000Z'),
    );

    expect(getTaskNode('task:retry-same-worker:root')).toMatchObject({
      workerClass: 'edge',
      backendId: 'edge',
      status: 'ready',
      error: null,
      failureClass: null,
      fallbackTarget: null,
      fallbackReason: null,
    });
  });

  it('falls back edge timeout failures to heavy with a new execution attempt', () => {
    createLogicalSession({
      id: 'task:edge-timeout',
      scopeType: 'task',
      scopeId: 'edge-timeout',
      providerSessionId: null,
      status: 'active',
      lastTurnId: null,
      workspaceVersion: null,
      groupMemoryVersion: null,
      summaryRef: null,
      recentMessagesWindow: null,
      createdAt: '2026-04-06T00:00:00.000Z',
      updatedAt: '2026-04-06T00:00:00.000Z',
    });

    createRootTaskGraph({
      graphId: 'graph:edge-timeout',
      rootTaskId: 'task:edge-timeout:root',
      requestKind: 'scheduled_task',
      scopeType: 'task',
      scopeId: 'edge-timeout',
      groupFolder: 'team_timeout',
      chatJid: 'timeout@g.us',
      logicalSessionId: 'task:edge-timeout',
      workerClass: 'edge',
      backendId: 'edge',
      fallbackEligible: true,
      now: new Date('2026-04-06T00:00:00.000Z'),
    });

    const edgeAttempt = beginExecution({
      scopeType: 'task',
      scopeId: 'edge-timeout',
      backend: 'edge',
      taskId: 'edge-timeout',
      taskNodeId: 'task:edge-timeout:root',
      now: new Date('2026-04-06T00:00:00.000Z'),
    });
    failExecution(
      edgeAttempt.executionId,
      'edge timeout',
      new Date('2026-04-06T00:00:05.000Z'),
    );
    recordTaskNodeFailure({
      taskId: 'task:edge-timeout:root',
      error: 'edge timeout',
      failureClass: 'execution_failure',
      fallbackTarget: 'heavy',
      fallbackReason: 'edge_timeout',
      now: new Date('2026-04-06T00:00:05.000Z'),
    });
    fallbackTaskNodeToHeavy(
      'task:edge-timeout:root',
      'edge_timeout',
      new Date('2026-04-06T00:00:06.000Z'),
    );

    const heavyAttempt = beginExecution({
      scopeType: 'task',
      scopeId: 'edge-timeout',
      backend: 'container',
      taskId: 'edge-timeout',
      taskNodeId: 'task:edge-timeout:root',
      now: new Date('2026-04-06T00:00:06.000Z'),
    });

    expect(getTaskNode('task:edge-timeout:root')).toMatchObject({
      workerClass: 'heavy',
      backendId: 'container',
      status: 'ready',
      error: null,
      fallbackTarget: 'heavy',
      fallbackReason: 'edge_timeout',
    });
    expect(listExecutionStatesForTaskNode('task:edge-timeout:root')).toEqual([
      expect.objectContaining({
        executionId: edgeAttempt.executionId,
        backend: 'edge',
        status: 'failed',
      }),
      expect.objectContaining({
        executionId: heavyAttempt.executionId,
        backend: 'container',
        status: 'running',
      }),
    ]);
  });

  it('marks commit conflicts as requiring replan', () => {
    createLogicalSession({
      id: 'task:replan',
      scopeType: 'task',
      scopeId: 'replan',
      providerSessionId: null,
      status: 'active',
      lastTurnId: null,
      workspaceVersion: null,
      groupMemoryVersion: null,
      summaryRef: null,
      recentMessagesWindow: null,
      createdAt: '2026-04-06T00:00:00.000Z',
      updatedAt: '2026-04-06T00:00:00.000Z',
    });

    createRootTaskGraph({
      graphId: 'graph:replan',
      rootTaskId: 'task:replan:root',
      requestKind: 'scheduled_task',
      scopeType: 'task',
      scopeId: 'replan',
      groupFolder: 'team_replan',
      chatJid: 'replan@g.us',
      logicalSessionId: 'task:replan',
      workerClass: 'edge',
      backendId: 'edge',
      fallbackEligible: true,
      now: new Date('2026-04-06T00:00:00.000Z'),
    });

    requireReplanForTaskNode(
      'task:replan:root',
      'state_conflict_requires_heavy',
      new Date('2026-04-06T00:00:01.000Z'),
    );

    expect(getTaskNode('task:replan:root')).toMatchObject({
      status: 'failed',
      failureClass: 'commit_failure',
      fallbackTarget: 'replan',
      fallbackReason: 'state_conflict_requires_heavy',
      error: 'Replan required: state_conflict_requires_heavy',
    });
  });

  it('continues partial best-effort graphs after recoverable child failures', () => {
    createLogicalSession({
      id: 'group:team_recovery',
      scopeType: 'group',
      scopeId: 'team_recovery',
      providerSessionId: null,
      status: 'active',
      lastTurnId: null,
      workspaceVersion: null,
      groupMemoryVersion: null,
      summaryRef: null,
      recentMessagesWindow: null,
      createdAt: '2026-04-06T00:00:00.000Z',
      updatedAt: '2026-04-06T00:00:00.000Z',
    });

    const fanout = createFanoutTaskGraph({
      graphId: 'graph:partial-continuation',
      rootTaskId: 'task:partial-continuation:root',
      aggregateTaskId: 'task:partial-continuation:aggregate',
      requestKind: 'group_turn',
      scopeType: 'group',
      scopeId: 'team_recovery',
      groupFolder: 'team_recovery',
      chatJid: 'recovery@g.us',
      logicalSessionId: 'group:team_recovery',
      childTasks: [
        { taskId: 'task:partial-continuation:child-1' },
        { taskId: 'task:partial-continuation:child-2' },
      ],
      aggregatePolicy: 'best_effort',
      now: new Date('2026-04-06T00:00:02.000Z'),
    });

    completeTaskNode(
      'task:partial-continuation:child-1',
      new Date('2026-04-06T00:00:03.000Z'),
    );
    recordTaskNodeFailure({
      taskId: 'task:partial-continuation:child-2',
      error: 'source failed',
      failureClass: 'execution_failure',
      now: new Date('2026-04-06T00:00:04.000Z'),
    });

    expect(
      continueTaskGraph(
        fanout.graph.graphId,
        new Date('2026-04-06T00:00:05.000Z'),
      ).map((node) => node.taskId),
    ).toEqual(['task:partial-continuation:aggregate']);
    expect(getTaskNode('task:partial-continuation:aggregate')).toMatchObject({
      status: 'ready',
      aggregatePolicy: 'best_effort',
    });

    completeTaskNode(
      'task:partial-continuation:aggregate',
      new Date('2026-04-06T00:00:06.000Z'),
    );

    expect(
      continueTaskGraph(
        fanout.graph.graphId,
        new Date('2026-04-06T00:00:07.000Z'),
      ).map((node) => node.taskId),
    ).toEqual(['task:partial-continuation:root']);
  });
});
