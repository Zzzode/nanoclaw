import type {
  AgentRunOutput,
  ExecutionContext,
  ExecutionPlanFragment,
} from './agent-backend.js';
import { buildExecutionRequest } from './backends/edge-backend.js';
import type { FrameworkRunContext } from './framework-orchestrator.js';
import type { FrameworkWorker } from './framework-worker.js';
import {
  beginExecution,
  completeExecution,
  deriveExecutionLeaseMs,
  failExecution,
} from './execution-state.js';
import { executeEdgeTool } from './edge-tool-host.js';
import { FRAMEWORK_POLICY_VERSION } from './framework-policy.js';
import { emitTerminalSystemEvent } from './channels/terminal.js';
import {
  completeTerminalTurn,
  completeTerminalWorker,
  ensureTerminalWorker,
  failTerminalTurn,
  failTerminalWorker,
  updateTerminalTurnStage,
} from './terminal-observability.js';
import {
  addTaskNodeDependency,
  completeRootTaskGraph,
  completeTaskNode,
  createAggregateTaskNode,
  createTaskNodeInGraph,
  failRootTaskGraph,
  failTaskNode,
  markTaskNodeRunning,
} from './task-graph-state.js';
import { getWorkspaceManifest } from './workspace-service.js';
import type { RegisteredGroup } from './types.js';

interface EdgeTeamRole {
  index: number;
  title: string;
}

interface EdgeTeamReminder {
  prompt: string;
  scheduleValue: string;
}

export interface EdgeTeamPlan {
  teamSize: number;
  roles: EdgeTeamRole[];
  reminders: EdgeTeamReminder[];
}

interface EdgeTeamPlannerResult {
  shouldFanout: boolean;
  teamSize: number;
  roles: EdgeTeamRole[];
  reason?: string;
}

export interface EdgeTeamOrchestrationOptions {
  group: RegisteredGroup;
  prompt: string;
  chatJid: string;
  isMain: boolean;
  assistantName: string;
  frameworkRun: FrameworkRunContext;
  edgeWorker: FrameworkWorker;
  onOutput?: (output: AgentRunOutput) => Promise<void>;
  now?: Date;
}

export type EdgeTeamOrchestrationResult =
  | { handled: false }
  | { handled: true; status: 'success' | 'error' };

const TEAM_TRIGGER_PATTERN =
  /\bagent\s+team\b/i;
const EDGE_TEAM_EXECUTION_DEADLINE_MS = 90 * 1000;
const EDGE_TEAM_PLANNER_OUTPUT_PREVIEW_LIMIT = 240;
const GROUNDED_TERMINAL_COMMANDS = [
  '/status',
  '/tasks',
  '/task list',
  '/task pause <taskId>',
  '/task resume <taskId>',
  '/task delete <taskId>',
  '/logs [n]',
  '/clear',
  '/quit',
] as const;
const GROUNDED_REPO_COMMANDS = [
  'npm run build',
  'node dist/index.js',
  'sqlite3 store/messages.db "<query>"',
] as const;
const FORBIDDEN_FAKE_COMMANDS = [
  'claw --version',
  'claw doctor',
  'claw config validate',
  'claw deps check',
  'claw test --adapter terminal',
  'claw hooks install',
  'claw launch',
] as const;

function formatDurationMs(durationMs: number): string {
  if (durationMs < 1000) return `${durationMs}ms`;
  return `${(durationMs / 1000).toFixed(1)}s`;
}

function emitTeamProgress(chatJid: string, text: string): void {
  emitTerminalSystemEvent(chatJid, text);
}

function previewWorkerSummary(text: string | null | undefined): string | undefined {
  const normalized = typeof text === 'string' ? text.replace(/\s+/g, ' ').trim() : '';
  if (!normalized) return undefined;
  return normalized.length <= 180 ? normalized : `${normalized.slice(0, 180)}...`;
}

function parseChineseNumeral(value: string): number | null {
  const map: Record<string, number> = {
    一: 1,
    二: 2,
    两: 2,
    三: 3,
    四: 4,
    五: 5,
    六: 6,
    七: 7,
    八: 8,
    九: 9,
  };
  return map[value] ?? null;
}

function extractTeamSize(prompt: string, roleCount: number): number {
  const explicitMatch =
    prompt.match(/(\d+)\s*-\s*agent\s*team/i) ??
    prompt.match(/(\d+)\s*agent\s*team/i) ??
    prompt.match(/([一二两三四五六七八九])\s*个?\s*agent/i);
  const rawValue = explicitMatch?.[1];
  if (rawValue) {
    return (
      Number.parseInt(rawValue, 10) ||
      parseChineseNumeral(rawValue) ||
      roleCount
    );
  }
  return roleCount > 0 ? roleCount : 3;
}

function parseReminders(prompt: string, now: Date): EdgeTeamReminder[] {
  const reminders: EdgeTeamReminder[] = [];

  const startPattern = /(\d+)\s*(分钟|小时)后提醒我/g;
  const matches = Array.from(prompt.matchAll(startPattern));

  for (const [index, match] of matches.entries()) {
    const amount = Number.parseInt(match[1] || '', 10);
    const unit = match[2];
    const bodyStart = (match.index ?? 0) + match[0].length;
    const nextStart = matches[index + 1]?.index ?? prompt.length;
    const body = prompt
      .slice(bodyStart, nextStart)
      .replace(/^[，,\s]*(?:一个|再)?\s*/u, '')
      .replace(/(?:，|,)\s*一个\s*$/u, '')
      .replace(/[，,\s]*(?:一个|再)?$/u, '')
      .replace(/[，,；;。\s]+$/g, '')
      .trim();
    if (!Number.isFinite(amount) || amount <= 0 || !body) continue;

    const deltaMs =
      unit === '小时' ? amount * 60 * 60 * 1000 : amount * 60 * 1000;
    reminders.push({
      prompt: `提醒我${body}`,
      scheduleValue: new Date(now.getTime() + deltaMs).toISOString(),
    });
  }

  return reminders;
}

export function shouldUseEdgeTeamPlanner(prompt: string): boolean {
  if (!TEAM_TRIGGER_PATTERN.test(prompt)) return false;

  return extractTeamSize(prompt, 0) >= 2;
}

function normalizePlannerRoles(
  teamSize: number,
  rawRoles: unknown,
): EdgeTeamRole[] {
  if (!Array.isArray(rawRoles)) return [];

  return rawRoles
    .map((role, offset) => {
      if (!role || typeof role !== 'object' || Array.isArray(role)) {
        return null;
      }
      const candidate = role as { title?: unknown };
      const title =
        typeof candidate.title === 'string' ? candidate.title.trim() : '';
      if (!title) return null;
      return {
        index: offset + 1,
        title,
      };
    })
    .filter((role): role is EdgeTeamRole => role !== null)
    .slice(0, teamSize);
}

function sanitizePlannerResult(
  result: unknown,
  fallbackTeamSize: number,
): EdgeTeamPlannerResult | null {
  if (!result || typeof result !== 'object' || Array.isArray(result)) {
    return null;
  }

  const parsed = result as {
    shouldFanout?: unknown;
    teamSize?: unknown;
    roles?: unknown;
    reason?: unknown;
  };

  const reason =
    typeof parsed.reason === 'string' && parsed.reason.trim()
      ? parsed.reason.trim()
      : undefined;

  if (parsed.shouldFanout !== true) {
    return {
      shouldFanout: false,
      teamSize: fallbackTeamSize,
      roles: [],
      ...(reason ? { reason } : {}),
    };
  }

  const requestedTeamSize =
    typeof parsed.teamSize === 'number' && Number.isFinite(parsed.teamSize)
      ? Math.trunc(parsed.teamSize)
      : fallbackTeamSize;
  const teamSize = Math.max(2, requestedTeamSize);
  const roles = normalizePlannerRoles(teamSize, parsed.roles);
  if (roles.length !== teamSize) return null;

  return {
    shouldFanout: true,
    teamSize,
    roles,
    ...(reason ? { reason } : {}),
  };
}

function extractJsonObject(text: string): string | null {
  const fencedMatch = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = fencedMatch?.[1] ?? text;
  const trimmed = candidate.trim();
  if (!trimmed) return null;
  const start = trimmed.indexOf('{');
  const end = trimmed.lastIndexOf('}');
  if (start === -1 || end === -1 || end <= start) return null;
  return trimmed.slice(start, end + 1);
}

function parsePlannerOutput(
  output: AgentRunOutput,
  fallbackTeamSize: number,
): EdgeTeamPlannerResult | null {
  if (output.status !== 'success' || !output.result) return null;
  const jsonText = extractJsonObject(output.result);
  if (!jsonText) return null;

  try {
    return sanitizePlannerResult(JSON.parse(jsonText), fallbackTeamSize);
  } catch {
    return null;
  }
}

function previewPlannerOutput(text: string | null | undefined): string {
  const normalized = typeof text === 'string' ? text.trim() : '';
  if (!normalized) return '(empty output)';
  if (normalized.length <= EDGE_TEAM_PLANNER_OUTPUT_PREVIEW_LIMIT) {
    return normalized;
  }
  return `${normalized.slice(0, EDGE_TEAM_PLANNER_OUTPUT_PREVIEW_LIMIT)}...`;
}

function formatWorkspaceFileList(workspaceVersion: string): string {
  try {
    const manifest = getWorkspaceManifest(workspaceVersion);
    const files = Object.keys(manifest).sort();
    if (files.length === 0) return '（workspace 为空）';
    return files.join(', ');
  } catch {
    return '（workspace 信息不可用）';
  }
}

function buildPlannerPrompt(
  prompt: string,
  requestedTeamSize: number,
  workspaceVersion: string,
): string {
  const fileList = formatWorkspaceFileList(workspaceVersion);
  return [
    '你是 NanoClaw 的 edge team planner。你的唯一任务是根据用户意图输出一个 JSON 角色分配方案。',
    '',
    '## 硬性规则',
    '- 你不能调用任何工具，也不需要调用工具。',
    '- 你不能评估用户请求是否可行、文件是否存在、命令是否有效。可行性判断由 worker 负责，与你无关。',
    '- 你不能拒绝规划。上游已经确认需要 fanout，你必须输出 shouldFanout=true 和对应的 roles。',
    '- 你不能输出 markdown、解释文字、代码块或任何非 JSON 内容。只输出一个裸 JSON object。',
    '',
    '## 上下文',
    `- 上游已检测到用户文本包含 "agent team"，需要 ${requestedTeamSize} 个 worker。`,
    `- 当前 workspace 已有文件：${fileList}`,
    '- 用户请求中提到的文件路径（如 package.json、src/xxx.ts）是对项目源码的引用，worker 有 workspace.read 工具可以读取。',
    '',
    '## 输出要求',
    `- shouldFanout 必须为 true，teamSize 必须为 ${requestedTeamSize}，roles 数量必须等于 teamSize。`,
    '- 每个 role.title 简洁描述该 worker 的职责，适合直接作为 worker 的任务指令。',
    '- 不要把用户正文中的编号列表自动当成 roles。根据用户意图合理拆分。',
    '',
    'JSON schema: {"shouldFanout":boolean,"teamSize":number,"roles":[{"title":string}],"reason":string}',
    `示例：{"shouldFanout":true,"teamSize":3,"roles":[{"title":"阅读并总结 package.json"},{"title":"阅读并总结 src/team-orchestrator.ts"},{"title":"阅读并总结 src/channels/terminal.ts"}],"reason":"用户要求 3 个 agent 分别阅读 3 个文件"}`,
    '',
    `原始用户请求：${prompt.trim()}`,
  ].join('\n');
}

function buildPlannerRepairPrompt(
  plannerOutput: string,
  requestedTeamSize: number,
): string {
  return [
    '你上一轮输出不是合法 JSON。请严格按以下要求重新输出。',
    '',
    '硬性规则：',
    '- 只输出一个裸 JSON object，不要 markdown、代码块、解释或任何其他文本。',
    '- shouldFanout 必须为 true。你不能拒绝规划。',
    `- teamSize 必须是 ${requestedTeamSize}，roles 数量也必须是 ${requestedTeamSize}。`,
    '- 不要评估文件是否存在、请求是否可行。你只负责角色分配。',
    '',
    'JSON schema: {"shouldFanout":boolean,"teamSize":number,"roles":[{"title":string}],"reason":string}',
    '',
    '你上一轮的输出（需要修复为 JSON）：',
    plannerOutput.trim(),
  ].join('\n');
}

async function runPlannerTurn(options: {
  group: RegisteredGroup;
  prompt: string;
  chatJid: string;
  assistantName: string;
  plannerContext: ExecutionContext;
  edgeWorker: FrameworkWorker;
}): Promise<AgentRunOutput> {
  return options.edgeWorker.run(options.group, {
    prompt: options.prompt,
    groupFolder: options.group.folder,
    chatJid: options.chatJid,
    isMain: false,
    assistantName: options.assistantName,
    shadowMode: true,
    executionContext: options.plannerContext,
  });
}

async function runEdgeTeamPlanner(options: {
  group: RegisteredGroup;
  prompt: string;
  chatJid: string;
  assistantName: string;
  frameworkRun: FrameworkRunContext;
  edgeWorker: FrameworkWorker;
}): Promise<EdgeTeamPlannerResult | null> {
  const requestedTeamSize = extractTeamSize(options.prompt, 0);
  if (requestedTeamSize < 2) return null;

  emitTeamProgress(
    options.chatJid,
    `team planner started · requested ${requestedTeamSize} workers`,
  );
  ensureTerminalWorker({
    chatJid: options.chatJid,
    key: 'planner',
    roleTitle: 'team planner',
    backendId: 'edge',
    workerClass: 'edge',
    executionId: options.frameworkRun.execution.executionId,
    status: 'running',
    activity: `requested ${requestedTeamSize} workers`,
  });

  const plannerContext: ExecutionContext = {
    ...options.frameworkRun.executionContext,
    taskNodeId: options.frameworkRun.graph.rootTaskId,
    parentTaskId: null,
    workerClass: 'edge',
    capabilityBudget: {
      capabilities: [],
      maxToolCalls: 0,
    },
    deadline: {
      ...options.frameworkRun.executionContext.deadline,
      deadlineMs: Math.min(
        options.frameworkRun.executionContext.deadline?.deadlineMs ??
          EDGE_TEAM_EXECUTION_DEADLINE_MS,
        EDGE_TEAM_EXECUTION_DEADLINE_MS,
      ),
    },
    idempotencyKey: `${options.frameworkRun.execution.executionId}:${options.frameworkRun.graph.rootTaskId}:team-planner`,
    planFragment: {
      ...(options.frameworkRun.executionContext.planFragment ?? {
        kind: 'single_root',
      }),
      kind: 'edge_team_planner',
      fanoutTeamSize: requestedTeamSize,
      fanoutRole: 'team-planner',
    },
    baseWorkspaceVersion: options.frameworkRun.baseWorkspaceVersion,
  };

  const plannerPrompt = buildPlannerPrompt(
    options.prompt,
    requestedTeamSize,
    options.frameworkRun.baseWorkspaceVersion,
  );
  const plannerOutput = await runPlannerTurn({
    group: options.group,
    prompt: plannerPrompt,
    chatJid: options.chatJid,
    assistantName: options.assistantName,
    plannerContext,
    edgeWorker: options.edgeWorker,
  });
  if (plannerOutput.status === 'error') {
    failTerminalWorker({
      chatJid: options.chatJid,
      key: 'planner',
      error: plannerOutput.error || 'Unknown error',
      activity: 'planner failed',
    });
    emitTeamProgress(
      options.chatJid,
      `team planner failed · ${plannerOutput.error || 'Unknown error'}`,
    );
    return null;
  }

  const parsedPlannerOutput = parsePlannerOutput(
    plannerOutput,
    requestedTeamSize,
  );
  if (parsedPlannerOutput) {
    completeTerminalWorker({
      chatJid: options.chatJid,
      key: 'planner',
      activity: parsedPlannerOutput.shouldFanout
        ? `accepted fanout · ${parsedPlannerOutput.teamSize} workers`
        : `rejected fanout · ${parsedPlannerOutput.reason || 'no reason'}`,
      summary: parsedPlannerOutput.reason,
    });
    emitTeamProgress(
      options.chatJid,
      parsedPlannerOutput.shouldFanout
        ? `team planner accepted fanout · ${parsedPlannerOutput.teamSize} workers`
        : `team planner rejected fanout · ${parsedPlannerOutput.reason || 'no reason'}`,
    );
    return parsedPlannerOutput;
  }

  emitTeamProgress(
    options.chatJid,
    `team planner returned invalid output · ${previewPlannerOutput(plannerOutput.result)}`,
  );
  ensureTerminalWorker({
    chatJid: options.chatJid,
    key: 'planner',
    status: 'running',
    activity: 'planner output invalid, retrying repair',
    summary: previewPlannerOutput(plannerOutput.result),
  });

  const repairOutput = await runPlannerTurn({
    group: options.group,
    prompt: buildPlannerRepairPrompt(
      plannerOutput.result || '',
      requestedTeamSize,
    ),
    chatJid: options.chatJid,
    assistantName: options.assistantName,
    plannerContext: {
      ...plannerContext,
      idempotencyKey: `${plannerContext.idempotencyKey}:repair`,
    },
    edgeWorker: options.edgeWorker,
  });
  if (repairOutput.status === 'error') {
    failTerminalWorker({
      chatJid: options.chatJid,
      key: 'planner',
      error: repairOutput.error || 'Unknown error',
      activity: 'planner repair failed',
    });
    emitTeamProgress(
      options.chatJid,
      `team planner repair failed · ${repairOutput.error || 'Unknown error'}`,
    );
    return null;
  }

  const repairedPlan = parsePlannerOutput(repairOutput, requestedTeamSize);
  if (!repairedPlan) {
    failTerminalWorker({
      chatJid: options.chatJid,
      key: 'planner',
      error: previewPlannerOutput(repairOutput.result) || 'repair invalid',
      activity: 'planner repair still invalid',
    });
    emitTeamProgress(
      options.chatJid,
      `team planner repair still invalid · ${previewPlannerOutput(repairOutput.result)}`,
    );
    return null;
  }

  emitTeamProgress(
    options.chatJid,
    repairedPlan.shouldFanout
      ? `team planner repair accepted fanout · ${repairedPlan.teamSize} workers`
      : `team planner repair rejected fanout · ${repairedPlan.reason || 'no reason'}`,
  );
  completeTerminalWorker({
    chatJid: options.chatJid,
    key: 'planner',
    activity: repairedPlan.shouldFanout
      ? `repair accepted fanout · ${repairedPlan.teamSize} workers`
      : `repair rejected fanout · ${repairedPlan.reason || 'no reason'}`,
    summary: repairedPlan.reason,
  });
  return repairedPlan;
}

export function detectEdgeTeamPlan(
  prompt: string,
  plannerResult: EdgeTeamPlannerResult | null,
  now: Date = new Date(),
): EdgeTeamPlan | null {
  if (!shouldUseEdgeTeamPlanner(prompt)) return null;

  if (!plannerResult?.shouldFanout) return null;

  if (plannerResult.roles.length < 2) return null;

  return {
    teamSize: plannerResult.teamSize,
    roles: plannerResult.roles,
    reminders: parseReminders(prompt, now),
  };
}

function buildFanoutPlanFragment(
  kind: Extract<
    ExecutionPlanFragment['kind'],
    'edge_fanout_child' | 'edge_fanout_aggregate'
  >,
  baseContext: ExecutionContext,
  teamSize: number,
  roleTitle?: string,
): ExecutionPlanFragment {
  return {
    ...(baseContext.planFragment ?? { kind: 'single_root' }),
    kind,
    policyVersion: FRAMEWORK_POLICY_VERSION,
    fanoutTeamSize: teamSize,
    ...(roleTitle ? { fanoutRole: roleTitle } : {}),
  };
}

function buildChildPrompt(
  role: EdgeTeamRole,
  prompt: string,
  teamSize: number,
  workspaceVersion: string,
): string {
  const allowedCommands = [
    ...GROUNDED_TERMINAL_COMMANDS,
    ...GROUNDED_REPO_COMMANDS,
  ].join('、');
  const forbiddenCommands = FORBIDDEN_FAKE_COMMANDS.join('、');
  return [
    `你是 edge team worker ${role.index}/${teamSize}。`,
    `原始用户请求：${prompt.trim()}`,
    `你的负责范围：${role.title}`,
    '你当前服务的项目是 NanoClaw 仓库，不是一个名为 claw 的独立 CLI 产品。',
    `当前 workspace 中的文件：${formatWorkspaceFileList(workspaceVersion)}`,
    '你有 workspace.read、workspace.list、workspace.search 工具可以使用，请用它们来读取和查找文件。',
    `如果要写命令，只能使用当前仓库里真实存在或本轮 runbook 已使用的命令：${allowedCommands}。`,
    `禁止虚构不存在的命令，例如：${forbiddenCommands}。`,
    '如果某条命令或能力无法从当前仓库文件中核实，明确写“未在当前仓库中找到对应命令”，不要编造。',
    '输出要求：只完成你负责的部分；避免重复其他 worker；给出简洁、准确、基于实际文件内容的总结。',
  ].join('\n');
}

function buildTaskNodeId(turnId: string, suffix: string): string {
  return `task:${turnId}:${suffix}`;
}

function buildChildExecutionContext(
  rootContext: ExecutionContext,
  executionId: string,
  turnId: string,
  logicalSessionId: string,
  taskId: string,
  teamSize: number,
  roleTitle: string,
): ExecutionContext {
  return {
    ...rootContext,
    executionId,
    turnId,
    logicalSessionId,
    taskNodeId: taskId,
    parentTaskId: rootContext.taskNodeId ?? null,
    workerClass: 'edge',
    deadline: {
      ...rootContext.deadline,
      deadlineMs: Math.min(
        rootContext.deadline?.deadlineMs ?? EDGE_TEAM_EXECUTION_DEADLINE_MS,
        EDGE_TEAM_EXECUTION_DEADLINE_MS,
      ),
    },
    idempotencyKey: `${executionId}:${taskId}`,
    planFragment: buildFanoutPlanFragment(
      'edge_fanout_child',
      rootContext,
      teamSize,
      roleTitle,
    ),
  };
}

function buildAggregateExecutionContext(
  rootContext: ExecutionContext,
  executionId: string,
  turnId: string,
  logicalSessionId: string,
  taskId: string,
  teamSize: number,
): ExecutionContext {
  return {
    ...rootContext,
    executionId,
    turnId,
    logicalSessionId,
    taskNodeId: taskId,
    parentTaskId: rootContext.taskNodeId ?? null,
    workerClass: 'edge',
    deadline: {
      ...rootContext.deadline,
      deadlineMs: Math.min(
        rootContext.deadline?.deadlineMs ?? EDGE_TEAM_EXECUTION_DEADLINE_MS,
        EDGE_TEAM_EXECUTION_DEADLINE_MS,
      ),
    },
    idempotencyKey: `${executionId}:${taskId}`,
    planFragment: buildFanoutPlanFragment(
      'edge_fanout_aggregate',
      rootContext,
      teamSize,
    ),
  };
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function scrubUngroundedContent(text: string): string {
  let sanitized = text;
  for (const command of FORBIDDEN_FAKE_COMMANDS) {
    const pattern = new RegExp(escapeRegExp(command), 'gi');
    sanitized = sanitized.replace(
      pattern,
      `未在当前仓库中找到对应命令（原输出包含：${command}）`,
    );
  }
  return sanitized;
}

function synthesizeAggregateResult(
  plan: EdgeTeamPlan,
  childResults: Array<{
    role: EdgeTeamRole;
    status: 'success' | 'error';
    result: string | null;
    error?: string;
  }>,
): string {
  const sections = childResults.map((result) => {
    const body =
      result.status === 'success'
        ? scrubUngroundedContent(result.result?.trim() || '') ||
          '（该 agent 未返回有效内容）'
        : `失败：${result.error || 'unknown error'}`;
    return `**${result.role.index}. ${result.role.title}**\n${body}`;
  });

  const successCount = childResults.filter(
    (result) => result.status === 'success',
  ).length;

  return [
    '**Terminal-only Claw Framework Launch Review**',
    `本轮由 ${plan.teamSize} 个 edge agents 并行完成，其中 ${successCount}/${plan.teamSize} 个成功返回。`,
    ...sections,
    '**简明计划**',
    '先按三块并行验证：目标与验收标准、风险与失败点、执行步骤与记录模板；完成后统一复盘 edge fanout、task 创建和回退表现。',
  ].join('\n\n');
}

async function createFollowUpTasks(options: {
  group: RegisteredGroup;
  chatJid: string;
  isMain: boolean;
  assistantName: string;
  executionContext: ExecutionContext;
  reminders: EdgeTeamReminder[];
}): Promise<string[]> {
  if (options.reminders.length === 0) return [];

  const taskToolExecutionContext: ExecutionContext = {
    ...options.executionContext,
    capabilityBudget: {
      capabilities: ['task.manage'],
      maxToolCalls:
        options.executionContext.capabilityBudget?.maxToolCalls ?? 12,
    },
    planFragment: {
      ...(options.executionContext.planFragment ?? { kind: 'single_root' }),
      kind: 'single_root',
    },
  };

  const request = buildExecutionRequest(options.group, {
    prompt: 'create follow-up reminders',
    groupFolder: options.group.folder,
    chatJid: options.chatJid,
    isMain: options.isMain,
    assistantName: options.assistantName,
    executionContext: taskToolExecutionContext,
  });

  const taskIds: string[] = [];
  for (const [index, reminder] of options.reminders.entries()) {
    const result = await executeEdgeTool(request, {
      tool: 'task.create',
      args: {
        prompt: reminder.prompt,
        scheduleType: 'once',
        scheduleValue: reminder.scheduleValue,
        operationId: `${options.executionContext.executionId}:follow-up:${index + 1}`,
      },
    });
    const taskId =
      result.result &&
      typeof result.result === 'object' &&
      !Array.isArray(result.result) &&
      typeof (result.result as { taskId?: unknown }).taskId === 'string'
        ? (result.result as { taskId: string }).taskId
        : null;
    if (taskId) taskIds.push(taskId);
  }

  return taskIds;
}

export async function maybeRunEdgeTeamOrchestration(
  options: EdgeTeamOrchestrationOptions,
): Promise<EdgeTeamOrchestrationResult> {
  if (options.frameworkRun.placement.backendId !== 'edge') {
    return { handled: false };
  }

  if (!shouldUseEdgeTeamPlanner(options.prompt)) {
    return { handled: false };
  }

  const plannerResult = await runEdgeTeamPlanner({
    group: options.group,
    prompt: options.prompt,
    chatJid: options.chatJid,
    assistantName: options.assistantName,
    frameworkRun: options.frameworkRun,
    edgeWorker: options.edgeWorker,
  });

  const plan = detectEdgeTeamPlan(options.prompt, plannerResult, options.now);
  if (!plan) {
    return { handled: false };
  }

  const { graph, execution, executionContext } = options.frameworkRun;
  const childTaskIds = plan.roles.map((role) =>
    buildTaskNodeId(execution.turnId, `child-${role.index}`),
  );
  const aggregateTaskId = buildTaskNodeId(execution.turnId, 'aggregate');

  for (const [index] of plan.roles.entries()) {
    createTaskNodeInGraph({
      taskId: childTaskIds[index]!,
      graphId: graph.graphId,
      parentTaskId: graph.rootTaskId,
      nodeKind: 'fanout_child',
      workerClass: 'edge',
      backendId: 'edge',
      requiredCapabilities: ['fs.read', 'task.manage'],
      routeReason: 'edge.team_fanout',
      policyVersion: FRAMEWORK_POLICY_VERSION,
      fallbackEligible: false,
    });
  }

  createAggregateTaskNode({
    taskId: aggregateTaskId,
    graphId: graph.graphId,
    parentTaskId: graph.rootTaskId,
    workerClass: 'edge',
    backendId: 'edge',
    aggregatePolicy: 'best_effort',
    dependsOnTaskIds: childTaskIds,
    requiredCapabilities: ['fs.read', 'task.manage'],
    routeReason: 'edge.team_aggregate',
    policyVersion: FRAMEWORK_POLICY_VERSION,
    fallbackEligible: false,
  });
  addTaskNodeDependency(graph.rootTaskId, aggregateTaskId);

  try {
    updateTerminalTurnStage({
      chatJid: options.chatJid,
      graphId: graph.graphId,
      rootTaskId: graph.rootTaskId,
      executionId: execution.executionId,
      stage: 'team_graph_running',
      backendId: 'edge',
      workerClass: 'edge',
      activity: `team graph started · ${plan.teamSize} workers`,
    });
    emitTeamProgress(
      options.chatJid,
      `team graph started: ${graph.graphId} · ${plan.teamSize} workers`,
    );
    await options.onOutput?.({
      status: 'success',
      result: `已启动 ${plan.teamSize} 个 edge agents 并行处理，正在等待汇总结果。`,
    });

    const childRuns = await Promise.all(
      plan.roles.map(async (role, index) => {
        const taskId = childTaskIds[index]!;
        const workerKey = `worker-${role.index}`;
        const lease = beginExecution({
          scopeType: 'task',
          scopeId: taskId,
          backend: 'edge',
          taskNodeId: taskId,
          groupJid: options.chatJid,
          baseWorkspaceVersion: options.frameworkRun.baseWorkspaceVersion,
          leaseMs: deriveExecutionLeaseMs(
            executionContext.deadline?.deadlineMs ??
              EDGE_TEAM_EXECUTION_DEADLINE_MS,
          ),
        });
        markTaskNodeRunning(graph.graphId, taskId);

        const childContext = buildChildExecutionContext(
          executionContext,
          lease.executionId,
          lease.turnId,
          lease.logicalSessionId,
          taskId,
          plan.teamSize,
          role.title,
        );

        emitTeamProgress(
          options.chatJid,
          `worker ${role.index}/${plan.teamSize} started · ${role.title}`,
        );
        ensureTerminalWorker({
          chatJid: options.chatJid,
          key: workerKey,
          taskId,
          nodeKind: 'fanout_child',
          roleTitle: role.title,
          backendId: 'edge',
          workerClass: 'edge',
          executionId: lease.executionId,
          status: 'running',
          activity: `started · ${role.title}`,
        });
        const startedAt = Date.now();

        const output = await options.edgeWorker.run(options.group, {
          prompt: buildChildPrompt(role, options.prompt, plan.teamSize, options.frameworkRun.baseWorkspaceVersion),
          groupFolder: options.group.folder,
          chatJid: options.chatJid,
          isMain: options.isMain,
          assistantName: options.assistantName,
          executionContext: childContext,
        });

        if (output.status === 'error') {
          failTerminalWorker({
            chatJid: options.chatJid,
            key: workerKey,
            error: output.error || 'Unknown error',
            activity: `failed in ${formatDurationMs(Date.now() - startedAt)}`,
          });
          emitTeamProgress(
            options.chatJid,
            `worker ${role.index}/${plan.teamSize} failed in ${formatDurationMs(
              Date.now() - startedAt,
            )} · ${output.error || 'Unknown error'}`,
          );
          failExecution(lease.executionId, output.error || 'Unknown error');
          failTaskNode(taskId, output.error || 'Unknown error');
          return {
            role,
            status: 'error' as const,
            result: null,
            error: output.error || 'Unknown error',
          };
        }

        completeExecution(lease.executionId);
        completeTaskNode(taskId);
        completeTerminalWorker({
          chatJid: options.chatJid,
          key: workerKey,
          activity: `completed in ${formatDurationMs(Date.now() - startedAt)}`,
          summary: previewWorkerSummary(output.result),
        });
        emitTeamProgress(
          options.chatJid,
          `worker ${role.index}/${plan.teamSize} completed in ${formatDurationMs(
            Date.now() - startedAt,
          )}`,
        );
        return {
          role,
          status: 'success' as const,
          result: output.result,
        };
      }),
    );

    const successfulChildCount = childRuns.filter(
      (run) => run.status === 'success',
    ).length;
    await options.onOutput?.({
      status: 'success',
      result: `${successfulChildCount}/${plan.teamSize} 个 edge agents 已返回，正在进行最终汇总。`,
    });
    updateTerminalTurnStage({
      chatJid: options.chatJid,
      stage: 'team_aggregating',
      backendId: 'edge',
      workerClass: 'edge',
      activity: `${successfulChildCount}/${plan.teamSize} workers finished`,
    });

    const aggregateLease = beginExecution({
      scopeType: 'task',
      scopeId: aggregateTaskId,
      backend: 'edge',
      taskNodeId: aggregateTaskId,
      groupJid: options.chatJid,
      baseWorkspaceVersion: options.frameworkRun.baseWorkspaceVersion,
      leaseMs: deriveExecutionLeaseMs(
        executionContext.deadline?.deadlineMs ??
          EDGE_TEAM_EXECUTION_DEADLINE_MS,
      ),
    });
    markTaskNodeRunning(graph.graphId, aggregateTaskId);

    const aggregateContext = buildAggregateExecutionContext(
      executionContext,
      aggregateLease.executionId,
      aggregateLease.turnId,
      aggregateLease.logicalSessionId,
      aggregateTaskId,
      plan.teamSize,
    );

    emitTeamProgress(options.chatJid, `aggregate started · ${aggregateTaskId}`);
    ensureTerminalWorker({
      chatJid: options.chatJid,
      key: 'aggregate',
      taskId: aggregateTaskId,
      nodeKind: 'aggregate',
      roleTitle: 'aggregate',
      backendId: 'edge',
      workerClass: 'edge',
      executionId: aggregateLease.executionId,
      status: 'running',
      activity: 'aggregate started',
    });

    completeExecution(aggregateLease.executionId);
    completeTaskNode(aggregateTaskId);
    completeTerminalWorker({
      chatJid: options.chatJid,
      key: 'aggregate',
      activity: 'aggregate completed',
    });
    emitTeamProgress(
      options.chatJid,
      `aggregate completed · ${aggregateTaskId}`,
    );

    const aggregateText = synthesizeAggregateResult(plan, childRuns);

    let followUpTaskIds: string[] = [];
    let followUpWarning = '';
    try {
      followUpTaskIds = await createFollowUpTasks({
        group: options.group,
        chatJid: options.chatJid,
        isMain: options.isMain,
        assistantName: options.assistantName,
        executionContext: aggregateContext,
        reminders: plan.reminders,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      followUpWarning = `\nFollow-up tasks 创建失败：${message}`;
      failTerminalWorker({
        chatJid: options.chatJid,
        key: 'aggregate',
        error: message,
        activity: 'follow-up task creation failed',
      });
      emitTeamProgress(
        options.chatJid,
        `follow-up task creation failed · ${message}`,
      );
    }

    if (followUpTaskIds.length > 0) {
      emitTeamProgress(
        options.chatJid,
        `follow-up tasks created · ${followUpTaskIds.join(', ')}`,
      );
    }

    const finalText = [
      aggregateText,
      followUpTaskIds.length > 0
        ? `\nFollow-up tasks: ${followUpTaskIds.join(', ')}`
        : '',
      followUpWarning,
    ]
      .join('')
      .trim();

    if (finalText) {
      await options.onOutput?.({
        status: 'success',
        result: finalText,
      });
    }

    completeExecution(execution.executionId);
    completeRootTaskGraph(graph.graphId, graph.rootTaskId);
    completeTerminalTurn({
      chatJid: options.chatJid,
      stage: 'team_completed',
      activity: `team graph completed: ${graph.graphId}`,
      summary: previewWorkerSummary(finalText),
    });
    emitTeamProgress(options.chatJid, `team graph completed: ${graph.graphId}`);
    return { handled: true, status: 'success' };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    failExecution(execution.executionId, message);
    failRootTaskGraph(graph.graphId, graph.rootTaskId, message);
    failTerminalTurn({
      chatJid: options.chatJid,
      stage: 'team_failed',
      error: message,
      activity: `team graph failed: ${graph.graphId} · ${message}`,
    });
    emitTeamProgress(
      options.chatJid,
      `team graph failed: ${graph.graphId} · ${message}`,
    );
    return { handled: true, status: 'error' };
  }
}
