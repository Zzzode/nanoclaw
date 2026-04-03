import fs from 'fs';
import path from 'path';

import { GroupsSnapshotPayload, TaskSnapshot } from './execution-snapshots.js';
import { resolveGroupIpcPath } from './group-folder.js';

export function writeTasksSnapshotToIpc(
  groupFolder: string,
  tasks: ReadonlyArray<TaskSnapshot>,
): void {
  const groupIpcDir = resolveGroupIpcPath(groupFolder);
  fs.mkdirSync(groupIpcDir, { recursive: true });

  const tasksFile = path.join(groupIpcDir, 'current_tasks.json');
  fs.writeFileSync(tasksFile, JSON.stringify(tasks, null, 2));
}

export function writeGroupsSnapshotToIpc(
  groupFolder: string,
  payload: GroupsSnapshotPayload,
): void {
  const groupIpcDir = resolveGroupIpcPath(groupFolder);
  fs.mkdirSync(groupIpcDir, { recursive: true });

  const groupsFile = path.join(groupIpcDir, 'available_groups.json');
  fs.writeFileSync(groupsFile, JSON.stringify(payload, null, 2));
}
