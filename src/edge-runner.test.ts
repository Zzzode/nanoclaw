import { afterEach, describe, expect, it, vi } from 'vitest';
import fs from 'fs';
import path from 'path';

import type { ExecutionEvent, ExecutionRequest } from './agent-backend.js';
import { localEdgeRunner, resolveDirectToolInvocation } from './edge-runner.js';
import { GROUPS_DIR } from './config.js';
import { ensureWorkspaceVersion } from './workspace-service.js';

const request: ExecutionRequest = {
  executionId: 'exec-1',
  graphId: 'graph:turn-1',
  taskId: 'task:turn-1:root',
  parentTaskId: null,
  logicalSessionId: 'group:team_alpha',
  workerClass: 'edge',
  groupId: 'team_alpha',
  chatJid: 'room@g.us',
  turnId: 'turn-1',
  modelProfile: 'edge-local-dev',
  workspaceRef: 'workspace:legacy',
  capabilityBudget: {
    capabilities: [
      'fs.read',
      'fs.write',
      'http.fetch',
      'task.manage',
      'message.send',
      'code.exec',
    ],
    maxToolCalls: 0,
  },
  deadline: {
    deadlineMs: 1000,
    expiresAt: null,
  },
  idempotencyKey: 'exec-1:task:turn-1:root',
  planFragment: {
    kind: 'single_root',
  },
  promptPackage: {
    system: 'You are Andy.',
    summary: null,
    recentMessages: [{ role: 'user', content: 'Summarize the backlog' }],
  },
  workspace: {
    baseVersion: 'workspace:legacy',
    manifestRef: 'workspace-manifest:team_alpha',
  },
  memory: {
    groupMemoryVersion: 'memory:legacy',
  },
  limits: {
    maxToolCalls: 0,
    deadlineMs: 1000,
    maxOutputBytes: 4096,
  },
  policy: {
    allowedTools: [
      'workspace.write',
      'workspace.read',
      'workspace.list',
      'workspace.search',
      'workspace.apply_patch',
      'message.send',
      'task.create',
      'task.list',
      'http.fetch',
    ],
    networkProfile: 'disabled',
    capabilities: [
      'fs.read',
      'fs.write',
      'http.fetch',
      'task.manage',
      'message.send',
      'code.exec',
    ],
  },
};

describe('localEdgeRunner', () => {
  it('emits the expected protocol events for a local turn', async () => {
    const events: ExecutionEvent[] = [];

    for await (const event of localEdgeRunner.runTurn(request)) {
      events.push(event);
    }

    expect(events.map((event) => event.type)).toEqual([
      'ack',
      'heartbeat',
      'output_delta',
      'output_delta',
      'checkpoint',
      'output_message',
      'final',
    ]);
    expect(events[0]).toMatchObject({
      type: 'ack',
      executionId: 'exec-1',
      nodeId: 'local-edge-runner',
    });
    expect(events[4]).toMatchObject({
      type: 'checkpoint',
      executionId: 'exec-1',
      providerSession: 'edge-session:group:team_alpha',
      workspaceOverlayDigest: 'workspace:unchanged',
    });
    expect(events[5]).toMatchObject({
      type: 'output_message',
      executionId: 'exec-1',
      text: expect.stringContaining('[edge runner local]'),
    });
    expect(events[6]).toMatchObject({
      type: 'final',
      executionId: 'exec-1',
      result: {
        status: 'success',
        outputText: expect.stringContaining('[edge runner local]'),
        providerSessionId: 'edge-session:group:team_alpha',
      },
    });
  });

  it('emits tool events for EDGE_TOOL prompts', async () => {
    const groupId = 'edge_runner_tool_test';
    const groupPath = path.join(GROUPS_DIR, groupId);
    fs.mkdirSync(groupPath, { recursive: true });

    try {
      const toolRequest: ExecutionRequest = {
        ...request,
        executionId: 'exec-2',
        logicalSessionId: `group:${groupId}`,
        groupId,
        workspace: {
          baseVersion: ensureWorkspaceVersion(groupId),
          manifestRef: ensureWorkspaceVersion(groupId),
        },
        promptPackage: {
          ...request.promptPackage,
          recentMessages: [
            {
              role: 'user',
              content:
                'EDGE_TOOL {"tool":"workspace.write","args":{"path":"runner.txt","content":"hi","operationId":"runner-op-1"}}',
            },
          ],
        },
      };

      const events: ExecutionEvent[] = [];
      for await (const event of localEdgeRunner.runTurn(toolRequest)) {
        events.push(event);
      }

      expect(events.map((event) => event.type)).toEqual([
        'ack',
        'heartbeat',
        'tool_call',
        'tool_result',
        'checkpoint',
        'output_delta',
        'output_delta',
        'output_message',
        'final',
      ]);
    } finally {
      fs.rmSync(groupPath, { recursive: true, force: true });
    }
  });
});

// Removed: detectExplicitToolChoice tests and natural language resolveDirectToolInvocation tests
// Intent detection now relies on model native tool_use.
// EDGE_TOOL structured syntax tests are preserved in localEdgeRunner describe block.
