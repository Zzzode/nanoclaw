import fs from 'fs';
import path from 'path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { type AgentRunOutput, type ExecutionEvent } from '../agent-backend.js';
import {
  _initTestDatabase,
  storeChatMetadata,
  storeMessageDirect,
} from '../db.js';
import { beginExecution, requestExecutionCancel } from '../execution-state.js';
import { createEdgeBackend, buildExecutionRequest } from './edge-backend.js';
import type { AgentRunInput } from '../agent-backend.js';
import { GROUPS_DIR } from '../config.js';
import type { RegisteredGroup } from '../types.js';

const group: RegisteredGroup = {
  name: 'Edge Group',
  folder: 'edge-group',
  trigger: '@Andy',
  added_at: '2026-04-03T00:00:00.000Z',
  executionMode: 'edge',
};

const input: AgentRunInput = {
  prompt: 'Summarize pending work items',
  groupFolder: 'edge-group',
  chatJid: 'edge@g.us',
  isMain: false,
  assistantName: 'Andy',
  executionContext: {
    executionId: 'exec-1',
    logicalSessionId: 'group:edge-group',
    turnId: 'turn-1',
  },
};

describe('edgeBackend', () => {
  const groupPath = path.join(GROUPS_DIR, group.folder);

  beforeEach(() => {
    vi.restoreAllMocks();
    _initTestDatabase();
    fs.mkdirSync(groupPath, { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(groupPath, { recursive: true, force: true });
  });

  it('builds a concrete execution request protocol payload', () => {
    const request = buildExecutionRequest(group, input);

    expect(request).toMatchObject({
      executionId: 'exec-1',
      graphId: 'graph:turn-1',
      taskId: 'task:turn-1:root',
      parentTaskId: null,
      logicalSessionId: 'group:edge-group',
      workerClass: 'edge',
      groupId: 'edge-group',
      chatJid: 'edge@g.us',
      turnId: 'turn-1',
      modelProfile: 'edge-local-dev',
      workspaceRef: expect.stringMatching(/^workspace:/),
      capabilityBudget: {
        capabilities: [
          'fs.read',
          'fs.write',
          'message.send',
          'task.manage',
          'http.fetch',
          'code.exec',
        ],
        maxToolCalls: 12,
      },
      deadline: {
        deadlineMs: 300000,
        expiresAt: null,
      },
      idempotencyKey: 'exec-1:task:turn-1:root',
      planFragment: {
        kind: 'single_root',
      },
      promptPackage: {
        system: 'You are Andy.',
        summary: null,
        recentMessages: [
          { role: 'user', content: 'Summarize pending work items' },
        ],
      },
      workspace: {
        baseVersion: expect.stringMatching(/^workspace:/),
      },
      memory: {
        groupMemoryVersion: 'memory:legacy',
      },
    });
    expect(request.workspace.manifestRef).toBe(request.workspace.baseVersion);
  });

  it('uses fanout worker prompts instead of stale chat history', () => {
    storeChatMetadata(
      'edge@g.us',
      '2026-04-07T00:00:00.000Z',
      'Edge Group',
      'test',
      true,
    );
    storeMessageDirect({
      id: 'msg-original-team',
      chat_jid: 'edge@g.us',
      sender: 'alice',
      sender_name: 'Alice',
      content: '请创建一个 3-agent team，并行完成原始任务',
      timestamp: '2026-04-07T00:00:00.000Z',
      is_from_me: false,
    });

    const request = buildExecutionRequest(group, {
      ...input,
      prompt: '你是 edge team worker 1/3。你的负责范围：目标与验收标准。',
      executionContext: {
        ...input.executionContext!,
        taskNodeId: 'task:turn-1:child-1',
        planFragment: {
          kind: 'edge_fanout_child',
          fanoutTeamSize: 3,
          fanoutRole: '目标与验收标准',
        },
      },
    });

    expect(request.promptPackage.recentMessages).toEqual([
      {
        role: 'user',
        content: '你是 edge team worker 1/3。你的负责范围：目标与验收标准。',
      },
    ]);
    expect(request.policy.allowedTools).toEqual([
      'workspace.read',
      'workspace.list',
      'workspace.search',
    ]);
    expect(request.policy.capabilities).toEqual(['fs.read']);
    expect(request.capabilityBudget).toEqual({
      capabilities: ['fs.read'],
      maxToolCalls: 12,
    });
  });

  it('caps plain group-turn recent history to a bounded window', () => {
    storeChatMetadata(
      'edge@g.us',
      '2026-04-07T00:00:00.000Z',
      'Edge Group',
      'test',
      true,
    );

    for (let index = 0; index < 8; index++) {
      storeMessageDirect({
        id: `msg-history-${index}`,
        chat_jid: 'edge@g.us',
        sender: index % 2 === 0 ? 'alice' : 'Andy',
        sender_name: index % 2 === 0 ? 'Alice' : 'Andy',
        content: `${index % 2 === 0 ? '用户' : '助手'}-${index}: ${'x'.repeat(2500)}`,
        timestamp: `2026-04-07T00:00:0${index}.000Z`,
        is_from_me: index % 2 === 1,
        is_bot_message: index % 2 === 1,
      });
    }

    storeMessageDirect({
      id: 'msg-latest-user',
      chat_jid: 'edge@g.us',
      sender: 'alice',
      sender_name: 'Alice',
      content: '请只回答：ok',
      timestamp: '2026-04-07T00:00:09.000Z',
      is_from_me: false,
      is_bot_message: false,
    });

    const request = buildExecutionRequest(group, {
      ...input,
      prompt: '请只回答：ok',
    });

    const rendered = request.promptPackage.recentMessages;
    const totalChars = rendered.reduce(
      (sum, message) => sum + message.content.length,
      0,
    );

    expect(totalChars).toBeLessThanOrEqual(12_000);
    expect(rendered.at(-1)).toEqual({
      role: 'user',
      content: 'Alice: 请只回答：ok',
    });
    expect(rendered.some((message) => message.content.includes('用户-0'))).toBe(
      false,
    );
  });

  it('builds a restricted shadow execution request', () => {
    const request = buildExecutionRequest(group, {
      ...input,
      shadowMode: true,
    });

    expect(request.policy).toEqual({
      allowedTools: ['workspace.read', 'workspace.list', 'workspace.search'],
      capabilities: ['fs.read'],
      execution: {
        allowJsExecution: false,
        maxJsExecutions: 3,
        allowedModuleImports: [],
      },
      networkProfile: 'disabled',
    });
    expect(request.capabilityBudget).toEqual({
      capabilities: ['fs.read'],
      maxToolCalls: 12,
    });
  });

  it('suppresses tool exposure when the execution budget allows zero tool calls', () => {
    const request = buildExecutionRequest(group, {
      ...input,
      shadowMode: true,
      executionContext: {
        ...input.executionContext!,
        capabilityBudget: {
          capabilities: [],
          maxToolCalls: 0,
        },
      },
    });

    expect(request.policy).toEqual({
      allowedTools: [],
      capabilities: [],
      execution: {
        allowJsExecution: false,
        maxJsExecutions: 3,
        allowedModuleImports: [],
      },
      networkProfile: 'disabled',
    });
    expect(request.capabilityBudget).toEqual({
      capabilities: [],
      maxToolCalls: 0,
    });
    expect(request.limits.maxToolCalls).toBe(0);
  });

  it('streams output and returns the local runner final result', async () => {
    const backend = createEdgeBackend();
    expect(backend).toMatchObject({
      backendId: 'edge',
      workerClass: 'edge',
      runtimeClass: 'edge-subprocess',
    });
    const onOutput = vi.fn(async (_output: AgentRunOutput) => {});
    const onExecutionStarted = vi.fn();

    const result = await backend.run(
      group,
      input,
      onExecutionStarted,
      onOutput,
    );

    expect(onExecutionStarted).not.toHaveBeenCalled();
    expect(onOutput).toHaveBeenCalledWith({
      status: 'success',
      result: null,
      newSessionId: 'edge-session:group:edge-group',
    });
    expect(result).toMatchObject({
      status: 'success',
      result: expect.stringContaining('[edge runner local]'),
      newSessionId: 'edge-session:group:edge-group',
    });
  });

  it('deduplicates repeated checkpoint and final events', async () => {
    async function* duplicatedEvents(): AsyncGenerator<ExecutionEvent> {
      yield { type: 'ack', executionId: 'exec-1', nodeId: 'node-1' };
      yield {
        type: 'checkpoint',
        executionId: 'exec-1',
        providerSession: 'edge-session:group:edge-group',
      };
      yield {
        type: 'checkpoint',
        executionId: 'exec-1',
        providerSession: 'edge-session:group:edge-group',
      };
      yield {
        type: 'output_message',
        executionId: 'exec-1',
        text: 'hello from edge',
      };
      yield {
        type: 'final',
        executionId: 'exec-1',
        result: {
          status: 'success',
          outputText: 'hello from edge',
          providerSessionId: 'edge-session:group:edge-group',
        },
      };
      yield {
        type: 'final',
        executionId: 'exec-1',
        result: {
          status: 'success',
          outputText: 'duplicate final',
          providerSessionId: 'edge-session:group:edge-group',
        },
      };
    }

    const backend = createEdgeBackend({
      runTurn: () => duplicatedEvents(),
    });
    const onOutput = vi.fn(async (_output: AgentRunOutput) => {});

    const result = await backend.run(group, input, undefined, onOutput);

    expect(result).toEqual({
      status: 'success',
      result: 'hello from edge',
      newSessionId: 'edge-session:group:edge-group',
    });
    expect(
      onOutput.mock.calls.filter((call) => {
        const value = call[0];
        return value?.newSessionId === 'edge-session:group:edge-group';
      }),
    ).toHaveLength(1);
  });

  it('suppresses intermediate tool chatter and only surfaces the final answer', async () => {
    async function* noisyEvents(): AsyncGenerator<ExecutionEvent> {
      yield { type: 'ack', executionId: 'exec-1', nodeId: 'node-1' };
      yield {
        type: 'tool_call',
        executionId: 'exec-1',
        tool: 'workspace.read',
        args: { path: 'CLAUDE.md' },
      };
      yield {
        type: 'tool_result',
        executionId: 'exec-1',
        tool: 'task.list',
        result: { tasks: [] },
      };
      yield {
        type: 'output_message',
        executionId: 'exec-1',
        text: '最终答案',
      };
      yield {
        type: 'final',
        executionId: 'exec-1',
        result: {
          status: 'success',
          outputText: '最终答案',
        },
      };
    }

    const backend = createEdgeBackend({
      runTurn: () => noisyEvents(),
    });
    const onOutput = vi.fn(async (_output: AgentRunOutput) => {});

    const result = await backend.run(group, input, undefined, onOutput);

    expect(result).toEqual({
      status: 'success',
      result: '最终答案',
    });
    expect(onOutput).not.toHaveBeenCalledWith({
      status: 'success',
      result: '正在调用工具：workspace.read',
    });
    expect(onOutput).not.toHaveBeenCalledWith({
      status: 'success',
      result: '任务列表已返回，共 0 条',
    });
  });

  it('falls back to a deferred task receipt when no final text is produced', async () => {
    async function* toolOnlyEvents(): AsyncGenerator<ExecutionEvent> {
      yield { type: 'ack', executionId: 'exec-1', nodeId: 'node-1' };
      yield {
        type: 'tool_result',
        executionId: 'exec-1',
        tool: 'task.update',
        result: { taskId: 'task-123', updated: true },
      };
      yield {
        type: 'final',
        executionId: 'exec-1',
        result: {
          status: 'success',
          outputText: null,
        },
      };
    }

    const backend = createEdgeBackend({
      runTurn: () => toolOnlyEvents(),
    });

    await expect(backend.run(group, input)).resolves.toEqual({
      status: 'success',
      result: '任务已更新，taskId=task-123',
    });
  });

  it('formats task.list deferred receipts with status details', async () => {
    async function* toolOnlyEvents(): AsyncGenerator<ExecutionEvent> {
      yield { type: 'ack', executionId: 'exec-1', nodeId: 'node-1' };
      yield {
        type: 'tool_result',
        executionId: 'exec-1',
        tool: 'task.list',
        result: {
          tasks: [
            {
              id: 'task-1',
              displayStatus: 'running',
              schedule_value: '300000',
              formattedNextRun: '2026/04/05 20:00 (Asia/Shanghai)',
              next_run: '2026-04-05T12:00:00.000Z',
            },
          ],
        },
      };
      yield {
        type: 'final',
        executionId: 'exec-1',
        result: {
          status: 'success',
          outputText: null,
        },
      };
    }

    const backend = createEdgeBackend({
      runTurn: () => toolOnlyEvents(),
    });

    await expect(backend.run(group, input)).resolves.toEqual({
      status: 'success',
      result:
        'taskId: task-1\nstatus: running\nscheduleValue: 300000\nnextRun: 2026/04/05 20:00 (Asia/Shanghai)',
    });
  });

  it('returns a controlled error for script-based runs', async () => {
    const backend = createEdgeBackend();

    await expect(
      backend.run(group, { ...input, script: 'echo 1' }),
    ).resolves.toEqual({
      status: 'error',
      result: null,
      error: 'Edge backend does not support scheduled task scripts yet.',
    });
  });

  it('stops edge runs when a cancel request is recorded', async () => {
    vi.useFakeTimers();

    try {
      const execution = beginExecution({
        scopeType: 'group',
        scopeId: group.folder,
        backend: 'edge',
        groupJid: input.chatJid,
        now: new Date('2026-04-03T00:00:00.000Z'),
        leaseMs: 60_000,
      });

      const backend = createEdgeBackend({
        async *runTurn(request, options) {
          yield {
            type: 'ack',
            executionId: request.executionId,
            nodeId: 'node-cancel',
          };

          await new Promise<void>((resolve) => {
            const timer = setTimeout(resolve, 5_000);
            options?.signal?.addEventListener(
              'abort',
              () => {
                clearTimeout(timer);
                resolve();
              },
              { once: true },
            );
          });
        },
      });

      const runPromise = backend.run(group, {
        ...input,
        executionContext: {
          executionId: execution.executionId,
          logicalSessionId: execution.logicalSessionId,
          turnId: execution.turnId,
        },
      });

      await vi.advanceTimersByTimeAsync(100);
      requestExecutionCancel(
        execution.executionId,
        new Date('2026-04-03T00:00:00.100Z'),
      );
      await vi.advanceTimersByTimeAsync(100);

      await expect(runPromise).resolves.toEqual({
        status: 'error',
        result: null,
        error: 'Edge execution cancelled before completion.',
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it('fails edge runs that exceed the execution deadline', async () => {
    vi.useFakeTimers();

    try {
      const execution = beginExecution({
        scopeType: 'group',
        scopeId: group.folder,
        backend: 'edge',
        groupJid: input.chatJid,
        now: new Date('2026-04-03T00:00:00.000Z'),
        leaseMs: 60_000,
      });

      const backend = createEdgeBackend({
        async *runTurn(request, options) {
          yield {
            type: 'ack',
            executionId: request.executionId,
            nodeId: 'node-deadline',
          };

          await new Promise<void>((resolve) => {
            const timer = setTimeout(resolve, 5_000);
            options?.signal?.addEventListener(
              'abort',
              () => {
                clearTimeout(timer);
                resolve();
              },
              { once: true },
            );
          });
        },
      });

      const runPromise = backend.run(
        {
          ...group,
          containerConfig: { timeout: 100 },
        },
        {
          ...input,
          executionContext: {
            executionId: execution.executionId,
            logicalSessionId: execution.logicalSessionId,
            turnId: execution.turnId,
          },
        },
      );

      await vi.advanceTimersByTimeAsync(200);

      await expect(runPromise).resolves.toEqual({
        status: 'error',
        result: null,
        error: 'Edge execution exceeded deadline of 100ms.',
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it('fails fast when the runner never emits a startup event', async () => {
    vi.useFakeTimers();

    try {
      const execution = beginExecution({
        scopeType: 'group',
        scopeId: group.folder,
        backend: 'edge',
        groupJid: input.chatJid,
        now: new Date('2026-04-03T00:00:00.000Z'),
        leaseMs: 60_000,
      });

      const backend = createEdgeBackend({
        async *runTurn(_request, options) {
          await new Promise<void>((resolve) => {
            options?.signal?.addEventListener('abort', () => resolve(), {
              once: true,
            });
          });
        },
      });

      const runPromise = backend.run(group, {
        ...input,
        executionContext: {
          executionId: execution.executionId,
          logicalSessionId: execution.logicalSessionId,
          turnId: execution.turnId,
        },
      });

      await vi.advanceTimersByTimeAsync(15_100);

      await expect(runPromise).resolves.toEqual({
        status: 'error',
        result: null,
        error: 'Edge runner produced no startup event within 15000ms.',
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it('fails when the runner goes silent after startup', async () => {
    vi.useFakeTimers();

    try {
      const execution = beginExecution({
        scopeType: 'group',
        scopeId: group.folder,
        backend: 'edge',
        groupJid: input.chatJid,
        now: new Date('2026-04-03T00:00:00.000Z'),
        leaseMs: 305_000,
      });

      const backend = createEdgeBackend({
        async *runTurn(request, options) {
          yield {
            type: 'ack',
            executionId: request.executionId,
            nodeId: 'node-silent',
          };
          yield {
            type: 'heartbeat',
            executionId: request.executionId,
            at: new Date('2026-04-03T00:00:00.000Z').toISOString(),
          };
          await new Promise<void>((resolve) => {
            options?.signal?.addEventListener('abort', () => resolve(), {
              once: true,
            });
          });
        },
      });

      const runPromise = backend.run(group, {
        ...input,
        executionContext: {
          executionId: execution.executionId,
          logicalSessionId: execution.logicalSessionId,
          turnId: execution.turnId,
        },
      });

      await vi.advanceTimersByTimeAsync(30_100);

      await expect(runPromise).resolves.toEqual({
        status: 'error',
        result: null,
        error: 'Edge runner produced no progress within 30000ms.',
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it('keeps long-running edge requests alive when heartbeats continue during upstream wait', async () => {
    vi.useFakeTimers();

    try {
      const execution = beginExecution({
        scopeType: 'group',
        scopeId: group.folder,
        backend: 'edge',
        groupJid: input.chatJid,
        now: new Date('2026-04-03T00:00:00.000Z'),
        leaseMs: 305_000,
      });

      const backend = createEdgeBackend({
        async *runTurn(request, options) {
          yield {
            type: 'ack',
            executionId: request.executionId,
            nodeId: 'node-heartbeat',
          };

          const startedAt = new Date('2026-04-03T00:00:00.000Z').getTime();
          for (let index = 1; index <= 4; index += 1) {
            await new Promise<void>((resolve, reject) => {
              const timer = setTimeout(resolve, 10_000);
              options?.signal?.addEventListener(
                'abort',
                () => {
                  clearTimeout(timer);
                  reject(options.signal?.reason ?? new Error('aborted'));
                },
                { once: true },
              );
            });

            yield {
              type: 'heartbeat',
              executionId: request.executionId,
              at: new Date(startedAt + index * 10_000).toISOString(),
            };
          }

          yield {
            type: 'checkpoint',
            executionId: request.executionId,
            providerSession: 'edge-session:group:edge-group',
            summaryDelta: 'planner still waiting',
            workspaceOverlayDigest: 'workspace:unchanged',
          };
          yield {
            type: 'output_message',
            executionId: request.executionId,
            text: 'planner response after long upstream wait',
          };
          yield {
            type: 'final',
            executionId: request.executionId,
            result: {
              status: 'success',
              outputText: 'planner response after long upstream wait',
              providerSessionId: 'edge-session:group:edge-group',
            },
          };
        },
      });

      const runPromise = backend.run(group, {
        ...input,
        executionContext: {
          executionId: execution.executionId,
          logicalSessionId: execution.logicalSessionId,
          turnId: execution.turnId,
        },
      });

      await vi.advanceTimersByTimeAsync(40_100);

      await expect(runPromise).resolves.toEqual({
        status: 'success',
        result: 'planner response after long upstream wait',
        newSessionId: 'edge-session:group:edge-group',
      });
    } finally {
      vi.useRealTimers();
    }
  });
});
