import {
  AgentOutputCallback,
  ExecutionEvent,
  ExecutionEventHooks,
  ExecutionRequest,
  AgentRunInput,
  AgentRunOutput,
  ExecutionStartedCallback,
} from '../agent-backend.js';
import {
  createToolOperation,
  getExecutionState,
  getRecentConversationMessages,
  getToolOperation,
} from '../db.js';
import {
  EDGE_ALLOWED_TOOL_SET,
  EDGE_SHADOW_ALLOWED_TOOL_SET,
  deriveCapabilitiesFromTools,
} from '../edge-capabilities.js';
import { createPersistentExecutionEventHooks } from '../edge-event-dispatcher.js';
import { localEdgeRunner, type EdgeRunner } from '../edge-runner.js';
import { createSubprocessEdgeRunner } from '../edge-subprocess-runner.js';
import { RegisteredGroup } from '../types.js';
import {
  EDGE_API_BASE_URL,
  EDGE_API_KEY,
  EDGE_MODEL,
  EDGE_RUNNER_PROVIDER,
} from '../config.js';
import {
  ensureWorkspaceVersion,
  getWorkspaceManifest,
} from '../workspace-service.js';
import type { FrameworkWorker } from '../framework-worker.js';

const EDGE_MODEL_PROFILE = 'edge-local-dev';
const EDGE_MAX_OUTPUT_BYTES = 64 * 1024;
const EDGE_DEFAULT_DEADLINE_MS = 5 * 60 * 1000;
const EDGE_DEFAULT_GROUP_MEMORY_VERSION = 'memory:legacy';
const EDGE_CONTROL_POLL_MS = 50;
const EDGE_RECENT_MESSAGE_LIMIT = 24;
const EDGE_RECENT_MESSAGE_CHAR_BUDGET = 12_000;
const EDGE_RECENT_MESSAGE_MAX_ITEM_CHARS = 4_000;
const EDGE_STARTUP_EVENT_TIMEOUT_MS = 15_000;
const EDGE_EVENT_SILENCE_TIMEOUT_MS = 30_000;
const EDGE_DEFAULT_MAX_TOOL_CALLS = 12;
const EDGE_FANOUT_ALLOWED_TOOLS = [
  'workspace.read',
  'workspace.list',
  'workspace.search',
] as const;

function normalizeVisibleText(text: string | null | undefined): string | null {
  if (typeof text !== 'string') return null;
  const normalized = text.trim();
  return normalized ? normalized : null;
}

function buildDeferredToolReceipt(event: ExecutionEvent): string | null {
  if (event.type !== 'tool_result') return null;

  if (
    event.tool === 'task.create' &&
    event.result &&
    typeof event.result === 'object' &&
    !Array.isArray(event.result)
  ) {
    const result = event.result as { taskId?: unknown };
    if (typeof result.taskId === 'string') {
      return `任务已创建，taskId=${result.taskId}`;
    }
  }

  if (
    event.tool === 'task.delete' &&
    event.result &&
    typeof event.result === 'object' &&
    !Array.isArray(event.result)
  ) {
    const result = event.result as { taskId?: unknown; deleted?: unknown };
    if (typeof result.taskId === 'string' && result.deleted === true) {
      return `任务已删除，taskId=${result.taskId}`;
    }
  }

  if (
    event.tool === 'task.update' &&
    event.result &&
    typeof event.result === 'object' &&
    !Array.isArray(event.result)
  ) {
    const result = event.result as { taskId?: unknown; updated?: unknown };
    if (typeof result.taskId === 'string' && result.updated === true) {
      return `任务已更新，taskId=${result.taskId}`;
    }
  }

  if (
    event.tool === 'task.list' &&
    event.result &&
    typeof event.result === 'object' &&
    !Array.isArray(event.result)
  ) {
    const result = event.result as {
      tasks?: Array<{
        id?: unknown;
        displayStatus?: unknown;
        status?: unknown;
        schedule_value?: unknown;
        formattedNextRun?: unknown;
        next_run?: unknown;
      }>;
    };
    if (Array.isArray(result.tasks)) {
      if (result.tasks.length === 0) {
        return '当前没有任务。';
      }
      return result.tasks
        .map((task) => {
          const taskId = typeof task.id === 'string' ? task.id : '(unknown)';
          const status =
            typeof task.displayStatus === 'string'
              ? task.displayStatus
              : typeof task.status === 'string'
                ? task.status
                : 'unknown';
          const scheduleValue =
            typeof task.schedule_value === 'string'
              ? task.schedule_value
              : '(unknown)';
          const nextRun =
            typeof task.formattedNextRun === 'string'
              ? task.formattedNextRun
              : typeof task.next_run === 'string'
                ? task.next_run
                : 'none';
          return [
            `taskId: ${taskId}`,
            `status: ${status}`,
            `scheduleValue: ${scheduleValue}`,
            `nextRun: ${nextRun}`,
          ].join('\n');
        })
        .join('\n\n');
    }
  }

  return null;
}

function buildSystemPrompt(
  baseWorkspaceVersion: string,
  input: AgentRunInput,
): string {
  const base = input.assistantName
    ? `You are ${input.assistantName}.`
    : 'You are the NanoClaw assistant.';
  const manifest = getWorkspaceManifest(baseWorkspaceVersion);
  const instructions = manifest['CLAUDE.md']?.trim();
  return instructions ? `${base}\n\n${instructions}` : base;
}

function clampRecentMessageContent(content: string): string {
  if (content.length <= EDGE_RECENT_MESSAGE_MAX_ITEM_CHARS) {
    return content;
  }

  const headBudget = Math.max(0, EDGE_RECENT_MESSAGE_MAX_ITEM_CHARS - 64);
  return `${content.slice(0, headBudget)}\n...[truncated]`;
}

function buildRecentMessages(
  input: AgentRunInput,
): ExecutionRequest['promptPackage']['recentMessages'] {
  const planKind = input.executionContext?.planFragment?.kind;
  if (
    input.prompt.trim() &&
    (planKind === 'edge_fanout_child' ||
      planKind === 'edge_fanout_aggregate' ||
      planKind === 'edge_team_planner')
  ) {
    return [{ role: 'user', content: input.prompt.trim() }];
  }

  const recent = getRecentConversationMessages(
    input.chatJid,
    EDGE_RECENT_MESSAGE_LIMIT,
  );
  if (recent.length === 0) {
    return input.prompt.trim()
      ? [{ role: 'user', content: input.prompt.trim() }]
      : [];
  }

  const normalized: ExecutionRequest['promptPackage']['recentMessages'] =
    recent.map((message) => ({
      role: message.isBotMessage ? 'assistant' : 'user',
      content: clampRecentMessageContent(
        message.isBotMessage || message.isFromMe
          ? message.content
          : `${message.senderName}: ${message.content}`,
      ),
    }));

  const selected: typeof normalized = [];
  let totalChars = 0;

  for (let index = normalized.length - 1; index >= 0; index--) {
    const message = normalized[index]!;
    const messageChars = message.content.length;
    if (
      selected.length > 0 &&
      totalChars + messageChars > EDGE_RECENT_MESSAGE_CHAR_BUDGET
    ) {
      continue;
    }
    selected.push(message);
    totalChars += messageChars;
    if (totalChars >= EDGE_RECENT_MESSAGE_CHAR_BUDGET) {
      break;
    }
  }

  if (selected.length === 0 && input.prompt.trim()) {
    return [{ role: 'user', content: input.prompt.trim() }];
  }

  return selected.reverse();
}

type ExecutionEventHooksFactory = (
  request: ExecutionRequest,
) => ExecutionEventHooks | undefined;

interface ExecutionControlDecision {
  code: string;
  message: string;
}

function buildExecutionRequest(
  group: RegisteredGroup,
  input: AgentRunInput,
): ExecutionRequest {
  const baseWorkspaceVersion =
    input.executionContext?.baseWorkspaceVersion ??
    ensureWorkspaceVersion(group.folder);
  const executionContext = input.executionContext ?? {
    executionId: `edge-exec:${group.folder}:${input.chatJid}`,
    logicalSessionId: `group:${group.folder}`,
    turnId: `edge-turn:${group.folder}:${input.chatJid}`,
    groupId: group.folder,
    baseWorkspaceVersion,
  };
  const maxToolCalls =
    executionContext.capabilityBudget?.maxToolCalls ??
    EDGE_DEFAULT_MAX_TOOL_CALLS;
  const planKind = executionContext.planFragment?.kind;
  const allowedTools =
    maxToolCalls <= 0
      ? []
      : Array.from(
          input.shadowMode
            ? EDGE_SHADOW_ALLOWED_TOOL_SET
            : planKind === 'edge_fanout_child' ||
                planKind === 'edge_fanout_aggregate'
              ? EDGE_FANOUT_ALLOWED_TOOLS
              : EDGE_ALLOWED_TOOL_SET,
        );
  const deadlineMs =
    executionContext.deadline?.deadlineMs ??
    group.containerConfig?.timeout ??
    EDGE_DEFAULT_DEADLINE_MS;
  const policyCapabilities = deriveCapabilitiesFromTools(allowedTools);
  const capabilityBudget = {
    capabilities:
      executionContext.capabilityBudget?.capabilities ?? policyCapabilities,
    maxToolCalls,
  };
  const taskId =
    executionContext.taskNodeId ?? `task:${executionContext.turnId}:root`;
  const graphId =
    executionContext.graphId ?? `graph:${executionContext.turnId}`;
  const workerClass = executionContext.workerClass ?? 'edge';
  const workspaceRef = baseWorkspaceVersion;
  const idempotencyKey =
    executionContext.idempotencyKey ??
    `${executionContext.executionId}:${taskId}`;
  const planFragment = executionContext.planFragment ?? {
    kind: 'single_root',
  };

  return {
    executionId: executionContext.executionId,
    graphId,
    taskId,
    parentTaskId: executionContext.parentTaskId ?? null,
    logicalSessionId: executionContext.logicalSessionId,
    workerClass,
    groupId: executionContext.groupId ?? group.folder,
    chatJid: input.chatJid,
    turnId: executionContext.turnId,
    modelProfile: EDGE_MODEL_PROFILE,
    workspaceRef,
    capabilityBudget,
    deadline: {
      deadlineMs,
      expiresAt: executionContext.deadline?.expiresAt ?? null,
    },
    idempotencyKey,
    planFragment,
    promptPackage: {
      system: buildSystemPrompt(baseWorkspaceVersion, input),
      summary: null,
      recentMessages: buildRecentMessages(input),
      taskContext: input.isScheduledTask
        ? {
            isScheduledTask: true,
            ...(input.script ? { script: input.script } : {}),
          }
        : undefined,
    },
    workspace: {
      baseVersion: baseWorkspaceVersion,
      manifestRef: baseWorkspaceVersion,
    },
    memory: {
      groupMemoryVersion: EDGE_DEFAULT_GROUP_MEMORY_VERSION,
    },
    limits: {
      maxToolCalls,
      deadlineMs,
      maxOutputBytes: EDGE_MAX_OUTPUT_BYTES,
    },
    runner: {
      provider:
        EDGE_RUNNER_PROVIDER === 'anthropic' ||
        EDGE_RUNNER_PROVIDER === 'openai'
          ? EDGE_RUNNER_PROVIDER
          : 'local',
      ...(EDGE_API_BASE_URL ? { apiBaseUrl: EDGE_API_BASE_URL } : {}),
      ...(EDGE_API_KEY ? { apiKey: EDGE_API_KEY } : {}),
      ...(EDGE_MODEL ? { model: EDGE_MODEL } : {}),
    },
    policy: {
      allowedTools,
      networkProfile: input.shadowMode ? 'disabled' : 'local',
      capabilities: policyCapabilities,
      execution: {
        allowJsExecution: !input.shadowMode,
        maxJsExecutions: 3,
        allowedModuleImports: [],
      },
    },
  };
}

function getExecutionControlDecision(
  request: ExecutionRequest,
  startedAtMs: number,
  sawAnyEvent: boolean,
  lastEventAtMs: number,
  nowMs: number = Date.now(),
): ExecutionControlDecision | null {
  if (!sawAnyEvent && nowMs - startedAtMs >= EDGE_STARTUP_EVENT_TIMEOUT_MS) {
    return {
      code: 'startup_timeout',
      message: `Edge runner produced no startup event within ${EDGE_STARTUP_EVENT_TIMEOUT_MS}ms.`,
    };
  }

  if (nowMs - startedAtMs >= request.limits.deadlineMs) {
    return {
      code: 'deadline_exceeded',
      message: `Edge execution exceeded deadline of ${request.limits.deadlineMs}ms.`,
    };
  }

  if (sawAnyEvent && nowMs - lastEventAtMs >= EDGE_EVENT_SILENCE_TIMEOUT_MS) {
    return {
      code: 'silence_timeout',
      message: `Edge runner produced no progress within ${EDGE_EVENT_SILENCE_TIMEOUT_MS}ms.`,
    };
  }

  const execution = getExecutionState(request.executionId);
  if (execution?.status === 'cancel_requested') {
    return {
      code: 'cancelled',
      message: 'Edge execution cancelled before completion.',
    };
  }

  return null;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function consumeExecutionEvents(
  request: ExecutionRequest,
  events: AsyncIterable<ExecutionEvent>,
  onOutput?: AgentOutputCallback,
  hooks?: ExecutionEventHooks,
  abortController?: AbortController,
): Promise<AgentRunOutput> {
  let deltaBuffer = '';
  let streamedMessage: string | null = null;
  let deferredToolReceipt: string | null = null;
  let finalOutput: AgentRunOutput | null = null;
  let sawFinal = false;
  const processedCheckpoints = new Set<string>();
  const processedSessionIds = new Set<string>();
  const iterator = events[Symbol.asyncIterator]();
  const startedAtMs = Date.now();
  const pollMarker = Symbol('poll');
  let pendingNext: Promise<IteratorResult<ExecutionEvent>> | null = null;
  let sawAnyEvent = false;
  let lastEventAtMs = startedAtMs;

  while (true) {
    const controlDecision = getExecutionControlDecision(
      request,
      startedAtMs,
      sawAnyEvent,
      lastEventAtMs,
    );
    if (controlDecision) {
      abortController?.abort(controlDecision);
      await hooks?.onError?.({
        type: 'error',
        executionId: request.executionId,
        code: controlDecision.code,
        message: controlDecision.message,
      });
      try {
        await iterator.return?.();
      } catch {
        // best-effort shutdown
      }
      return {
        status: 'error',
        result: null,
        error: controlDecision.message,
      };
    }

    pendingNext ??= iterator.next();
    const nextResult = (await Promise.race([
      pendingNext,
      delay(EDGE_CONTROL_POLL_MS).then(() => pollMarker),
    ])) as IteratorResult<ExecutionEvent> | typeof pollMarker;

    if (nextResult === pollMarker) {
      continue;
    }

    pendingNext = null;

    if (nextResult.done) {
      break;
    }

    const event = nextResult.value;
    sawAnyEvent = true;
    lastEventAtMs = Date.now();
    if (event.executionId !== request.executionId) {
      return {
        status: 'error',
        result: null,
        error: `Edge runner emitted mismatched executionId: ${event.executionId}`,
      };
    }

    switch (event.type) {
      case 'ack':
        await hooks?.onAck?.(event);
        break;
      case 'heartbeat':
        await hooks?.onHeartbeat?.(event);
        break;
      case 'progress':
        await hooks?.onProgress?.(event);
        break;
      case 'warning':
        await hooks?.onWarning?.(event);
        break;
      case 'needs_fallback':
        await hooks?.onNeedsFallback?.(event);
        break;
      case 'tool_call':
        if (
          event.tool === 'message.send' &&
          event.args &&
          typeof event.args === 'object' &&
          !Array.isArray(event.args)
        ) {
          const args = event.args as Record<string, unknown>;
          const operationId =
            typeof args.operationId === 'string' ? args.operationId : undefined;
          const text = normalizeVisibleText(
            typeof args.text === 'string' ? args.text : null,
          );

          if (text) {
            const shouldSend = !operationId || !getToolOperation(operationId);
            if (shouldSend) {
              await onOutput?.({
                status: 'success',
                result: text,
              });
              if (operationId) {
                createToolOperation({
                  operationId,
                  executionId: request.executionId,
                  tool: event.tool,
                  resultJson: JSON.stringify({
                    sent: true,
                    text,
                  }),
                  createdAt: new Date().toISOString(),
                });
              }
            }
          }
        }
        break;
      case 'tool_result':
        deferredToolReceipt = buildDeferredToolReceipt(event);
        break;
      case 'output_delta':
        deltaBuffer += event.text;
        break;
      case 'output_message':
        streamedMessage = normalizeVisibleText(event.text);
        break;
      case 'checkpoint': {
        await hooks?.onCheckpoint?.(event);
        const checkpointKey = JSON.stringify({
          providerSession: event.providerSession ?? null,
          summaryDelta: event.summaryDelta ?? null,
          workspaceOverlayDigest: event.workspaceOverlayDigest ?? null,
        });
        if (processedCheckpoints.has(checkpointKey)) break;
        processedCheckpoints.add(checkpointKey);

        if (
          typeof event.providerSession === 'string' &&
          !processedSessionIds.has(event.providerSession)
        ) {
          processedSessionIds.add(event.providerSession);
          await onOutput?.({
            status: 'success',
            result: null,
            newSessionId: event.providerSession,
          });
        }
        break;
      }
      case 'final':
        await hooks?.onFinal?.(event);
        if (sawFinal) break;
        sawFinal = true;
        if (
          event.result.providerSessionId &&
          !processedSessionIds.has(event.result.providerSessionId)
        ) {
          processedSessionIds.add(event.result.providerSessionId);
          await onOutput?.({
            status: 'success',
            result: null,
            newSessionId: event.result.providerSessionId,
          });
        }
        finalOutput =
          event.result.status === 'error'
            ? {
                status: 'error',
                result: null,
                error: event.result.error?.message || 'Edge execution failed.',
              }
            : {
                status: 'success',
                result: (() => {
                  const outputText = normalizeVisibleText(
                    event.result.outputText,
                  );
                  const streamedText = normalizeVisibleText(streamedMessage);
                  const deltaText = normalizeVisibleText(deltaBuffer);
                  return (
                    outputText ??
                    streamedText ??
                    deltaText ??
                    deferredToolReceipt
                  );
                })(),
                ...(event.result.providerSessionId
                  ? { newSessionId: event.result.providerSessionId }
                  : {}),
              };
        break;
      case 'error':
        await hooks?.onError?.(event);
        return {
          status: 'error',
          result: null,
          error: event.message,
        };
    }
  }

  if (finalOutput) return finalOutput;

  if (streamedMessage || deltaBuffer) {
    return {
      status: 'success',
      result:
        normalizeVisibleText(streamedMessage) ??
        normalizeVisibleText(deltaBuffer) ??
        deferredToolReceipt,
    };
  }

  if (deferredToolReceipt) {
    return {
      status: 'success',
      result: deferredToolReceipt,
    };
  }

  return {
    status: 'error',
    result: null,
    error: 'Edge runner finished without a final event.',
  };
}

class EdgeBackend implements FrameworkWorker {
  readonly backendId = 'edge' as const;
  readonly workerClass = 'edge' as const;
  readonly runtimeClass = 'edge-subprocess';
  readonly capabilityEnvelope = [
    'fs.read',
    'fs.write',
    'http.fetch',
    'task.manage',
    'message.send',
    'code.exec',
  ] as const;

  constructor(
    private readonly runner: EdgeRunner,
    private readonly hooksFactory?: ExecutionEventHooksFactory,
  ) {}

  async run(
    group: RegisteredGroup,
    input: AgentRunInput,
    _onExecutionStarted?: ExecutionStartedCallback,
    onOutput?: AgentOutputCallback,
  ): Promise<AgentRunOutput> {
    if (input.script) {
      return {
        status: 'error',
        result: null,
        error: 'Edge backend does not support scheduled task scripts yet.',
      };
    }

    const request = buildExecutionRequest(group, input);
    const hooks = this.hooksFactory?.(request);
    const abortController = new AbortController();
    return consumeExecutionEvents(
      request,
      this.runner.runTurn(request, { signal: abortController.signal }),
      onOutput,
      hooks,
      abortController,
    );
  }
}

export function createEdgeBackend(
  runner?: EdgeRunner,
  hooksFactory?: ExecutionEventHooksFactory,
): FrameworkWorker {
  return new EdgeBackend(runner ?? localEdgeRunner, hooksFactory);
}

export {
  buildExecutionRequest,
  consumeExecutionEvents,
  getExecutionControlDecision,
};

export const edgeBackend = new EdgeBackend(
  createSubprocessEdgeRunner(),
  createPersistentExecutionEventHooks,
);
