import { beforeEach, describe, expect, it } from 'vitest';

import {
  _initTestDatabase,
  createLogicalSession,
  getTaskNode,
  listTaskNodeDependencies,
} from './db.js';
import {
  completeTaskNode,
  createFanoutTaskGraph,
  failTaskNode,
  listRunnableTaskNodes,
  reconcileAggregateTaskNode,
} from './task-graph-state.js';

beforeEach(() => {
  _initTestDatabase();
});

describe('task graph fanout', () => {
  it('runs child nodes first and blocks strict aggregates on dependency failure', () => {
    createLogicalSession({
      id: 'group:team_fanout',
      scopeType: 'group',
      scopeId: 'team_fanout',
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
      graphId: 'graph:fanout-strict',
      rootTaskId: 'task:fanout-strict:root',
      aggregateTaskId: 'task:fanout-strict:aggregate',
      requestKind: 'group_turn',
      scopeType: 'group',
      scopeId: 'team_fanout',
      groupFolder: 'team_fanout',
      chatJid: 'fanout@g.us',
      logicalSessionId: 'group:team_fanout',
      childTasks: [
        {
          taskId: 'task:fanout-strict:child-1',
          requiredCapabilities: ['fs.read'],
        },
        {
          taskId: 'task:fanout-strict:child-2',
          requiredCapabilities: ['fs.read'],
        },
      ],
      aggregatePolicy: 'strict',
      now: new Date('2026-04-06T00:00:00.000Z'),
    });

    expect(
      listRunnableTaskNodes(fanout.graph.graphId).map((node) => node.taskId),
    ).toEqual(['task:fanout-strict:child-1', 'task:fanout-strict:child-2']);
    expect(listTaskNodeDependencies(fanout.aggregateNode.taskId)).toHaveLength(
      2,
    );

    completeTaskNode('task:fanout-strict:child-1');
    failTaskNode('task:fanout-strict:child-2', 'read failed');
    reconcileAggregateTaskNode(fanout.aggregateNode.taskId);

    expect(getTaskNode(fanout.aggregateNode.taskId)).toMatchObject({
      taskId: 'task:fanout-strict:aggregate',
      status: 'failed',
      aggregatePolicy: 'strict',
      error: 'Strict aggregate blocked by 1 failed dependency',
    });
    expect(listRunnableTaskNodes(fanout.graph.graphId)).toEqual([]);
  });

  it('supports quorum and best-effort aggregate readiness', () => {
    createLogicalSession({
      id: 'task:fanout-quorum',
      scopeType: 'task',
      scopeId: 'fanout-quorum',
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

    const quorum = createFanoutTaskGraph({
      graphId: 'graph:fanout-quorum',
      rootTaskId: 'task:fanout-quorum:root',
      aggregateTaskId: 'task:fanout-quorum:aggregate',
      requestKind: 'scheduled_task',
      scopeType: 'task',
      scopeId: 'fanout-quorum',
      groupFolder: 'team_quorum',
      chatJid: 'quorum@g.us',
      logicalSessionId: 'task:fanout-quorum',
      childTasks: [
        { taskId: 'task:fanout-quorum:child-1' },
        { taskId: 'task:fanout-quorum:child-2' },
        { taskId: 'task:fanout-quorum:child-3' },
      ],
      aggregatePolicy: 'quorum',
      quorumCount: 2,
      now: new Date('2026-04-06T00:00:01.000Z'),
    });

    completeTaskNode('task:fanout-quorum:child-1');
    completeTaskNode('task:fanout-quorum:child-2');
    failTaskNode('task:fanout-quorum:child-3', 'source unavailable');

    expect(
      listRunnableTaskNodes(quorum.graph.graphId).map((node) => node.taskId),
    ).toEqual(['task:fanout-quorum:aggregate']);

    completeTaskNode(quorum.aggregateNode.taskId);
    expect(
      listRunnableTaskNodes(quorum.graph.graphId).map((node) => node.taskId),
    ).toEqual(['task:fanout-quorum:root']);

    const bestEffort = createFanoutTaskGraph({
      graphId: 'graph:fanout-best-effort',
      rootTaskId: 'task:fanout-best-effort:root',
      aggregateTaskId: 'task:fanout-best-effort:aggregate',
      requestKind: 'group_turn',
      scopeType: 'group',
      scopeId: 'team_best_effort',
      groupFolder: 'team_best_effort',
      chatJid: 'best-effort@g.us',
      logicalSessionId: 'task:fanout-quorum',
      childTasks: [
        { taskId: 'task:fanout-best-effort:child-1' },
        { taskId: 'task:fanout-best-effort:child-2' },
      ],
      aggregatePolicy: 'best_effort',
      now: new Date('2026-04-06T00:00:02.000Z'),
    });

    completeTaskNode('task:fanout-best-effort:child-1');
    failTaskNode('task:fanout-best-effort:child-2', 'partial source failure');
    reconcileAggregateTaskNode(bestEffort.aggregateNode.taskId);

    expect(
      listRunnableTaskNodes(bestEffort.graph.graphId).map(
        (node) => node.taskId,
      ),
    ).toEqual(['task:fanout-best-effort:aggregate']);
    expect(getTaskNode(bestEffort.aggregateNode.taskId)).toMatchObject({
      status: 'ready',
      aggregatePolicy: 'best_effort',
    });
  });
});
