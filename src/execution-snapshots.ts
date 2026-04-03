import { ScheduledTask } from './types.js';

export type TaskSnapshotSource = Pick<
  ScheduledTask,
  | 'id'
  | 'group_folder'
  | 'prompt'
  | 'script'
  | 'schedule_type'
  | 'schedule_value'
  | 'status'
  | 'next_run'
>;

export interface TaskSnapshot {
  id: string;
  groupFolder: string;
  prompt: string;
  script?: string | null;
  schedule_type: ScheduledTask['schedule_type'];
  schedule_value: string;
  status: ScheduledTask['status'];
  next_run: string | null;
}

export interface GroupSnapshot {
  jid: string;
  name: string;
  lastActivity: string;
  isRegistered: boolean;
}

export interface GroupsSnapshotPayload {
  groups: GroupSnapshot[];
  lastSync: string;
}

export interface PromptPackage {
  prompt: string;
  tasks: TaskSnapshot[];
  groups: GroupsSnapshotPayload;
}

export function buildTaskSnapshots(
  tasks: ReadonlyArray<TaskSnapshotSource>,
  groupFolder: string,
  isMain: boolean,
): TaskSnapshot[] {
  const visibleTasks = isMain
    ? tasks
    : tasks.filter((task) => task.group_folder === groupFolder);

  return visibleTasks.map((task) => {
    const snapshot: TaskSnapshot = {
      id: task.id,
      groupFolder: task.group_folder,
      prompt: task.prompt,
      schedule_type: task.schedule_type,
      schedule_value: task.schedule_value,
      status: task.status,
      next_run: task.next_run,
    };

    if (task.script) snapshot.script = task.script;

    return snapshot;
  });
}

export function buildGroupsSnapshotPayload(
  groups: ReadonlyArray<GroupSnapshot>,
  isMain: boolean,
  now: () => string = () => new Date().toISOString(),
): GroupsSnapshotPayload {
  return {
    groups: isMain ? [...groups] : [],
    lastSync: now(),
  };
}
