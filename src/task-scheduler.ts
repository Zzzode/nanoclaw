import { CronExpressionParser } from 'cron-parser';
import fs from 'fs';

import {
  AgentBackend,
  AgentRunOutput,
  ExecutionStartedCallback,
} from './agent-backend.js';
import { selectAgentBackend } from './backend-selection.js';
import {
  ASSISTANT_NAME,
  DEFAULT_EXECUTION_MODE,
  SCHEDULER_POLL_INTERVAL,
  TIMEZONE,
} from './config.js';
import { writeTasksSnapshotToIpc } from './container-snapshot-writer.js';
import {
  getAllTasks,
  getDueTasks,
  getTaskById,
  logTaskRun,
  setSession,
  updateTask,
  updateTaskAfterRun,
} from './db.js';
import {
  beginExecution,
  commitExecution,
  completeExecution,
  failExecution,
  heartbeatExecution,
} from './execution-state.js';
import { buildTaskSnapshots } from './execution-snapshots.js';
import { type AgentBackendId, type ExecutionMode } from './execution-mode.js';
import { GroupQueue } from './group-queue.js';
import { resolveGroupFolderPath } from './group-folder.js';
import { logger } from './logger.js';
import { RegisteredGroup, ScheduledTask } from './types.js';

/**
 * Compute the next run time for a recurring task, anchored to the
 * task's scheduled time rather than Date.now() to prevent cumulative
 * drift on interval-based tasks.
 *
 * Co-authored-by: @community-pr-601
 */
export function computeNextRun(task: ScheduledTask): string | null {
  if (task.schedule_type === 'once') return null;

  const now = Date.now();

  if (task.schedule_type === 'cron') {
    const interval = CronExpressionParser.parse(task.schedule_value, {
      tz: TIMEZONE,
    });
    return interval.next().toISOString();
  }

  if (task.schedule_type === 'interval') {
    const ms = parseInt(task.schedule_value, 10);
    if (!ms || ms <= 0) {
      // Guard against malformed interval that would cause an infinite loop
      logger.warn(
        { taskId: task.id, value: task.schedule_value },
        'Invalid interval value',
      );
      return new Date(now + 60_000).toISOString();
    }
    // Anchor to the scheduled time, not now, to prevent drift.
    // Skip past any missed intervals so we always land in the future.
    let next = new Date(task.next_run!).getTime() + ms;
    while (next <= now) {
      next += ms;
    }
    return new Date(next).toISOString();
  }

  return null;
}

export interface SchedulerDependencies {
  backends: Record<AgentBackendId, AgentBackend>;
  defaultExecutionMode: ExecutionMode;
  registeredGroups: () => Record<string, RegisteredGroup>;
  getSessions: () => Record<string, string>;
  queue: GroupQueue;
  onExecutionStarted?: ExecutionStartedCallback;
  sendMessage: (jid: string, text: string) => Promise<void>;
}

async function runTask(
  task: ScheduledTask,
  deps: SchedulerDependencies,
): Promise<void> {
  const startTime = Date.now();
  let groupDir: string;
  try {
    groupDir = resolveGroupFolderPath(task.group_folder);
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    // Stop retry churn for malformed legacy rows.
    updateTask(task.id, { status: 'paused' });
    logger.error(
      { taskId: task.id, groupFolder: task.group_folder, error },
      'Task has invalid group folder',
    );
    logTaskRun({
      task_id: task.id,
      run_at: new Date().toISOString(),
      duration_ms: Date.now() - startTime,
      status: 'error',
      result: null,
      error,
    });
    return;
  }
  fs.mkdirSync(groupDir, { recursive: true });

  logger.info(
    { taskId: task.id, group: task.group_folder },
    'Running scheduled task',
  );

  const groups = deps.registeredGroups();
  const group = Object.values(groups).find(
    (g) => g.folder === task.group_folder,
  );

  if (!group) {
    logger.error(
      { taskId: task.id, groupFolder: task.group_folder },
      'Group not found for task',
    );
    logTaskRun({
      task_id: task.id,
      run_at: new Date().toISOString(),
      duration_ms: Date.now() - startTime,
      status: 'error',
      result: null,
      error: `Group not found: ${task.group_folder}`,
    });
    return;
  }

  const isMain = group.isMain === true;
  const selection = selectAgentBackend(
    group,
    { script: task.script || undefined },
    deps.defaultExecutionMode,
  );
  const usesContainer = selection.backendId === 'container';
  const backend = deps.backends[selection.backendId];

  if (usesContainer) {
    writeTasksSnapshotToIpc(
      task.group_folder,
      buildTaskSnapshots(getAllTasks(), task.group_folder, isMain),
    );
  }

  logger.debug(
    {
      taskId: task.id,
      executionMode: selection.executionMode,
      backendId: selection.backendId,
      fallbackReason: selection.fallbackReason,
    },
    'Selected backend for scheduled task',
  );

  let result: string | null = null;
  let error: string | null = null;
  let executionId: string | null = null;
  let streamedError: string | null = null;

  // Keep current behavior: only group-context tasks resume the group's
  // provider session; isolated tasks still execute as single-turn runs.
  const sessions = deps.getSessions();
  const sessionId =
    task.context_mode === 'group' ? sessions[task.group_folder] : undefined;
  const scopeType = task.context_mode === 'group' ? 'group' : 'task';
  const scopeId = task.context_mode === 'group' ? task.group_folder : task.id;

  // After the task produces a result, close the container promptly.
  // Tasks are single-turn — no need to wait IDLE_TIMEOUT (30 min) for the
  // query loop to time out. A short delay handles any final MCP calls.
  const TASK_CLOSE_DELAY_MS = 10000;
  let closeTimer: ReturnType<typeof setTimeout> | null = null;

  const scheduleClose = () => {
    if (!usesContainer) return;
    if (closeTimer) return; // already scheduled
    closeTimer = setTimeout(() => {
      logger.debug({ taskId: task.id }, 'Closing task container after result');
      deps.queue.closeStdin(task.chat_jid);
    }, TASK_CLOSE_DELAY_MS);
  };

  try {
    const execution = beginExecution({
      scopeType,
      scopeId,
      backend: selection.backendId,
      groupJid: task.chat_jid,
      taskId: task.id,
    });
    executionId = execution.executionId;

    const output = await backend.run(
      group,
      {
        prompt: task.prompt,
        sessionId,
        groupFolder: task.group_folder,
        chatJid: task.chat_jid,
        isMain,
        isScheduledTask: true,
        assistantName: ASSISTANT_NAME,
        script: task.script || undefined,
      },
      usesContainer ? deps.onExecutionStarted : undefined,
      async (streamedOutput: AgentRunOutput) => {
        if (executionId) heartbeatExecution(executionId);
        if (task.context_mode === 'group' && streamedOutput.newSessionId) {
          sessions[task.group_folder] = streamedOutput.newSessionId;
          setSession(task.group_folder, streamedOutput.newSessionId);
        }
        if (streamedOutput.status === 'error') {
          streamedError = streamedOutput.error || 'Unknown error';
        }
        if (streamedOutput.result) {
          result = streamedOutput.result;
          // Forward result to user (sendMessage handles formatting)
          await deps.sendMessage(task.chat_jid, streamedOutput.result);
          scheduleClose();
        }
        if (usesContainer && streamedOutput.status === 'success') {
          deps.queue.notifyIdle(task.chat_jid);
          scheduleClose(); // Close promptly even when result is null (e.g. IPC-only tasks)
        }
      },
    );

    if (closeTimer) clearTimeout(closeTimer);

    if (task.context_mode === 'group' && output.newSessionId) {
      sessions[task.group_folder] = output.newSessionId;
      setSession(task.group_folder, output.newSessionId);
    }

    error = streamedError || output.error || error;
    if (output.status === 'error') {
      error = error || 'Unknown error';
    } else if (output.result) {
      // Result was already forwarded to the user via the streaming callback above
      result = output.result;
    }

    if (error) {
      failExecution(executionId, error);
    } else {
      commitExecution(executionId);
      completeExecution(executionId);
    }

    logger.info(
      { taskId: task.id, durationMs: Date.now() - startTime },
      'Task completed',
    );
  } catch (err) {
    if (closeTimer) clearTimeout(closeTimer);
    error = err instanceof Error ? err.message : String(err);
    if (executionId) {
      failExecution(executionId, error);
    }
    logger.error({ taskId: task.id, error }, 'Task failed');
  }

  const durationMs = Date.now() - startTime;

  logTaskRun({
    task_id: task.id,
    run_at: new Date().toISOString(),
    duration_ms: durationMs,
    status: error ? 'error' : 'success',
    result,
    error,
  });

  const nextRun = computeNextRun(task);
  const resultSummary = error
    ? `Error: ${error}`
    : result
      ? result.slice(0, 200)
      : 'Completed';
  updateTaskAfterRun(task.id, nextRun, resultSummary);
}
let schedulerRunning = false;

export function startSchedulerLoop(deps: SchedulerDependencies): void {
  if (schedulerRunning) {
    logger.debug('Scheduler loop already running, skipping duplicate start');
    return;
  }
  schedulerRunning = true;
  logger.info('Scheduler loop started');

  const effectiveDefaultExecutionMode =
    deps.defaultExecutionMode || DEFAULT_EXECUTION_MODE;

  const loop = async () => {
    try {
      const dueTasks = getDueTasks();
      if (dueTasks.length > 0) {
        logger.info({ count: dueTasks.length }, 'Found due tasks');
      }

      for (const task of dueTasks) {
        // Re-check task status in case it was paused/cancelled
        const currentTask = getTaskById(task.id);
        if (!currentTask || currentTask.status !== 'active') {
          continue;
        }

        deps.queue.enqueueTask(currentTask.chat_jid, currentTask.id, () =>
          runTask(currentTask, {
            ...deps,
            defaultExecutionMode: effectiveDefaultExecutionMode,
          }),
        );
      }
    } catch (err) {
      logger.error({ err }, 'Error in scheduler loop');
    }

    setTimeout(loop, SCHEDULER_POLL_INTERVAL);
  };

  loop();
}

/** @internal - for tests only. */
export function _resetSchedulerLoopForTests(): void {
  schedulerRunning = false;
}
