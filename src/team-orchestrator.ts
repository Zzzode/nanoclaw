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
  addTaskNodeDependency,
  completeRootTaskGraph,
  completeTaskNode,
  createAggregateTaskNode,
  createTaskNodeInGraph,
  failRootTaskGraph,
  failTaskNode,
  markTaskNodeRunning,
} from './task-graph-state.js';
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
  /(?:\b\d+\s*[- ]?agent\s+team\b|创建.{0,16}agent\s+team|创建.{0,12}team|并行|parallel)/i;
const EDGE_TEAM_EXECUTION_DEADLINE_MS = 90 * 1000;
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
const GROUNDING_SOURCE_PATHS = [
  'package.json',
  'src/channels/terminal.ts',
  'docs/superpowers/followups/2026-04-07-edge-concurrency-launch-review-runbook.md',
  'docs/superpowers/followups/2026-04-07-claw-framework-dogfooding-runbook.md',
] as const;

function formatDurationMs(durationMs: number): string {
  if (durationMs < 1000) return `${durationMs}ms`;
  return `${(durationMs / 1000).toFixed(1)}s`;
}

function emitTeamProgress(chatJid: string, text: string): void {
  emitTerminalSystemEvent(chatJid, text);
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

function extractNumberedRoles(prompt: string): EdgeTeamRole[] {
  const roles: EdgeTeamRole[] = [];
  const rolePattern =
    /(?:^|[\n，,；;：:])\s*(\d+)[\)\]）.、:：]\s*([\s\S]*?)(?=(?:[\n，,；;：:]\s*\d+[\)\]）.、:：])|(?:最后统一汇总|最后汇总|并创建|创建\s*\d+\s*个?\s*follow-up)|$)/g;

  for (const match of prompt.matchAll(rolePattern)) {
    const index = Number.parseInt(match[1] || '', 10);
    const title = match[2]?.trim().replace(/[，,；;。\s]+$/g, '');
    if (!Number.isFinite(index) || !title) continue;
    roles.push({ index, title });
  }

  return roles.sort((left, right) => left.index - right.index);
}

function buildFallbackRoles(teamSize: number, prompt: string): EdgeTeamRole[] {
  return Array.from({ length: teamSize }, (_, offset) => ({
    index: offset + 1,
    title:
      offset === 0
        ? `拆解用户目标与验收标准：${prompt.trim()}`
        : offset === 1
          ? `识别主要风险、失败点与回退条件：${prompt.trim()}`
          : `整理执行步骤、观察指标与结果记录方式：${prompt.trim()}`,
  }));
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

export function detectEdgeTeamPlan(
  prompt: string,
  now: Date = new Date(),
): EdgeTeamPlan | null {
  if (!TEAM_TRIGGER_PATTERN.test(prompt)) return null;

  const numberedRoles = extractNumberedRoles(prompt);
  const teamSize = extractTeamSize(prompt, numberedRoles.length);
  if (teamSize < 2) return null;

  const roles =
    numberedRoles.length > 0
      ? numberedRoles.slice(0, teamSize)
      : buildFallbackRoles(teamSize, prompt);

  if (roles.length < 2) return null;

  return {
    teamSize: roles.length,
    roles,
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
): string {
  const allowedCommands = [
    ...GROUNDED_TERMINAL_COMMANDS,
    ...GROUNDED_REPO_COMMANDS,
  ].join('、');
  const forbiddenCommands = FORBIDDEN_FAKE_COMMANDS.join('、');
  const sourcePaths = GROUNDING_SOURCE_PATHS.join('、');
  return [
    `你是 edge team worker ${role.index}/${teamSize}。`,
    `原始用户请求：${prompt.trim()}`,
    `你的负责范围：${role.title}`,
    '你当前服务的项目是 NanoClaw 仓库，不是一个名为 claw 的独立 CLI 产品。',
    `在回答前，优先基于这些仓库文件核实事实：${sourcePaths}。`,
    `如果要写命令，只能使用当前仓库里真实存在或本轮 runbook 已使用的命令：${allowedCommands}。`,
    `禁止虚构不存在的命令，例如：${forbiddenCommands}。`,
    '如果某条命令或能力无法从当前仓库文件中核实，明确写“未在当前仓库中找到对应命令”，不要编造。',
    '输出要求：只完成你负责的部分；避免重复其他 worker；优先给出与 terminal dogfooding 直接相关、可执行、与 NanoClaw 当前实现一致的结论。',
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

  const plan = detectEdgeTeamPlan(options.prompt, options.now);
  if (!plan) {
    return { handled: false };
  }

  const { graph, execution, executionContext } = options.frameworkRun;
  const childTaskIds = plan.roles.map((role) =>
    buildTaskNodeId(execution.turnId, `child-${role.index}`),
  );
  const aggregateTaskId = buildTaskNodeId(execution.turnId, 'aggregate');

  for (const [index, role] of plan.roles.entries()) {
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
        const startedAt = Date.now();

        const output = await options.edgeWorker.run(options.group, {
          prompt: buildChildPrompt(role, options.prompt, plan.teamSize),
          groupFolder: options.group.folder,
          chatJid: options.chatJid,
          isMain: options.isMain,
          assistantName: options.assistantName,
          executionContext: childContext,
        });

        if (output.status === 'error') {
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

    completeExecution(aggregateLease.executionId);
    completeTaskNode(aggregateTaskId);
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
    emitTeamProgress(options.chatJid, `team graph completed: ${graph.graphId}`);
    return { handled: true, status: 'success' };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    failExecution(execution.executionId, message);
    failRootTaskGraph(graph.graphId, graph.rootTaskId, message);
    emitTeamProgress(
      options.chatJid,
      `team graph failed: ${graph.graphId} · ${message}`,
    );
    return { handled: true, status: 'error' };
  }
}
