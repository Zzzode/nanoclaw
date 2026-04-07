import { beforeEach, describe, expect, it } from 'vitest';

import {
  _initTestDatabase,
  createLogicalSession,
  createToolOperation,
  createWorkspaceCommit,
  createWorkspaceVersion,
} from './db.js';
import {
  commitExecution,
  completeExecution,
  beginExecution,
  failExecution,
} from './execution-state.js';
import { FRAMEWORK_POLICY_VERSION } from './framework-policy.js';
import {
  listFrameworkExecutionObservations,
  listFrameworkRouteObservations,
  summarizeFrameworkGovernance,
} from './framework-observability.js';
import {
  completeRootTaskGraph,
  createRootTaskGraph,
  failRootTaskGraph,
  fallbackTaskNodeToHeavy,
  recordTaskNodeFailure,
  requireReplanForTaskNode,
} from './task-graph-state.js';

beforeEach(() => {
  _initTestDatabase();
});

describe('framework observability', () => {
  it('lists durable route metadata with policy versions', () => {
    createLogicalSession({
      id: 'task:route-metadata',
      scopeType: 'task',
      scopeId: 'route-metadata',
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
      graphId: 'graph:route-metadata',
      rootTaskId: 'task:route-metadata:root',
      requestKind: 'scheduled_task',
      scopeType: 'task',
      scopeId: 'route-metadata',
      groupFolder: 'team_route',
      chatJid: 'route@g.us',
      logicalSessionId: 'task:route-metadata',
      workerClass: 'edge',
      backendId: 'edge',
      requiredCapabilities: ['message.send'],
      routeReason: 'capability_match_edge',
      policyVersion: FRAMEWORK_POLICY_VERSION,
      fallbackEligible: true,
      now: new Date('2026-04-06T00:00:00.000Z'),
    });

    expect(listFrameworkRouteObservations('graph:route-metadata')).toEqual([
      expect.objectContaining({
        graphId: 'graph:route-metadata',
        taskId: 'task:route-metadata:root',
        workerClass: 'edge',
        backendId: 'edge',
        requiredCapabilities: ['message.send'],
        routeReason: 'capability_match_edge',
        policyVersion: FRAMEWORK_POLICY_VERSION,
        fallbackEligible: true,
      }),
    ]);
  });

  it('derives execution metrics and governance summaries from durable state', () => {
    createLogicalSession({
      id: 'task:edge-fallback',
      scopeType: 'task',
      scopeId: 'edge-fallback',
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
      graphId: 'graph:edge-fallback',
      rootTaskId: 'task:edge-fallback:root',
      requestKind: 'scheduled_task',
      scopeType: 'task',
      scopeId: 'edge-fallback',
      groupFolder: 'team_obs',
      chatJid: 'edge-fallback@g.us',
      logicalSessionId: 'task:edge-fallback',
      workerClass: 'edge',
      backendId: 'edge',
      requiredCapabilities: ['message.send'],
      routeReason: 'capability_match_edge',
      policyVersion: FRAMEWORK_POLICY_VERSION,
      fallbackEligible: true,
      now: new Date('2026-04-06T00:00:00.000Z'),
    });

    createWorkspaceVersion({
      versionId: 'workspace:base',
      groupFolder: 'team_obs',
      baseVersionId: null,
      manifestJson: JSON.stringify({ 'README.md': 'before' }),
      createdAt: '2026-04-06T00:00:00.000Z',
    });
    createWorkspaceVersion({
      versionId: 'workspace:after-heavy',
      groupFolder: 'team_obs',
      baseVersionId: 'workspace:base',
      manifestJson: JSON.stringify({ 'README.md': 'updated' }),
      createdAt: '2026-04-06T00:00:06.000Z',
    });

    const edgeAttempt = beginExecution({
      scopeType: 'task',
      scopeId: 'edge-fallback',
      backend: 'edge',
      taskId: 'edge-fallback',
      taskNodeId: 'task:edge-fallback:root',
      baseWorkspaceVersion: 'workspace:base',
      now: new Date('2026-04-06T00:00:00.000Z'),
    });
    createToolOperation({
      operationId: 'op:edge-fallback:1',
      executionId: edgeAttempt.executionId,
      tool: 'workspace.read',
      resultJson: JSON.stringify({ ok: true }),
      createdAt: '2026-04-06T00:00:01.000Z',
    });
    failExecution(
      edgeAttempt.executionId,
      'edge timeout',
      new Date('2026-04-06T00:00:02.000Z'),
    );
    recordTaskNodeFailure({
      taskId: 'task:edge-fallback:root',
      error: 'edge timeout',
      failureClass: 'execution_failure',
      fallbackTarget: 'heavy',
      fallbackReason: 'edge_timeout',
      now: new Date('2026-04-06T00:00:02.000Z'),
    });
    fallbackTaskNodeToHeavy(
      'task:edge-fallback:root',
      'edge_timeout',
      new Date('2026-04-06T00:00:03.000Z'),
    );

    const heavyAttempt = beginExecution({
      scopeType: 'task',
      scopeId: 'edge-fallback',
      backend: 'container',
      taskId: 'edge-fallback',
      taskNodeId: 'task:edge-fallback:root',
      baseWorkspaceVersion: 'workspace:base',
      now: new Date('2026-04-06T00:00:03.000Z'),
    });
    createToolOperation({
      operationId: 'op:edge-fallback:2',
      executionId: heavyAttempt.executionId,
      tool: 'workspace.write',
      resultJson: JSON.stringify({ ok: true }),
      createdAt: '2026-04-06T00:00:04.000Z',
    });
    createWorkspaceCommit({
      operationId: `${heavyAttempt.executionId}:workspace-commit`,
      groupFolder: 'team_obs',
      baseVersionId: 'workspace:base',
      newVersionId: 'workspace:after-heavy',
      createdAt: '2026-04-06T00:00:06.000Z',
    });
    commitExecution(
      heavyAttempt.executionId,
      new Date('2026-04-06T00:00:06.000Z'),
    );
    completeExecution(
      heavyAttempt.executionId,
      new Date('2026-04-06T00:00:08.000Z'),
    );
    completeRootTaskGraph(
      'graph:edge-fallback',
      'task:edge-fallback:root',
      new Date('2026-04-06T00:00:08.000Z'),
    );

    createLogicalSession({
      id: 'task:edge-only',
      scopeType: 'task',
      scopeId: 'edge-only',
      providerSessionId: null,
      status: 'active',
      lastTurnId: null,
      workspaceVersion: null,
      groupMemoryVersion: null,
      summaryRef: null,
      recentMessagesWindow: null,
      createdAt: '2026-04-06T00:00:10.000Z',
      updatedAt: '2026-04-06T00:00:10.000Z',
    });
    createRootTaskGraph({
      graphId: 'graph:edge-only',
      rootTaskId: 'task:edge-only:root',
      requestKind: 'scheduled_task',
      scopeType: 'task',
      scopeId: 'edge-only',
      groupFolder: 'team_obs',
      chatJid: 'edge-only@g.us',
      logicalSessionId: 'task:edge-only',
      workerClass: 'edge',
      backendId: 'edge',
      requiredCapabilities: [],
      routeReason: 'no_special_capabilities',
      policyVersion: FRAMEWORK_POLICY_VERSION,
      fallbackEligible: false,
      now: new Date('2026-04-06T00:00:10.000Z'),
    });

    const edgeOnlyAttempt = beginExecution({
      scopeType: 'task',
      scopeId: 'edge-only',
      backend: 'edge',
      taskId: 'edge-only',
      taskNodeId: 'task:edge-only:root',
      now: new Date('2026-04-06T00:00:10.000Z'),
    });
    createToolOperation({
      operationId: 'op:edge-only:1',
      executionId: edgeOnlyAttempt.executionId,
      tool: 'message.send',
      resultJson: JSON.stringify({ ok: true }),
      createdAt: '2026-04-06T00:00:12.000Z',
    });
    commitExecution(
      edgeOnlyAttempt.executionId,
      new Date('2026-04-06T00:00:14.000Z'),
    );
    completeExecution(
      edgeOnlyAttempt.executionId,
      new Date('2026-04-06T00:00:18.000Z'),
    );
    completeRootTaskGraph(
      'graph:edge-only',
      'task:edge-only:root',
      new Date('2026-04-06T00:00:18.000Z'),
    );

    createLogicalSession({
      id: 'task:commit-conflict',
      scopeType: 'task',
      scopeId: 'commit-conflict',
      providerSessionId: null,
      status: 'active',
      lastTurnId: null,
      workspaceVersion: null,
      groupMemoryVersion: null,
      summaryRef: null,
      recentMessagesWindow: null,
      createdAt: '2026-04-06T00:00:20.000Z',
      updatedAt: '2026-04-06T00:00:20.000Z',
    });
    createRootTaskGraph({
      graphId: 'graph:commit-conflict',
      rootTaskId: 'task:commit-conflict:root',
      requestKind: 'scheduled_task',
      scopeType: 'task',
      scopeId: 'commit-conflict',
      groupFolder: 'team_obs',
      chatJid: 'commit-conflict@g.us',
      logicalSessionId: 'task:commit-conflict',
      workerClass: 'edge',
      backendId: 'edge',
      requiredCapabilities: ['message.send'],
      routeReason: 'capability_match_edge',
      policyVersion: FRAMEWORK_POLICY_VERSION,
      fallbackEligible: true,
      now: new Date('2026-04-06T00:00:20.000Z'),
    });
    requireReplanForTaskNode(
      'task:commit-conflict:root',
      'state_conflict_requires_heavy',
      new Date('2026-04-06T00:00:25.000Z'),
    );
    failRootTaskGraph(
      'graph:commit-conflict',
      'task:commit-conflict:root',
      'workspace conflict',
      new Date('2026-04-06T00:00:28.000Z'),
    );

    const fallbackExecutions = listFrameworkExecutionObservations({
      graphId: 'graph:edge-fallback',
      now: new Date('2026-04-06T00:01:00.000Z'),
    });
    const failedEdgeObservation = fallbackExecutions.find(
      (execution) => execution.backend === 'edge',
    );
    const heavyObservation = fallbackExecutions.find(
      (execution) => execution.backend === 'container',
    );

    expect(failedEdgeObservation).toMatchObject({
      graphId: 'graph:edge-fallback',
      workerClass: 'edge',
      routeReason: 'capability_match_edge',
      policyVersion: FRAMEWORK_POLICY_VERSION,
      status: 'failed',
      timedOut: true,
      toolCallCount: 1,
      commitStatus: 'not_attempted',
    });
    expect(heavyObservation).toMatchObject({
      graphId: 'graph:edge-fallback',
      workerClass: 'heavy',
      status: 'completed',
      durationMs: 5000,
      toolCallCount: 1,
      workspaceChangeCount: 1,
      workspaceOverlayBytes: 7,
      commitStatus: 'applied',
    });

    expect(
      listFrameworkExecutionObservations({
        graphId: 'graph:edge-only',
        now: new Date('2026-04-06T00:01:00.000Z'),
      }),
    ).toEqual([
      expect.objectContaining({
        backend: 'edge',
        commitStatus: 'accepted_without_overlay',
      }),
    ]);

    expect(
      summarizeFrameworkGovernance(new Date('2026-04-06T00:01:00.000Z')),
    ).toMatchObject({
      totalGraphs: 3,
      totalExecutions: 3,
      routeReasonCounts: {
        capability_match_edge: 2,
        no_special_capabilities: 1,
      },
      workerClassCounts: {
        edge: 2,
        heavy: 1,
      },
      edgeOnlyCompletionRate: 0.5,
      edgeToHeavyFallbackRate: 0.5,
      averageFanoutWidth: 0,
      averageGraphCompletionLatencyMs: 8000,
      commitSuccessRate: 1,
      commitConflictRate: 1 / 3,
    });
  });

  it('surfaces fallback and replan outcomes in route and execution observations', () => {
    createLogicalSession({
      id: 'task:obs-fallback',
      scopeType: 'task',
      scopeId: 'obs-fallback',
      providerSessionId: null,
      status: 'active',
      lastTurnId: null,
      workspaceVersion: null,
      groupMemoryVersion: null,
      summaryRef: null,
      recentMessagesWindow: null,
      createdAt: '2026-04-07T00:00:00.000Z',
      updatedAt: '2026-04-07T00:00:00.000Z',
    });
    createRootTaskGraph({
      graphId: 'graph:obs-fallback',
      rootTaskId: 'task:obs-fallback:root',
      requestKind: 'group_turn',
      scopeType: 'task',
      scopeId: 'obs-fallback',
      groupFolder: 'team_obs',
      chatJid: 'obs-fallback@g.us',
      logicalSessionId: 'task:obs-fallback',
      workerClass: 'edge',
      backendId: 'edge',
      requiredCapabilities: ['message.send'],
      routeReason: 'capability_match_edge',
      policyVersion: FRAMEWORK_POLICY_VERSION,
      fallbackEligible: true,
      now: new Date('2026-04-07T00:00:00.000Z'),
    });

    const fallbackEdgeAttempt = beginExecution({
      scopeType: 'task',
      scopeId: 'obs-fallback',
      backend: 'edge',
      taskId: 'obs-fallback',
      taskNodeId: 'task:obs-fallback:root',
      now: new Date('2026-04-07T00:00:00.000Z'),
    });
    failExecution(
      fallbackEdgeAttempt.executionId,
      'Edge execution exceeded deadline of 100ms.',
      new Date('2026-04-07T00:00:02.000Z'),
    );
    recordTaskNodeFailure({
      taskId: 'task:obs-fallback:root',
      error: 'Edge execution exceeded deadline of 100ms.',
      failureClass: 'execution_failure',
      fallbackTarget: 'heavy',
      fallbackReason: 'edge_timeout',
      now: new Date('2026-04-07T00:00:02.000Z'),
    });
    fallbackTaskNodeToHeavy(
      'task:obs-fallback:root',
      'edge_timeout',
      new Date('2026-04-07T00:00:03.000Z'),
    );

    const fallbackHeavyAttempt = beginExecution({
      scopeType: 'task',
      scopeId: 'obs-fallback',
      backend: 'container',
      taskId: 'obs-fallback',
      taskNodeId: 'task:obs-fallback:root',
      now: new Date('2026-04-07T00:00:03.000Z'),
    });
    commitExecution(
      fallbackHeavyAttempt.executionId,
      new Date('2026-04-07T00:00:04.000Z'),
    );
    completeExecution(
      fallbackHeavyAttempt.executionId,
      new Date('2026-04-07T00:00:05.000Z'),
    );
    completeRootTaskGraph(
      'graph:obs-fallback',
      'task:obs-fallback:root',
      new Date('2026-04-07T00:00:05.000Z'),
    );

    createLogicalSession({
      id: 'task:obs-replan',
      scopeType: 'task',
      scopeId: 'obs-replan',
      providerSessionId: null,
      status: 'active',
      lastTurnId: null,
      workspaceVersion: null,
      groupMemoryVersion: null,
      summaryRef: null,
      recentMessagesWindow: null,
      createdAt: '2026-04-07T00:00:10.000Z',
      updatedAt: '2026-04-07T00:00:10.000Z',
    });
    createRootTaskGraph({
      graphId: 'graph:obs-replan',
      rootTaskId: 'task:obs-replan:root',
      requestKind: 'group_turn',
      scopeType: 'task',
      scopeId: 'obs-replan',
      groupFolder: 'team_obs',
      chatJid: 'obs-replan@g.us',
      logicalSessionId: 'task:obs-replan',
      workerClass: 'edge',
      backendId: 'edge',
      requiredCapabilities: ['message.send'],
      routeReason: 'capability_match_edge',
      policyVersion: FRAMEWORK_POLICY_VERSION,
      fallbackEligible: true,
      now: new Date('2026-04-07T00:00:10.000Z'),
    });

    const replanEdgeAttempt = beginExecution({
      scopeType: 'task',
      scopeId: 'obs-replan',
      backend: 'edge',
      taskId: 'obs-replan',
      taskNodeId: 'task:obs-replan:root',
      now: new Date('2026-04-07T00:00:10.000Z'),
    });
    failExecution(
      replanEdgeAttempt.executionId,
      'Workspace version conflict: expected a, received b',
      new Date('2026-04-07T00:00:11.000Z'),
    );
    requireReplanForTaskNode(
      'task:obs-replan:root',
      'state_conflict_requires_heavy',
      new Date('2026-04-07T00:00:11.000Z'),
    );
    failRootTaskGraph(
      'graph:obs-replan',
      'task:obs-replan:root',
      'Workspace version conflict: expected a, received b',
      new Date('2026-04-07T00:00:12.000Z'),
    );

    expect(listFrameworkRouteObservations('graph:obs-fallback')).toEqual([
      expect.objectContaining({
        taskId: 'task:obs-fallback:root',
        workerClass: 'heavy',
        backendId: 'container',
        fallbackEligible: true,
        fallbackTarget: 'heavy',
        fallbackReason: 'edge_timeout',
      }),
    ]);
    expect(listFrameworkRouteObservations('graph:obs-replan')).toEqual([
      expect.objectContaining({
        taskId: 'task:obs-replan:root',
        workerClass: 'edge',
        backendId: 'edge',
        fallbackEligible: true,
        fallbackTarget: 'replan',
        fallbackReason: 'state_conflict_requires_heavy',
      }),
    ]);

    expect(
      listFrameworkExecutionObservations({
        graphId: 'graph:obs-fallback',
        now: new Date('2026-04-07T00:01:00.000Z'),
      }),
    ).toEqual([
      expect.objectContaining({
        backend: 'edge',
        status: 'failed',
        timedOut: true,
        commitStatus: 'not_attempted',
      }),
      expect.objectContaining({
        backend: 'container',
        status: 'completed',
        commitStatus: 'accepted_without_overlay',
      }),
    ]);
    expect(
      listFrameworkExecutionObservations({
        graphId: 'graph:obs-replan',
        now: new Date('2026-04-07T00:01:00.000Z'),
      }),
    ).toEqual([
      expect.objectContaining({
        backend: 'edge',
        status: 'failed',
        commitStatus: 'conflict',
        heartbeatHealth: 'terminal',
      }),
    ]);

    expect(
      summarizeFrameworkGovernance(new Date('2026-04-07T00:01:00.000Z')),
    ).toMatchObject({
      totalGraphs: 2,
      totalExecutions: 3,
      edgeToHeavyFallbackRate: 0.5,
      commitConflictRate: 0.5,
    });
  });
});
