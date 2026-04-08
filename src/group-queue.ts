import { ChildProcess } from 'child_process';
import fs from 'fs';
import path from 'path';

import { DATA_DIR, MAX_CONCURRENT_CONTAINERS } from './config.js';
import { logger } from './logger.js';
import { emitTerminalSystemEvent } from './channels/terminal.js';

interface QueuedTask {
  id: string;
  groupJid: string;
  fn: () => Promise<void>;
}

export type QueueLane = 'foreground' | 'background';

export interface ResetGroupQueueOptions {
  closeForeground?: boolean;
  closeBackground?: boolean;
  clearPendingMessages?: boolean;
  clearPendingTasks?: boolean;
}

const MAX_RETRIES = 5;
const BASE_RETRY_MS = 5000;

interface LaneState {
  active: boolean;
  idleWaiting: boolean;
  isTaskContainer: boolean;
  runningTaskId: string | null;
  retryScheduled: boolean;
  process: ChildProcess | null;
  containerName: string | null;
  groupFolder: string | null;
  retryCount: number;
}

interface GroupState {
  pendingMessages: boolean;
  pendingTasks: QueuedTask[];
  foreground: LaneState;
  background: LaneState;
}

export class GroupQueue {
  private groups = new Map<string, GroupState>();
  private activeCount = 0;
  private waitingGroups: Array<{ groupJid: string; lane: QueueLane }> = [];
  private processMessagesFn: ((groupJid: string) => Promise<boolean>) | null =
    null;
  private shuttingDown = false;

  private getGroup(groupJid: string): GroupState {
    let state = this.groups.get(groupJid);
    if (!state) {
      state = {
        pendingMessages: false,
        pendingTasks: [],
        foreground: {
          active: false,
          idleWaiting: false,
          isTaskContainer: false,
          runningTaskId: null,
          retryScheduled: false,
          process: null,
          containerName: null,
          groupFolder: null,
          retryCount: 0,
        },
        background: {
          active: false,
          idleWaiting: false,
          isTaskContainer: true,
          runningTaskId: null,
          retryScheduled: false,
          process: null,
          containerName: null,
          groupFolder: null,
          retryCount: 0,
        },
      };
      this.groups.set(groupJid, state);
    }
    return state;
  }

  private getLaneState(groupJid: string, lane: QueueLane): LaneState {
    return this.getGroup(groupJid)[lane];
  }

  private enqueueWaitingGroup(groupJid: string, lane: QueueLane): void {
    if (
      this.waitingGroups.some(
        (entry) => entry.groupJid === groupJid && entry.lane === lane,
      )
    ) {
      return;
    }
    this.waitingGroups.push({ groupJid, lane });
  }

  setProcessMessagesFn(fn: (groupJid: string) => Promise<boolean>): void {
    this.processMessagesFn = fn;
  }

  hasForegroundWork(groupJid: string): boolean {
    const { foreground, pendingMessages } = this.getGroup(groupJid);
    return foreground.active || pendingMessages || foreground.retryScheduled;
  }

  enqueueMessageCheck(groupJid: string): void {
    if (this.shuttingDown) return;

    const state = this.getGroup(groupJid);
    const foreground = state.foreground;
    foreground.retryScheduled = false;

    if (foreground.active) {
      state.pendingMessages = true;
      logger.debug({ groupJid }, 'Container active, message queued');
      return;
    }

    if (this.activeCount >= MAX_CONCURRENT_CONTAINERS) {
      state.pendingMessages = true;
      this.enqueueWaitingGroup(groupJid, 'foreground');
      logger.debug(
        { groupJid, activeCount: this.activeCount },
        'At concurrency limit, message queued',
      );
      return;
    }

    this.runForGroup(groupJid, 'messages').catch((err) =>
      logger.error({ groupJid, err }, 'Unhandled error in runForGroup'),
    );
  }

  enqueueTask(groupJid: string, taskId: string, fn: () => Promise<void>): void {
    if (this.shuttingDown) return;

    const state = this.getGroup(groupJid);
    const background = state.background;

    // Prevent double-queuing: check both pending and currently-running task
    if (background.runningTaskId === taskId) {
      logger.debug({ groupJid, taskId }, 'Task already running, skipping');
      return;
    }
    if (state.pendingTasks.some((t) => t.id === taskId)) {
      logger.debug({ groupJid, taskId }, 'Task already queued, skipping');
      return;
    }

    if (background.active) {
      state.pendingTasks.push({ id: taskId, groupJid, fn });
      if (background.idleWaiting) {
        this.closeStdin(groupJid, 'background');
      }
      logger.debug({ groupJid, taskId }, 'Container active, task queued');
      return;
    }

    if (this.activeCount >= MAX_CONCURRENT_CONTAINERS) {
      state.pendingTasks.push({ id: taskId, groupJid, fn });
      this.enqueueWaitingGroup(groupJid, 'background');
      logger.debug(
        { groupJid, taskId, activeCount: this.activeCount },
        'At concurrency limit, task queued',
      );
      return;
    }

    // Run immediately
    this.runTask(groupJid, { id: taskId, groupJid, fn }).catch((err) =>
      logger.error({ groupJid, taskId, err }, 'Unhandled error in runTask'),
    );
  }

  cancelTask(groupJid: string, taskId: string): void {
    const state = this.getGroup(groupJid);
    const pendingBefore = state.pendingTasks.length;
    state.pendingTasks = state.pendingTasks.filter(
      (task) => task.id !== taskId,
    );

    if (state.background.runningTaskId === taskId) {
      this.closeStdin(groupJid, 'background');
    }

    if (
      pendingBefore !== state.pendingTasks.length ||
      state.background.runningTaskId === taskId
    ) {
      logger.info(
        {
          groupJid,
          taskId,
          pendingRemoved: pendingBefore - state.pendingTasks.length,
          runningCancelled: state.background.runningTaskId === taskId,
        },
        'Cancelled scheduled task in queue',
      );
    }
  }

  registerProcess(
    groupJid: string,
    proc: ChildProcess,
    containerName: string,
    groupFolder?: string,
    lane: QueueLane = 'foreground',
  ): void {
    const state = this.getLaneState(groupJid, lane);
    state.process = proc;
    state.containerName = containerName;
    if (groupFolder) state.groupFolder = groupFolder;
  }

  /**
   * Mark the container as idle-waiting (finished work, waiting for IPC input).
   * If tasks are pending, preempt the idle container immediately.
   */
  notifyIdle(groupJid: string, lane: QueueLane = 'foreground'): void {
    const groupState = this.getGroup(groupJid);
    const state = groupState[lane];
    state.idleWaiting = true;
    if (lane === 'background' && groupState.pendingTasks.length > 0) {
      this.closeStdin(groupJid, 'background');
    }
  }

  /**
   * Send a follow-up message to the active container via IPC file.
   * Returns true if the message was written, false if no active container.
   */
  sendMessage(groupJid: string, text: string): boolean {
    const state = this.getLaneState(groupJid, 'foreground');
    if (!state.active || !state.groupFolder || state.isTaskContainer)
      return false;
    state.idleWaiting = false; // Agent is about to receive work, no longer idle

    const inputDir = path.join(DATA_DIR, 'ipc', state.groupFolder, 'input');
    try {
      fs.mkdirSync(inputDir, { recursive: true });
      const filename = `${Date.now()}-${Math.random().toString(36).slice(2, 6)}.json`;
      const filepath = path.join(inputDir, filename);
      const tempPath = `${filepath}.tmp`;
      fs.writeFileSync(tempPath, JSON.stringify({ type: 'message', text }));
      fs.renameSync(tempPath, filepath);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Signal the active container to wind down by writing a close sentinel.
   */
  closeStdin(groupJid: string, lane: QueueLane = 'foreground'): void {
    const state = this.getLaneState(groupJid, lane);
    if (!state.active || !state.groupFolder) return;

    const inputDir = path.join(DATA_DIR, 'ipc', state.groupFolder, 'input');
    try {
      fs.mkdirSync(inputDir, { recursive: true });
      fs.writeFileSync(path.join(inputDir, '_close'), '');
    } catch {
      // ignore
    }
  }

  resetGroup(groupJid: string, options: ResetGroupQueueOptions = {}): void {
    const state = this.getGroup(groupJid);

    if (options.closeForeground) {
      this.closeStdin(groupJid, 'foreground');
      state.foreground.idleWaiting = false;
      state.foreground.retryScheduled = false;
      state.foreground.retryCount = 0;
    }

    if (options.closeBackground) {
      this.closeStdin(groupJid, 'background');
      state.background.idleWaiting = false;
    }

    if (options.clearPendingMessages) {
      state.pendingMessages = false;
    }

    if (options.clearPendingTasks) {
      state.pendingTasks = [];
    }

    this.waitingGroups = this.waitingGroups.filter(
      (entry) => entry.groupJid !== groupJid,
    );
  }

  private async runForGroup(
    groupJid: string,
    reason: 'messages' | 'drain',
  ): Promise<void> {
    const state = this.getLaneState(groupJid, 'foreground');
    state.active = true;
    state.idleWaiting = false;
    state.isTaskContainer = false;
    this.getGroup(groupJid).pendingMessages = false;
    state.retryScheduled = false;
    this.activeCount++;

    logger.debug(
      { groupJid, reason, activeCount: this.activeCount },
      'Starting container for group',
    );

    try {
      if (this.processMessagesFn) {
        const success = await this.processMessagesFn(groupJid);
        if (success) {
          state.retryCount = 0;
        } else {
          this.scheduleRetry(groupJid, this.getGroup(groupJid));
        }
      }
    } catch (err) {
      logger.error({ groupJid, err }, 'Error processing messages for group');
      this.scheduleRetry(groupJid, this.getGroup(groupJid));
    } finally {
      state.active = false;
      state.process = null;
      state.containerName = null;
      state.groupFolder = null;
      this.activeCount--;
      this.drainGroup(groupJid);
    }
  }

  private async runTask(groupJid: string, task: QueuedTask): Promise<void> {
    const state = this.getLaneState(groupJid, 'background');
    state.active = true;
    state.idleWaiting = false;
    state.isTaskContainer = true;
    state.runningTaskId = task.id;
    this.activeCount++;

    logger.debug(
      { groupJid, taskId: task.id, activeCount: this.activeCount },
      'Running queued task',
    );

    try {
      await task.fn();
    } catch (err) {
      logger.error({ groupJid, taskId: task.id, err }, 'Error running task');
    } finally {
      state.active = false;
      state.isTaskContainer = false;
      state.runningTaskId = null;
      state.process = null;
      state.containerName = null;
      state.groupFolder = null;
      this.activeCount--;
      this.drainGroup(groupJid);
    }
  }

  private scheduleRetry(groupJid: string, state: GroupState): void {
    const foreground = state.foreground;
    foreground.retryCount++;
    if (foreground.retryCount > MAX_RETRIES) {
      foreground.retryScheduled = false;
      logger.error(
        { groupJid, retryCount: foreground.retryCount },
        'Max retries exceeded, dropping messages (will retry on next incoming message)',
      );
      foreground.retryCount = 0;
      return;
    }

    foreground.retryScheduled = true;
    const delayMs = BASE_RETRY_MS * Math.pow(2, foreground.retryCount - 1);
    logger.info(
      { groupJid, retryCount: foreground.retryCount, delayMs },
      'Scheduling retry with backoff',
    );
    emitTerminalSystemEvent(
      groupJid,
      `执行失败，${Math.round(delayMs / 1000)} 秒后重试（第 ${foreground.retryCount} 次）`,
    );
    setTimeout(() => {
      if (!this.shuttingDown) {
        this.enqueueMessageCheck(groupJid);
      }
    }, delayMs);
  }

  private drainGroup(groupJid: string): void {
    if (this.shuttingDown) return;

    const state = this.getGroup(groupJid);

    if (
      !state.foreground.active &&
      state.pendingMessages &&
      this.activeCount < MAX_CONCURRENT_CONTAINERS
    ) {
      this.runForGroup(groupJid, 'drain').catch((err) =>
        logger.error(
          { groupJid, err },
          'Unhandled error in runForGroup (drain)',
        ),
      );
    }

    if (
      !state.background.active &&
      state.pendingTasks.length > 0 &&
      this.activeCount < MAX_CONCURRENT_CONTAINERS
    ) {
      const task = state.pendingTasks.shift()!;
      this.runTask(groupJid, task).catch((err) =>
        logger.error(
          { groupJid, taskId: task.id, err },
          'Unhandled error in runTask (drain)',
        ),
      );
    }

    this.drainWaiting();
  }

  private drainWaiting(): void {
    while (
      this.waitingGroups.length > 0 &&
      this.activeCount < MAX_CONCURRENT_CONTAINERS
    ) {
      const foregroundIndex = this.waitingGroups.findIndex((entry) => {
        const state = this.getGroup(entry.groupJid);
        return (
          entry.lane === 'foreground' &&
          !state.foreground.active &&
          state.pendingMessages
        );
      });
      const backgroundIndex =
        foregroundIndex === -1
          ? this.waitingGroups.findIndex((entry) => {
              const state = this.getGroup(entry.groupJid);
              return (
                entry.lane === 'background' &&
                !state.background.active &&
                state.pendingTasks.length > 0
              );
            })
          : -1;
      const nextIndex =
        foregroundIndex !== -1
          ? foregroundIndex
          : backgroundIndex !== -1
            ? backgroundIndex
            : 0;
      const [nextEntry] = this.waitingGroups.splice(nextIndex, 1);
      const state = this.getGroup(nextEntry.groupJid);

      if (
        nextEntry.lane === 'foreground' &&
        state.pendingMessages &&
        !state.foreground.active
      ) {
        this.runForGroup(nextEntry.groupJid, 'drain').catch((err) =>
          logger.error(
            { groupJid: nextEntry.groupJid, err },
            'Unhandled error in runForGroup (waiting)',
          ),
        );
      } else if (
        nextEntry.lane === 'background' &&
        state.pendingTasks.length > 0 &&
        !state.background.active
      ) {
        const task = state.pendingTasks.shift()!;
        this.runTask(nextEntry.groupJid, task).catch((err) =>
          logger.error(
            { groupJid: nextEntry.groupJid, taskId: task.id, err },
            'Unhandled error in runTask (waiting)',
          ),
        );
      }
      // If neither pending, skip this group
    }
  }

  async shutdown(_gracePeriodMs: number): Promise<void> {
    this.shuttingDown = true;

    // Count active containers but don't kill them — they'll finish on their own
    // via idle timeout or container timeout. The --rm flag cleans them up on exit.
    // This prevents WhatsApp reconnection restarts from killing working agents.
    const activeContainers: string[] = [];
    for (const [_jid, state] of this.groups) {
      for (const laneState of [state.foreground, state.background]) {
        if (
          laneState.process &&
          !laneState.process.killed &&
          laneState.containerName
        ) {
          activeContainers.push(laneState.containerName);
        }
      }
    }

    logger.info(
      { activeCount: this.activeCount, detachedContainers: activeContainers },
      'GroupQueue shutting down (containers detached, not killed)',
    );
  }
}
