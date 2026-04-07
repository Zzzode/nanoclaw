import fs from 'fs';
import os from 'os';
import path from 'path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { FRAMEWORK_POLICY_VERSION } from './framework-policy.js';
import type { RegisteredGroup } from './types.js';

describe('framework orchestrator facade', () => {
  let tempRoot: string;

  beforeEach(() => {
    tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoclaw-framework-'));
    vi.stubEnv('NANOCLAW_STORE_DIR', path.join(tempRoot, 'store'));
    vi.stubEnv('NANOCLAW_GROUPS_DIR', path.join(tempRoot, 'groups'));
    vi.stubEnv('NANOCLAW_DATA_DIR', path.join(tempRoot, 'data'));
  });

  afterEach(() => {
    vi.resetModules();
    vi.unstubAllEnvs();
    fs.rmSync(tempRoot, { recursive: true, force: true });
  });

  it('maps current group turns into a root task graph with a heavy worker placement', async () => {
    vi.resetModules();
    const [{ _initTestDatabase }, { createFrameworkRunContext }] =
      await Promise.all([
        import('./db.js'),
        import('./framework-orchestrator.js'),
      ]);
    _initTestDatabase();

    const group: RegisteredGroup = {
      name: 'Team Alpha',
      folder: 'team_alpha',
      trigger: '@Andy',
      added_at: '2026-04-06T00:00:00.000Z',
      executionMode: 'container',
    };

    fs.mkdirSync(path.join(tempRoot, 'groups', group.folder), {
      recursive: true,
    });
    fs.writeFileSync(
      path.join(tempRoot, 'groups', group.folder, 'CLAUDE.md'),
      '# Team Alpha\n',
    );

    const context = createFrameworkRunContext({
      requestKind: 'group_turn',
      group,
      input: {
        prompt: 'Summarize the last discussion',
        script: undefined,
        chatJid: 'room@g.us',
      },
      defaultExecutionMode: 'edge',
      executionScope: {
        scopeType: 'group',
        scopeId: group.folder,
        groupJid: 'room@g.us',
      },
    });

    expect(context.placement).toMatchObject({
      executionMode: 'container',
      backendId: 'container',
      workerClass: 'heavy',
      routeReason: 'group_pinned_heavy',
      policyVersion: FRAMEWORK_POLICY_VERSION,
      adaptivePolicy: {
        routingProfile: 'group_turn_edge_first',
        workspaceEdgeWritePolicy: 'inherit',
        adaptiveFanoutLimit: 8,
        heavyFirstDowngradeThreshold: null,
        heavyFirstDowngradeWindow: null,
        shardedControlPlaneCandidate: false,
      },
      requiredCapabilities: [],
      fallbackEligible: false,
    });
    expect(context.graph).toMatchObject({
      requestKind: 'group_turn',
      scopeType: 'group',
      scopeId: group.folder,
      groupFolder: group.folder,
      chatJid: 'room@g.us',
    });
    expect(context.graph.graphId).toBe(`graph:${context.execution.turnId}`);
    expect(context.graph.rootTaskId).toBe(
      `task:${context.execution.turnId}:root`,
    );
    expect(context.executionContext).toMatchObject({
      executionId: context.execution.executionId,
      turnId: context.execution.turnId,
      logicalSessionId: context.execution.logicalSessionId,
      groupId: group.folder,
      graphId: context.graph.graphId,
      taskNodeId: context.graph.rootTaskId,
      parentTaskId: null,
      workerClass: 'heavy',
      capabilityBudget: {
        capabilities: [],
        maxToolCalls: 12,
      },
      deadline: {
        deadlineMs: 300000,
      },
      idempotencyKey: `${context.execution.executionId}:${context.graph.rootTaskId}`,
      planFragment: {
        kind: 'single_root',
        requestKind: 'group_turn',
        routeReason: 'group_pinned_heavy',
        policyVersion: FRAMEWORK_POLICY_VERSION,
        routingProfile: 'group_turn_edge_first',
        workspaceEdgeWritePolicy: 'inherit',
        adaptiveFanoutLimit: 8,
        heavyFirstDowngradeThreshold: null,
        heavyFirstDowngradeWindow: null,
        shardedControlPlaneCandidate: false,
        fallbackEligible: false,
      },
      baseWorkspaceVersion: context.baseWorkspaceVersion,
    });

    const { getExecutionState, getTaskGraph, getTaskNode } =
      await import('./db.js');
    expect(getExecutionState(context.execution.executionId)).toMatchObject({
      executionId: context.execution.executionId,
      taskNodeId: context.graph.rootTaskId,
      taskId: null,
      backend: 'container',
      status: 'running',
      leaseUntil: expect.any(String),
    });
    expect(
      Date.parse(getExecutionState(context.execution.executionId)!.leaseUntil) -
        Date.parse(getExecutionState(context.execution.executionId)!.createdAt),
    ).toBe(305000);
    expect(getTaskGraph(context.graph.graphId)).toMatchObject({
      graphId: context.graph.graphId,
      rootTaskId: context.graph.rootTaskId,
      requestKind: 'group_turn',
      status: 'running',
      logicalSessionId: context.execution.logicalSessionId,
    });
    expect(getTaskNode(context.graph.rootTaskId)).toMatchObject({
      taskId: context.graph.rootTaskId,
      graphId: context.graph.graphId,
      nodeKind: 'root',
      workerClass: 'heavy',
      backendId: 'container',
      requiredCapabilities: [],
      routeReason: 'group_pinned_heavy',
      policyVersion: FRAMEWORK_POLICY_VERSION,
      fallbackEligible: false,
      status: 'running',
    });
  });

  it('maps isolated scheduled tasks into a root task graph with an edge worker placement', async () => {
    vi.resetModules();
    const [{ _initTestDatabase }, { createFrameworkRunContext }] =
      await Promise.all([
        import('./db.js'),
        import('./framework-orchestrator.js'),
      ]);
    _initTestDatabase();

    const group: RegisteredGroup = {
      name: 'Team Beta',
      folder: 'team_beta',
      trigger: '@Andy',
      added_at: '2026-04-06T00:00:00.000Z',
      executionMode: 'edge',
    };

    fs.mkdirSync(path.join(tempRoot, 'groups', group.folder), {
      recursive: true,
    });

    const context = createFrameworkRunContext({
      requestKind: 'scheduled_task',
      group,
      input: {
        prompt: 'Run maintenance',
        script: undefined,
        chatJid: 'team@g.us',
      },
      defaultExecutionMode: 'container',
      executionScope: {
        scopeType: 'task',
        scopeId: 'task-123',
        groupJid: 'team@g.us',
        taskId: 'task-123',
      },
    });

    expect(context.placement).toMatchObject({
      executionMode: 'edge',
      backendId: 'edge',
      workerClass: 'edge',
      routeReason: 'group_pinned_edge',
      policyVersion: FRAMEWORK_POLICY_VERSION,
      adaptivePolicy: {
        routingProfile: 'scheduled_task_edge_first',
        workspaceEdgeWritePolicy: 'inherit',
        adaptiveFanoutLimit: 4,
        heavyFirstDowngradeThreshold: null,
        heavyFirstDowngradeWindow: null,
        shardedControlPlaneCandidate: false,
      },
      fallbackEligible: true,
    });
    expect(context.graph).toMatchObject({
      requestKind: 'scheduled_task',
      scopeType: 'task',
      scopeId: 'task-123',
      groupFolder: group.folder,
      chatJid: 'team@g.us',
    });

    const { getExecutionState, getTaskGraph, getTaskNode } =
      await import('./db.js');
    expect(getExecutionState(context.execution.executionId)).toMatchObject({
      executionId: context.execution.executionId,
      taskNodeId: context.graph.rootTaskId,
      taskId: 'task-123',
      backend: 'edge',
      status: 'running',
      leaseUntil: expect.any(String),
    });
    expect(
      Date.parse(getExecutionState(context.execution.executionId)!.leaseUntil) -
        Date.parse(getExecutionState(context.execution.executionId)!.createdAt),
    ).toBe(305000);
    expect(getTaskGraph(context.graph.graphId)).toMatchObject({
      graphId: context.graph.graphId,
      requestKind: 'scheduled_task',
      status: 'running',
    });
    expect(getTaskNode(context.graph.rootTaskId)).toMatchObject({
      taskId: context.graph.rootTaskId,
      graphId: context.graph.graphId,
      workerClass: 'edge',
      backendId: 'edge',
      requiredCapabilities: [],
      routeReason: 'group_pinned_edge',
      policyVersion: FRAMEWORK_POLICY_VERSION,
      fallbackEligible: true,
      status: 'running',
    });
  });
});
