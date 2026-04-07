import fs from 'fs';
import path from 'path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { ExecutionRequest } from './agent-backend.js';
import { _initTestDatabase, getAllTasks } from './db.js';
import { executeEdgeTool } from './edge-tool-host.js';
import { GROUPS_DIR } from './config.js';
import { beginExecution } from './execution-state.js';
import { ensureWorkspaceVersion } from './workspace-service.js';

function createRequest(groupId: string): ExecutionRequest {
  const baseVersion = ensureWorkspaceVersion(groupId);
  return {
    executionId: 'exec-tools-1',
    graphId: 'graph:turn-tools-1',
    taskId: 'task:turn-tools-1:root',
    parentTaskId: null,
    logicalSessionId: `group:${groupId}`,
    workerClass: 'edge',
    groupId,
    chatJid: 'edge@g.us',
    turnId: 'turn-tools-1',
    modelProfile: 'edge-local-dev',
    workspaceRef: baseVersion,
    capabilityBudget: {
      capabilities: [
        'fs.read',
        'fs.write',
        'message.send',
        'task.create',
        'task.read',
        'task.delete',
        'task.update',
        'http.fetch',
        'code.exec',
      ],
      maxToolCalls: 10,
    },
    deadline: {
      deadlineMs: 1000,
      expiresAt: null,
    },
    idempotencyKey: 'exec-tools-1:task:turn-tools-1:root',
    planFragment: {
      kind: 'single_root',
    },
    promptPackage: {
      system: 'You are Andy.',
      summary: null,
      recentMessages: [{ role: 'user', content: 'test' }],
    },
    workspace: {
      baseVersion,
      manifestRef: baseVersion,
    },
    memory: {
      groupMemoryVersion: 'memory:legacy',
    },
    limits: {
      maxToolCalls: 10,
      deadlineMs: 1000,
      maxOutputBytes: 4096,
    },
    policy: {
      allowedTools: [
        'workspace.read',
        'workspace.list',
        'workspace.search',
        'workspace.write',
        'workspace.apply_patch',
        'message.send',
        'task.create',
        'task.list',
        'task.delete',
        'task.update',
        'http.fetch',
        'js.exec',
      ],
      networkProfile: 'local',
      capabilities: [
        'fs.read',
        'fs.write',
        'message.send',
        'task.manage',
        'http.fetch',
        'code.exec',
      ],
      execution: {
        allowJsExecution: true,
      },
    },
  };
}

describe('edge tool host', () => {
  let groupId: string;
  let groupPath: string;

  beforeEach(() => {
    _initTestDatabase();
    groupId = `edge_tool_${Date.now()}`;
    groupPath = path.join(GROUPS_DIR, groupId);
    fs.mkdirSync(groupPath, { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(groupPath, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it('supports workspace write, read, list, search, and apply_patch', async () => {
    fs.writeFileSync(
      path.join(groupPath, 'notes.txt'),
      'hello world\nsecond line',
    );
    const request = createRequest(groupId);

    const writeResult = await executeEdgeTool(request, {
      tool: 'workspace.write',
      args: {
        path: 'draft.txt',
        content: 'draft content',
        operationId: 'op-write-1',
      },
    });
    expect(writeResult.workspaceOverlay).toEqual({
      changes: [{ op: 'write', path: 'draft.txt', content: 'draft content' }],
      digest: 'workspace:overlay:workspace.write:1',
    });

    const readResult = await executeEdgeTool(request, {
      tool: 'workspace.read',
      args: { path: 'notes.txt' },
    });
    expect(readResult.result).toEqual({
      path: 'notes.txt',
      content: 'hello world\nsecond line',
    });

    const absoluteStyleReadResult = await executeEdgeTool(request, {
      tool: 'workspace.read',
      args: { path: '/workspace/group/notes.txt' },
    });
    expect(absoluteStyleReadResult.result).toEqual({
      path: '/workspace/group/notes.txt',
      content: 'hello world\nsecond line',
    });

    const listResult = await executeEdgeTool(request, {
      tool: 'workspace.list',
      args: { path: '.', recursive: true },
    });
    expect(listResult.result).toEqual({
      path: '.',
      entries: ['notes.txt'],
    });

    const searchResult = await executeEdgeTool(request, {
      tool: 'workspace.search',
      args: { path: '.', pattern: 'second' },
    });
    expect(searchResult.result).toEqual({
      path: '.',
      pattern: 'second',
      matches: [{ path: 'notes.txt', line: 2, text: 'second line' }],
    });

    await executeEdgeTool(request, {
      tool: 'workspace.apply_patch',
      args: {
        operationId: 'op-patch-1',
        patch: [
          '*** Begin Patch',
          '*** Update File: notes.txt',
          '@@',
          ' hello world',
          '-second line',
          '+patched line',
          '*** End Patch',
        ].join('\n'),
      },
    });
    expect(fs.readFileSync(path.join(groupPath, 'notes.txt'), 'utf8')).toBe(
      'hello world\nsecond line',
    );
  });

  it('blocks workspace path traversal', async () => {
    const request = createRequest(groupId);

    await expect(
      executeEdgeTool(request, {
        tool: 'workspace.read',
        args: { path: '../outside.txt' },
      }),
    ).rejects.toThrow(/escapes workspace root/i);
  });

  it('creates, lists, updates, and deletes tasks', async () => {
    const request = createRequest(groupId);

    const first = await executeEdgeTool(request, {
      tool: 'task.create',
      args: {
        prompt: 'do thing',
        scheduleType: 'interval',
        scheduleValue: '60000',
        operationId: 'op-task-1',
      },
    });
    const second = await executeEdgeTool(request, {
      tool: 'task.create',
      args: {
        prompt: 'do thing',
        scheduleType: 'interval',
        scheduleValue: '60000',
        operationId: 'op-task-1',
      },
    });

    expect(second.result).toEqual(first.result);
    expect(getAllTasks()).toHaveLength(1);

    const list = await executeEdgeTool(request, {
      tool: 'task.list',
      args: {},
    });
    expect((list.result as { tasks: unknown[] }).tasks).toHaveLength(1);
    expect(list.outputText).toContain('taskId:');
    expect(list.outputText).toContain('status: active');
    expect(list.outputText).toContain('scheduleValue: 60000');
    expect(list.outputText).toContain('nextRun: ');
    expect(list.outputText).toMatch(/nextRun: .+\(.+\)/);

    const taskId = (first.result as { taskId: string }).taskId;
    const updated = await executeEdgeTool(request, {
      tool: 'task.update',
      args: {
        taskId,
        prompt: 'do thing better',
        scheduleValue: '120000',
        status: 'paused',
        operationId: 'op-task-update-1',
      },
    });
    expect(updated.result).toMatchObject({
      taskId,
      updated: true,
      task: {
        id: taskId,
        prompt: 'do thing better',
        schedule_value: '120000',
        status: 'paused',
        next_run: null,
      },
    });

    const resumed = await executeEdgeTool(request, {
      tool: 'task.update',
      args: {
        taskId,
        status: 'active',
        operationId: 'op-task-update-2',
      },
    });
    expect(resumed.result).toMatchObject({
      taskId,
      updated: true,
      task: {
        id: taskId,
        status: 'active',
        next_run: expect.any(String),
      },
    });

    const deleted = await executeEdgeTool(request, {
      tool: 'task.delete',
      args: {
        taskId,
        operationId: 'op-task-delete-1',
      },
    });
    expect(deleted.result).toEqual({
      taskId,
      deleted: true,
    });
    expect(getAllTasks()).toHaveLength(0);
  });

  it('marks running tasks in task.list output', async () => {
    const request = createRequest(groupId);
    const created = await executeEdgeTool(request, {
      tool: 'task.create',
      args: {
        prompt: 'do thing',
        scheduleType: 'interval',
        scheduleValue: '60000',
      },
    });

    const taskId = (created.result as { taskId: string }).taskId;
    beginExecution({
      scopeType: 'task',
      scopeId: taskId,
      backend: 'edge',
      taskId,
      groupJid: 'edge@g.us',
    });

    const list = await executeEdgeTool(request, {
      tool: 'task.list',
      args: {},
    });

    expect(
      (
        list.result as {
          tasks: Array<{ runtimeStatus: string; displayStatus: string }>;
        }
      ).tasks[0],
    ).toMatchObject({
      runtimeStatus: 'running',
      displayStatus: 'running',
    });
    expect(list.outputText).toContain('status: running');
  });

  it('fetches from local HTTP endpoints only', async () => {
    const request = createRequest(groupId);
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response('hello from server', {
        status: 200,
      }),
    );

    const result = await executeEdgeTool(request, {
      tool: 'http.fetch',
      args: {
        url: 'http://127.0.0.1:8080/hello',
      },
    });
    expect(fetchMock).toHaveBeenCalledWith(
      new URL('http://127.0.0.1:8080/hello'),
      {
        method: 'GET',
        headers: undefined,
        body: undefined,
      },
    );
    expect(result.result).toEqual({
      status: 200,
      ok: true,
      url: '',
      body: 'hello from server',
    });
  });

  it('executes js.exec with the injected SDK', async () => {
    fs.writeFileSync(path.join(groupPath, 'script.txt'), 'hello from edge sdk');
    const request = createRequest(groupId);

    const result = await executeEdgeTool(request, {
      tool: 'js.exec',
      args: {
        code: 'return await sdk.workspace.read({ path: "script.txt" });',
      },
    });

    expect(result.result).toEqual({
      ok: true,
      value: {
        path: 'script.txt',
        content: 'hello from edge sdk',
      },
    });
  });
});
