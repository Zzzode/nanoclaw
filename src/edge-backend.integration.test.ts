import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { RegisteredGroup } from './types.js';

const group: RegisteredGroup = {
  name: 'Edge Group',
  folder: 'edge-group',
  trigger: '@Andy',
  added_at: '2026-04-03T00:00:00.000Z',
  executionMode: 'edge',
};

describe('edge backend integration', () => {
  let tempRoot: string;

  beforeEach(() => {
    tempRoot = fs.mkdtempSync(
      path.join(os.tmpdir(), 'nanoclaw-edge-integration-'),
    );
    vi.stubEnv('NANOCLAW_STORE_DIR', path.join(tempRoot, 'store'));
    vi.stubEnv('NANOCLAW_GROUPS_DIR', path.join(tempRoot, 'groups'));
    vi.stubEnv('NANOCLAW_DATA_DIR', path.join(tempRoot, 'data'));
  });

  afterEach(() => {
    vi.resetModules();
    vi.unstubAllEnvs();
    fs.rmSync(tempRoot, { recursive: true, force: true });
  });

  it(
    'dispatches to the edge runner and persists ack/checkpoint state',
    { timeout: 30000 },
    async () => {
      vi.resetModules();
      const [
        dbModule,
        executionStateModule,
        { createPersistentExecutionEventHooks },
        { createSubprocessEdgeRunner },
        { createEdgeBackend },
      ] = await Promise.all([
        import('./db.js'),
        import('./execution-state.js'),
        import('./edge-event-dispatcher.js'),
        import('./edge-subprocess-runner.js'),
        import('./backends/edge-backend.js'),
      ]);
      dbModule.initDatabase();

      const { getExecutionState, getLogicalSession, listExecutionCheckpoints } =
        dbModule;
      const { beginExecution, commitExecution, completeExecution } =
        executionStateModule;

      const execution = beginExecution({
        scopeType: 'task',
        scopeId: 'task-edge-integration',
        backend: 'edge',
        taskId: 'task-edge-integration',
        groupJid: 'edge@g.us',
        now: new Date('2026-04-03T00:00:00.000Z'),
      });

      const backend = createEdgeBackend(
        createSubprocessEdgeRunner(),
        createPersistentExecutionEventHooks,
      );

      const result = await backend.run(group, {
        prompt: 'Summarize pending work items',
        groupFolder: group.folder,
        chatJid: 'edge@g.us',
        isMain: false,
        assistantName: 'Andy',
        executionContext: {
          executionId: execution.executionId,
          logicalSessionId: execution.logicalSessionId,
          turnId: execution.turnId,
        },
      });

      commitExecution(execution.executionId);
      completeExecution(execution.executionId);

      expect(result).toMatchObject({
        status: 'success',
        result: expect.stringContaining('[edge runner local]'),
        newSessionId: 'edge-session:task:task-edge-integration',
      });
      expect(getExecutionState(execution.executionId)).toMatchObject({
        executionId: execution.executionId,
        backend: 'edge',
        edgeNodeId: 'local-edge-runner',
        status: 'completed',
        lastHeartbeatAt: expect.any(String),
      });
      expect(listExecutionCheckpoints(execution.executionId)).toEqual([
        expect.objectContaining({
          executionId: execution.executionId,
          providerSessionId: 'edge-session:task:task-edge-integration',
          workspaceOverlayDigest: 'workspace:unchanged',
        }),
      ]);
      expect(getLogicalSession('task', 'task-edge-integration')).toMatchObject({
        id: 'task:task-edge-integration',
        providerSessionId: 'edge-session:task:task-edge-integration',
        status: 'active',
      });
    },
  );

  it('handles message.send through orchestrator output', async () => {
    vi.resetModules();
    const [
      { initDatabase },
      executionStateModule,
      { createPersistentExecutionEventHooks },
      { createSubprocessEdgeRunner },
      { createEdgeBackend },
    ] = await Promise.all([
      import('./db.js'),
      import('./execution-state.js'),
      import('./edge-event-dispatcher.js'),
      import('./edge-subprocess-runner.js'),
      import('./backends/edge-backend.js'),
    ]);
    initDatabase();

    const { beginExecution, commitExecution, completeExecution } =
      executionStateModule;

    const execution = beginExecution({
      scopeType: 'task',
      scopeId: 'task-edge-message-send',
      backend: 'edge',
      taskId: 'task-edge-message-send',
      groupJid: 'edge@g.us',
    });

    const backend = createEdgeBackend(
      createSubprocessEdgeRunner(),
      createPersistentExecutionEventHooks,
    );

    const streamed: string[] = [];
    const result = await backend.run(
      group,
      {
        prompt:
          'EDGE_TOOL {"tool":"message.send","args":{"text":"hello from tool"}}',
        groupFolder: group.folder,
        chatJid: 'edge@g.us',
        isMain: false,
        assistantName: 'Andy',
        executionContext: {
          executionId: execution.executionId,
          logicalSessionId: execution.logicalSessionId,
          turnId: execution.turnId,
        },
      },
      undefined,
      async (output) => {
        if (output.result) streamed.push(output.result);
      },
    );

    commitExecution(execution.executionId);
    completeExecution(execution.executionId);

    expect(streamed).toEqual(['hello from tool']);
    expect(result).toMatchObject({
      status: 'success',
      result: null,
    });
  });

  it('runs workspace tool calls end to end', async () => {
    vi.resetModules();
    const [
      { initDatabase },
      executionStateModule,
      { createPersistentExecutionEventHooks },
      { createSubprocessEdgeRunner },
      { createEdgeBackend },
      { GROUPS_DIR },
    ] = await Promise.all([
      import('./db.js'),
      import('./execution-state.js'),
      import('./edge-event-dispatcher.js'),
      import('./edge-subprocess-runner.js'),
      import('./backends/edge-backend.js'),
      import('./config.js'),
    ]);
    initDatabase();

    const { beginExecution, commitExecution, completeExecution } =
      executionStateModule;

    const execution = beginExecution({
      scopeType: 'task',
      scopeId: 'task-edge-workspace-write',
      backend: 'edge',
      taskId: 'task-edge-workspace-write',
      groupJid: 'edge@g.us',
    });
    const workspaceDir = path.join(GROUPS_DIR, group.folder);
    fs.mkdirSync(workspaceDir, { recursive: true });

    const backend = createEdgeBackend(
      createSubprocessEdgeRunner(),
      createPersistentExecutionEventHooks,
    );

    const result = await backend.run(group, {
      prompt:
        'EDGE_TOOL {"tool":"workspace.write","args":{"path":"phase6.txt","content":"phase6 data","operationId":"op-phase6-write"}}',
      groupFolder: group.folder,
      chatJid: 'edge@g.us',
      isMain: false,
      assistantName: 'Andy',
      executionContext: {
        executionId: execution.executionId,
        logicalSessionId: execution.logicalSessionId,
        turnId: execution.turnId,
      },
    });

    commitExecution(execution.executionId);
    completeExecution(execution.executionId);

    expect(result).toMatchObject({
      status: 'success',
      result: expect.stringContaining('"path":"phase6.txt"'),
    });
    expect(fs.readFileSync(path.join(workspaceDir, 'phase6.txt'), 'utf8')).toBe(
      'phase6 data',
    );
  });

  it('bridges task tools through the subprocess host', async () => {
    vi.resetModules();
    const [
      dbModule,
      executionStateModule,
      { createPersistentExecutionEventHooks },
      { createSubprocessEdgeRunner },
      { createEdgeBackend },
    ] = await Promise.all([
      import('./db.js'),
      import('./execution-state.js'),
      import('./edge-event-dispatcher.js'),
      import('./edge-subprocess-runner.js'),
      import('./backends/edge-backend.js'),
    ]);
    dbModule.initDatabase();

    const { beginExecution, commitExecution, completeExecution } =
      executionStateModule;

    const execution = beginExecution({
      scopeType: 'task',
      scopeId: 'task-edge-create-task',
      backend: 'edge',
      taskId: 'task-edge-create-task',
      groupJid: 'edge@g.us',
    });

    const backend = createEdgeBackend(
      createSubprocessEdgeRunner(),
      createPersistentExecutionEventHooks,
    );

    const result = await backend.run(group, {
      prompt:
        'EDGE_TOOL {"tool":"task.create","args":{"prompt":"remind me","scheduleType":"interval","scheduleValue":"60000","operationId":"op-task-create-1"}}',
      groupFolder: group.folder,
      chatJid: 'edge@g.us',
      isMain: false,
      assistantName: 'Andy',
      executionContext: {
        executionId: execution.executionId,
        logicalSessionId: execution.logicalSessionId,
        turnId: execution.turnId,
      },
    });

    commitExecution(execution.executionId);
    completeExecution(execution.executionId);

    expect(result).toMatchObject({
      status: 'success',
      result: expect.stringContaining('taskId'),
    });
    expect(dbModule.getAllTasks()).toHaveLength(1);
    expect(dbModule.getAllTasks()[0]).toMatchObject({
      prompt: 'remind me',
      schedule_value: '60000',
    });
  });
});
