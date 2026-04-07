import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('fs', async () => {
  const actual = await vi.importActual<typeof import('fs')>('fs');
  return {
    ...actual,
    default: {
      ...actual,
      mkdirSync: vi.fn(),
      writeFileSync: vi.fn(),
    },
  };
});

vi.mock('./group-folder.js', () => ({
  resolveGroupIpcPath: vi.fn(
    (groupFolder: string) => `/tmp/nanoclaw-ipc/${groupFolder}`,
  ),
}));

import fs from 'fs';

import {
  writeGroupsSnapshotToIpc,
  writeObservabilitySnapshotToIpc,
  writeTasksSnapshotToIpc,
} from './container-snapshot-writer.js';
import { _initTestDatabase, createLogicalSession } from './db.js';
import {
  buildGroupsSnapshotPayload,
  buildTaskSnapshots,
  type GroupSnapshot,
  type TaskSnapshotSource,
} from './execution-snapshots.js';
import { beginExecution, failExecution } from './execution-state.js';
import { FRAMEWORK_POLICY_VERSION } from './framework-policy.js';
import { buildFrameworkObservabilitySnapshot } from './framework-observability.js';
import { resolveGroupIpcPath } from './group-folder.js';
import {
  createRootTaskGraph,
  failRootTaskGraph,
  requireReplanForTaskNode,
} from './task-graph-state.js';

describe('execution snapshots', () => {
  beforeEach(() => {
    _initTestDatabase();
    vi.mocked(fs.mkdirSync).mockClear();
    vi.mocked(fs.writeFileSync).mockClear();
    vi.mocked(resolveGroupIpcPath).mockClear();
  });

  it('returns all tasks for main groups', () => {
    const tasks: TaskSnapshotSource[] = [
      {
        id: 'task-alpha',
        group_folder: 'alpha',
        prompt: 'alpha prompt',
        script: null,
        schedule_type: 'once',
        schedule_value: '2026-04-03T00:00:00.000Z',
        status: 'active',
        next_run: '2026-04-03T00:00:00.000Z',
      },
      {
        id: 'task-beta',
        group_folder: 'beta',
        prompt: 'beta prompt',
        script: 'echo test',
        schedule_type: 'interval',
        schedule_value: '60000',
        status: 'paused',
        next_run: null,
      },
    ];

    expect(buildTaskSnapshots(tasks, 'alpha', true)).toEqual([
      {
        id: 'task-alpha',
        groupFolder: 'alpha',
        prompt: 'alpha prompt',
        schedule_type: 'once',
        schedule_value: '2026-04-03T00:00:00.000Z',
        status: 'active',
        next_run: '2026-04-03T00:00:00.000Z',
      },
      {
        id: 'task-beta',
        groupFolder: 'beta',
        prompt: 'beta prompt',
        script: 'echo test',
        schedule_type: 'interval',
        schedule_value: '60000',
        status: 'paused',
        next_run: null,
      },
    ]);
  });

  it('filters tasks to the current group for non-main groups', () => {
    const tasks: TaskSnapshotSource[] = [
      {
        id: 'task-alpha',
        group_folder: 'alpha',
        prompt: 'alpha prompt',
        script: null,
        schedule_type: 'once',
        schedule_value: '2026-04-03T00:00:00.000Z',
        status: 'active',
        next_run: '2026-04-03T00:00:00.000Z',
      },
      {
        id: 'task-beta',
        group_folder: 'beta',
        prompt: 'beta prompt',
        script: null,
        schedule_type: 'once',
        schedule_value: '2026-04-03T01:00:00.000Z',
        status: 'completed',
        next_run: null,
      },
    ];

    expect(buildTaskSnapshots(tasks, 'alpha', false)).toEqual([
      {
        id: 'task-alpha',
        groupFolder: 'alpha',
        prompt: 'alpha prompt',
        schedule_type: 'once',
        schedule_value: '2026-04-03T00:00:00.000Z',
        status: 'active',
        next_run: '2026-04-03T00:00:00.000Z',
      },
    ]);
  });

  it('builds a groups payload for main groups', () => {
    const groups: GroupSnapshot[] = [
      {
        jid: 'group@g.us',
        name: 'Group',
        lastActivity: '2026-04-03T00:00:00.000Z',
        isRegistered: true,
      },
    ];

    expect(
      buildGroupsSnapshotPayload(
        groups,
        true,
        () => '2026-04-03T02:00:00.000Z',
      ),
    ).toEqual({
      groups,
      lastSync: '2026-04-03T02:00:00.000Z',
    });
  });

  it('hides groups from non-main payloads', () => {
    const groups: GroupSnapshot[] = [
      {
        jid: 'group@g.us',
        name: 'Group',
        lastActivity: '2026-04-03T00:00:00.000Z',
        isRegistered: true,
      },
    ];

    expect(
      buildGroupsSnapshotPayload(
        groups,
        false,
        () => '2026-04-03T02:00:00.000Z',
      ),
    ).toEqual({
      groups: [],
      lastSync: '2026-04-03T02:00:00.000Z',
    });
  });

  it('writes task snapshots to the IPC tasks file', () => {
    const tasks = buildTaskSnapshots(
      [
        {
          id: 'task-alpha',
          group_folder: 'alpha',
          prompt: 'alpha prompt',
          script: null,
          schedule_type: 'once',
          schedule_value: '2026-04-03T00:00:00.000Z',
          status: 'active',
          next_run: '2026-04-03T00:00:00.000Z',
        },
      ],
      'alpha',
      false,
    );

    writeTasksSnapshotToIpc('alpha', tasks);

    expect(fs.mkdirSync).toHaveBeenCalledWith('/tmp/nanoclaw-ipc/alpha', {
      recursive: true,
    });
    expect(fs.writeFileSync).toHaveBeenCalledWith(
      '/tmp/nanoclaw-ipc/alpha/current_tasks.json',
      JSON.stringify(tasks, null, 2),
    );
  });

  it('writes group snapshots to the IPC groups file', () => {
    const payload = buildGroupsSnapshotPayload(
      [],
      false,
      () => '2026-04-03T02:00:00.000Z',
    );

    writeGroupsSnapshotToIpc('alpha', payload);

    expect(fs.mkdirSync).toHaveBeenCalledWith('/tmp/nanoclaw-ipc/alpha', {
      recursive: true,
    });
    expect(fs.writeFileSync).toHaveBeenCalledWith(
      '/tmp/nanoclaw-ipc/alpha/available_groups.json',
      JSON.stringify(payload, null, 2),
    );
  });

  it('writes observability snapshots with governance, routes, and executions', () => {
    createLogicalSession({
      id: 'task:obs-ipc',
      scopeType: 'task',
      scopeId: 'obs-ipc',
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
      graphId: 'graph:obs-ipc',
      rootTaskId: 'task:obs-ipc:root',
      requestKind: 'group_turn',
      scopeType: 'task',
      scopeId: 'obs-ipc',
      groupFolder: 'alpha',
      chatJid: 'alpha@g.us',
      logicalSessionId: 'task:obs-ipc',
      workerClass: 'edge',
      backendId: 'edge',
      requiredCapabilities: ['message.send'],
      routeReason: 'capability_match_edge',
      policyVersion: FRAMEWORK_POLICY_VERSION,
      fallbackEligible: true,
      now: new Date('2026-04-07T00:00:00.000Z'),
    });
    const execution = beginExecution({
      scopeType: 'task',
      scopeId: 'obs-ipc',
      backend: 'edge',
      taskId: 'obs-ipc',
      taskNodeId: 'task:obs-ipc:root',
      now: new Date('2026-04-07T00:00:00.000Z'),
    });
    failExecution(
      execution.executionId,
      'Workspace version conflict: expected a, received b',
      new Date('2026-04-07T00:00:01.000Z'),
    );
    requireReplanForTaskNode(
      'task:obs-ipc:root',
      'state_conflict_requires_heavy',
      new Date('2026-04-07T00:00:01.000Z'),
    );
    failRootTaskGraph(
      'graph:obs-ipc',
      'task:obs-ipc:root',
      'Workspace version conflict: expected a, received b',
      new Date('2026-04-07T00:00:02.000Z'),
    );

    const payload = buildFrameworkObservabilitySnapshot({
      groupFolder: 'alpha',
      now: new Date('2026-04-07T00:01:00.000Z'),
    });

    expect(payload).toMatchObject({
      scope: { kind: 'group', id: 'alpha' },
      governance: {
        totalGraphs: 1,
        totalExecutions: 1,
        edgeToHeavyFallbackRate: 0,
        commitConflictRate: 1,
      },
      routes: [
        expect.objectContaining({
          taskId: 'task:obs-ipc:root',
          fallbackTarget: 'replan',
          fallbackReason: 'state_conflict_requires_heavy',
        }),
      ],
      executions: [
        expect.objectContaining({
          backend: 'edge',
          status: 'failed',
          commitStatus: 'conflict',
        }),
      ],
    });

    writeObservabilitySnapshotToIpc('alpha', payload);

    expect(fs.writeFileSync).toHaveBeenCalledWith(
      '/tmp/nanoclaw-ipc/alpha/framework_observability.json',
      JSON.stringify(payload, null, 2),
    );
  });
});
