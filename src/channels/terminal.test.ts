import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { TaskNodeRecord } from '../db.js';

const readlineHarness = vi.hoisted(() => {
  let lineHandler: ((line: string) => void) | null = null;
  const rl = {
    setPrompt: vi.fn(),
    prompt: vi.fn(),
    on: vi.fn((event: string, handler: (line: string) => void) => {
      if (event === 'line') {
        lineHandler = handler;
      }
      return rl;
    }),
    pause: vi.fn(),
    resume: vi.fn(),
    close: vi.fn(),
  };

  return {
    createInterface: vi.fn(() => rl),
    rl,
    emitLine(line: string) {
      lineHandler?.(line);
    },
    reset() {
      lineHandler = null;
      rl.setPrompt.mockReset();
      rl.prompt.mockReset();
      rl.on.mockClear();
      rl.pause.mockReset();
      rl.resume.mockReset();
      rl.close.mockReset();
      this.createInterface.mockClear();
    },
  };
});

vi.mock('readline', () => ({
  default: {
    createInterface: readlineHarness.createInterface,
  },
}));

vi.mock('../config.js', () => ({
  ASSISTANT_NAME: 'Andy',
  EDGE_ANTHROPIC_MODEL: 'claude-sonnet-4',
  EDGE_ENABLE_TOOLS: true,
  EDGE_MODEL: 'glm-5',
  EDGE_RUNNER_MODE: 'edgejs',
  EDGE_RUNNER_PROVIDER: 'openai',
  TERMINAL_CHANNEL_ENABLED: true,
  TERMINAL_GROUP_FOLDER: 'terminal_canary',
  TERMINAL_GROUP_EXECUTION_MODE: 'edge',
  TERMINAL_GROUP_JID: 'term:canary-group',
  TERMINAL_GROUP_NAME: 'Terminal Canary',
  TERMINAL_USER_JID: 'term:user',
  TERMINAL_USER_NAME: 'You',
  TIMEZONE: 'Asia/Shanghai',
}));

vi.mock('../db.js', () => ({
  getAllTasks: vi.fn(),
  getTaskById: vi.fn(),
  listExecutionStatesForTaskNode: vi.fn(),
  listTaskGraphs: vi.fn(),
  listTaskNodes: vi.fn(),
  listExecutionStates: vi.fn(),
  updateTask: vi.fn(),
}));

vi.mock('../task-control.js', () => ({
  deleteScheduledTask: vi.fn(),
}));

vi.mock('../timezone.js', () => ({
  formatDisplayDateTime: vi.fn((value: string, timezone: string) => {
    return `${value} @ ${timezone}`;
  }),
}));

vi.mock('../framework-observability.js', () => ({
  buildFrameworkObservabilitySnapshot: vi.fn(() => ({
    scope: { kind: 'group', id: 'terminal_canary' },
    generatedAt: '2026-04-05T12:00:00.000Z',
    governance: {
      totalGraphs: 2,
      totalExecutions: 3,
      routeReasonCounts: { capability_match_edge: 2 },
      workerClassCounts: { edge: 1, heavy: 1 },
      edgeOnlyCompletionRate: 0.5,
      edgeToHeavyFallbackRate: 0.5,
      averageFanoutWidth: 0,
      averageGraphCompletionLatencyMs: 8000,
      commitSuccessRate: 1,
      commitConflictRate: 0.25,
    },
    routes: [],
    executions: [],
  })),
}));

vi.mock('../terminal-observability.js', () => ({
  buildTerminalActiveTurnSummary: vi.fn(() => 'activeTurn: none'),
  buildTerminalAgentsSummaryFromObservability: vi.fn(() => null),
  buildTerminalFocusSummary: vi.fn(() => null),
  buildTerminalGraphSummaryFromObservability: vi.fn(() => null),
  cycleTerminalFocus: vi.fn(() => null),
  getTerminalTurnState: vi.fn(() => null),
  resetTerminalObservability: vi.fn(),
  setTerminalFocus: vi.fn((target: string) => `focus -> ${target}`),
}));

import {
  getAllTasks,
  getTaskById,
  listExecutionStatesForTaskNode,
  listTaskGraphs,
  listTaskNodes,
  listExecutionStates,
  updateTask,
} from '../db.js';
import { deleteScheduledTask } from '../task-control.js';
import {
  appendTerminalEventForTests,
  buildTerminalAgentsSummary,
  buildTerminalGraphSummary,
  buildTerminalLogsSummary,
  buildTerminalObservabilitySummary,
  buildTerminalStatusLine,
  buildTerminalStatusSummary,
  buildTerminalTasksSummary,
  emitTerminalSystemEvent,
  executeTerminalTaskCommand,
  resetTerminalEventLogForTests,
} from './terminal.js';
import { getChannelFactory } from './registry.js';
import {
  buildTerminalAgentsSummaryFromObservability,
  buildTerminalGraphSummaryFromObservability,
  buildTerminalFocusSummary,
  cycleTerminalFocus,
  resetTerminalObservability,
  setTerminalFocus,
} from '../terminal-observability.js';

describe('terminal ui helpers', () => {
  beforeEach(() => {
    readlineHarness.reset();
    resetTerminalEventLogForTests();
    vi.mocked(buildTerminalAgentsSummaryFromObservability).mockReturnValue(null);
    vi.mocked(buildTerminalGraphSummaryFromObservability).mockReturnValue(null);
    vi.mocked(buildTerminalFocusSummary).mockReturnValue(null);
    vi.mocked(cycleTerminalFocus).mockReturnValue(null);
    vi.mocked(resetTerminalObservability).mockReset();
    vi.mocked(setTerminalFocus).mockImplementation((target: string) => `focus -> ${target}`);
    vi.mocked(getAllTasks).mockReturnValue([
      {
        id: 'task-active',
        group_folder: 'terminal_canary',
        chat_jid: 'term:canary-group',
        prompt: 'run active',
        schedule_type: 'interval',
        schedule_value: '60000',
        context_mode: 'isolated',
        next_run: '2026-04-05T12:00:00.000Z',
        last_run: null,
        last_result: null,
        status: 'active',
        created_at: '2026-04-05T11:00:00.000Z',
      },
      {
        id: 'task-paused',
        group_folder: 'terminal_canary',
        chat_jid: 'term:canary-group',
        prompt: 'run paused',
        schedule_type: 'interval',
        schedule_value: '300000',
        context_mode: 'isolated',
        next_run: '2026-04-05T13:00:00.000Z',
        last_run: null,
        last_result: null,
        status: 'paused',
        created_at: '2026-04-05T11:30:00.000Z',
      },
    ]);
    vi.mocked(listExecutionStates).mockReturnValue([
      {
        executionId: 'exec-1',
        logicalSessionId: 'task:task-active',
        turnId: 'turn-1',
        taskNodeId: 'task:turn-1:root',
        groupJid: 'term:canary-group',
        taskId: 'task-active',
        backend: 'edge',
        edgeNodeId: null,
        baseWorkspaceVersion: null,
        leaseUntil: '2026-04-05T12:05:00.000Z',
        status: 'running',
        lastHeartbeatAt: null,
        cancelRequestedAt: null,
        committedAt: null,
        finishedAt: null,
        error: null,
        createdAt: '2026-04-05T12:00:00.000Z',
        updatedAt: '2026-04-05T12:00:00.000Z',
      },
    ]);
    vi.mocked(getTaskById).mockImplementation((taskId: string) => {
      const tasks = vi.mocked(getAllTasks).mock.results.at(-1)?.value || [];
      return tasks.find((task: { id: string }) => task.id === taskId);
    });
    vi.mocked(listTaskGraphs).mockReturnValue([
      {
        graphId: 'graph:turn-team-stale',
        requestKind: 'group_turn',
        scopeType: 'group',
        scopeId: 'terminal_canary',
        groupFolder: 'terminal_canary',
        chatJid: 'term:canary-group',
        logicalSessionId: 'group:terminal_canary',
        rootTaskId: 'task:turn-team-stale:root',
        status: 'running',
        error: null,
        createdAt: '2026-04-05T12:05:00.000Z',
        updatedAt: '2026-04-05T12:05:30.000Z',
      },
      {
        graphId: 'graph:turn-team-1',
        requestKind: 'group_turn',
        scopeType: 'group',
        scopeId: 'terminal_canary',
        groupFolder: 'terminal_canary',
        chatJid: 'term:canary-group',
        logicalSessionId: 'group:terminal_canary',
        rootTaskId: 'task:turn-team-1:root',
        status: 'running',
        error: null,
        createdAt: '2026-04-05T12:00:00.000Z',
        updatedAt: '2026-04-05T12:00:30.000Z',
      },
    ]);
    const allNodes: TaskNodeRecord[] = [
      {
        taskId: 'task:turn-team-stale:root',
        graphId: 'graph:turn-team-stale',
        parentTaskId: null,
        nodeKind: 'root',
        workerClass: 'edge',
        backendId: 'edge',
        requiredCapabilities: ['fs.read'],
        routeReason: 'group_pinned_edge',
        policyVersion: '2026-04-05',
        fallbackEligible: false,
        fallbackTarget: null,
        fallbackReason: null,
        failureClass: null,
        aggregatePolicy: null,
        quorumCount: null,
        status: 'running',
        error: null,
        createdAt: '2026-04-05T12:05:00.000Z',
        updatedAt: '2026-04-05T12:05:10.000Z',
      },
      {
        taskId: 'task:turn-team-stale:child-1',
        graphId: 'graph:turn-team-stale',
        parentTaskId: 'task:turn-team-stale:root',
        nodeKind: 'fanout_child',
        workerClass: 'edge',
        backendId: 'edge',
        requiredCapabilities: ['fs.read'],
        routeReason: 'edge.team_fanout',
        policyVersion: '2026-04-05',
        fallbackEligible: false,
        fallbackTarget: null,
        fallbackReason: null,
        failureClass: null,
        aggregatePolicy: null,
        quorumCount: null,
        status: 'running',
        error: null,
        createdAt: '2026-04-05T12:05:01.000Z',
        updatedAt: '2026-04-05T12:05:10.000Z',
      },
      {
        taskId: 'task:turn-team-1:root',
        graphId: 'graph:turn-team-1',
        parentTaskId: null,
        nodeKind: 'root',
        workerClass: 'edge',
        backendId: 'edge',
        requiredCapabilities: ['fs.read'],
        routeReason: 'capability_match_edge',
        policyVersion: '2026-04-05',
        fallbackEligible: false,
        fallbackTarget: null,
        fallbackReason: null,
        failureClass: null,
        aggregatePolicy: null,
        quorumCount: null,
        status: 'completed',
        error: null,
        createdAt: '2026-04-05T12:00:00.000Z',
        updatedAt: '2026-04-05T12:00:05.000Z',
      },
      {
        taskId: 'task:turn-team-1:child-1',
        graphId: 'graph:turn-team-1',
        parentTaskId: 'task:turn-team-1:root',
        nodeKind: 'fanout_child',
        workerClass: 'edge',
        backendId: 'edge',
        requiredCapabilities: ['fs.read'],
        routeReason: 'edge.team_fanout',
        policyVersion: '2026-04-05',
        fallbackEligible: false,
        fallbackTarget: null,
        fallbackReason: null,
        failureClass: null,
        aggregatePolicy: null,
        quorumCount: null,
        status: 'completed',
        error: null,
        createdAt: '2026-04-05T12:00:01.000Z',
        updatedAt: '2026-04-05T12:00:10.000Z',
      },
      {
        taskId: 'task:turn-team-1:child-2',
        graphId: 'graph:turn-team-1',
        parentTaskId: 'task:turn-team-1:root',
        nodeKind: 'fanout_child',
        workerClass: 'edge',
        backendId: 'edge',
        requiredCapabilities: ['fs.read'],
        routeReason: 'edge.team_fanout',
        policyVersion: '2026-04-05',
        fallbackEligible: false,
        fallbackTarget: null,
        fallbackReason: null,
        failureClass: null,
        aggregatePolicy: null,
        quorumCount: null,
        status: 'running',
        error: null,
        createdAt: '2026-04-05T12:00:02.000Z',
        updatedAt: '2026-04-05T12:00:20.000Z',
      },
      {
        taskId: 'task:turn-team-1:aggregate',
        graphId: 'graph:turn-team-1',
        parentTaskId: 'task:turn-team-1:root',
        nodeKind: 'aggregate',
        workerClass: 'edge',
        backendId: 'edge',
        requiredCapabilities: ['fs.read'],
        routeReason: 'edge.team_aggregate',
        policyVersion: '2026-04-05',
        fallbackEligible: false,
        fallbackTarget: null,
        fallbackReason: null,
        failureClass: null,
        aggregatePolicy: 'best_effort',
        quorumCount: null,
        status: 'ready',
        error: null,
        createdAt: '2026-04-05T12:00:03.000Z',
        updatedAt: '2026-04-05T12:00:20.000Z',
      },
    ];
    vi.mocked(listTaskNodes).mockImplementation((graphId?: string) =>
      graphId ? allNodes.filter((node) => node.graphId === graphId) : allNodes,
    );
    vi.mocked(listExecutionStatesForTaskNode).mockImplementation(
      (taskId: string) => {
        if (taskId === 'task:turn-team-stale:child-1') {
          return [
            {
              executionId: 'exec-child-stale-1',
              logicalSessionId: 'task:child-stale-1',
              turnId: 'turn-child-stale-1',
              taskNodeId: taskId,
              groupJid: 'term:canary-group',
              taskId,
              backend: 'edge',
              edgeNodeId: null,
              baseWorkspaceVersion: null,
              leaseUntil: '2026-04-05T12:00:00.000Z',
              status: 'running',
              lastHeartbeatAt: '2026-04-05T12:00:00.000Z',
              cancelRequestedAt: null,
              committedAt: null,
              finishedAt: null,
              error: null,
              createdAt: '2026-04-05T12:05:01.000Z',
              updatedAt: '2026-04-05T12:05:10.000Z',
            },
          ];
        }
        if (taskId === 'task:turn-team-1:child-1') {
          return [
            {
              executionId: 'exec-child-1',
              logicalSessionId: 'task:child-1',
              turnId: 'turn-child-1',
              taskNodeId: taskId,
              groupJid: 'term:canary-group',
              taskId,
              backend: 'edge',
              edgeNodeId: null,
              baseWorkspaceVersion: null,
              leaseUntil: '2026-04-05T12:05:00.000Z',
              status: 'completed',
              lastHeartbeatAt: '2026-04-05T12:00:05.000Z',
              cancelRequestedAt: null,
              committedAt: null,
              finishedAt: '2026-04-05T12:00:10.000Z',
              error: null,
              createdAt: '2026-04-05T12:00:01.000Z',
              updatedAt: '2026-04-05T12:00:10.000Z',
            },
          ];
        }
        if (taskId === 'task:turn-team-1:child-2') {
          return [
            {
              executionId: 'exec-child-2',
              logicalSessionId: 'task:child-2',
              turnId: 'turn-child-2',
              taskNodeId: taskId,
              groupJid: 'term:canary-group',
              taskId,
              backend: 'edge',
              edgeNodeId: null,
              baseWorkspaceVersion: null,
              leaseUntil: '2099-04-05T12:05:00.000Z',
              status: 'running',
              lastHeartbeatAt: '2099-04-05T12:00:20.000Z',
              cancelRequestedAt: null,
              committedAt: null,
              finishedAt: null,
              error: null,
              createdAt: '2026-04-05T12:00:02.000Z',
              updatedAt: '2026-04-05T12:00:20.000Z',
            },
          ];
        }
        if (taskId === 'task:turn-team-1:aggregate') {
          return [];
        }
        return [];
      },
    );
  });

  it('renders a compact status line with runtime counts', () => {
    const line = buildTerminalStatusLine();

    expect(line).toContain('edge/edgejs');
    expect(line).toContain('openai-compatible');
    expect(line).toContain('glm-5');
    expect(line).toContain('tools:on');
    expect(line).toContain('group:terminal_canary');
    expect(line).toContain('tasks:1 running/1 scheduled');
  });

  it('renders task summaries with runtime status and next run', () => {
    const summary = buildTerminalTasksSummary();

    expect(summary).toContain('taskId: task-active');
    expect(summary).toContain('status: running');
    expect(summary).toContain('scheduleValue: 60000');
    expect(summary).toContain('2026-04-05T12:00:00.000Z @ Asia/Shanghai');
    expect(summary).toContain('taskId: task-paused');
    expect(summary).toContain('status: paused');
  });

  it('renders current team agent statuses', () => {
    const summary = buildTerminalAgentsSummary();

    expect(summary).toContain('graphId: graph:turn-team-1');
    expect(summary).toContain('agent: worker 1');
    expect(summary).toContain('status: completed');
    expect(summary).toContain('agent: worker 2');
    expect(summary).toContain('status: running');
    expect(summary).toContain('graphHealth: healthy');
    expect(summary).toContain('health: healthy');
    expect(summary).toContain('agent: aggregate');
  });

  it('renders current team graph details', () => {
    const summary = buildTerminalGraphSummary();

    expect(summary).toContain('graphId: graph:turn-team-1');
    expect(summary).toContain('requestKind: group_turn');
    expect(summary).toContain('graphHealth: healthy');
    expect(summary).toContain('taskId: task:turn-team-1:child-1');
    expect(summary).toContain('nodeKind: fanout_child');
    expect(summary).toContain('executionStatus: completed');
  });

  it('renders a readable status summary block', () => {
    const summary = buildTerminalStatusSummary();

    expect(summary).toContain('mode: edge/edgejs');
    expect(summary).toContain('provider: openai-compatible');
    expect(summary).toContain('model: glm-5');
    expect(summary).toContain('tools: on');
    expect(summary).toContain('group: Terminal Canary (terminal_canary)');
    expect(summary).toContain('framework.graphs: 2');
    expect(summary).toContain('framework.executions: 3');
  });

  it('renders framework observability summary for terminal status consumers', () => {
    const summary = buildTerminalObservabilitySummary();

    expect(summary).toContain('framework.graphs: 2');
    expect(summary).toContain('framework.executions: 3');
    expect(summary).toContain('framework.edgeFallbackRate: 0.5');
    expect(summary).toContain('framework.commitConflictRate: 0.25');
  });

  it('renders recent system events for `/logs`', () => {
    appendTerminalEventForTests('任务开始：task-active');
    appendTerminalEventForTests('执行失败，5 秒后重试（第 1 次）');

    const summary = buildTerminalLogsSummary(2);

    expect(summary).toContain('任务开始：task-active');
    expect(summary).toContain('执行失败，5 秒后重试（第 1 次）');
    expect(summary).toContain('@ Asia/Shanghai');
  });

  it('pauses a terminal task locally', () => {
    const result = executeTerminalTaskCommand(['pause', 'task-active']);

    expect(result).toBe('任务已暂停：task-active');
    expect(updateTask).toHaveBeenCalledWith('task-active', {
      status: 'paused',
    });
  });

  it('resumes a paused terminal task locally', () => {
    vi.mocked(getTaskById).mockReturnValue({
      id: 'task-paused',
      group_folder: 'terminal_canary',
      chat_jid: 'term:canary-group',
      prompt: 'run paused',
      schedule_type: 'interval',
      schedule_value: '300000',
      context_mode: 'isolated',
      next_run: '2026-04-05T13:00:00.000Z',
      last_run: null,
      last_result: null,
      status: 'paused',
      created_at: '2026-04-05T11:30:00.000Z',
    });

    const result = executeTerminalTaskCommand(['resume', 'task-paused']);

    expect(result).toBe('任务已恢复：task-paused');
    expect(updateTask).toHaveBeenCalledWith('task-paused', {
      status: 'active',
    });
  });

  it('deletes a terminal task locally', () => {
    const result = executeTerminalTaskCommand(['delete', 'task-active']);

    expect(result).toBe('任务已删除：task-active');
    expect(deleteScheduledTask).toHaveBeenCalledWith('task-active');
  });

  it('rejects operations for tasks outside terminal scope', () => {
    vi.mocked(getTaskById).mockReturnValue({
      id: 'task-foreign',
      group_folder: 'other_group',
      chat_jid: 'other:j',
      prompt: 'foreign',
      schedule_type: 'interval',
      schedule_value: '60000',
      context_mode: 'isolated',
      next_run: '2026-04-05T13:00:00.000Z',
      last_run: null,
      last_result: null,
      status: 'active',
      created_at: '2026-04-05T11:30:00.000Z',
    });

    const result = executeTerminalTaskCommand(['pause', 'task-foreign']);

    expect(result).toBe('当前 terminal 无权操作任务：task-foreign');
  });

  it('re-renders the prompt after local `/tasks` commands', async () => {
    vi.mocked(getAllTasks).mockReturnValue([]);
    vi.mocked(listExecutionStates).mockReturnValue([]);
    const writeSpy = vi
      .spyOn(process.stdout, 'write')
      .mockImplementation(() => true);

    try {
      const factory = getChannelFactory('terminal');
      expect(factory).toBeTypeOf('function');
      const channel = factory!({
        onMessage: vi.fn(),
        onChatMetadata: vi.fn(),
        registeredGroups: () => ({}),
      });

      expect(channel).not.toBeNull();
      await channel!.connect();
      const promptCountAfterConnect =
        readlineHarness.rl.prompt.mock.calls.length;

      readlineHarness.emitLine('/tasks');
      await new Promise((resolve) => setTimeout(resolve, 0));

      expect(readlineHarness.rl.prompt.mock.calls.length).toBe(
        promptCountAfterConnect + 1,
      );
      expect(
        writeSpy.mock.calls.some(([chunk]) =>
          String(chunk).includes('当前没有任务。'),
        ),
      ).toBe(true);

      await channel!.disconnect();
    } finally {
      writeSpy.mockRestore();
    }
  });

  it('clears terminal session via `/new`', async () => {
    const onResetSession = vi.fn();
    const factory = getChannelFactory('terminal');
    expect(factory).toBeTypeOf('function');
    const channel = factory!({
      onMessage: vi.fn(),
      onChatMetadata: vi.fn(),
      onResetSession,
      registeredGroups: () => ({}),
    });

    expect(channel).not.toBeNull();
    await channel!.connect();

    readlineHarness.emitLine('/new');
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(onResetSession).toHaveBeenCalledWith('terminal_canary');
    expect(resetTerminalObservability).toHaveBeenCalledTimes(1);
    await channel!.disconnect();
  });

  it('handles `/focus` command via observability store', async () => {
    const factory = getChannelFactory('terminal');
    const channel = factory!({
      onMessage: vi.fn(),
      onChatMetadata: vi.fn(),
      registeredGroups: () => ({}),
    });

    expect(channel).not.toBeNull();
    await channel!.connect();

    readlineHarness.emitLine('/focus worker 2');
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(setTerminalFocus).toHaveBeenCalledWith('worker 2');
    await channel!.disconnect();
  });

  it('cycles focus on Shift+Down escape sequence', async () => {
    Object.defineProperty(process.stdin, 'isTTY', { value: true, configurable: true });
    vi.mocked(cycleTerminalFocus).mockReturnValue('worker 2');
    vi.mocked(buildTerminalFocusSummary).mockReturnValue('focus: worker 2');
    const writeSpy = vi
      .spyOn(process.stdout, 'write')
      .mockImplementation(() => true);

    try {
      const factory = getChannelFactory('terminal');
      const channel = factory!({
        onMessage: vi.fn(),
        onChatMetadata: vi.fn(),
        registeredGroups: () => ({}),
      });

      expect(channel).not.toBeNull();
      await channel!.connect();

      process.stdin.emit('data', Buffer.from('\u001b[1;2B'));
      await new Promise((resolve) => setTimeout(resolve, 0));

      expect(cycleTerminalFocus).toHaveBeenCalledWith(1);
      expect(
        writeSpy.mock.calls.some(([chunk]) => String(chunk).includes('focus: worker 2')),
      ).toBe(true);

      await channel!.disconnect();
    } finally {
      writeSpy.mockRestore();
    }
  });

  it('calls onQuit callback before exiting on `/quit`', async () => {
    const exitSpy = vi
      .spyOn(process, 'exit')
      .mockImplementation(() => undefined as never);

    try {
      const onQuit = vi.fn();
      const factory = getChannelFactory('terminal');
      expect(factory).toBeTypeOf('function');
      const channel = factory!({
        onMessage: vi.fn(),
        onChatMetadata: vi.fn(),
        onQuit,
        registeredGroups: () => ({}),
      });

      expect(channel).not.toBeNull();
      await channel!.connect();

      readlineHarness.emitLine('/quit');
      await new Promise((resolve) => setTimeout(resolve, 0));

      expect(onQuit).toHaveBeenCalledWith('terminal_canary');
      expect(exitSpy).toHaveBeenCalledWith(0);
    } finally {
      exitSpy.mockRestore();
    }
  });

  it('calls onQuit callback before exiting on `/exit`', async () => {
    const exitSpy = vi
      .spyOn(process, 'exit')
      .mockImplementation(() => undefined as never);

    try {
      const onQuit = vi.fn();
      const factory = getChannelFactory('terminal');
      expect(factory).toBeTypeOf('function');
      const channel = factory!({
        onMessage: vi.fn(),
        onChatMetadata: vi.fn(),
        onQuit,
        registeredGroups: () => ({}),
      });

      expect(channel).not.toBeNull();
      await channel!.connect();

      readlineHarness.emitLine('/exit');
      await new Promise((resolve) => setTimeout(resolve, 0));

      expect(onQuit).toHaveBeenCalledWith('terminal_canary');
      expect(exitSpy).toHaveBeenCalledWith(0);
    } finally {
      exitSpy.mockRestore();
    }
  });

  it('re-renders the prompt after local `/agents` commands', async () => {
    const factory = getChannelFactory('terminal');
    expect(factory).toBeTypeOf('function');
    const channel = factory!({
      onMessage: vi.fn(),
      onChatMetadata: vi.fn(),
      registeredGroups: () => ({}),
    });

    expect(channel).not.toBeNull();
    await channel!.connect();
    const promptCountAfterConnect = readlineHarness.rl.prompt.mock.calls.length;

    readlineHarness.emitLine('/agents');
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(readlineHarness.rl.prompt.mock.calls.length).toBe(
      promptCountAfterConnect + 1,
    );
    await channel!.disconnect();
  });

  it('shows a single busy indicator while processing terminal turns', async () => {
    const writeSpy = vi
      .spyOn(process.stdout, 'write')
      .mockImplementation(() => true);

    try {
      const factory = getChannelFactory('terminal');
      const channel = factory!({
        onMessage: vi.fn(),
        onChatMetadata: vi.fn(),
        registeredGroups: () => ({}),
      });

      expect(channel).not.toBeNull();
      await channel!.connect();
      const promptCountAfterConnect =
        readlineHarness.rl.prompt.mock.calls.length;

      await channel!.setTyping?.('term:canary-group', true);
      await channel!.setTyping?.('term:canary-group', true);

      expect(readlineHarness.rl.prompt.mock.calls.length).toBe(
        promptCountAfterConnect + 1,
      );
      expect(
        writeSpy.mock.calls.some(([chunk]) =>
          String(chunk).includes('处理中…'),
        ),
      ).toBe(true);

      await channel!.setTyping?.('term:canary-group', false);
      expect(readlineHarness.rl.prompt.mock.calls.length).toBe(
        promptCountAfterConnect + 2,
      );
      await channel!.disconnect();
    } finally {
      writeSpy.mockRestore();
    }
  });

  it('refreshes the panel for system events while typing is active', async () => {
    const writeSpy = vi
      .spyOn(process.stdout, 'write')
      .mockImplementation(() => true);

    try {
      const factory = getChannelFactory('terminal');
      const channel = factory!({
        onMessage: vi.fn(),
        onChatMetadata: vi.fn(),
        registeredGroups: () => ({}),
      });

      expect(channel).not.toBeNull();
      await channel!.connect();
      const promptCountAfterConnect = readlineHarness.rl.prompt.mock.calls.length;

      await channel!.setTyping?.('term:canary-group', true);
      const promptCountWhileBusy = readlineHarness.rl.prompt.mock.calls.length;

      emitTerminalSystemEvent(
        'term:canary-group',
        '执行开始：graph:test · edge/edge',
      );

      expect(readlineHarness.rl.prompt.mock.calls.length).toBe(
        promptCountWhileBusy + 1,
      );
      expect(
        writeSpy.mock.calls.some(([chunk]) =>
          String(chunk).includes('执行开始：graph:test · edge/edge'),
        ),
      ).toBe(true);

      await channel!.setTyping?.('term:canary-group', false);
      expect(readlineHarness.rl.prompt.mock.calls.length).toBe(
        promptCountAfterConnect + 3,
      );
      await channel!.disconnect();
    } finally {
      writeSpy.mockRestore();
    }
  });

  it('refreshes the panel for system events while executions are still active', async () => {
    const writeSpy = vi
      .spyOn(process.stdout, 'write')
      .mockImplementation(() => true);

    try {
      const factory = getChannelFactory('terminal');
      const channel = factory!({
        onMessage: vi.fn(),
        onChatMetadata: vi.fn(),
        registeredGroups: () => ({}),
      });

      expect(channel).not.toBeNull();
      await channel!.connect();
      const promptCountAfterConnect = readlineHarness.rl.prompt.mock.calls.length;

      emitTerminalSystemEvent(
        'term:canary-group',
        'team planner accepted fanout · 3 workers',
      );

      expect(readlineHarness.rl.prompt.mock.calls.length).toBe(
        promptCountAfterConnect + 1,
      );
      expect(
        writeSpy.mock.calls.some(([chunk]) =>
          String(chunk).includes('team planner accepted fanout · 3 workers'),
        ),
      ).toBe(true);

      await channel!.disconnect();
    } finally {
      writeSpy.mockRestore();
    }
  });

  it('renders a conversation transcript for user, system, and assistant updates', async () => {
    const writeSpy = vi
      .spyOn(process.stdout, 'write')
      .mockImplementation(() => true);

    try {
      const factory = getChannelFactory('terminal');
      const channel = factory!({
        onMessage: vi.fn(),
        onChatMetadata: vi.fn(),
        registeredGroups: () => ({}),
      });

      expect(channel).not.toBeNull();
      await channel!.connect();

      readlineHarness.emitLine('你好');
      await new Promise((resolve) => setTimeout(resolve, 0));

      emitTerminalSystemEvent(
        'term:canary-group',
        'team planner accepted fanout · 3 workers',
      );
      await channel!.sendMessage?.('term:canary-group', '已开始处理');

      const finalFrame = String(writeSpy.mock.calls.at(-1)?.[0] ?? '');
      expect(finalFrame).toContain('[ Transcript ]');
      expect(finalFrame).toContain('你好');
      expect(finalFrame).toContain('team planner accepted fanout · 3 workers');
      expect(finalFrame).toContain('已开始处理');

      await channel!.disconnect();
    } finally {
      writeSpy.mockRestore();
    }
  });

  it('clears conversation transcript via `/new`', async () => {
    const writeSpy = vi
      .spyOn(process.stdout, 'write')
      .mockImplementation(() => true);

    try {
      const factory = getChannelFactory('terminal');
      const channel = factory!({
        onMessage: vi.fn(),
        onChatMetadata: vi.fn(),
        onResetSession: vi.fn(),
        registeredGroups: () => ({}),
      });

      expect(channel).not.toBeNull();
      await channel!.connect();
      await channel!.sendMessage?.('term:canary-group', '旧回复');

      readlineHarness.emitLine('/new');
      await new Promise((resolve) => setTimeout(resolve, 0));

      const finalFrame = String(writeSpy.mock.calls.at(-1)?.[0] ?? '');
      expect(finalFrame).not.toContain('旧回复');
      expect(finalFrame).toContain('已清空当前 terminal provider session');

      await channel!.disconnect();
    } finally {
      writeSpy.mockRestore();
    }
  });

  it('triggers onCancel when ESC is pressed during active typing', async () => {
    Object.defineProperty(process.stdin, 'isTTY', { value: true, configurable: true });
    const onCancel = vi.fn();
    const factory = getChannelFactory('terminal');
    const channel = factory!({
      onMessage: vi.fn(),
      onChatMetadata: vi.fn(),
      onCancel,
      registeredGroups: () => ({}),
    });

    expect(channel).not.toBeNull();
    await channel!.connect();

    await channel!.setTyping?.('term:canary-group', true);

    process.stdin.emit('data', Buffer.from([0x1b]));
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(onCancel).toHaveBeenCalledWith('terminal_canary');
    await channel!.disconnect();
  });

  it('triggers onCancel when ESC is pressed with running executions', async () => {
    Object.defineProperty(process.stdin, 'isTTY', { value: true, configurable: true });
    vi.mocked(listExecutionStates).mockReturnValue([
      {
        executionId: 'exec-running',
        logicalSessionId: 'session-1',
        turnId: 'turn-1',
        taskNodeId: 'task:root',
        groupJid: 'term:canary-group',
        taskId: 'task-1',
        backend: 'edge',
        edgeNodeId: null,
        baseWorkspaceVersion: null,
        leaseUntil: '2099-12-31T23:59:59.000Z',
        status: 'running',
        lastHeartbeatAt: '2026-04-08T12:00:00.000Z',
        cancelRequestedAt: null,
        committedAt: null,
        finishedAt: null,
        error: null,
        createdAt: '2026-04-08T12:00:00.000Z',
        updatedAt: '2026-04-08T12:00:00.000Z',
      },
    ]);

    const onCancel = vi.fn();
    const factory = getChannelFactory('terminal');
    const channel = factory!({
      onMessage: vi.fn(),
      onChatMetadata: vi.fn(),
      onCancel,
      registeredGroups: () => ({}),
    });

    expect(channel).not.toBeNull();
    await channel!.connect();

    process.stdin.emit('data', Buffer.from([0x1b]));
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(onCancel).toHaveBeenCalledWith('terminal_canary');
    await channel!.disconnect();
  });

  it('does not trigger onCancel when ESC is pressed while idle', async () => {
    Object.defineProperty(process.stdin, 'isTTY', { value: true, configurable: true });
    vi.mocked(listExecutionStates).mockReturnValue([]);
    vi.mocked(listTaskGraphs).mockReturnValue([]);

    const onCancel = vi.fn();
    const factory = getChannelFactory('terminal');
    const channel = factory!({
      onMessage: vi.fn(),
      onChatMetadata: vi.fn(),
      onCancel,
      registeredGroups: () => ({}),
    });

    expect(channel).not.toBeNull();
    await channel!.connect();

    process.stdin.emit('data', Buffer.from([0x1b]));
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(onCancel).not.toHaveBeenCalled();
    await channel!.disconnect();
  });

  it('ignores escape sequences (arrow keys) and only responds to lone ESC', async () => {
    Object.defineProperty(process.stdin, 'isTTY', { value: true, configurable: true });
    const onCancel = vi.fn();
    const factory = getChannelFactory('terminal');
    const channel = factory!({
      onMessage: vi.fn(),
      onChatMetadata: vi.fn(),
      onCancel,
      registeredGroups: () => ({}),
    });

    expect(channel).not.toBeNull();
    await channel!.connect();
    await channel!.setTyping?.('term:canary-group', true);

    process.stdin.emit('data', Buffer.from([0x1b, 0x5b, 0x41]));
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(onCancel).not.toHaveBeenCalled();
    await channel!.disconnect();
  });
});
