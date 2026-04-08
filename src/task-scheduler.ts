import { CronExpressionParser } from 'cron-parser';
import fs from 'fs';

import {
  AgentBackend,
  AgentRunOutput,
  ExecutionStartedCallback,
  StartedExecution,
} from './agent-backend.js';
import {
  ASSISTANT_NAME,
  DEFAULT_EXECUTION_MODE,
  SCHEDULER_POLL_INTERVAL,
  SHADOW_EXECUTION_MODE,
  TIMEZONE,
} from './config.js';
import {
  syncObservabilitySnapshotToIpc,
  writeTasksSnapshotToIpc,
} from './container-snapshot-writer.js';
import {
  getAllTasks,
  getDueTasks,
  getTaskById,
  logTaskRun,
  setSession,
  updateLogicalSession,
  updateTask,
  updateTaskAfterRun,
} from './db.js';
import {
  commitExecution,
  completeExecution,
  failExecution,
  heartbeatExecution,
  markExpiredExecutionsLost,
  requestExecutionCancel,
} from './execution-state.js';
import { buildTaskSnapshots } from './execution-snapshots.js';
import { type AgentBackendId, type ExecutionMode } from './execution-mode.js';
import { createFrameworkRunContext } from './framework-orchestrator.js';
import {
  classifyRuntimeRecovery,
  markTaskNodeForReplan,
  prepareHeavyFallbackExecution,
} from './framework-recovery.js';
import { GroupQueue } from './group-queue.js';
import { resolveGroupFolderPath } from './group-folder.js';
import { logger } from './logger.js';

function summarizeRuntimeError(error: string | null | undefined): string {
  const normalized = typeof error === 'string' ? error.trim() : '';
  if (!normalized) return 'Unknown error';
  const singleLine = normalized.replace(/\s+/g, ' ');
  return singleLine.length <= 200
    ? singleLine
    : `${singleLine.slice(0, 200)}...`;
}
import {
  runShadowExecutionComparison,
  selectShadowExecution,
} from './shadow-execution.js';
import {
  completeRootTaskGraph,
  failRootTaskGraph,
} from './task-graph-state.js';
import { registerTaskRuntimeController } from './task-control.js';
import { RegisteredGroup, ScheduledTask } from './types.js';
import { emitTerminalSystemEvent } from './channels/terminal.js';

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

function shouldSurfaceScheduledTaskOutput(
  text: string | null | undefined,
): text is string {
  if (typeof text !== 'string') return false;
  const normalized = text.trim();
  if (!normalized) return false;
  if (normalized.startsWith('正在调用工具：')) return false;
  return true;
}

async function runTask(
  task: ScheduledTask,
  deps: SchedulerDependencies,
): Promise<void> {
  const startTime = Date.now();
  const currentTask = getTaskById(task.id);
  if (!currentTask || currentTask.status !== 'active') {
    logger.info(
      {
        taskId: task.id,
        exists: Boolean(currentTask),
        status: currentTask?.status ?? 'deleted',
      },
      'Skipping scheduled task because it is no longer runnable',
    );
    return;
  }

  task = currentTask;
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
    {
      taskId: task.id,
      group: task.group_folder,
      status: 'running',
      scheduleValue: task.schedule_value,
      nextRun: task.next_run,
    },
    'Running scheduled task',
  );
  emitTerminalSystemEvent(task.chat_jid, `任务开始：${task.id}`);

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
  const scopeType = task.context_mode === 'group' ? 'group' : 'task';
  const scopeId = task.context_mode === 'group' ? task.group_folder : task.id;
  const frameworkRun = createFrameworkRunContext({
    requestKind: 'scheduled_task',
    group,
    input: {
      prompt: task.prompt,
      script: task.script || undefined,
      chatJid: task.chat_jid,
    },
    defaultExecutionMode: deps.defaultExecutionMode,
    executionScope: {
      scopeType,
      scopeId,
      groupJid: task.chat_jid,
      taskId: task.id,
    },
  });
  const {
    placement,
    graph,
    execution,
    executionContext,
    baseWorkspaceVersion,
  } = frameworkRun;
  const usesHeavyWorker = placement.workerClass === 'heavy';
  const backend = deps.backends[placement.backendId];

  if (usesHeavyWorker) {
    writeTasksSnapshotToIpc(
      task.group_folder,
      buildTaskSnapshots(getAllTasks(), task.group_folder, isMain),
    );
    syncObservabilitySnapshotToIpc(task.group_folder);
  }

  logger.debug(
    {
      taskId: task.id,
      graphId: graph.graphId,
      rootTaskId: graph.rootTaskId,
      executionMode: placement.executionMode,
      backendId: placement.backendId,
      workerClass: placement.workerClass,
      routeReason: placement.routeReason,
      requiredCapabilities: placement.requiredCapabilities,
      fallbackEligible: placement.fallbackEligible,
      fallbackReason: placement.fallbackReason,
    },
    'Selected backend for scheduled task',
  );

  let result: string | null = null;
  let error: string | null = null;
  let executionId: string | null = null;
  let streamedError: string | null = null;
  let latestSuccessfulOutput: string | null = null;
  let sentVisibleMessage = false;

  // Keep current behavior: only group-context tasks resume the group's
  // provider session; isolated tasks still execute as single-turn runs.
  const sessions = deps.getSessions();
  const sessionId =
    task.context_mode === 'group' ? sessions[task.group_folder] : undefined;

  // After the task produces a result, close the container promptly.
  // Tasks are single-turn — no need to wait IDLE_TIMEOUT (30 min) for the
  // query loop to time out. A short delay handles any final MCP calls.
  const TASK_CLOSE_DELAY_MS = 10000;
  let closeTimer: ReturnType<typeof setTimeout> | null = null;
  let taskDeletedDuringRun = false;

  const refreshTaskState = () => getTaskById(task.id);
  const markDeletedDuringRun = () => {
    const latestTask = refreshTaskState();
    if (latestTask) return false;
    taskDeletedDuringRun = true;
    if (executionId) {
      requestExecutionCancel(executionId);
    }
    if (usesHeavyWorker) {
      deps.queue.closeStdin(task.chat_jid, 'background');
    }
    return true;
  };

  const scheduleClose = () => {
    if (!usesHeavyWorker) return;
    if (closeTimer) return; // already scheduled
    closeTimer = setTimeout(() => {
      logger.debug({ taskId: task.id }, 'Closing heavy worker after result');
      deps.queue.closeStdin(task.chat_jid, 'background');
    }, TASK_CLOSE_DELAY_MS);
  };

  try {
    executionId = execution.executionId;
    let effectiveExecutionId = execution.executionId;
    let effectiveBackendId = placement.backendId;

    const onScheduledExecutionStarted = usesHeavyWorker
      ? (execution: StartedExecution) => {
          deps.queue.registerProcess(
            execution.chatJid,
            execution.process,
            execution.executionName,
            execution.groupFolder,
            'background',
          );
          deps.onExecutionStarted?.(execution);
        }
      : undefined;

    let output = await backend.run(
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
        executionContext,
      },
      onScheduledExecutionStarted,
      async (streamedOutput: AgentRunOutput) => {
        if (markDeletedDuringRun()) {
          return;
        }
        if (executionId) heartbeatExecution(executionId);
        if (streamedOutput.newSessionId) {
          if (task.context_mode === 'group') {
            sessions[task.group_folder] = streamedOutput.newSessionId;
            setSession(task.group_folder, streamedOutput.newSessionId);
          } else {
            updateLogicalSession(execution.logicalSessionId, {
              providerSessionId: streamedOutput.newSessionId,
              status: 'active',
            });
          }
        }
        if (streamedOutput.status === 'error') {
          streamedError = streamedOutput.error || 'Unknown error';
        }
        if (shouldSurfaceScheduledTaskOutput(streamedOutput.result)) {
          result = streamedOutput.result;
          latestSuccessfulOutput = streamedOutput.result;
          scheduleClose();
        }
        if (usesHeavyWorker && streamedOutput.status === 'success') {
          deps.queue.notifyIdle(task.chat_jid, 'background');
          scheduleClose(); // Close promptly even when result is null (e.g. IPC-only tasks)
        }
      },
    );

    const recovery = classifyRuntimeRecovery({
      error: streamedError || output.error || '',
      workerClass: placement.workerClass,
      fallbackEligible: placement.fallbackEligible,
    });

    if (recovery.kind === 'fallback' && executionId) {
      const rawError = streamedError || output.error || 'Unknown error';
      failExecution(
        executionId,
        rawError,
      );
      emitTerminalSystemEvent(
        task.chat_jid,
        `执行降级：${graph.graphId} · edge → heavy · ${recovery.reason} · ${summarizeRuntimeError(rawError)}`,
      );

      const fallback = prepareHeavyFallbackExecution({
        scope: {
          scopeType,
          scopeId,
          groupJid: task.chat_jid,
          taskId: task.id,
        },
        taskNodeId: graph.rootTaskId,
        baseWorkspaceVersion,
        previousContext: executionContext,
        reason: recovery.reason,
      });

      executionId = fallback.execution.executionId;
      effectiveExecutionId = fallback.execution.executionId;
      effectiveBackendId = 'container';
      streamedError = null;
      result = null;
      latestSuccessfulOutput = null;

      output = await deps.backends.container.run(
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
          executionContext: fallback.executionContext,
        },
        (execution) => {
          deps.queue.registerProcess(
            execution.chatJid,
            execution.process,
            execution.executionName,
            execution.groupFolder,
            'background',
          );
          deps.onExecutionStarted?.(execution);
        },
        async (streamedOutput: AgentRunOutput) => {
          if (markDeletedDuringRun()) {
            return;
          }
          if (executionId) heartbeatExecution(executionId);
          if (streamedOutput.newSessionId) {
            if (task.context_mode === 'group') {
              sessions[task.group_folder] = streamedOutput.newSessionId;
              setSession(task.group_folder, streamedOutput.newSessionId);
            } else {
              updateLogicalSession(fallback.execution.logicalSessionId, {
                providerSessionId: streamedOutput.newSessionId,
                status: 'active',
              });
            }
          }
          if (streamedOutput.status === 'error') {
            streamedError = streamedOutput.error || 'Unknown error';
          }
          if (shouldSurfaceScheduledTaskOutput(streamedOutput.result)) {
            result = streamedOutput.result;
            latestSuccessfulOutput = streamedOutput.result;
            scheduleClose();
          }
          deps.queue.notifyIdle(task.chat_jid, 'background');
          scheduleClose();
        },
      );
    }

    if (closeTimer) clearTimeout(closeTimer);
    if (markDeletedDuringRun()) {
      error = 'Task deleted before completion.';
    }

    if (!taskDeletedDuringRun && output.newSessionId) {
      if (task.context_mode === 'group') {
        sessions[task.group_folder] = output.newSessionId;
        setSession(task.group_folder, output.newSessionId);
      } else {
        updateLogicalSession(execution.logicalSessionId, {
          providerSessionId: output.newSessionId,
          status: 'active',
        });
      }
    }

    if (!taskDeletedDuringRun) {
      await runShadowExecutionComparison({
        selection: selectShadowExecution(
          effectiveBackendId,
          { prompt: task.prompt, script: task.script || undefined },
          SHADOW_EXECUTION_MODE,
        ),
        backends: deps.backends,
        group,
        input: {
          prompt: task.prompt,
          sessionId,
          groupFolder: task.group_folder,
          chatJid: task.chat_jid,
          isMain,
          isScheduledTask: true,
          assistantName: ASSISTANT_NAME,
          script: task.script || undefined,
        },
        primaryBackendId: effectiveBackendId,
        primaryOutput: output,
        scope: 'task',
        scopeId: task.id,
        fallbackReason: placement.fallbackReason,
      });
    }

    error = streamedError || output.error || error;
    if (output.status === 'error') {
      error = error || 'Unknown error';
    } else if (
      !taskDeletedDuringRun &&
      shouldSurfaceScheduledTaskOutput(output.result)
    ) {
      // Result was already forwarded to the user via the streaming callback above
      result = output.result;
    }

    if (error) {
      const finalRecovery = classifyRuntimeRecovery({
        error,
        workerClass: effectiveBackendId === 'container' ? 'heavy' : 'edge',
        fallbackEligible: false,
      });

      failExecution(effectiveExecutionId, error);
      if (finalRecovery.kind === 'replan') {
        markTaskNodeForReplan(graph.rootTaskId, finalRecovery.reason);
      }
      failRootTaskGraph(graph.graphId, graph.rootTaskId, error);
    } else {
      commitExecution(effectiveExecutionId);
      completeExecution(effectiveExecutionId);
      completeRootTaskGraph(graph.graphId, graph.rootTaskId);
      if (!taskDeletedDuringRun && (output.result || latestSuccessfulOutput)) {
        sentVisibleMessage = true;
        await deps.sendMessage(
          task.chat_jid,
          output.result || latestSuccessfulOutput!,
        );
      }
    }

    logger.info(
      {
        taskId: task.id,
        durationMs: Date.now() - startTime,
        status: error ? 'error' : 'completed',
      },
      'Task completed',
    );
  } catch (err) {
    if (closeTimer) clearTimeout(closeTimer);
    error = err instanceof Error ? err.message : String(err);
    const recovery = classifyRuntimeRecovery({
      error,
      workerClass: placement.workerClass,
      fallbackEligible: placement.fallbackEligible,
    });
    if (executionId) failExecution(executionId, error);
    if (recovery.kind === 'replan') {
      markTaskNodeForReplan(graph.rootTaskId, recovery.reason);
    }
    failRootTaskGraph(graph.graphId, graph.rootTaskId, error);
    logger.error({ taskId: task.id, error }, 'Task failed');
  }

  const latestTask = getTaskById(task.id);
  if (!latestTask) {
    logger.info(
      {
        taskId: task.id,
        durationMs: Date.now() - startTime,
        status: 'deleted',
      },
      'Skipping task finalization because task was deleted during execution',
    );
    return;
  }

  if (error) {
    emitTerminalSystemEvent(task.chat_jid, `任务失败：${task.id}`);
  } else if (!sentVisibleMessage) {
    emitTerminalSystemEvent(task.chat_jid, `任务完成：${task.id}`);
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

  const nextRun = computeNextRun(latestTask);
  const resultSummary = error
    ? `Error: ${error}`
    : result
      ? result.slice(0, 200)
      : 'Completed';
  updateTaskAfterRun(task.id, nextRun, resultSummary);
  syncObservabilitySnapshotToIpc(task.group_folder);
}
let schedulerRunning = false;

export function startSchedulerLoop(deps: SchedulerDependencies): void {
  if (schedulerRunning) {
    logger.debug('Scheduler loop already running, skipping duplicate start');
    return;
  }
  schedulerRunning = true;
  logger.info('Scheduler loop started');
  registerTaskRuntimeController({
    cancelTask: ({ chatJid, taskId }) => {
      deps.queue.cancelTask?.(chatJid, taskId);
    },
  });

  const effectiveDefaultExecutionMode =
    deps.defaultExecutionMode || DEFAULT_EXECUTION_MODE;

  const loop = async () => {
    try {
      markExpiredExecutionsLost();
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
        if (
          typeof deps.queue.hasForegroundWork === 'function' &&
          deps.queue.hasForegroundWork(currentTask.chat_jid)
        ) {
          logger.debug(
            { taskId: currentTask.id, groupJid: currentTask.chat_jid },
            'Deferring scheduled task because foreground work is pending',
          );
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
  registerTaskRuntimeController(null);
}
