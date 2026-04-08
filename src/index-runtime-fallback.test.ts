import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { Channel } from './types.js';

const { edgeBackendRun, containerBackendRun } = vi.hoisted(() => ({
  edgeBackendRun: vi.fn(),
  containerBackendRun: vi.fn(),
}));

const { syncObservabilitySnapshotToIpc } = vi.hoisted(() => ({
  syncObservabilitySnapshotToIpc: vi.fn(),
}));

vi.mock('./backends/edge-backend.js', () => ({
  edgeBackend: {
    backendId: 'edge',
    workerClass: 'edge',
    runtimeClass: 'edge-subprocess',
    capabilityEnvelope: [],
    run: edgeBackendRun,
  },
}));

vi.mock('./backends/container-backend.js', () => ({
  heavyWorker: {
    backendId: 'container',
    workerClass: 'heavy',
    runtimeClass: 'container',
    plannedSpecializations: [],
    capabilityEnvelope: [],
    run: containerBackendRun,
  },
}));

vi.mock('./container-snapshot-writer.js', () => ({
  writeTasksSnapshotToIpc: vi.fn(),
  writeGroupsSnapshotToIpc: vi.fn(),
  writeObservabilitySnapshotToIpc: vi.fn(),
  syncObservabilitySnapshotToIpc,
}));

describe('index group runtime fallback', () => {
  const originalShadowMode = process.env.SHADOW_EXECUTION_MODE;

  beforeEach(() => {
    process.env.SHADOW_EXECUTION_MODE = 'off';
    edgeBackendRun.mockReset();
    containerBackendRun.mockReset();
    syncObservabilitySnapshotToIpc.mockReset();
  });

  afterEach(() => {
    if (originalShadowMode === undefined) {
      delete process.env.SHADOW_EXECUTION_MODE;
    } else {
      process.env.SHADOW_EXECUTION_MODE = originalShadowMode;
    }
  });

  it('falls back group turns from edge to container without duplicating output', async () => {
    vi.resetModules();

    const db = await import('./db.js');
    const index = await import('./index.js');

    db._initTestDatabase();
    index._setRegisteredGroups({});
    index._setChannelsForTests([]);
    index._setSessionsForTests({});
    index._setLastAgentTimestampForTests({});

    const sendMessage = vi.fn(async () => {});
    const setTyping = vi.fn(async () => {});
    const channel: Channel = {
      name: 'test',
      connect: async () => {},
      disconnect: async () => {},
      isConnected: () => true,
      ownsJid: (jid) => jid === 'room@g.us',
      sendMessage,
      setTyping,
    };

    index._setChannelsForTests([channel]);
    index._setRegisteredGroups({
      'room@g.us': {
        name: 'Team Alpha',
        folder: 'team_alpha',
        trigger: '@Andy',
        added_at: '2026-04-07T00:00:00.000Z',
        executionMode: 'auto',
        requiresTrigger: false,
      },
    });
    index._setSessionsForTests({ team_alpha: 'session-edge-1' });

    db.storeChatMetadata(
      'room@g.us',
      '2026-04-07T00:00:01.000Z',
      'Team Alpha',
      'whatsapp',
      true,
    );
    db.storeMessageDirect({
      id: 'msg-1',
      chat_jid: 'room@g.us',
      sender: 'alice',
      sender_name: 'Alice',
      content: 'please summarize this',
      timestamp: '2026-04-07T00:00:01.000Z',
      is_from_me: false,
    });

    edgeBackendRun.mockResolvedValueOnce({
      status: 'error',
      result: null,
      error: 'Edge execution exceeded deadline of 100ms.',
    });
    containerBackendRun.mockImplementationOnce(
      async (_group, input, onExecutionStarted, onOutput) => {
        expect(input.sessionId).toBe('session-edge-1');
        expect(input.executionContext.workerClass).toBe('heavy');
        await onExecutionStarted?.({
          chatJid: 'room@g.us',
          process: {} as any,
          executionName: 'nanoclaw-fallback',
          groupFolder: 'team_alpha',
        });
        await onOutput?.({
          status: 'success',
          result: 'heavy fallback result',
          newSessionId: 'session-heavy-2',
        });
        return {
          status: 'success',
          result: 'heavy fallback result',
          newSessionId: 'session-heavy-2',
        };
      },
    );

    const processed = await index._processGroupMessagesForTests('room@g.us');

    expect(processed).toBe(true);
    expect(edgeBackendRun).toHaveBeenCalledTimes(1);
    expect(containerBackendRun).toHaveBeenCalledTimes(1);
    expect(edgeBackendRun.mock.calls[0]?.[1]).toMatchObject({
      sessionId: 'session-edge-1',
      chatJid: 'room@g.us',
    });
    expect(sendMessage).toHaveBeenCalledTimes(1);
    expect(sendMessage).toHaveBeenCalledWith(
      'room@g.us',
      'heavy fallback result',
    );
    expect(setTyping).toHaveBeenNthCalledWith(1, 'room@g.us', true);
    expect(setTyping).toHaveBeenNthCalledWith(2, 'room@g.us', false);

    const executions = db.listExecutionStates();
    expect(executions).toHaveLength(2);
    expect(executions[0]).toMatchObject({
      backend: 'edge',
      status: 'failed',
      error: 'Edge execution exceeded deadline of 100ms.',
    });
    expect(executions[1]).toMatchObject({
      backend: 'container',
      status: 'completed',
      error: null,
    });

    const graph = db.getTaskGraph(`graph:${executions[0]!.turnId}`);
    expect(graph).toMatchObject({
      requestKind: 'group_turn',
      scopeType: 'group',
      scopeId: 'team_alpha',
      status: 'completed',
    });
    expect(db.getTaskNode(graph!.rootTaskId)).toMatchObject({
      graphId: graph!.graphId,
      status: 'completed',
      workerClass: 'heavy',
      backendId: 'container',
      fallbackTarget: 'heavy',
      fallbackReason: 'edge_timeout',
    });
    expect(db.listExecutionStatesForTaskNode(graph!.rootTaskId)).toMatchObject([
      { backend: 'edge', status: 'failed' },
      { backend: 'container', status: 'completed' },
    ]);

    expect(db.getAllSessions()).toEqual({ team_alpha: 'session-heavy-2' });
    expect(db.getLogicalSession('group', 'team_alpha')).toMatchObject({
      id: 'group:team_alpha',
      providerSessionId: 'session-heavy-2',
      lastTurnId: executions[1]!.turnId,
      status: 'active',
    });

    const secondProcessed =
      await index._processGroupMessagesForTests('room@g.us');
    expect(secondProcessed).toBe(true);
    expect(edgeBackendRun).toHaveBeenCalledTimes(1);
    expect(containerBackendRun).toHaveBeenCalledTimes(1);
    expect(sendMessage).toHaveBeenCalledTimes(1);
  });

  it('falls back edge-pinned group turns to container on edge timeout', async () => {
    vi.resetModules();

    const db = await import('./db.js');
    const index = await import('./index.js');

    db._initTestDatabase();
    index._setRegisteredGroups({});
    index._setChannelsForTests([]);
    index._setSessionsForTests({});
    index._setLastAgentTimestampForTests({});

    const sendMessage = vi.fn(async () => {});
    const setTyping = vi.fn(async () => {});
    const channel: Channel = {
      name: 'test',
      connect: async () => {},
      disconnect: async () => {},
      isConnected: () => true,
      ownsJid: (jid) => jid === 'room@g.us',
      sendMessage,
      setTyping,
    };

    index._setChannelsForTests([channel]);
    index._setRegisteredGroups({
      'room@g.us': {
        name: 'Team Edge',
        folder: 'team_edge',
        trigger: '@Andy',
        added_at: '2026-04-07T00:00:00.000Z',
        executionMode: 'edge',
        requiresTrigger: false,
      },
    });

    db.storeChatMetadata(
      'room@g.us',
      '2026-04-07T00:00:01.000Z',
      'Team Edge',
      'whatsapp',
      true,
    );
    db.storeMessageDirect({
      id: 'msg-edge-fallback',
      chat_jid: 'room@g.us',
      sender: 'alice',
      sender_name: 'Alice',
      content: 'hello there',
      timestamp: '2026-04-07T00:00:01.000Z',
      is_from_me: false,
    });

    edgeBackendRun.mockResolvedValueOnce({
      status: 'error',
      result: null,
      error: 'Edge runner produced no progress within 30000ms.',
    });
    containerBackendRun.mockResolvedValueOnce({
      status: 'success',
      result: 'heavy hello',
      newSessionId: 'session-heavy-edge',
    });

    const processed = await index._processGroupMessagesForTests('room@g.us');

    expect(processed).toBe(true);
    expect(edgeBackendRun).toHaveBeenCalledTimes(1);
    expect(containerBackendRun).toHaveBeenCalledTimes(1);
    expect(sendMessage).toHaveBeenCalledWith('room@g.us', 'heavy hello');
  });

  it('marks workspace conflicts for replan and closes the failed edge attempt', async () => {
    vi.resetModules();

    const db = await import('./db.js');
    const index = await import('./index.js');

    db._initTestDatabase();
    index._setRegisteredGroups({});
    index._setChannelsForTests([]);
    index._setSessionsForTests({});
    index._setLastAgentTimestampForTests({});

    const sendMessage = vi.fn(async () => {});
    const channel: Channel = {
      name: 'test',
      connect: async () => {},
      disconnect: async () => {},
      isConnected: () => true,
      ownsJid: (jid) => jid === 'room@g.us',
      sendMessage,
      setTyping: vi.fn(async () => {}),
    };

    index._setChannelsForTests([channel]);
    index._setRegisteredGroups({
      'room@g.us': {
        name: 'Team Alpha',
        folder: 'team_alpha',
        trigger: '@Andy',
        added_at: '2026-04-07T00:00:00.000Z',
        executionMode: 'auto',
        requiresTrigger: false,
      },
    });

    db.storeChatMetadata(
      'room@g.us',
      '2026-04-07T00:00:02.000Z',
      'Team Alpha',
      'whatsapp',
      true,
    );
    db.storeMessageDirect({
      id: 'msg-conflict',
      chat_jid: 'room@g.us',
      sender: 'alice',
      sender_name: 'Alice',
      content: 'please update the workspace',
      timestamp: '2026-04-07T00:00:02.000Z',
      is_from_me: false,
    });

    const conflictError = 'Workspace version conflict: expected a, received b';
    edgeBackendRun.mockResolvedValueOnce({
      status: 'error',
      result: null,
      error: conflictError,
    });

    const processed = await index._processGroupMessagesForTests('room@g.us');

    expect(processed).toBe(false);
    expect(edgeBackendRun).toHaveBeenCalledTimes(1);
    expect(containerBackendRun).not.toHaveBeenCalled();
    expect(sendMessage).not.toHaveBeenCalled();

    const executions = db.listExecutionStates();
    expect(executions).toHaveLength(1);
    expect(executions[0]).toMatchObject({
      backend: 'edge',
      status: 'failed',
      error: conflictError,
    });

    const graph = db.getTaskGraph(`graph:${executions[0]!.turnId}`);
    expect(graph).toMatchObject({
      requestKind: 'group_turn',
      status: 'failed',
      error: conflictError,
    });
    expect(db.getTaskNode(graph!.rootTaskId)).toMatchObject({
      status: 'failed',
      failureClass: 'commit_failure',
      fallbackTarget: 'replan',
      fallbackReason: 'state_conflict_requires_heavy',
      error: conflictError,
    });
    expect(syncObservabilitySnapshotToIpc).toHaveBeenCalledWith('team_alpha');
  });

  it('writes observability snapshots after successful edge group turns', async () => {
    vi.resetModules();

    const db = await import('./db.js');
    const index = await import('./index.js');

    db._initTestDatabase();
    index._setRegisteredGroups({});
    index._setChannelsForTests([]);
    index._setSessionsForTests({});
    index._setLastAgentTimestampForTests({});

    const sendMessage = vi.fn(async () => {});
    const channel: Channel = {
      name: 'test',
      connect: async () => {},
      disconnect: async () => {},
      isConnected: () => true,
      ownsJid: (jid) => jid === 'room@g.us',
      sendMessage,
      setTyping: vi.fn(async () => {}),
    };

    index._setChannelsForTests([channel]);
    index._setRegisteredGroups({
      'room@g.us': {
        name: 'Team Alpha',
        folder: 'team_alpha',
        trigger: '@Andy',
        added_at: '2026-04-07T00:00:00.000Z',
        executionMode: 'edge',
        requiresTrigger: false,
      },
    });

    db.storeChatMetadata(
      'room@g.us',
      '2026-04-07T00:00:03.000Z',
      'Team Alpha',
      'whatsapp',
      true,
    );
    db.storeMessageDirect({
      id: 'msg-success',
      chat_jid: 'room@g.us',
      sender: 'alice',
      sender_name: 'Alice',
      content: 'please summarize this',
      timestamp: '2026-04-07T00:00:03.000Z',
      is_from_me: false,
    });

    edgeBackendRun.mockResolvedValueOnce({
      status: 'success',
      result: 'edge result',
      newSessionId: 'session-edge-2',
    });

    const processed = await index._processGroupMessagesForTests('room@g.us');

    expect(processed).toBe(true);
    expect(sendMessage).toHaveBeenCalledWith('room@g.us', 'edge result');
    expect(syncObservabilitySnapshotToIpc).toHaveBeenCalledWith('team_alpha');
  });

  it('cleans up terminal runtime on startup reset without affecting other groups', async () => {
    vi.resetModules();

    const db = await import('./db.js');
    const index = await import('./index.js');
    const { createRootTaskGraph, markTaskNodeRunning } = await import(
      './task-graph-state.js'
    );
    const { beginExecution } = await import('./execution-state.js');

    db._initTestDatabase();
    index._setRegisteredGroups({});
    index._setChannelsForTests([]);
    index._setSessionsForTests({
      terminal_canary: 'session-terminal-old',
      team_alpha: 'session-team-old',
    });
    index._setLastAgentTimestampForTests({});

    db.setSession('terminal_canary', 'session-terminal-old');
    db.setSession('team_alpha', 'session-team-old');

    createRootTaskGraph({
      graphId: 'graph:terminal-stale',
      rootTaskId: 'task:terminal-stale:root',
      requestKind: 'group_turn',
      scopeType: 'group',
      scopeId: 'terminal_canary',
      groupFolder: 'terminal_canary',
      chatJid: 'term:canary-group',
      logicalSessionId: 'group:terminal_canary',
      workerClass: 'edge',
      backendId: 'edge',
      now: new Date('2026-04-08T00:00:00.000Z'),
    });
    markTaskNodeRunning('graph:terminal-stale', 'task:terminal-stale:root');

    createRootTaskGraph({
      graphId: 'graph:other-running',
      rootTaskId: 'task:other-running:root',
      requestKind: 'group_turn',
      scopeType: 'group',
      scopeId: 'team_alpha',
      groupFolder: 'team_alpha',
      chatJid: 'room@g.us',
      logicalSessionId: 'group:team_alpha',
      workerClass: 'edge',
      backendId: 'edge',
      now: new Date('2026-04-08T00:00:01.000Z'),
    });
    markTaskNodeRunning('graph:other-running', 'task:other-running:root');

    const terminalExecution = beginExecution({
      scopeType: 'group',
      scopeId: 'terminal_canary',
      backend: 'edge',
      groupJid: 'term:canary-group',
      taskNodeId: 'task:terminal-stale:root',
      now: new Date('2026-04-08T00:00:00.000Z'),
      leaseMs: 300_000,
    });
    const otherExecution = beginExecution({
      scopeType: 'group',
      scopeId: 'team_alpha',
      backend: 'edge',
      groupJid: 'room@g.us',
      taskNodeId: 'task:other-running:root',
      now: new Date('2026-04-08T00:00:01.000Z'),
      leaseMs: 300_000,
    });

    index._cleanupTerminalRuntimeForTests('startup');

    expect(db.getSession('terminal_canary')).toBeUndefined();
    expect(db.getSession('team_alpha')).toBe('session-team-old');

    expect(db.getExecutionState(terminalExecution.executionId)).toMatchObject({
      status: 'failed',
      error: 'Terminal session reset on startup',
    });
    expect(db.getTaskGraph('graph:terminal-stale')).toMatchObject({
      status: 'failed',
      error: 'Terminal session reset on startup',
    });
    expect(db.getTaskNode('task:terminal-stale:root')).toMatchObject({
      status: 'failed',
      error: 'Terminal session reset on startup',
    });

    expect(db.getExecutionState(otherExecution.executionId)).toMatchObject({
      status: 'running',
    });
    expect(db.getTaskGraph('graph:other-running')).toMatchObject({
      status: 'running',
    });
  });
});
