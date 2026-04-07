import readline from 'readline';

import {
  ASSISTANT_NAME,
  EDGE_ANTHROPIC_MODEL,
  EDGE_ENABLE_TOOLS,
  EDGE_MODEL,
  EDGE_RUNNER_MODE,
  EDGE_RUNNER_PROVIDER,
  TERMINAL_CHANNEL_ENABLED,
  TERMINAL_GROUP_FOLDER,
  TERMINAL_GROUP_EXECUTION_MODE,
  TERMINAL_GROUP_JID,
  TERMINAL_GROUP_NAME,
  TERMINAL_USER_JID,
  TERMINAL_USER_NAME,
  TIMEZONE,
} from '../config.js';
import {
  getAllTasks,
  getTaskById,
  listExecutionStatesForTaskNode,
  listTaskGraphs,
  listTaskNodes,
  listExecutionStates,
  updateTask,
} from '../db.js';
import { buildFrameworkObservabilitySnapshot } from '../framework-observability.js';
import { deleteScheduledTask } from '../task-control.js';
import type { Channel } from '../types.js';
import { formatDisplayDateTime } from '../timezone.js';
import { registerChannel, type ChannelOpts } from './registry.js';

const COLOR_DIM = '\x1b[90m';
const COLOR_CYAN = '\x1b[36m';
const COLOR_GREEN = '\x1b[32m';
const COLOR_YELLOW = '\x1b[33m';
const COLOR_RESET = '\x1b[0m';
const TERMINAL_EVENT_LIMIT = 50;
const DEFAULT_LOG_TAIL = 12;

type TerminalExecutionHealth = 'healthy' | 'missing' | 'stale' | 'terminal';
type TerminalGraphHealth = 'healthy' | 'stale' | 'terminal' | 'idle';

let activeTerminalChannel: TerminalChannel | null = null;
let terminalEvents: Array<{ at: string; text: string }> = [];

function formatClock(date = new Date()): string {
  return date.toLocaleTimeString('zh-CN', {
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
}

function providerLabel(): string {
  if (EDGE_RUNNER_PROVIDER === 'openai') return 'openai-compatible';
  return EDGE_RUNNER_PROVIDER;
}

function modelLabel(): string {
  if (EDGE_RUNNER_PROVIDER === 'anthropic') {
    return EDGE_ANTHROPIC_MODEL;
  }
  return EDGE_MODEL || 'default';
}

function assistantLabel(): string {
  return ASSISTANT_NAME.toLowerCase();
}

function terminalTaskSnapshot() {
  const tasks = getAllTasks().filter(
    (task) =>
      task.chat_jid === TERMINAL_GROUP_JID ||
      task.group_folder === TERMINAL_GROUP_FOLDER,
  );
  const taskIds = new Set(tasks.map((task) => task.id));
  const running = listExecutionStates('running').filter(
    (execution) => execution.taskId && taskIds.has(execution.taskId),
  ).length;
  const scheduled = tasks.filter((task) => task.status === 'active').length;
  return { tasks, running, scheduled };
}

function parseTimestamp(value: string | null | undefined): number | null {
  if (!value) return null;
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? null : parsed;
}

function formatDuration(createdAt: string, finishedAt?: string | null): string {
  const started = parseTimestamp(createdAt);
  const finished = parseTimestamp(finishedAt);
  if (started === null) return 'unknown';
  const end = finished ?? Date.now();
  const durationMs = Math.max(0, end - started);
  if (durationMs < 1000) return `${durationMs}ms`;
  return `${(durationMs / 1000).toFixed(1)}s`;
}

function resolveExecutionHealth(execution: {
  status: string;
  leaseUntil: string;
  lastHeartbeatAt: string | null;
}): TerminalExecutionHealth {
  if (
    execution.status === 'completed' ||
    execution.status === 'failed' ||
    execution.status === 'committed' ||
    execution.status === 'lost'
  ) {
    return 'terminal';
  }

  const leaseUntil = parseTimestamp(execution.leaseUntil);
  if (leaseUntil === null || !execution.lastHeartbeatAt) {
    return 'missing';
  }

  return leaseUntil >= Date.now() ? 'healthy' : 'stale';
}

function buildGraphExecutionHealth(graphId: string): {
  graphHealth: TerminalGraphHealth;
  executionHealthByTaskId: Map<string, TerminalExecutionHealth>;
} {
  const executionHealthByTaskId = new Map<string, TerminalExecutionHealth>();
  const nodes = listTaskNodes(graphId);
  const executions = nodes.flatMap((node) =>
    listExecutionStatesForTaskNode(node.taskId).map((execution) => ({
      taskId: node.taskId,
      health: resolveExecutionHealth(execution),
      status: execution.status,
    })),
  );

  for (const execution of executions) {
    executionHealthByTaskId.set(execution.taskId, execution.health);
  }

  const activeExecutions = executions.filter(
    (execution) =>
      execution.status === 'running' || execution.status === 'cancel_requested',
  );
  if (activeExecutions.length === 0) {
    return {
      graphHealth: executions.length > 0 ? 'terminal' : 'idle',
      executionHealthByTaskId,
    };
  }
  if (activeExecutions.some((execution) => execution.health === 'healthy')) {
    return { graphHealth: 'healthy', executionHealthByTaskId };
  }
  if (activeExecutions.some((execution) => execution.health === 'missing')) {
    return { graphHealth: 'idle', executionHealthByTaskId };
  }
  return { graphHealth: 'stale', executionHealthByTaskId };
}

function extractWorkerLabel(taskId: string, nodeKind: string): string {
  if (nodeKind === 'aggregate') return 'aggregate';
  if (nodeKind === 'root') return 'root';
  const match = taskId.match(/:child-(\d+)$/);
  if (match) return `worker ${match[1]}`;
  return taskId;
}

function findLatestTerminalTeamGraph() {
  const graphs = listTaskGraphs().filter(
    (graph) =>
      graph.chatJid === TERMINAL_GROUP_JID ||
      graph.groupFolder === TERMINAL_GROUP_FOLDER,
  );
  const graphIdsWithFanout = new Set(
    listTaskNodes()
      .filter((node) => node.nodeKind === 'fanout_child')
      .map((node) => node.graphId),
  );
  const teamGraphs = graphs.filter((graph) =>
    graphIdsWithFanout.has(graph.graphId),
  );
  if (teamGraphs.length === 0) return null;

  const enriched = teamGraphs.map((graph) => ({
    graph,
    ...buildGraphExecutionHealth(graph.graphId),
  }));

  const rankGraph = (entry: {
    graph: { status: string };
    graphHealth: TerminalGraphHealth;
  }) => {
    if (entry.graph.status === 'running' && entry.graphHealth === 'healthy')
      return 4;
    if (entry.graph.status === 'running' && entry.graphHealth === 'idle')
      return 3;
    if (entry.graph.status === 'completed' || entry.graph.status === 'failed')
      return 2;
    if (entry.graph.status === 'running' && entry.graphHealth === 'stale')
      return 1;
    return 0;
  };

  const sorted = enriched.sort((left, right) => {
    const rankDiff = rankGraph(right) - rankGraph(left);
    if (rankDiff !== 0) return rankDiff;
    return (
      (parseTimestamp(right.graph.createdAt) ?? 0) -
      (parseTimestamp(left.graph.createdAt) ?? 0)
    );
  });

  return sorted[0] ?? null;
}

function indentBlock(text: string): string {
  return text
    .split('\n')
    .map((line) => `  ${line}`)
    .join('\n');
}

function recordTerminalEvent(text: string): void {
  const normalized = text.trim();
  if (!normalized) return;
  terminalEvents.push({
    at: new Date().toISOString(),
    text: normalized,
  });
  if (terminalEvents.length > TERMINAL_EVENT_LIMIT) {
    terminalEvents = terminalEvents.slice(-TERMINAL_EVENT_LIMIT);
  }
}

export function buildTerminalLogsSummary(limit = DEFAULT_LOG_TAIL): string {
  const safeLimit = Number.isFinite(limit)
    ? Math.max(1, Math.trunc(limit))
    : DEFAULT_LOG_TAIL;
  const entries = terminalEvents.slice(-safeLimit);
  if (entries.length === 0) {
    return '最近没有系统事件。';
  }
  return entries
    .map(
      (entry) => `[${formatDisplayDateTime(entry.at, TIMEZONE)}] ${entry.text}`,
    )
    .join('\n');
}

export function resetTerminalEventLogForTests(): void {
  terminalEvents = [];
}

export function appendTerminalEventForTests(text: string): void {
  recordTerminalEvent(text);
}

export function executeTerminalTaskCommand(args: string[]): string {
  const action = args[0];
  const taskId = args[1];

  if (!action || action === 'list') {
    return buildTerminalTasksSummary();
  }

  if (!taskId) {
    return '用法：/task <list|pause|resume|delete> [taskId]';
  }

  const task = getTaskById(taskId);
  if (!task) {
    return `任务不存在：${taskId}`;
  }

  if (
    task.chat_jid !== TERMINAL_GROUP_JID &&
    task.group_folder !== TERMINAL_GROUP_FOLDER
  ) {
    return `当前 terminal 无权操作任务：${taskId}`;
  }

  switch (action) {
    case 'pause':
      if (task.status === 'paused') {
        return `任务已是 paused：${taskId}`;
      }
      if (task.status === 'completed') {
        return `任务已完成，不能暂停：${taskId}`;
      }
      updateTask(taskId, { status: 'paused' });
      return `任务已暂停：${taskId}`;
    case 'resume':
      if (task.status === 'active') {
        return `任务已是 active：${taskId}`;
      }
      if (task.status === 'completed' || !task.next_run) {
        return `任务不可恢复：${taskId}`;
      }
      updateTask(taskId, { status: 'active' });
      return `任务已恢复：${taskId}`;
    case 'delete':
      deleteScheduledTask(taskId);
      return `任务已删除：${taskId}`;
    default:
      return `未知 task 命令：${action}\n用法：/task <list|pause|resume|delete> [taskId]`;
  }
}

export function buildTerminalStatusLine(): string {
  const { running, scheduled } = terminalTaskSnapshot();
  const segments = [
    `${TERMINAL_GROUP_EXECUTION_MODE}/${EDGE_RUNNER_MODE}`,
    providerLabel(),
    modelLabel(),
    `tools:${EDGE_ENABLE_TOOLS ? 'on' : 'off'}`,
    `group:${TERMINAL_GROUP_FOLDER}`,
    `tasks:${running} running/${scheduled} scheduled`,
  ];
  return `${COLOR_DIM}${segments.join(' · ')}${COLOR_RESET}`;
}

export function buildTerminalTasksSummary(): string {
  const { tasks } = terminalTaskSnapshot();
  if (tasks.length === 0) {
    return '当前没有任务。';
  }

  const runningTaskIds = new Set(
    listExecutionStates('running')
      .map((execution) => execution.taskId)
      .filter((taskId): taskId is string => typeof taskId === 'string'),
  );

  return tasks
    .map((task) => {
      const status = runningTaskIds.has(task.id) ? 'running' : task.status;
      const nextRun = task.next_run
        ? formatDisplayDateTime(task.next_run, TIMEZONE)
        : 'none';
      return [
        `taskId: ${task.id}`,
        `status: ${status}`,
        `scheduleValue: ${task.schedule_value}`,
        `nextRun: ${nextRun}`,
      ].join('\n');
    })
    .join('\n\n');
}

export function buildTerminalAgentsSummary(): string {
  const selection = findLatestTerminalTeamGraph();
  if (!selection) {
    return '当前没有可观察的 edge team graph。';
  }
  const { graph, graphHealth, executionHealthByTaskId } = selection;

  const nodes = listTaskNodes(graph.graphId).filter(
    (node) => node.nodeKind === 'fanout_child' || node.nodeKind === 'aggregate',
  );
  if (nodes.length === 0) {
    return `graphId: ${graph.graphId}\n当前 graph 还没有 fanout agents。`;
  }

  return [
    `graphId: ${graph.graphId}`,
    `graphStatus: ${graph.status}`,
    `graphHealth: ${graphHealth}`,
    ...nodes.map((node) => {
      const executions = listExecutionStatesForTaskNode(node.taskId);
      const latestExecution =
        executions.length > 0 ? executions[executions.length - 1] : null;
      const status = latestExecution?.status ?? node.status;
      const duration = latestExecution
        ? formatDuration(latestExecution.createdAt, latestExecution.finishedAt)
        : 'unknown';
      return [
        `agent: ${extractWorkerLabel(node.taskId, node.nodeKind)}`,
        `taskId: ${node.taskId}`,
        `nodeKind: ${node.nodeKind}`,
        `status: ${status}`,
        `health: ${executionHealthByTaskId.get(node.taskId) ?? 'terminal'}`,
        `backend: ${latestExecution?.backend ?? node.backendId ?? 'unknown'}`,
        `duration: ${duration}`,
        `error: ${latestExecution?.error ?? node.error ?? 'none'}`,
      ].join('\n');
    }),
  ].join('\n\n');
}

export function buildTerminalGraphSummary(): string {
  const selection = findLatestTerminalTeamGraph();
  if (!selection) {
    return '当前没有可观察的 edge team graph。';
  }
  const { graph, graphHealth, executionHealthByTaskId } = selection;

  const nodes = listTaskNodes(graph.graphId);
  const nodeLines = nodes.map((node) => {
    const executions = listExecutionStatesForTaskNode(node.taskId);
    const latestExecution =
      executions.length > 0 ? executions[executions.length - 1] : null;
    return [
      `taskId: ${node.taskId}`,
      `nodeKind: ${node.nodeKind}`,
      `status: ${node.status}`,
      `executionStatus: ${latestExecution?.status ?? 'none'}`,
      `health: ${executionHealthByTaskId.get(node.taskId) ?? 'terminal'}`,
      `backend: ${latestExecution?.backend ?? node.backendId ?? 'unknown'}`,
      `routeReason: ${node.routeReason ?? 'none'}`,
      `error: ${latestExecution?.error ?? node.error ?? 'none'}`,
    ].join('\n');
  });

  return [
    `graphId: ${graph.graphId}`,
    `requestKind: ${graph.requestKind}`,
    `graphStatus: ${graph.status}`,
    `graphHealth: ${graphHealth}`,
    `rootTaskId: ${graph.rootTaskId}`,
    `createdAt: ${formatDisplayDateTime(graph.createdAt, TIMEZONE)}`,
    `updatedAt: ${formatDisplayDateTime(graph.updatedAt, TIMEZONE)}`,
    `error: ${graph.error ?? 'none'}`,
    '',
    ...nodeLines,
  ].join('\n');
}

export function buildTerminalStatusSummary(): string {
  return [
    `mode: ${TERMINAL_GROUP_EXECUTION_MODE}/${EDGE_RUNNER_MODE}`,
    `provider: ${providerLabel()}`,
    `model: ${modelLabel()}`,
    `tools: ${EDGE_ENABLE_TOOLS ? 'on' : 'off'}`,
    `group: ${TERMINAL_GROUP_NAME} (${TERMINAL_GROUP_FOLDER})`,
    buildTerminalStatusLine().replace(/\x1b\[[0-9;]*m/g, ''),
    buildTerminalObservabilitySummary(),
  ].join('\n');
}

export function buildTerminalObservabilitySummary(): string {
  const snapshot = buildFrameworkObservabilitySnapshot({
    groupFolder: TERMINAL_GROUP_FOLDER,
  });
  const { governance } = snapshot;
  return [
    `framework.graphs: ${governance.totalGraphs}`,
    `framework.executions: ${governance.totalExecutions}`,
    `framework.edgeFallbackRate: ${governance.edgeToHeavyFallbackRate}`,
    `framework.commitConflictRate: ${governance.commitConflictRate}`,
  ].join('\n');
}

type LocalCommand =
  | '/help'
  | '/status'
  | '/agents'
  | '/graph'
  | '/tasks'
  | '/task'
  | '/new'
  | '/session'
  | '/logs'
  | '/clear'
  | '/exit'
  | '/quit';

class TerminalChannel implements Channel {
  name = 'terminal';
  private connected = false;
  private rl: readline.Interface | null = null;
  private lastAssistantMessageByJid = new Map<string, string>();
  private typingByJid = new Set<string>();
  private lastPromptSignature: string | null = null;

  constructor(private readonly opts: ChannelOpts) {}

  async connect(): Promise<void> {
    this.connected = true;
    activeTerminalChannel = this;
    this.opts.onChatMetadata(
      TERMINAL_GROUP_JID,
      new Date().toISOString(),
      TERMINAL_GROUP_NAME,
      this.name,
      true,
    );

    this.rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
      terminal: true,
    });

    this.renderHeader();
    this.renderPrompt();

    this.rl.on('line', (line) => {
      void this.handleLine(line);
    });
  }

  private async handleLine(line: string): Promise<void> {
    const text = line.trim();
    if (!text) {
      this.renderPrompt();
      return;
    }

    if (await this.handleLocalCommand(text)) {
      return;
    }

    const now = new Date().toISOString();
    this.lastAssistantMessageByJid.delete(TERMINAL_GROUP_JID);
    this.opts.onMessage(TERMINAL_GROUP_JID, {
      id: `terminal:${Date.now()}:${Math.random().toString(36).slice(2, 8)}`,
      chat_jid: TERMINAL_GROUP_JID,
      sender: TERMINAL_USER_JID,
      sender_name: TERMINAL_USER_NAME,
      content: text,
      timestamp: now,
      is_from_me: false,
    });
  }

  private async handleLocalCommand(input: string): Promise<boolean> {
    const parts = input.trim().split(/\s+/);
    const command = parts[0] as LocalCommand | string;
    switch (command) {
      case '/exit':
      case '/quit':
        await this.disconnect();
        process.exit(0);
        return true;
      case '/help':
        this.renderLocalCommandResult(
          [
            '可用命令：',
            '/help  查看帮助',
            '/status 查看当前状态',
            '/agents 查看当前 team agents 状态',
            '/graph 查看当前 team graph 明细',
            '/tasks  查看当前任务',
            '/task list 查看任务详情',
            '/task pause <taskId> 暂停任务',
            '/task resume <taskId> 恢复任务',
            '/task delete <taskId> 删除任务',
            '/new  清空当前 terminal provider session',
            '/session clear 清空当前 terminal provider session',
            '/logs [n] 查看最近系统事件',
            '/clear  清空当前界面',
            '/quit   退出终端',
          ].join('\n'),
        );
        return true;
      case '/status':
        this.renderLocalCommandResult(buildTerminalStatusSummary());
        return true;
      case '/agents':
        this.renderLocalCommandResult(buildTerminalAgentsSummary());
        return true;
      case '/graph':
        this.renderLocalCommandResult(buildTerminalGraphSummary());
        return true;
      case '/tasks':
        this.renderLocalCommandResult(buildTerminalTasksSummary());
        return true;
      case '/task':
        await this.handleTaskCommand(parts.slice(1));
        return true;
      case '/new':
        await this.handleSessionCommand(['clear']);
        return true;
      case '/session':
        await this.handleSessionCommand(parts.slice(1));
        return true;
      case '/logs': {
        const count = Number.parseInt(parts[1] || '', 10);
        this.renderLocalCommandResult(
          buildTerminalLogsSummary(
            Number.isNaN(count) ? DEFAULT_LOG_TAIL : count,
          ),
        );
        return true;
      }
      case '/clear':
        console.clear();
        this.renderHeader();
        this.renderPrompt();
        return true;
      default:
        return false;
    }
  }

  private async handleTaskCommand(args: string[]): Promise<void> {
    this.renderLocalCommandResult(executeTerminalTaskCommand(args));
  }

  private async handleSessionCommand(args: string[]): Promise<void> {
    const action = args[0];
    if (!action || (action !== 'clear' && action !== 'new')) {
      this.renderLocalCommandResult('用法：/session <clear>');
      return;
    }

    await this.opts.onResetSession?.(TERMINAL_GROUP_FOLDER);
    this.lastAssistantMessageByJid.delete(TERMINAL_GROUP_JID);
    this.renderLocalCommandResult(
      '已清空当前 terminal provider session。下一条消息将从新会话开始。',
    );
  }

  private renderHeader(): void {
    process.stdout.write(
      [
        '',
        `${COLOR_CYAN}NanoClaw Edge Canary${COLOR_RESET}`,
        `${COLOR_DIM}聊天优先 · 少量系统事件 · /help 查看命令${COLOR_RESET}`,
        '',
      ].join('\n'),
    );
  }

  private renderPrompt(): void {
    if (!this.rl) return;
    const busy = this.typingByJid.has(TERMINAL_GROUP_JID);
    const prompt = busy
      ? `${buildTerminalStatusLine()}\n… `
      : `${buildTerminalStatusLine()}\nyou> `;
    if (this.lastPromptSignature === prompt) {
      return;
    }
    this.lastPromptSignature = prompt;
    this.rl.setPrompt(prompt);
    this.rl.prompt(true);
  }

  private writeBlock(label: string, text: string, color = COLOR_RESET): void {
    const normalized = text.replace(/\r\n/g, '\n').trimEnd();
    if (this.rl) {
      this.rl.pause();
    }
    if (!normalized.includes('\n')) {
      process.stdout.write(`\n${color}${label} ${normalized}${COLOR_RESET}\n`);
      this.rl?.resume();
      return;
    }
    process.stdout.write(
      `\n${color}${label}${COLOR_RESET}\n${indentBlock(normalized)}\n`,
    );
    this.rl?.resume();
  }

  private invalidatePrompt(): void {
    this.lastPromptSignature = null;
  }

  private renderAssistantMessage(text: string): void {
    this.writeBlock(`${assistantLabel()}>`, text, COLOR_GREEN);
  }

  private renderSystemMessage(text: string): void {
    this.writeBlock(`system [${formatClock()}]`, text, COLOR_YELLOW);
  }

  private renderLocalCommandResult(text: string): void {
    this.renderSystemMessage(text);
    this.invalidatePrompt();
    this.renderPrompt();
  }

  async sendMessage(jid: string, text: string): Promise<void> {
    if (!this.ownsJid(jid)) return;
    const normalized = text.trim();
    if (!normalized) return;
    if (this.lastAssistantMessageByJid.get(jid) === normalized) return;
    this.lastAssistantMessageByJid.set(jid, normalized);
    this.renderAssistantMessage(normalized);
    if (!this.typingByJid.has(jid)) {
      this.invalidatePrompt();
      this.renderPrompt();
    }
  }

  sendSystemEvent(jid: string, text: string): void {
    if (!this.ownsJid(jid)) return;
    const normalized = text.trim();
    if (!normalized) return;
    recordTerminalEvent(normalized);
    this.renderSystemMessage(normalized);
    if (!this.typingByJid.has(jid)) {
      this.invalidatePrompt();
      this.renderPrompt();
    }
  }

  async setTyping(jid: string, isTyping: boolean): Promise<void> {
    if (!this.ownsJid(jid)) return;

    if (isTyping) {
      if (this.typingByJid.has(jid)) return;
      this.typingByJid.add(jid);
      this.invalidatePrompt();
      this.renderSystemMessage('处理中…');
      this.renderPrompt();
      return;
    }

    if (!this.typingByJid.has(jid)) return;
    this.typingByJid.delete(jid);
    this.invalidatePrompt();
    this.renderPrompt();
  }

  isConnected(): boolean {
    return this.connected;
  }

  ownsJid(jid: string): boolean {
    return jid === TERMINAL_GROUP_JID;
  }

  async disconnect(): Promise<void> {
    this.connected = false;
    this.lastAssistantMessageByJid.clear();
    this.typingByJid.clear();
    this.lastPromptSignature = null;
    if (activeTerminalChannel === this) {
      activeTerminalChannel = null;
    }
    this.rl?.close();
    this.rl = null;
  }
}

export function emitTerminalSystemEvent(jid: string, text: string): void {
  activeTerminalChannel?.sendSystemEvent(jid, text);
}

registerChannel('terminal', (opts) => {
  if (!TERMINAL_CHANNEL_ENABLED) return null;
  return new TerminalChannel(opts);
});
