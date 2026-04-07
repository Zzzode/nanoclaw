import { beforeEach, describe, expect, it } from 'vitest';

import {
  _initTestDatabase,
  createLogicalSession,
  getTaskGraph,
  getTaskNode,
} from './db.js';
import {
  completeRootTaskGraph,
  createRootTaskGraph,
  failRootTaskGraph,
  listRunnableTaskNodes,
  markTaskNodeRunning,
} from './task-graph-state.js';

beforeEach(() => {
  _initTestDatabase();
});

describe('task graph state', () => {
  it('creates a root graph and root node, then marks them running', () => {
    createLogicalSession({
      id: 'group:team_alpha',
      scopeType: 'group',
      scopeId: 'team_alpha',
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
      graphId: 'graph:1',
      rootTaskId: 'task:1:root',
      requestKind: 'group_turn',
      scopeType: 'group',
      scopeId: 'team_alpha',
      groupFolder: 'team_alpha',
      chatJid: 'room@g.us',
      logicalSessionId: 'group:team_alpha',
      workerClass: 'edge',
      backendId: 'edge',
      now: new Date('2026-04-06T00:00:00.000Z'),
    });

    expect(listRunnableTaskNodes('graph:1')).toHaveLength(1);

    markTaskNodeRunning(
      'graph:1',
      'task:1:root',
      new Date('2026-04-06T00:00:01.000Z'),
    );

    expect(getTaskGraph('graph:1')).toMatchObject({
      graphId: 'graph:1',
      status: 'running',
      rootTaskId: 'task:1:root',
    });
    expect(getTaskNode('task:1:root')).toMatchObject({
      taskId: 'task:1:root',
      status: 'running',
      workerClass: 'edge',
      backendId: 'edge',
    });
  });

  it('marks a root graph completed or failed', () => {
    createLogicalSession({
      id: 'task:task-2',
      scopeType: 'task',
      scopeId: 'task-2',
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
      graphId: 'graph:2',
      rootTaskId: 'task:2:root',
      requestKind: 'scheduled_task',
      scopeType: 'task',
      scopeId: 'task-2',
      groupFolder: 'team_beta',
      chatJid: 'team@g.us',
      logicalSessionId: 'task:task-2',
      workerClass: 'heavy',
      backendId: 'container',
      now: new Date('2026-04-06T00:00:00.000Z'),
    });
    markTaskNodeRunning(
      'graph:2',
      'task:2:root',
      new Date('2026-04-06T00:00:01.000Z'),
    );
    completeRootTaskGraph(
      'graph:2',
      'task:2:root',
      new Date('2026-04-06T00:00:02.000Z'),
    );

    expect(getTaskGraph('graph:2')).toMatchObject({
      status: 'completed',
      error: null,
    });
    expect(getTaskNode('task:2:root')).toMatchObject({
      status: 'completed',
      error: null,
    });

    createLogicalSession({
      id: 'group:team_gamma',
      scopeType: 'group',
      scopeId: 'team_gamma',
      providerSessionId: null,
      status: 'active',
      lastTurnId: null,
      workspaceVersion: null,
      groupMemoryVersion: null,
      summaryRef: null,
      recentMessagesWindow: null,
      createdAt: '2026-04-06T00:00:03.000Z',
      updatedAt: '2026-04-06T00:00:03.000Z',
    });
    createRootTaskGraph({
      graphId: 'graph:3',
      rootTaskId: 'task:3:root',
      requestKind: 'group_turn',
      scopeType: 'group',
      scopeId: 'team_gamma',
      groupFolder: 'team_gamma',
      chatJid: 'gamma@g.us',
      logicalSessionId: 'group:team_gamma',
      workerClass: 'edge',
      backendId: 'edge',
      now: new Date('2026-04-06T00:00:03.000Z'),
    });
    markTaskNodeRunning(
      'graph:3',
      'task:3:root',
      new Date('2026-04-06T00:00:04.000Z'),
    );
    failRootTaskGraph(
      'graph:3',
      'task:3:root',
      'edge timeout',
      new Date('2026-04-06T00:00:05.000Z'),
    );

    expect(getTaskGraph('graph:3')).toMatchObject({
      status: 'failed',
      error: 'edge timeout',
    });
    expect(getTaskNode('task:3:root')).toMatchObject({
      status: 'failed',
      error: 'edge timeout',
    });
  });
});
