import { deleteTask, getTaskById } from './db.js';
import { requestTaskExecutionsCancel } from './execution-state.js';
import { logger } from './logger.js';

export interface TaskRuntimeCancelTarget {
  taskId: string;
  chatJid: string;
  groupFolder: string;
}

export interface TaskRuntimeController {
  cancelTask(target: TaskRuntimeCancelTarget): void;
}

let taskRuntimeController: TaskRuntimeController | null = null;

export function registerTaskRuntimeController(
  controller: TaskRuntimeController | null,
): void {
  taskRuntimeController = controller;
}

export function deleteScheduledTask(taskId: string): {
  deleted: boolean;
  cancelledExecutionIds: string[];
} {
  const task = getTaskById(taskId);
  if (!task) {
    return { deleted: false, cancelledExecutionIds: [] };
  }

  const cancelledExecutionIds = requestTaskExecutionsCancel(taskId);
  taskRuntimeController?.cancelTask({
    taskId: task.id,
    chatJid: task.chat_jid,
    groupFolder: task.group_folder,
  });

  deleteTask(taskId);
  logger.info(
    { taskId, cancelledExecutionIds },
    'Deleted scheduled task and requested runtime cancellation',
  );
  return { deleted: true, cancelledExecutionIds };
}
