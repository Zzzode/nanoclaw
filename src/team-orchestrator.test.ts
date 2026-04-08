import fs from 'fs';
import os from 'os';
import path from 'path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { FrameworkWorker } from './framework-worker.js';
import type { RegisteredGroup } from './types.js';

describe('team orchestrator', () => {
  let tempRoot: string;

  beforeEach(() => {
    tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoclaw-team-'));
    vi.stubEnv('NANOCLAW_STORE_DIR', path.join(tempRoot, 'store'));
    vi.stubEnv('NANOCLAW_GROUPS_DIR', path.join(tempRoot, 'groups'));
    vi.stubEnv('NANOCLAW_DATA_DIR', path.join(tempRoot, 'data'));
  });

  afterEach(() => {
    vi.resetModules();
    vi.unstubAllEnvs();
    fs.rmSync(tempRoot, { recursive: true, force: true });
  });

  it('uses explicit agent team trigger and planner result instead of numbered regex splitting', async () => {
    const { detectEdgeTeamPlan, shouldUseEdgeTeamPlanner } = await import(
      './team-orchestrator.js'
    );

    expect(
      shouldUseEdgeTeamPlanner(
        '请创建一个 10-agent team，并行完成 terminal edge team observability 文档审阅。1) 标题与范围，2) 前提条件，3) 固定 prompt。',
      ),
    ).toBe(true);
    expect(
      shouldUseEdgeTeamPlanner(
        '并行完成 terminal edge team observability 文档审阅。1) 标题与范围，2) 前提条件，3) 固定 prompt。',
      ),
    ).toBe(false);

    const plan = detectEdgeTeamPlan(
      '请创建一个 3-agent team，并行完成：1) 目标与验收标准，2) 风险与失败点，3) 执行步骤与结果记录模板。最后统一汇总，并创建 2 个 follow-up task：一个 10 分钟后提醒我检查并发执行结果，一个 20 分钟后提醒我回顾风险项。',
      {
        shouldFanout: true,
        teamSize: 3,
        roles: [
          { index: 1, title: '目标与验收标准' },
          { index: 2, title: '风险与失败点' },
          { index: 3, title: '执行步骤与结果记录模板' },
        ],
      },
      new Date('2026-04-07T08:00:00.000Z'),
    );

    expect(plan).toMatchObject({
      teamSize: 3,
      roles: [
        { index: 1, title: '目标与验收标准' },
        { index: 2, title: '风险与失败点' },
        { index: 3, title: '执行步骤与结果记录模板' },
      ],
    });
    expect(plan?.reminders).toEqual([
      {
        prompt: '提醒我检查并发执行结果',
        scheduleValue: '2026-04-07T08:10:00.000Z',
      },
      {
        prompt: '提醒我回顾风险项',
        scheduleValue: '2026-04-07T08:20:00.000Z',
      },
    ]);
  });

  it('returns null when planner decides not to fan out', async () => {
    const { detectEdgeTeamPlan } = await import('./team-orchestrator.js');

    expect(
      detectEdgeTeamPlan(
        '请创建一个 10-agent team，并行完成 terminal edge team observability 文档审阅。1) 标题与范围，2) 前提条件，3) 固定 prompt。',
        {
          shouldFanout: false,
          teamSize: 10,
          roles: [],
          reason: '章节列表更适合单次回答，不适合 fanout。',
        },
      ),
    ).toBeNull();
  });

  it('creates real child executions, aggregates results, and creates follow-up tasks', async () => {
    vi.resetModules();

    const [
      {
        _initTestDatabase,
        getAllTasks,
        getTaskGraph,
        getTaskNode,
        listExecutionStates,
      },
      { createFrameworkRunContext },
      { maybeRunEdgeTeamOrchestration },
    ] = await Promise.all([
      import('./db.js'),
      import('./framework-orchestrator.js'),
      import('./team-orchestrator.js'),
    ]);

    _initTestDatabase();

    const group: RegisteredGroup = {
      name: 'Terminal Canary',
      folder: 'terminal_canary',
      trigger: '@Andy',
      added_at: '2026-04-07T00:00:00.000Z',
      executionMode: 'edge',
      requiresTrigger: false,
    };

    fs.mkdirSync(path.join(tempRoot, 'groups', group.folder), {
      recursive: true,
    });
    fs.writeFileSync(
      path.join(tempRoot, 'groups', group.folder, 'CLAUDE.md'),
      '# Terminal Canary\n',
    );

    const frameworkRun = createFrameworkRunContext({
      requestKind: 'group_turn',
      group,
      input: {
        prompt:
          '请创建一个 3-agent team，并行完成：1) 目标与验收标准，2) 风险与失败点，3) 执行步骤与结果记录模板。最后统一汇总，并创建 2 个 follow-up task：一个 10 分钟后提醒我检查并发执行结果，一个 20 分钟后提醒我回顾风险项。',
        script: undefined,
        chatJid: 'term:canary-group',
      },
      defaultExecutionMode: 'edge',
      executionScope: {
        scopeType: 'group',
        scopeId: group.folder,
        groupJid: 'term:canary-group',
      },
    });

    let activeChildren = 0;
    let maxConcurrentChildren = 0;
    let plannerCalls = 0;
    const childPrompts: string[] = [];
    const edgeWorker: FrameworkWorker = {
      backendId: 'edge',
      workerClass: 'edge',
      runtimeClass: 'edge-subprocess',
      capabilityEnvelope: ['fs.read'],
      async run(_group, input) {
        if (input.shadowMode) {
          plannerCalls += 1;
          return {
            status: 'success',
            result: JSON.stringify({
              shouldFanout: true,
              teamSize: 3,
              roles: [
                { title: '目标与验收标准' },
                { title: '风险与失败点' },
                { title: '执行步骤与结果记录模板' },
              ],
              reason: '用户显式请求 3-agent team，且三块工作可以并行。',
            }),
          };
        }
        childPrompts.push(input.prompt);
        activeChildren += 1;
        maxConcurrentChildren = Math.max(maxConcurrentChildren, activeChildren);
        await new Promise((resolve) => setTimeout(resolve, 20));
        activeChildren -= 1;
        return {
          status: 'success',
          result: `子结果：${input.executionContext?.planFragment?.fanoutRole}\n可用命令不要写 claw --version。`,
        };
      },
    };

    const onOutput = vi.fn(async () => {});
    const result = await maybeRunEdgeTeamOrchestration({
      group,
      prompt:
        '请创建一个 3-agent team，并行完成：1) 目标与验收标准，2) 风险与失败点，3) 执行步骤与结果记录模板。最后统一汇总，并创建 2 个 follow-up task：一个 10 分钟后提醒我检查并发执行结果，一个 20 分钟后提醒我回顾风险项。',
      chatJid: 'term:canary-group',
      isMain: false,
      assistantName: 'Andy',
      frameworkRun,
      edgeWorker,
      onOutput,
      now: new Date('2026-04-07T08:00:00.000Z'),
    });

    const turnId = frameworkRun.execution.turnId;
    const aggregateTaskId = `task:${turnId}:aggregate`;

    expect(result).toEqual({ handled: true, status: 'success' });
    expect(plannerCalls).toBe(1);
    expect(maxConcurrentChildren).toBeGreaterThanOrEqual(2);
    expect(onOutput).toHaveBeenCalledTimes(3);
    expect(onOutput).toHaveBeenNthCalledWith(1, {
      status: 'success',
      result: '已启动 3 个 edge agents 并行处理，正在等待汇总结果。',
    });
    expect(onOutput).toHaveBeenNthCalledWith(2, {
      status: 'success',
      result: '3/3 个 edge agents 已返回，正在进行最终汇总。',
    });
    expect(onOutput).toHaveBeenCalledWith({
      status: 'success',
      result: expect.stringContaining(
        '**Terminal-only Claw Framework Launch Review**',
      ),
    });
    const finalCall =
      onOutput.mock.calls.length > 0
        ? onOutput.mock.calls[onOutput.mock.calls.length - 1]
        : undefined;
    let finalOutput: { result?: string | null } | undefined;
    if (finalCall && finalCall.length > 0) {
      finalOutput = (finalCall as unknown[])[0] as { result?: string | null };
    }
    expect(finalOutput?.result).toContain('Follow-up tasks: task-');
    expect(finalOutput?.result).toContain(
      '未在当前仓库中找到对应命令（原输出包含：claw --version）',
    );
    expect(childPrompts).toHaveLength(3);
    expect(childPrompts[0]).toContain('CLAUDE.md');
    expect(childPrompts[0]).toContain('workspace.read');
    expect(childPrompts[0]).toContain('/status');
    expect(childPrompts[0]).toContain('/tasks');
    expect(childPrompts[0]).toContain('npm run build');
    expect(childPrompts[0]).toContain('禁止虚构不存在的命令');
    expect(getAllTasks()).toHaveLength(2);

    expect(getTaskGraph(frameworkRun.graph.graphId)).toMatchObject({
      status: 'completed',
      rootTaskId: frameworkRun.graph.rootTaskId,
    });
    expect(getTaskNode(frameworkRun.graph.rootTaskId)).toMatchObject({
      status: 'completed',
      nodeKind: 'root',
    });
    expect(getTaskNode(`task:${turnId}:child-1`)).toMatchObject({
      status: 'completed',
      nodeKind: 'fanout_child',
    });
    expect(getTaskNode(`task:${turnId}:child-2`)).toMatchObject({
      status: 'completed',
      nodeKind: 'fanout_child',
    });
    expect(getTaskNode(`task:${turnId}:child-3`)).toMatchObject({
      status: 'completed',
      nodeKind: 'fanout_child',
    });
    expect(getTaskNode(aggregateTaskId)).toMatchObject({
      status: 'completed',
      nodeKind: 'aggregate',
      aggregatePolicy: 'best_effort',
    });

    expect(listExecutionStates()).toHaveLength(5);
    expect(
      listExecutionStates().map((execution) => execution.taskNodeId),
    ).toEqual(
      expect.arrayContaining([
        frameworkRun.graph.rootTaskId,
        `task:${turnId}:child-1`,
        `task:${turnId}:child-2`,
        `task:${turnId}:child-3`,
        aggregateTaskId,
      ]),
    );
  });
});
