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
  writeTasksSnapshotToIpc,
} from './container-snapshot-writer.js';
import {
  buildGroupsSnapshotPayload,
  buildTaskSnapshots,
  type GroupSnapshot,
  type TaskSnapshotSource,
} from './execution-snapshots.js';
import { resolveGroupIpcPath } from './group-folder.js';

describe('execution snapshots', () => {
  beforeEach(() => {
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
});
