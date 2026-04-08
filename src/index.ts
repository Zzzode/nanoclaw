import fs from 'fs';
import path from 'path';

import { OneCLI } from '@onecli-sh/sdk';

import { AgentRunOutput } from './agent-backend.js';
import { deploymentRequiresContainerRuntime } from './backend-selection.js';
import { edgeBackend } from './backends/edge-backend.js';
import { heavyWorker } from './backends/container-backend.js';
import {
  ASSISTANT_NAME,
  DEFAULT_EXECUTION_MODE,
  DEFAULT_TRIGGER,
  getTriggerPattern,
  GROUPS_DIR,
  IDLE_TIMEOUT,
  MAX_MESSAGES_PER_PROMPT,
  ONECLI_URL,
  POLL_INTERVAL,
  SHADOW_EXECUTION_MODE,
  TERMINAL_CHANNEL_ENABLED,
  TERMINAL_GROUP_EXECUTION_MODE,
  TERMINAL_GROUP_FOLDER,
  TERMINAL_GROUP_JID,
  TERMINAL_GROUP_NAME,
  TERMINAL_RESET_SESSION_ON_START,
  TIMEZONE,
} from './config.js';
import './channels/index.js';
import {
  getChannelFactory,
  getRegisteredChannelNames,
} from './channels/registry.js';
import {
  writeGroupsSnapshotToIpc,
  syncObservabilitySnapshotToIpc,
  writeTasksSnapshotToIpc,
} from './container-snapshot-writer.js';
import {
  cleanupOrphans,
  ensureContainerRuntimeRunning,
} from './container-runtime.js';
import {
  getAllChats,
  getAllRegisteredGroups,
  getAllSessions,
  deleteSession,
  getAllTasks,
  getLastBotMessageTimestamp,
  getMessagesSince,
  getNewMessages,
  getRouterState,
  initDatabase,
  listExecutionStates,
  listTaskGraphs,
  listTaskNodes,
  setRegisteredGroup,
  setRouterState,
  setSession,
  storeChatMetadata,
  storeMessage,
  storeMessageDirect,
  updateTaskNode,
} from './db.js';
import {
  commitExecution,
  completeExecution,
  failExecution,
  heartbeatExecution,
  requestExecutionCancel,
} from './execution-state.js';
import {
  buildGroupsSnapshotPayload,
  buildTaskSnapshots,
  type GroupSnapshot,
} from './execution-snapshots.js';
import {
  classifyRuntimeRecovery,
  markTaskNodeForReplan,
  prepareHeavyFallbackExecution,
} from './framework-recovery.js';
import { GroupQueue } from './group-queue.js';
import { resolveGroupFolderPath } from './group-folder.js';
import { startIpcWatcher } from './ipc.js';
import { findChannel, formatMessages, formatOutbound } from './router.js';
import {
  restoreRemoteControl,
  startRemoteControl,
  stopRemoteControl,
} from './remote-control.js';
import {
  isSenderAllowed,
  isTriggerAllowed,
  loadSenderAllowlist,
  shouldDropMessage,
} from './sender-allowlist.js';
import {
  runShadowExecutionComparison,
  selectShadowExecution,
} from './shadow-execution.js';
import { emitTerminalSystemEvent } from './channels/terminal.js';
import { createFrameworkRunContext } from './framework-orchestrator.js';
import {
  beginTerminalTurn,
  completeTerminalTurn,
  failTerminalTurn,
  getTerminalWorkerLabel,
  recordTerminalFallback,
  recordTerminalTimeline,
  resetTerminalObservability,
  ensureTerminalWorker,
  updateTerminalTurnStage,
} from './terminal-observability.js';
import {
  createFrameworkWorkerRegistry,
  type FrameworkWorkerRegistry,
} from './framework-worker.js';
import { maybeRunEdgeTeamOrchestration } from './team-orchestrator.js';
import {
  completeRootTaskGraph,
  failRootTaskGraph,
} from './task-graph-state.js';
import { startSchedulerLoop } from './task-scheduler.js';
import { Channel, NewMessage, RegisteredGroup } from './types.js';
import { logger } from './logger.js';

// Re-export for backwards compatibility during refactor
export { escapeXml, formatMessages } from './router.js';

let lastTimestamp = '';
let sessions: Record<string, string> = {};
let registeredGroups: Record<string, RegisteredGroup> = {};
let lastAgentTimestamp: Record<string, string> = {};
let messageLoopRunning = false;

function summarizeRuntimeError(error: string | null | undefined): string {
  const normalized = typeof error === 'string' ? error.trim() : '';
  if (!normalized) return 'Unknown error';
  const singleLine = normalized.replace(/\s+/g, ' ');
  return singleLine.length <= 200
    ? singleLine
    : `${singleLine.slice(0, 200)}...`;
}

function handleStructuredAgentOutput(options: {
  chatJid: string;
  graphId: string;
  executionId: string | null;
  backendId: string;
  workerClass: 'edge' | 'heavy';
  output: AgentRunOutput;
}): boolean {
  const metadata = options.output.metadata;
  if (!metadata?.event) return false;

  const targetKey = metadata.targetKey ?? 'root';
  const detail = metadata.detail ?? metadata.summary ?? metadata.event;

  ensureTerminalWorker({
    chatJid: options.chatJid,
    key: targetKey,
    backendId: options.backendId,
    workerClass: options.workerClass,
    executionId: options.executionId,
    status: 'running',
    activity: detail,
    summary: metadata.summary,
  });
  recordTerminalTimeline({
    chatJid: options.chatJid,
    targetKey,
    text: `${getTerminalWorkerLabel(targetKey)} · ${metadata.event}${detail ? ` · ${detail}` : ''}`,
  });
  updateTerminalTurnStage({
    chatJid: options.chatJid,
    graphId: options.graphId,
    executionId: options.executionId,
    stage: metadata.event,
    backendId: options.backendId,
    workerClass: options.workerClass,
    activity: detail,
  });
  return true;
}

const channels: Channel[] = [];
const queue = new GroupQueue();
const frameworkWorkers: FrameworkWorkerRegistry = createFrameworkWorkerRegistry(
  {
    container: heavyWorker,
    edge: edgeBackend,
  },
);

const onecli = new OneCLI({ url: ONECLI_URL });

function ensureOneCLIAgent(jid: string, group: RegisteredGroup): void {
  if (group.isMain) return;
  const identifier = group.folder.toLowerCase().replace(/_/g, '-');
  onecli.ensureAgent({ name: group.name, identifier }).then(
    (res) => {
      logger.info(
        { jid, identifier, created: res.created },
        'OneCLI agent ensured',
      );
    },
    (err) => {
      logger.debug(
        { jid, identifier, err: String(err) },
        'OneCLI agent ensure skipped',
      );
    },
  );
}

function loadState(): void {
  lastTimestamp = getRouterState('last_timestamp') || '';
  const agentTs = getRouterState('last_agent_timestamp');
  try {
    lastAgentTimestamp = agentTs ? JSON.parse(agentTs) : {};
  } catch {
    logger.warn('Corrupted last_agent_timestamp in DB, resetting');
    lastAgentTimestamp = {};
  }
  sessions = getAllSessions();
  registeredGroups = getAllRegisteredGroups();
  logger.info(
    { groupCount: Object.keys(registeredGroups).length },
    'State loaded',
  );
}

/**
 * Return the message cursor for a group, recovering from the last bot reply
 * if lastAgentTimestamp is missing (new group, corrupted state, restart).
 */
function getOrRecoverCursor(chatJid: string): string {
  const existing = lastAgentTimestamp[chatJid];
  if (existing) return existing;

  const botTs = getLastBotMessageTimestamp(chatJid, ASSISTANT_NAME);
  if (botTs) {
    logger.info(
      { chatJid, recoveredFrom: botTs },
      'Recovered message cursor from last bot reply',
    );
    lastAgentTimestamp[chatJid] = botTs;
    saveState();
    return botTs;
  }
  return '';
}

function saveState(): void {
  setRouterState('last_timestamp', lastTimestamp);
  setRouterState('last_agent_timestamp', JSON.stringify(lastAgentTimestamp));
}

function registerGroup(jid: string, group: RegisteredGroup): void {
  let groupDir: string;
  try {
    groupDir = resolveGroupFolderPath(group.folder);
  } catch (err) {
    logger.warn(
      { jid, folder: group.folder, err },
      'Rejecting group registration with invalid folder',
    );
    return;
  }

  registeredGroups[jid] = group;
  setRegisteredGroup(jid, group);

  // Create group folder
  fs.mkdirSync(path.join(groupDir, 'logs'), { recursive: true });

  // Copy CLAUDE.md template into the new group folder so agents have
  // identity and instructions from the first run.  (Fixes #1391)
  const groupMdFile = path.join(groupDir, 'CLAUDE.md');
  if (!fs.existsSync(groupMdFile)) {
    const templateFile = path.join(
      GROUPS_DIR,
      group.isMain ? 'main' : 'global',
      'CLAUDE.md',
    );
    if (fs.existsSync(templateFile)) {
      let content = fs.readFileSync(templateFile, 'utf-8');
      if (ASSISTANT_NAME !== 'Andy') {
        content = content.replace(/^# Andy$/m, `# ${ASSISTANT_NAME}`);
        content = content.replace(/You are Andy/g, `You are ${ASSISTANT_NAME}`);
      }
      fs.writeFileSync(groupMdFile, content);
      logger.info({ folder: group.folder }, 'Created CLAUDE.md from template');
    }
  }

  // Ensure a corresponding OneCLI agent exists (best-effort, non-blocking)
  ensureOneCLIAgent(jid, group);

  logger.info(
    { jid, name: group.name, folder: group.folder },
    'Group registered',
  );
}

const TERMINAL_SOURCE_MOUNT_TARGETS = [
  'package.json',
  'tsconfig.json',
  'src',
] as const;

function mountProjectSourceIntoGroup(groupFolder: string): void {
  const groupDir = resolveGroupFolderPath(groupFolder);
  const projectRoot = process.cwd();

  for (const target of TERMINAL_SOURCE_MOUNT_TARGETS) {
    const sourcePath = path.join(projectRoot, target);
    const destPath = path.join(groupDir, target);

    if (!fs.existsSync(sourcePath)) continue;
    if (fs.existsSync(destPath)) {
      try {
        const stat = fs.lstatSync(destPath);
        if (stat.isSymbolicLink()) {
          const currentTarget = fs.readlinkSync(destPath);
          if (currentTarget === sourcePath) continue;
          fs.unlinkSync(destPath);
        } else {
          continue;
        }
      } catch {
        continue;
      }
    }

    try {
      fs.symlinkSync(sourcePath, destPath);
      logger.info(
        { groupFolder, target, sourcePath },
        'Mounted project source into group workspace',
      );
    } catch (err) {
      logger.warn(
        { groupFolder, target, err },
        'Failed to mount project source into group workspace',
      );
    }
  }
}

function ensureTerminalCanaryGroup(): void {
  if (!TERMINAL_CHANNEL_ENABLED) return;
  const existing = registeredGroups[TERMINAL_GROUP_JID];
  if (
    existing &&
    existing.folder === TERMINAL_GROUP_FOLDER &&
    existing.executionMode === TERMINAL_GROUP_EXECUTION_MODE &&
    existing.requiresTrigger === false
  ) {
    return;
  }

  registerGroup(TERMINAL_GROUP_JID, {
    name: TERMINAL_GROUP_NAME,
    folder: TERMINAL_GROUP_FOLDER,
    trigger: DEFAULT_TRIGGER,
    added_at: new Date().toISOString(),
    executionMode: TERMINAL_GROUP_EXECUTION_MODE,
    requiresTrigger: false,
  });

  mountProjectSourceIntoGroup(TERMINAL_GROUP_FOLDER);
}

function resetTerminalSession(reason: 'startup' | 'command'): void {
  delete sessions[TERMINAL_GROUP_FOLDER];
  deleteSession(TERMINAL_GROUP_FOLDER);
  resetTerminalObservability();
  logger.info(
    { group: TERMINAL_GROUP_FOLDER, reason },
    'Terminal session reset',
  );
}

function failTerminalTaskNodes(graphId: string, error: string): number {
  const timestamp = new Date().toISOString();
  let failedCount = 0;

  for (const node of listTaskNodes(graphId)) {
    if (node.status === 'completed' || node.status === 'failed') {
      continue;
    }
    updateTaskNode(node.taskId, {
      status: 'failed',
      error,
      updatedAt: timestamp,
    });
    failedCount += 1;
  }

  return failedCount;
}

function cleanupTerminalRuntime(options: {
  reason: 'startup' | 'command' | 'quit' | 'interrupt';
  error: string;
  resetSession: boolean;
  finalizeExecutions: boolean;
  closeForeground: boolean;
  closeBackground: boolean;
  clearPendingMessages: boolean;
  clearPendingTasks: boolean;
}): void {
  const activeExecutions = listExecutionStates().filter(
    (execution) =>
      execution.groupJid === TERMINAL_GROUP_JID &&
      (execution.status === 'running' ||
        execution.status === 'cancel_requested'),
  );

  for (const execution of activeExecutions) {
    requestExecutionCancel(execution.executionId);
    if (options.finalizeExecutions) {
      failExecution(execution.executionId, options.error);
    }
  }

  const runningGraphs = listTaskGraphs().filter(
    (graph) =>
      (graph.chatJid === TERMINAL_GROUP_JID ||
        graph.groupFolder === TERMINAL_GROUP_FOLDER) &&
      graph.status === 'running',
  );
  let failedNodes = 0;
  for (const graph of runningGraphs) {
    failedNodes += failTerminalTaskNodes(graph.graphId, options.error);
    failRootTaskGraph(graph.graphId, graph.rootTaskId, options.error);
  }

  queue.resetGroup(TERMINAL_GROUP_JID, {
    closeForeground: options.closeForeground,
    closeBackground: options.closeBackground,
    clearPendingMessages: options.clearPendingMessages,
    clearPendingTasks: options.clearPendingTasks,
  });

  if (options.resetSession) {
    resetTerminalSession(options.reason === 'startup' ? 'startup' : 'command');
  }

  logger.info(
    {
      reason: options.reason,
      resetSession: options.resetSession,
      finalizeExecutions: options.finalizeExecutions,
      affectedExecutions: activeExecutions.length,
      affectedGraphs: runningGraphs.length,
      affectedNodes: failedNodes,
    },
    'Terminal runtime cleaned up',
  );
}

function gracefulTerminalQuit(): void {
  cleanupTerminalRuntime({
    reason: 'quit',
    error: 'Terminal session quit',
    resetSession: true,
    finalizeExecutions: false,
    closeForeground: true,
    closeBackground: true,
    clearPendingMessages: true,
    clearPendingTasks: true,
  });
}

/**
 * Interrupt the current terminal turn by cancelling active executions and task graphs.
 * Unlike gracefulTerminalQuit, this does NOT reset the session — it only stops
 * the current run so the user can start a new turn immediately.
 */
function interruptTerminalTurn(): void {
  cleanupTerminalRuntime({
    reason: 'interrupt',
    error: 'Terminal turn interrupted',
    resetSession: false,
    finalizeExecutions: false,
    closeForeground: true,
    closeBackground: false,
    clearPendingMessages: true,
    clearPendingTasks: false,
  });
}

function resetTerminalConversation(): void {
  cleanupTerminalRuntime({
    reason: 'command',
    error: 'Terminal session reset',
    resetSession: true,
    finalizeExecutions: false,
    closeForeground: true,
    closeBackground: true,
    clearPendingMessages: true,
    clearPendingTasks: true,
  });
}

function recordBotMessage(chatJid: string, text: string): void {
  const normalized = text.trim();
  if (!normalized) return;
  const timestamp = new Date().toISOString();
  storeMessageDirect({
    id: `bot:${chatJid}:${Date.now()}:${Math.random().toString(36).slice(2, 8)}`,
    chat_jid: chatJid,
    sender: ASSISTANT_NAME,
    sender_name: ASSISTANT_NAME,
    content: normalized,
    timestamp,
    is_from_me: true,
    is_bot_message: true,
  });
}

/**
 * Get available groups list for the agent.
 * Returns groups ordered by most recent activity.
 */
export function getAvailableGroups(): GroupSnapshot[] {
  const chats = getAllChats();
  const registeredJids = new Set(Object.keys(registeredGroups));

  return chats
    .filter((c) => c.jid !== '__group_sync__' && c.is_group)
    .map((c) => ({
      jid: c.jid,
      name: c.name,
      lastActivity: c.last_message_time,
      isRegistered: registeredJids.has(c.jid),
    }));
}

/** @internal - exported for testing */
export function _setRegisteredGroups(
  groups: Record<string, RegisteredGroup>,
): void {
  registeredGroups = groups;
}

/** @internal - exported for testing */
export function _setChannelsForTests(next: Channel[]): void {
  channels.splice(0, channels.length, ...next);
}

/** @internal - exported for testing */
export function _setSessionsForTests(next: Record<string, string>): void {
  sessions = next;
}

/** @internal - exported for testing */
export function _setLastAgentTimestampForTests(
  next: Record<string, string>,
): void {
  lastAgentTimestamp = next;
}

/** @internal - exported for testing */
export function _cleanupTerminalRuntimeForTests(
  reason: 'startup' | 'command' | 'quit' = 'startup',
): void {
  cleanupTerminalRuntime({
    reason,
    error:
      reason === 'startup'
        ? 'Terminal session reset on startup'
        : reason === 'quit'
          ? 'Terminal session quit'
          : 'Terminal session reset',
    resetSession: true,
    finalizeExecutions: reason === 'startup',
    closeForeground: true,
    closeBackground: true,
    clearPendingMessages: true,
    clearPendingTasks: true,
  });
}

/** @internal - exported for testing */
export async function _processGroupMessagesForTests(
  chatJid: string,
): Promise<boolean> {
  return processGroupMessages(chatJid);
}

/**
 * Process all pending messages for a group.
 * Called by the GroupQueue when it's this group's turn.
 */
async function processGroupMessages(chatJid: string): Promise<boolean> {
  const group = registeredGroups[chatJid];
  if (!group) return true;

  const channel = findChannel(channels, chatJid);
  if (!channel) {
    logger.warn({ chatJid }, 'No channel owns JID, skipping messages');
    return true;
  }

  const isMainGroup = group.isMain === true;

  const missedMessages = getMessagesSince(
    chatJid,
    getOrRecoverCursor(chatJid),
    ASSISTANT_NAME,
    MAX_MESSAGES_PER_PROMPT,
  );

  if (missedMessages.length === 0) return true;

  // For non-main groups, check if trigger is required and present
  if (!isMainGroup && group.requiresTrigger !== false) {
    const triggerPattern = getTriggerPattern(group.trigger);
    const allowlistCfg = loadSenderAllowlist();
    const hasTrigger = missedMessages.some(
      (m) =>
        triggerPattern.test(m.content.trim()) &&
        (m.is_from_me || isTriggerAllowed(chatJid, m.sender, allowlistCfg)),
    );
    if (!hasTrigger) return true;
  }

  const prompt = formatMessages(missedMessages, TIMEZONE);

  // Advance cursor so the piping path in startMessageLoop won't re-fetch
  // these messages. Save the old cursor so we can roll back on error.
  const previousCursor = lastAgentTimestamp[chatJid] || '';
  lastAgentTimestamp[chatJid] =
    missedMessages[missedMessages.length - 1].timestamp;
  saveState();

  logger.info(
    { group: group.name, messageCount: missedMessages.length },
    'Processing messages',
  );

  // Track idle timer for closing stdin when agent is idle
  let idleTimer: ReturnType<typeof setTimeout> | null = null;

  const resetIdleTimer = () => {
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = setTimeout(() => {
      logger.debug(
        { group: group.name },
        'Idle timeout, closing container stdin',
      );
      queue.closeStdin(chatJid);
    }, IDLE_TIMEOUT);
  };

  await channel.setTyping?.(chatJid, true);
  let hadError = false;
  let outputSentToUser = false;
  let typingReleased = false;

  const output = await runAgent(group, prompt, chatJid, async (result) => {
    // Streaming output callback — called for each agent result
    if (result.result) {
      const raw =
        typeof result.result === 'string'
          ? result.result
          : JSON.stringify(result.result);
      // Strip <internal>...</internal> blocks — agent uses these for internal reasoning
      const text = raw.replace(/<internal>[\s\S]*?<\/internal>/g, '').trim();
      logger.info({ group: group.name }, `Agent output: ${raw.length} chars`);
      if (text) {
        await channel.sendMessage(chatJid, text);
        recordBotMessage(chatJid, text);
        outputSentToUser = true;
        if (!typingReleased) {
          await channel.setTyping?.(chatJid, false);
          typingReleased = true;
        }
      }
      // Only reset idle timer on actual results, not session-update markers (result: null)
      resetIdleTimer();
    }

    if (result.status === 'success') {
      queue.notifyIdle(chatJid);
    }

    if (result.status === 'error') {
      hadError = true;
    }
  });

  if (!typingReleased) {
    await channel.setTyping?.(chatJid, false);
  }
  if (idleTimer) clearTimeout(idleTimer);

  if (output === 'error' || hadError) {
    // If we already sent output to the user, don't roll back the cursor —
    // the user got their response and re-processing would send duplicates.
    if (outputSentToUser) {
      logger.warn(
        { group: group.name },
        'Agent error after output was sent, skipping cursor rollback to prevent duplicates',
      );
      return true;
    }
    // Roll back cursor so retries can re-process these messages
    lastAgentTimestamp[chatJid] = previousCursor;
    saveState();
    logger.warn(
      { group: group.name },
      'Agent error, rolled back message cursor for retry',
    );
    return false;
  }

  return true;
}

async function runAgent(
  group: RegisteredGroup,
  prompt: string,
  chatJid: string,
  onOutput?: (output: AgentRunOutput) => Promise<void>,
): Promise<'success' | 'error'> {
  const isMain = group.isMain === true;
  const sessionId = sessions[group.folder];
  const frameworkRun = createFrameworkRunContext({
    requestKind: 'group_turn',
    group,
    input: {
      prompt,
      script: undefined,
      chatJid,
    },
    defaultExecutionMode: DEFAULT_EXECUTION_MODE,
    executionScope: {
      scopeType: 'group',
      scopeId: group.folder,
      groupJid: chatJid,
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
  const backend = frameworkWorkers[placement.backendId];

  if (usesHeavyWorker) {
    const taskSnapshots = buildTaskSnapshots(
      getAllTasks(),
      group.folder,
      isMain,
    );
    writeTasksSnapshotToIpc(group.folder, taskSnapshots);

    const availableGroups = getAvailableGroups();
    writeGroupsSnapshotToIpc(
      group.folder,
      buildGroupsSnapshotPayload(availableGroups, isMain),
    );
    syncObservabilitySnapshotToIpc(group.folder);
  }

  let executionId: string | null = null;
  let streamedError: string | null = null;
  let streamedVisibleResult = false;

  logger.debug(
    {
      chatJid,
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
    'Selected backend for group execution',
  );
  emitTerminalSystemEvent(
    chatJid,
    `执行开始：${graph.graphId} · ${placement.backendId}/${placement.workerClass}`,
  );
  beginTerminalTurn({
    chatJid,
    graphId: graph.graphId,
    rootTaskId: graph.rootTaskId,
    executionId: execution.executionId,
    stage: 'starting',
    backendId: placement.backendId,
    workerClass: placement.workerClass,
    activity: `执行开始：${graph.graphId} · ${placement.backendId}/${placement.workerClass}`,
  });

  try {
    executionId = execution.executionId;
    let effectiveExecutionId = execution.executionId;
    let effectiveBackendId = placement.backendId;

    // Always stream through the wrapper so execution heartbeats and
    // session compatibility updates happen even when the caller does not
    // need per-chunk output handling.
    const wrappedOnOutput = async (output: AgentRunOutput) => {
      if (output.newSessionId) {
        sessions[group.folder] = output.newSessionId;
        setSession(group.folder, output.newSessionId);
      }
      if (executionId) heartbeatExecution(executionId);
      if (output.status === 'error') {
        streamedError = output.error || 'Unknown error';
        updateTerminalTurnStage({
          chatJid,
          graphId: graph.graphId,
          executionId: effectiveExecutionId,
          stage: 'stream_error',
          backendId: effectiveBackendId,
          workerClass: effectiveBackendId === 'container' ? 'heavy' : 'edge',
          activity: output.error || 'Unknown error',
          error: output.error || 'Unknown error',
        });
      }
      const handledStructuredOutput = handleStructuredAgentOutput({
        chatJid,
        graphId: graph.graphId,
        executionId: effectiveExecutionId,
        backendId: effectiveBackendId,
        workerClass: effectiveBackendId === 'container' ? 'heavy' : 'edge',
        output,
      });
      if (output.result) {
        streamedVisibleResult = true;
        updateTerminalTurnStage({
          chatJid,
          graphId: graph.graphId,
          executionId: effectiveExecutionId,
          stage: 'streaming_output',
          backendId: effectiveBackendId,
          workerClass: effectiveBackendId === 'container' ? 'heavy' : 'edge',
          activity: output.result,
        });
      }
      if (handledStructuredOutput && !output.result && !output.error) {
        await onOutput?.(output);
        return;
      }
      await onOutput?.(output);
    };

    const teamOrchestrationResult = await maybeRunEdgeTeamOrchestration({
      group,
      prompt,
      chatJid,
      isMain,
      assistantName: ASSISTANT_NAME,
      frameworkRun,
      edgeWorker: frameworkWorkers.edge,
      onOutput: wrappedOnOutput,
    });
    if (teamOrchestrationResult.handled) {
      return teamOrchestrationResult.status;
    }

    let output = await backend.run(
      group,
      {
        prompt,
        sessionId,
        groupFolder: group.folder,
        chatJid,
        isMain,
        assistantName: ASSISTANT_NAME,
        executionContext,
      },
      usesHeavyWorker
        ? (execution) =>
          queue.registerProcess(
            execution.chatJid,
            execution.process,
            execution.executionName,
            execution.groupFolder,
          )
        : undefined,
      wrappedOnOutput,
    );

    const recovery = classifyRuntimeRecovery({
      error: streamedError || output.error || '',
      workerClass: placement.workerClass,
      fallbackEligible: placement.fallbackEligible,
      visibleOutputEmitted: streamedVisibleResult,
    });

    if (recovery.kind === 'fallback' && executionId) {
      const rawError = streamedError || output.error || 'Unknown error';
      failExecution(
        executionId,
        rawError,
      );
      emitTerminalSystemEvent(
        chatJid,
        `执行降级：${graph.graphId} · edge → heavy · ${recovery.reason} · ${summarizeRuntimeError(rawError)}`,
      );
      recordTerminalFallback({
        chatJid,
        fromBackend: 'edge',
        toBackend: 'container',
        reason: recovery.reason,
        detail: rawError,
      });

      if (sessionId) {
        sessions[group.folder] = sessionId;
        setSession(group.folder, sessionId);
      } else {
        delete sessions[group.folder];
        deleteSession(group.folder);
      }

      const fallback = prepareHeavyFallbackExecution({
        scope: {
          scopeType: 'group',
          scopeId: group.folder,
          groupJid: chatJid,
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
      streamedVisibleResult = false;
      updateTerminalTurnStage({
        chatJid,
        graphId: graph.graphId,
        executionId: effectiveExecutionId,
        stage: 'fallback_running',
        backendId: 'container',
        workerClass: 'heavy',
        activity: `heavy fallback started · ${recovery.reason}`,
      });

      output = await frameworkWorkers.container.run(
        group,
        {
          prompt,
          sessionId,
          groupFolder: group.folder,
          chatJid,
          isMain,
          assistantName: ASSISTANT_NAME,
          executionContext: fallback.executionContext,
        },
        (execution) =>
          queue.registerProcess(
            execution.chatJid,
            execution.process,
            execution.executionName,
            execution.groupFolder,
          ),
        wrappedOnOutput,
      );
    }

    if (output.newSessionId) {
      sessions[group.folder] = output.newSessionId;
      setSession(group.folder, output.newSessionId);
    }

    if (output.result && !streamedVisibleResult) {
      await onOutput?.(output);
    }

    await runShadowExecutionComparison({
      selection: selectShadowExecution(
        effectiveBackendId,
        { prompt, script: undefined },
        SHADOW_EXECUTION_MODE,
      ),
      backends: frameworkWorkers,
      group,
      input: {
        prompt,
        sessionId,
        groupFolder: group.folder,
        chatJid,
        isMain,
        assistantName: ASSISTANT_NAME,
      },
      primaryBackendId: effectiveBackendId,
      primaryOutput: output,
      scope: 'group',
      scopeId: group.folder,
      fallbackReason: placement.fallbackReason,
    });

    const error = streamedError || output.error;
    if (output.status === 'error' || error) {
      const finalRecovery = classifyRuntimeRecovery({
        error: error || 'Unknown error',
        workerClass: effectiveBackendId === 'container' ? 'heavy' : 'edge',
        fallbackEligible: false,
        visibleOutputEmitted: streamedVisibleResult,
      });

      if (effectiveExecutionId) {
        failExecution(effectiveExecutionId, error || 'Unknown error');
      }
      if (finalRecovery.kind === 'replan') {
        markTaskNodeForReplan(graph.rootTaskId, finalRecovery.reason);
      }

      // Detect stale/corrupt session — clear it so the next retry starts fresh.
      // The session .jsonl can go missing after a crash mid-write, manual
      // deletion, or disk-full. The existing backoff in group-queue.ts
      // handles the retry; we just need to remove the broken session ID.
      const isStaleSession =
        sessionId &&
        error &&
        /no conversation found|ENOENT.*\.jsonl|session.*not found/i.test(error);

      if (isStaleSession) {
        logger.warn(
          { group: group.name, staleSessionId: sessionId, error },
          'Stale session detected — clearing for next retry',
        );
        delete sessions[group.folder];
        deleteSession(group.folder);
      }

      failRootTaskGraph(
        graph.graphId,
        graph.rootTaskId,
        error || 'Unknown error',
      );
      failTerminalTurn({
        chatJid,
        stage: 'failed',
        error: error || 'Unknown error',
        activity: `执行失败：${graph.graphId} · ${error || 'Unknown error'}`,
      });
      emitTerminalSystemEvent(
        chatJid,
        `执行失败：${graph.graphId} · ${error || 'Unknown error'}`,
      );
      logger.error(
        { group: group.name, error },
        'Heavy worker execution error',
      );
      return 'error';
    }

    commitExecution(effectiveExecutionId);
    completeExecution(effectiveExecutionId);
    completeRootTaskGraph(graph.graphId, graph.rootTaskId);
    completeTerminalTurn({
      chatJid,
      stage: 'completed',
      activity: `执行完成：${graph.graphId}`,
    });
    emitTerminalSystemEvent(chatJid, `执行完成：${graph.graphId}`);
    return 'success';
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    const recovery = classifyRuntimeRecovery({
      error,
      workerClass: placement.workerClass,
      fallbackEligible: placement.fallbackEligible,
      visibleOutputEmitted: streamedVisibleResult,
    });
    if (executionId) failExecution(executionId, error);
    if (recovery.kind === 'replan') {
      markTaskNodeForReplan(graph.rootTaskId, recovery.reason);
    }
    failRootTaskGraph(graph.graphId, graph.rootTaskId, error);
    failTerminalTurn({
      chatJid,
      stage: 'failed',
      error,
      activity: `执行失败：${graph.graphId} · ${error}`,
    });
    emitTerminalSystemEvent(chatJid, `执行失败：${graph.graphId} · ${error}`);
    logger.error({ group: group.name, err }, 'Agent error');
    return 'error';
  } finally {
    try {
      syncObservabilitySnapshotToIpc(group.folder);
    } catch (snapshotError) {
      logger.warn(
        {
          group: group.name,
          error:
            snapshotError instanceof Error
              ? snapshotError.message
              : String(snapshotError),
        },
        'Failed to write framework observability snapshot',
      );
    }
  }
}
async function startMessageLoop(): Promise<void> {
  if (messageLoopRunning) {
    logger.debug('Message loop already running, skipping duplicate start');
    return;
  }
  messageLoopRunning = true;

  logger.info(`NanoClaw running (default trigger: ${DEFAULT_TRIGGER})`);

  while (true) {
    try {
      const jids = Object.keys(registeredGroups);
      const { messages, newTimestamp } = getNewMessages(
        jids,
        lastTimestamp,
        ASSISTANT_NAME,
      );

      if (messages.length > 0) {
        logger.info({ count: messages.length }, 'New messages');

        // Advance the "seen" cursor for all messages immediately
        lastTimestamp = newTimestamp;
        saveState();

        // Deduplicate by group
        const messagesByGroup = new Map<string, NewMessage[]>();
        for (const msg of messages) {
          const existing = messagesByGroup.get(msg.chat_jid);
          if (existing) {
            existing.push(msg);
          } else {
            messagesByGroup.set(msg.chat_jid, [msg]);
          }
        }

        for (const [chatJid, groupMessages] of messagesByGroup) {
          const group = registeredGroups[chatJid];
          if (!group) continue;

          const channel = findChannel(channels, chatJid);
          if (!channel) {
            logger.warn({ chatJid }, 'No channel owns JID, skipping messages');
            continue;
          }

          const isMainGroup = group.isMain === true;
          const needsTrigger = !isMainGroup && group.requiresTrigger !== false;

          // For non-main groups, only act on trigger messages.
          // Non-trigger messages accumulate in DB and get pulled as
          // context when a trigger eventually arrives.
          if (needsTrigger) {
            const triggerPattern = getTriggerPattern(group.trigger);
            const allowlistCfg = loadSenderAllowlist();
            const hasTrigger = groupMessages.some(
              (m) =>
                triggerPattern.test(m.content.trim()) &&
                (m.is_from_me ||
                  isTriggerAllowed(chatJid, m.sender, allowlistCfg)),
            );
            if (!hasTrigger) continue;
          }

          // Pull all messages since lastAgentTimestamp so non-trigger
          // context that accumulated between triggers is included.
          const allPending = getMessagesSince(
            chatJid,
            getOrRecoverCursor(chatJid),
            ASSISTANT_NAME,
            MAX_MESSAGES_PER_PROMPT,
          );
          const messagesToSend =
            allPending.length > 0 ? allPending : groupMessages;
          const formatted = formatMessages(messagesToSend, TIMEZONE);

          if (queue.sendMessage(chatJid, formatted)) {
            logger.debug(
              { chatJid, count: messagesToSend.length },
              'Piped messages to active container',
            );
            lastAgentTimestamp[chatJid] =
              messagesToSend[messagesToSend.length - 1].timestamp;
            saveState();
            // Show typing indicator while the container processes the piped message
            channel
              .setTyping?.(chatJid, true)
              ?.catch((err) =>
                logger.warn({ chatJid, err }, 'Failed to set typing indicator'),
              );
          } else {
            // No active container — enqueue for a new one
            queue.enqueueMessageCheck(chatJid);
          }
        }
      }
    } catch (err) {
      logger.error({ err }, 'Error in message loop');
    }
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL));
  }
}

/**
 * Startup recovery: check for unprocessed messages in registered groups.
 * Handles crash between advancing lastTimestamp and processing messages.
 */
function recoverPendingMessages(): void {
  for (const [chatJid, group] of Object.entries(registeredGroups)) {
    const pending = getMessagesSince(
      chatJid,
      getOrRecoverCursor(chatJid),
      ASSISTANT_NAME,
      MAX_MESSAGES_PER_PROMPT,
    );
    if (pending.length > 0) {
      if (TERMINAL_CHANNEL_ENABLED && chatJid === TERMINAL_GROUP_JID) {
        lastAgentTimestamp[chatJid] = pending[pending.length - 1].timestamp;
        saveState();
        logger.info(
          { group: group.name, pendingCount: pending.length },
          'Recovery: muted pending terminal messages',
        );
        continue;
      }
      logger.info(
        { group: group.name, pendingCount: pending.length },
        'Recovery: found unprocessed messages',
      );
      queue.enqueueMessageCheck(chatJid);
    }
  }
}

function ensureContainerSystemRunning(): void {
  ensureContainerRuntimeRunning();
  cleanupOrphans();
}

async function main(): Promise<void> {
  initDatabase();
  logger.info('Database initialized');
  loadState();
  ensureTerminalCanaryGroup();
  if (TERMINAL_CHANNEL_ENABLED && TERMINAL_RESET_SESSION_ON_START) {
    cleanupTerminalRuntime({
      reason: 'startup',
      error: 'Terminal session reset on startup',
      resetSession: true,
      finalizeExecutions: true,
      closeForeground: true,
      closeBackground: true,
      clearPendingMessages: true,
      clearPendingTasks: true,
    });
  }

  if (
    deploymentRequiresContainerRuntime(
      Object.values(registeredGroups),
      DEFAULT_EXECUTION_MODE,
    )
  ) {
    ensureContainerSystemRunning();
  } else {
    logger.info(
      { defaultExecutionMode: DEFAULT_EXECUTION_MODE },
      'Skipping container runtime startup check for edge-only deployment',
    );
  }

  // Ensure OneCLI agents exist for all registered groups.
  // Recovers from missed creates (e.g. OneCLI was down at registration time).
  for (const [jid, group] of Object.entries(registeredGroups)) {
    ensureOneCLIAgent(jid, group);
  }

  restoreRemoteControl();

  // Graceful shutdown handlers
  const shutdown = async (signal: string) => {
    logger.info({ signal }, 'Shutdown signal received');
    await queue.shutdown(10000);
    for (const ch of channels) await ch.disconnect();
    process.exit(0);
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));

  // Handle /remote-control and /remote-control-end commands
  async function handleRemoteControl(
    command: string,
    chatJid: string,
    msg: NewMessage,
  ): Promise<void> {
    const group = registeredGroups[chatJid];
    if (!group?.isMain) {
      logger.warn(
        { chatJid, sender: msg.sender },
        'Remote control rejected: not main group',
      );
      return;
    }

    const channel = findChannel(channels, chatJid);
    if (!channel) return;

    if (command === '/remote-control') {
      const result = await startRemoteControl(
        msg.sender,
        chatJid,
        process.cwd(),
      );
      if (result.ok) {
        await channel.sendMessage(chatJid, result.url);
      } else {
        await channel.sendMessage(
          chatJid,
          `Remote Control failed: ${result.error}`,
        );
      }
    } else {
      const result = stopRemoteControl();
      if (result.ok) {
        await channel.sendMessage(chatJid, 'Remote Control session ended.');
      } else {
        await channel.sendMessage(chatJid, result.error);
      }
    }
  }

  // Channel callbacks (shared by all channels)
  const channelOpts = {
    onMessage: (chatJid: string, msg: NewMessage) => {
      // Remote control commands — intercept before storage
      const trimmed = msg.content.trim();
      if (trimmed === '/remote-control' || trimmed === '/remote-control-end') {
        handleRemoteControl(trimmed, chatJid, msg).catch((err) =>
          logger.error({ err, chatJid }, 'Remote control command error'),
        );
        return;
      }

      // Sender allowlist drop mode: discard messages from denied senders before storing
      if (!msg.is_from_me && !msg.is_bot_message && registeredGroups[chatJid]) {
        const cfg = loadSenderAllowlist();
        if (
          shouldDropMessage(chatJid, cfg) &&
          !isSenderAllowed(chatJid, msg.sender, cfg)
        ) {
          if (cfg.logDenied) {
            logger.debug(
              { chatJid, sender: msg.sender },
              'sender-allowlist: dropping message (drop mode)',
            );
          }
          return;
        }
      }
      storeMessage(msg);
    },
    onChatMetadata: (
      chatJid: string,
      timestamp: string,
      name?: string,
      channel?: string,
      isGroup?: boolean,
    ) => storeChatMetadata(chatJid, timestamp, name, channel, isGroup),
    registeredGroups: () => registeredGroups,
    onResetSession: (groupFolder: string) => {
      if (groupFolder === TERMINAL_GROUP_FOLDER) {
        resetTerminalConversation();
      }
    },
    onQuit: (groupFolder: string) => {
      if (groupFolder === TERMINAL_GROUP_FOLDER) {
        gracefulTerminalQuit();
      }
    },
    onCancel: (groupFolder: string) => {
      if (groupFolder === TERMINAL_GROUP_FOLDER) {
        interruptTerminalTurn();
        emitTerminalSystemEvent(TERMINAL_GROUP_JID, '已打断当前对话（ESC）');
      }
    },
  };

  // Create and connect all registered channels.
  // Each channel self-registers via the barrel import above.
  // Factories return null when credentials are missing, so unconfigured channels are skipped.
  for (const channelName of getRegisteredChannelNames()) {
    const factory = getChannelFactory(channelName)!;
    const channel = factory(channelOpts);
    if (!channel) {
      logger.warn(
        { channel: channelName },
        'Channel installed but credentials missing — skipping. Check .env or re-run the channel skill.',
      );
      continue;
    }
    channels.push(channel);
    await channel.connect();
  }
  if (channels.length === 0) {
    logger.fatal('No channels connected');
    process.exit(1);
  }

  // Start subsystems (independently of connection handler)
  startSchedulerLoop({
    backends: frameworkWorkers,
    defaultExecutionMode: DEFAULT_EXECUTION_MODE,
    registeredGroups: () => registeredGroups,
    getSessions: () => sessions,
    queue,
    onExecutionStarted: (execution) =>
      queue.registerProcess(
        execution.chatJid,
        execution.process,
        execution.executionName,
        execution.groupFolder,
      ),
    sendMessage: async (jid, rawText) => {
      const channel = findChannel(channels, jid);
      if (!channel) {
        logger.warn({ jid }, 'No channel owns JID, cannot send message');
        return;
      }
      const text = formatOutbound(rawText);
      if (text) {
        await channel.sendMessage(jid, text);
        recordBotMessage(jid, text);
      }
    },
  });
  startIpcWatcher({
    sendMessage: (jid, text) => {
      const channel = findChannel(channels, jid);
      if (!channel) throw new Error(`No channel for JID: ${jid}`);
      return channel
        .sendMessage(jid, text)
        .then(() => recordBotMessage(jid, text));
    },
    registeredGroups: () => registeredGroups,
    registerGroup,
    syncGroups: async (force: boolean) => {
      await Promise.all(
        channels
          .filter((ch) => ch.syncGroups)
          .map((ch) => ch.syncGroups!(force)),
      );
    },
    getAvailableGroups,
    writeGroupsSnapshot: writeGroupsSnapshotToIpc,
    onTasksChanged: () => {
      const tasks = getAllTasks();
      for (const group of Object.values(registeredGroups)) {
        writeTasksSnapshotToIpc(
          group.folder,
          buildTaskSnapshots(tasks, group.folder, group.isMain === true),
        );
        syncObservabilitySnapshotToIpc(group.folder);
      }
    },
  });
  queue.setProcessMessagesFn(processGroupMessages);
  recoverPendingMessages();
  startMessageLoop().catch((err) => {
    logger.fatal({ err }, 'Message loop crashed unexpectedly');
    process.exit(1);
  });
}

// Guard: only run when executed directly, not when imported by tests
const isDirectRun =
  process.argv[1] &&
  new URL(import.meta.url).pathname ===
  new URL(`file://${process.argv[1]}`).pathname;

if (isDirectRun) {
  main().catch((err) => {
    logger.error({ err }, 'Failed to start NanoClaw');
    process.exit(1);
  });
}
