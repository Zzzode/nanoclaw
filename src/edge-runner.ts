import {
  ExecutionEvent,
  ExecutionFinalResult,
  ExecutionRequest,
  WorkspaceOverlay,
} from './agent-backend.js';
import {
  EDGE_ANTHROPIC_API_BASE_URL,
  EDGE_ANTHROPIC_API_KEY,
  EDGE_ANTHROPIC_MODEL,
  EDGE_API_BASE_URL,
  EDGE_API_KEY,
  EDGE_MODEL,
} from './config.js';
import { getEdgeHostBridge } from './edge-host-bridge.js';

export interface EdgeRunner {
  runTurn(
    request: ExecutionRequest,
    options?: {
      signal?: AbortSignal;
    },
  ): AsyncIterable<ExecutionEvent>;
}

interface EdgeToolInvocation {
  tool: string;
  args?: Record<string, unknown>;
}

interface EdgeToolExecutionResult {
  result: unknown;
  outputText: string | null;
  workspaceOverlayDigest?: string;
  workspaceOverlay?: WorkspaceOverlay;
}

interface AnthropicContentBlock {
  type: string;
  text?: string;
  id?: string;
  name?: string;
  input?: Record<string, unknown>;
}

interface AnthropicResponse {
  id: string;
  content: AnthropicContentBlock[];
  stop_reason: string | null;
}

type AnthropicMessage =
  | { role: 'user' | 'assistant'; content: string }
  | {
      role: 'user' | 'assistant';
      content: Array<Record<string, unknown>>;
    };

interface OpenAiCompatibleToolCall {
  id: string;
  type: 'function';
  function: {
    name: string;
    arguments: string;
  };
}

interface OpenAiCompatibleMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content?: string | null;
  tool_calls?: OpenAiCompatibleToolCall[];
  tool_call_id?: string;
}

interface OpenAiCompatibleResponse {
  choices?: Array<{
    message?: {
      content?: string | null;
      tool_calls?: OpenAiCompatibleToolCall[];
    };
    finish_reason?: string | null;
  }>;
}

function buildPromptPreview(request: ExecutionRequest): string {
  const recent = request.promptPackage.recentMessages
    .map((message) => message.content.trim())
    .filter(Boolean)
    .join('\n\n');

  return recent || '(empty prompt)';
}

function getLatestUserMessage(request: ExecutionRequest): string {
  for (
    let index = request.promptPackage.recentMessages.length - 1;
    index >= 0;
    index -= 1
  ) {
    const message = request.promptPackage.recentMessages[index];
    if (message.role === 'user') {
      return message.content.trim();
    }
  }
  return '';
}

// Removed: parseExplicitTaskDeleteInvocation, parseExplicitTaskListInvocation,
// parseExplicitTaskCreateInvocation, detectExplicitToolChoice, escapeRegExp
// Intent detection now relies on model native tool_use. Only EDGE_TOOL structured
// syntax is preserved for debugging/scripting direct tool invocation.

export function resolveDirectToolInvocation(
  request: ExecutionRequest,
): EdgeToolInvocation | null {
  const latestUserMessage = getLatestUserMessage(request);
  if (!latestUserMessage) return null;

  // Only EDGE_TOOL structured syntax is supported for direct invocation.
  // Natural language intent detection is delegated to model native tool_use.
  return parseSingleToolInvocation(latestUserMessage);
}

async function* emitDirectToolInvocationResult(
  request: ExecutionRequest,
  signal: AbortSignal | undefined,
  nodeId: string,
  toolInvocation: EdgeToolInvocation,
): AsyncGenerator<ExecutionEvent, ExecutionFinalResult> {
  const providerSessionId = synthesizeProviderSessionId(request);
  const finalResult: ExecutionFinalResult = {
    status: 'success',
    outputText: null,
    providerSessionId,
  };

  yield {
    type: 'ack',
    executionId: request.executionId,
    nodeId,
  };
  yield {
    type: 'heartbeat',
    executionId: request.executionId,
    at: new Date().toISOString(),
  };

  const abortAfterHeartbeat = buildAbortError(request, signal);
  if (abortAfterHeartbeat) {
    yield abortAfterHeartbeat;
    return {
      status: 'error',
      outputText: null,
      providerSessionId,
      error: {
        code: abortAfterHeartbeat.code,
        message: abortAfterHeartbeat.message,
      },
    };
  }

  yield {
    type: 'tool_call',
    executionId: request.executionId,
    tool: toolInvocation.tool,
    args: toolInvocation.args ?? {},
  };

  const toolResult = await executeTool(
    request,
    normalizeToolInvocation(toolInvocation),
  );
  if (toolResult.workspaceOverlay) {
    finalResult.workspaceOverlay = toolResult.workspaceOverlay;
  }

  yield {
    type: 'tool_result',
    executionId: request.executionId,
    tool: toolInvocation.tool,
    result: toolResult.result,
  };
  yield {
    type: 'checkpoint',
    executionId: request.executionId,
    providerSession: providerSessionId,
    summaryDelta: JSON.stringify(toolResult.result).slice(0, 120),
    workspaceOverlayDigest:
      toolResult.workspaceOverlayDigest ?? 'workspace:unchanged',
    workspaceOverlay: toolResult.workspaceOverlay,
  };

  const abortAfterCheckpoint = buildAbortError(request, signal);
  if (abortAfterCheckpoint) {
    yield abortAfterCheckpoint;
    return {
      status: 'error',
      outputText: null,
      providerSessionId,
      error: {
        code: abortAfterCheckpoint.code,
        message: abortAfterCheckpoint.message,
      },
    };
  }

  if (toolResult.outputText) {
    for (const text of splitIntoDeltas(toolResult.outputText)) {
      yield {
        type: 'output_delta',
        executionId: request.executionId,
        text,
      };
    }
    yield {
      type: 'output_message',
      executionId: request.executionId,
      text: toolResult.outputText,
    };
    finalResult.outputText = toolResult.outputText;
  }

  const abortBeforeFinal = buildAbortError(request, signal);
  if (abortBeforeFinal) {
    yield abortBeforeFinal;
    return {
      status: 'error',
      outputText: null,
      providerSessionId,
      error: {
        code: abortBeforeFinal.code,
        message: abortBeforeFinal.message,
      },
    };
  }

  yield {
    type: 'final',
    executionId: request.executionId,
    result: finalResult,
  };

  return finalResult;
}

function buildOutputText(request: ExecutionRequest): string {
  const promptPreview = buildPromptPreview(request);
  const taskLabel = request.promptPackage.taskContext?.isScheduledTask
    ? 'scheduled task'
    : 'message turn';

  return [
    `[edge runner local] processed ${taskLabel} for "${request.groupId}"`,
    `executionId=${request.executionId}`,
    `prompt=${promptPreview}`,
  ].join('\n');
}

function splitIntoDeltas(text: string): string[] {
  if (text.length <= 1) return [text];

  const midpoint = Math.ceil(text.length / 2);
  return [text.slice(0, midpoint), text.slice(midpoint)].filter(Boolean);
}

function normalizeToolInvocation(
  invocation: EdgeToolInvocation,
): EdgeToolInvocation {
  const args = { ...(invocation.args ?? {}) };
  if (
    [
      'workspace.write',
      'workspace.apply_patch',
      'message.send',
      'task.create',
    ].includes(invocation.tool) &&
    typeof args.operationId !== 'string'
  ) {
    args.operationId = `op:${invocation.tool}:${Date.now()}:${Math.random().toString(36).slice(2, 8)}`;
  }
  return {
    tool: invocation.tool,
    args,
  };
}

function parseSingleToolInvocation(prompt: string): EdgeToolInvocation | null {
  const trimmed = prompt.trim();
  const prefix = 'EDGE_TOOL ';
  if (!trimmed.startsWith(prefix)) return null;

  const payload = JSON.parse(trimmed.slice(prefix.length)) as unknown;
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new Error('Invalid EDGE_TOOL payload');
  }
  const tool = (payload as { tool?: unknown }).tool;
  if (typeof tool !== 'string' || tool.length === 0) {
    throw new Error('Invalid EDGE_TOOL tool');
  }
  const args = (payload as { args?: unknown }).args;

  return {
    tool,
    args:
      args && typeof args === 'object' && !Array.isArray(args)
        ? (args as Record<string, unknown>)
        : {},
  };
}

function synthesizeProviderSessionId(request: ExecutionRequest): string {
  return `edge-session:${request.logicalSessionId}`;
}

function buildToolDefinitions(
  request: ExecutionRequest,
): Array<Record<string, unknown>> {
  const definitions: Record<string, Record<string, unknown>> = {
    'workspace.read': {
      name: 'workspace.read',
      description: 'Read the contents of a workspace file.',
      input_schema: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Relative file path.' },
        },
        required: ['path'],
        additionalProperties: false,
      },
    },
    'workspace.list': {
      name: 'workspace.list',
      description: 'List files or directories in the workspace.',
      input_schema: {
        type: 'object',
        properties: {
          path: { type: 'string' },
          recursive: { type: 'boolean' },
        },
        additionalProperties: false,
      },
    },
    'workspace.search': {
      name: 'workspace.search',
      description: 'Search for a string in workspace files.',
      input_schema: {
        type: 'object',
        properties: {
          path: { type: 'string' },
          pattern: { type: 'string' },
        },
        required: ['pattern'],
        additionalProperties: false,
      },
    },
    'workspace.write': {
      name: 'workspace.write',
      description: 'Write a file in the workspace overlay.',
      input_schema: {
        type: 'object',
        properties: {
          path: { type: 'string' },
          content: { type: 'string' },
          operationId: { type: 'string' },
        },
        required: ['path', 'content'],
        additionalProperties: false,
      },
    },
    'workspace.apply_patch': {
      name: 'workspace.apply_patch',
      description: 'Apply a structured patch to workspace files.',
      input_schema: {
        type: 'object',
        properties: {
          patch: { type: 'string' },
          operationId: { type: 'string' },
        },
        required: ['patch'],
        additionalProperties: false,
      },
    },
    'message.send': {
      name: 'message.send',
      description: 'Send a user-visible message back to the current chat.',
      input_schema: {
        type: 'object',
        properties: {
          text: { type: 'string' },
          chatJid: { type: 'string' },
          operationId: { type: 'string' },
        },
        required: ['text'],
        additionalProperties: false,
      },
    },
    'task.create': {
      name: 'task.create',
      description: 'Create a scheduled NanoClaw task.',
      input_schema: {
        type: 'object',
        properties: {
          prompt: { type: 'string' },
          scheduleType: {
            type: 'string',
            enum: ['cron', 'interval', 'once'],
          },
          scheduleValue: { type: 'string' },
          contextMode: { type: 'string', enum: ['group', 'isolated'] },
          operationId: { type: 'string' },
        },
        required: ['prompt', 'scheduleType', 'scheduleValue'],
        additionalProperties: true,
      },
    },
    'task.list': {
      name: 'task.list',
      description: 'List scheduled tasks visible to the current group.',
      input_schema: {
        type: 'object',
        properties: {},
        additionalProperties: false,
      },
    },
    'task.delete': {
      name: 'task.delete',
      description: 'Delete a scheduled NanoClaw task by taskId.',
      input_schema: {
        type: 'object',
        properties: {
          taskId: { type: 'string' },
          operationId: { type: 'string' },
        },
        required: ['taskId'],
        additionalProperties: false,
      },
    },
    'task.update': {
      name: 'task.update',
      description:
        'Update a scheduled NanoClaw task by taskId. Supports prompt, scheduleType, scheduleValue, and status.',
      input_schema: {
        type: 'object',
        properties: {
          taskId: { type: 'string' },
          prompt: { type: 'string' },
          scheduleType: {
            type: 'string',
            enum: ['cron', 'interval', 'once'],
          },
          scheduleValue: { type: 'string' },
          status: {
            type: 'string',
            enum: ['active', 'paused'],
          },
          operationId: { type: 'string' },
        },
        required: ['taskId'],
        additionalProperties: false,
      },
    },
    'http.fetch': {
      name: 'http.fetch',
      description:
        'Perform a controlled HTTP request subject to network policy.',
      input_schema: {
        type: 'object',
        properties: {
          url: { type: 'string' },
          method: { type: 'string' },
          headers: { type: 'object' },
          body: { type: 'string' },
        },
        required: ['url'],
        additionalProperties: false,
      },
    },
    'js.exec': {
      name: 'js.exec',
      description:
        'Execute a JavaScript snippet inside the edge runtime using the injected sdk. Use this when the user explicitly asks to run JavaScript or to use sdk.*. The code is the body of an async function and must return a serializable value. Example: const file = await sdk.workspace.read({ path: "CLAUDE.md" }); return file.content.split(/\\r?\\n/)[0];',
      input_schema: {
        type: 'object',
        properties: {
          code: { type: 'string' },
        },
        required: ['code'],
        additionalProperties: false,
      },
    },
  };

  return request.policy.allowedTools
    .map((tool) => definitions[tool])
    .filter((definition): definition is Record<string, unknown> =>
      Boolean(definition),
    );
}

function buildOpenAiCompatibleToolDefinitions(
  request: ExecutionRequest,
): Array<Record<string, unknown>> {
  return buildToolDefinitions(request).map((definition) => ({
    type: 'function',
    function: {
      name: definition.name,
      description: definition.description,
      parameters: definition.input_schema,
    },
  }));
}

function buildAnthropicSystemPrompt(request: ExecutionRequest): string {
  const sections = [request.promptPackage.system.trim()];
  if (request.promptPackage.summary) {
    sections.push(`Conversation summary:\n${request.promptPackage.summary}`);
  }
  const toolGuidance =
    request.limits.maxToolCalls > 0
      ? [
          'Use tools only when they materially help.',
          'When tools are available, call them via the provider tool/function-calling API.',
          'If the user explicitly asks for a specific tool by name, honor that exact tool unless it is unavailable or unsafe.',
          'Do not emit pseudo tool syntax like <tool_call> or textual tool requests.',
          `Maximum tool calls for this turn: ${request.limits.maxToolCalls}.`,
        ]
      : [
          'No tools are available for this turn. Do not attempt to call tools.',
          'Focus on reasoning and producing the requested output directly.',
        ];
  sections.push(
    [
      'You are running inside NanoClaw Edge mode.',
      'Be concise and helpful.',
      ...toolGuidance,
      `Workspace base version: ${request.workspace.baseVersion}.`,
      `Network profile for tools: ${request.policy.networkProfile}.`,
    ].join('\n'),
  );
  return sections.join('\n\n');
}

function buildAnthropicMessages(request: ExecutionRequest): AnthropicMessage[] {
  if (request.promptPackage.recentMessages.length > 0) {
    return request.promptPackage.recentMessages.map((message) => ({
      role: message.role,
      content: message.content,
    }));
  }
  return [{ role: 'user', content: '(empty prompt)' }];
}

function buildOpenAiCompatibleMessages(
  request: ExecutionRequest,
): OpenAiCompatibleMessage[] {
  const messages: OpenAiCompatibleMessage[] = [
    {
      role: 'system',
      content: buildAnthropicSystemPrompt(request),
    },
  ];

  if (request.promptPackage.recentMessages.length > 0) {
    messages.push(
      ...request.promptPackage.recentMessages.map((message) => ({
        role: message.role,
        content: message.content,
      })),
    );
  } else {
    messages.push({ role: 'user', content: '(empty prompt)' });
  }

  return messages;
}

async function edgeFetchText(
  url: string,
  init: {
    method?: string;
    headers?: Record<string, string>;
    body?: string;
    signal?: AbortSignal;
  },
): Promise<{
  ok: boolean;
  status: number;
  url: string;
  text(): Promise<string>;
}> {
  const bridge = getEdgeHostBridge();
  if (!bridge) {
    const response = await fetch(url, init);
    return {
      ok: response.ok,
      status: response.status,
      url: response.url,
      text: () => response.text(),
    };
  }

  const result = await bridge.requestHttp({
    url,
    method: init.method,
    headers: init.headers,
    body: init.body,
  });
  return {
    ok: result.ok,
    status: result.status,
    url: result.url,
    text: async () => result.body,
  };
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function* withHeartbeatWhilePending<T>(options: {
  executionId: string;
  signal?: AbortSignal;
  run: () => Promise<T>;
  intervalMs?: number;
}): AsyncGenerator<ExecutionEvent, T> {
  const intervalMs = options.intervalMs ?? 10_000;
  const taggedRun = options.run().then((value) => ({ kind: 'result', value }));

  while (true) {
    const next = (await Promise.race([
      taggedRun,
      delay(intervalMs).then(() => ({ kind: 'heartbeat' as const })),
    ])) as
      | { kind: 'result'; value: T }
      | { kind: 'heartbeat' };

    if (next.kind === 'result') {
      return next.value;
    }

    if (options.signal?.aborted) {
      continue;
    }

    yield {
      type: 'heartbeat',
      executionId: options.executionId,
      at: new Date().toISOString(),
    };
  }
}

async function executeTool(
  request: ExecutionRequest,
  invocation: EdgeToolInvocation,
): Promise<EdgeToolExecutionResult> {
  const module = await import('./edge-tool-host.js');
  return module.executeEdgeTool(request, invocation);
}

function appendOverlay(
  current: WorkspaceOverlay | undefined,
  next: WorkspaceOverlay | undefined,
): WorkspaceOverlay | undefined {
  if (!next) return current;
  if (!current) return next;
  return {
    changes: [...current.changes, ...next.changes],
    digest: next.digest,
  };
}

function buildAbortError(
  request: ExecutionRequest,
  signal?: AbortSignal,
): Extract<ExecutionEvent, { type: 'error' }> | null {
  if (!signal?.aborted) return null;

  const reason =
    signal.reason &&
    typeof signal.reason === 'object' &&
    !Array.isArray(signal.reason)
      ? (signal.reason as { code?: unknown; message?: unknown })
      : null;

  return {
    type: 'error',
    executionId: request.executionId,
    code: typeof reason?.code === 'string' ? reason.code : 'execution_aborted',
    message:
      typeof reason?.message === 'string'
        ? reason.message
        : 'Edge execution aborted.',
  };
}

class LocalEdgeRunner implements EdgeRunner {
  async *runTurn(
    request: ExecutionRequest,
    options?: {
      signal?: AbortSignal;
    },
  ): AsyncGenerator<ExecutionEvent, ExecutionFinalResult> {
    const signal = options?.signal;
    const providerSessionId = synthesizeProviderSessionId(request);
    const toolInvocationRaw = parseSingleToolInvocation(
      buildPromptPreview(request),
    );
    const toolInvocation = toolInvocationRaw
      ? normalizeToolInvocation(toolInvocationRaw)
      : null;
    const outputText = toolInvocation ? null : buildOutputText(request);
    const finalResult: ExecutionFinalResult = {
      status: 'success',
      outputText,
      providerSessionId,
    };

    yield {
      type: 'ack',
      executionId: request.executionId,
      nodeId: 'local-edge-runner',
    };
    yield {
      type: 'heartbeat',
      executionId: request.executionId,
      at: new Date().toISOString(),
    };

    const abortAfterHeartbeat = buildAbortError(request, signal);
    if (abortAfterHeartbeat) {
      yield abortAfterHeartbeat;
      return {
        status: 'error',
        outputText: null,
        providerSessionId,
        error: {
          code: abortAfterHeartbeat.code,
          message: abortAfterHeartbeat.message,
        },
      };
    }

    if (toolInvocation) {
      yield {
        type: 'tool_call',
        executionId: request.executionId,
        tool: toolInvocation.tool,
        args: toolInvocation.args ?? {},
      };

      const toolResult = await executeTool(request, toolInvocation);
      if (toolResult.workspaceOverlay) {
        finalResult.workspaceOverlay = toolResult.workspaceOverlay;
      }

      yield {
        type: 'tool_result',
        executionId: request.executionId,
        tool: toolInvocation.tool,
        result: toolResult.result,
      };
      yield {
        type: 'checkpoint',
        executionId: request.executionId,
        providerSession: providerSessionId,
        summaryDelta: JSON.stringify(toolResult.result).slice(0, 120),
        workspaceOverlayDigest:
          toolResult.workspaceOverlayDigest ?? 'workspace:unchanged',
        workspaceOverlay: toolResult.workspaceOverlay,
      };

      const abortAfterCheckpoint = buildAbortError(request, signal);
      if (abortAfterCheckpoint) {
        yield abortAfterCheckpoint;
        return {
          status: 'error',
          outputText: null,
          providerSessionId,
          error: {
            code: abortAfterCheckpoint.code,
            message: abortAfterCheckpoint.message,
          },
        };
      }

      if (toolResult.outputText) {
        for (const text of splitIntoDeltas(toolResult.outputText)) {
          yield {
            type: 'output_delta',
            executionId: request.executionId,
            text,
          };
        }
        yield {
          type: 'output_message',
          executionId: request.executionId,
          text: toolResult.outputText,
        };
        finalResult.outputText = toolResult.outputText;
      }
    } else {
      const fallbackOutputText = outputText ?? '';
      for (const text of splitIntoDeltas(fallbackOutputText)) {
        yield {
          type: 'output_delta',
          executionId: request.executionId,
          text,
        };
      }

      yield {
        type: 'checkpoint',
        executionId: request.executionId,
        providerSession: providerSessionId,
        summaryDelta: fallbackOutputText.slice(0, 120),
        workspaceOverlayDigest: 'workspace:unchanged',
      };
      yield {
        type: 'output_message',
        executionId: request.executionId,
        text: fallbackOutputText,
      };
    }

    const abortBeforeFinal = buildAbortError(request, signal);
    if (abortBeforeFinal) {
      yield abortBeforeFinal;
      return {
        status: 'error',
        outputText: null,
        providerSessionId,
        error: {
          code: abortBeforeFinal.code,
          message: abortBeforeFinal.message,
        },
      };
    }

    yield {
      type: 'final',
      executionId: request.executionId,
      result: finalResult,
    };

    return finalResult;
  }
}

class AnthropicEdgeRunner implements EdgeRunner {
  async *runTurn(
    request: ExecutionRequest,
    options?: {
      signal?: AbortSignal;
    },
  ): AsyncGenerator<ExecutionEvent, ExecutionFinalResult> {
    const signal = options?.signal;
    const directToolInvocation = resolveDirectToolInvocation(request);
    if (directToolInvocation) {
      return yield* emitDirectToolInvocationResult(
        request,
        signal,
        'edgejs-openai-compatible-runner',
        directToolInvocation,
      );
    }
    const providerSessionId = synthesizeProviderSessionId(request);
    let workspaceOverlay: WorkspaceOverlay | undefined;
    const messages = buildAnthropicMessages(request);
    const tools = buildToolDefinitions(request);
    let toolCalls = 0;

    yield {
      type: 'ack',
      executionId: request.executionId,
      nodeId: 'edgejs-anthropic-runner',
    };

    while (true) {
      const abortError = buildAbortError(request, signal);
      if (abortError) {
        yield abortError;
        return {
          status: 'error',
          outputText: null,
          providerSessionId,
          workspaceOverlay,
          error: {
            code: abortError.code,
            message: abortError.message,
          },
        };
      }

      yield {
        type: 'heartbeat',
        executionId: request.executionId,
        at: new Date().toISOString(),
      };

      const apiKey =
        request.runner?.apiKey ||
        EDGE_ANTHROPIC_API_KEY ||
        process.env.EDGE_ANTHROPIC_API_KEY ||
        process.env.ANTHROPIC_API_KEY;
      if (!apiKey) {
        const message =
          'Missing EDGE_ANTHROPIC_API_KEY or ANTHROPIC_API_KEY for edge runner.';
        yield {
          type: 'error',
          executionId: request.executionId,
          code: 'missing_api_key',
          message,
        };
        return {
          status: 'error',
          outputText: null,
          providerSessionId,
          workspaceOverlay,
          error: {
            code: 'missing_api_key',
            message,
          },
        };
      }

      const baseUrl = (
        request.runner?.apiBaseUrl ||
        EDGE_ANTHROPIC_API_BASE_URL ||
        'https://api.anthropic.com'
      ).replace(/\/+$/, '');
      const response = yield* withHeartbeatWhilePending({
        executionId: request.executionId,
        signal,
        run: () =>
          fetch(`${baseUrl}/v1/messages`, {
            method: 'POST',
            headers: {
              'content-type': 'application/json',
              'anthropic-version': '2023-06-01',
              'x-api-key': apiKey,
            },
            body: JSON.stringify({
              model: request.runner?.model || EDGE_ANTHROPIC_MODEL,
              max_tokens: 1024,
              system: buildAnthropicSystemPrompt(request),
              messages,
              ...(tools.length > 0 ? { tools } : {}),
            }),
            signal,
          }),
      });

      if (!response.ok) {
        const body = await response.text();
        const message =
          `Anthropic edge request failed: ${response.status} ${body}`.slice(
            0,
            1000,
          );
        yield {
          type: 'error',
          executionId: request.executionId,
          code: 'anthropic_request_failed',
          message,
        };
        return {
          status: 'error',
          outputText: null,
          providerSessionId,
          workspaceOverlay,
          error: {
            code: 'anthropic_request_failed',
            message,
          },
        };
      }

      const data = (await response.json()) as AnthropicResponse;
      const assistantText = data.content
        .filter(
          (block) => block.type === 'text' && typeof block.text === 'string',
        )
        .map((block) => block.text)
        .join('')
        .trim();
      const toolUses = data.content.filter(
        (block) =>
          block.type === 'tool_use' &&
          typeof block.id === 'string' &&
          typeof block.name === 'string',
      );

      messages.push({
        role: 'assistant',
        content: data.content.map((block) => {
          if (block.type === 'text') {
            return { type: 'text', text: block.text ?? '' };
          }
          return {
            type: 'tool_use',
            id: block.id!,
            name: block.name!,
            input: block.input ?? {},
          };
        }),
      });

      if (toolUses.length > 0) {
        if (toolCalls + toolUses.length > request.limits.maxToolCalls) {
          const message = `Edge execution exceeded maxToolCalls=${request.limits.maxToolCalls}.`;
          yield {
            type: 'error',
            executionId: request.executionId,
            code: 'max_tool_calls_exceeded',
            message,
          };
          return {
            status: 'error',
            outputText: assistantText || null,
            providerSessionId,
            workspaceOverlay,
            error: {
              code: 'max_tool_calls_exceeded',
              message,
            },
          };
        }

        toolCalls += toolUses.length;
        const toolResults: Array<Record<string, unknown>> = [];

        for (const toolUse of toolUses) {
          yield {
            type: 'tool_call',
            executionId: request.executionId,
            tool: toolUse.name!,
            args: toolUse.input ?? {},
          };

          let toolResult: EdgeToolExecutionResult;
          try {
            toolResult = await executeTool(
              request,
              normalizeToolInvocation({
                tool: toolUse.name!,
                args: toolUse.input ?? {},
              }),
            );
            workspaceOverlay = appendOverlay(
              workspaceOverlay,
              toolResult.workspaceOverlay,
            );
          } catch (error) {
            const message =
              error instanceof Error ? error.message : String(error);
            toolResult = {
              result: { error: message },
              outputText: null,
            };
          }

          yield {
            type: 'tool_result',
            executionId: request.executionId,
            tool: toolUse.name!,
            result: toolResult.result,
          };
          yield {
            type: 'checkpoint',
            executionId: request.executionId,
            providerSession: providerSessionId,
            summaryDelta: assistantText.slice(0, 120) || toolUse.name!,
            workspaceOverlayDigest:
              toolResult.workspaceOverlayDigest ?? workspaceOverlay?.digest,
            workspaceOverlay: workspaceOverlay,
          };

          toolResults.push({
            type: 'tool_result',
            tool_use_id: toolUse.id!,
            content:
              typeof toolResult.result === 'string'
                ? toolResult.result
                : JSON.stringify(toolResult.result),
          });
        }

        messages.push({
          role: 'user',
          content: toolResults,
        });
        continue;
      }

      yield {
        type: 'checkpoint',
        executionId: request.executionId,
        providerSession: providerSessionId,
        summaryDelta: assistantText.slice(0, 120),
        workspaceOverlayDigest:
          workspaceOverlay?.digest ?? 'workspace:unchanged',
        workspaceOverlay,
      };

      if (assistantText) {
        yield {
          type: 'output_message',
          executionId: request.executionId,
          text: assistantText,
        };
      }

      const finalResult: ExecutionFinalResult = {
        status: 'success',
        outputText: assistantText || null,
        providerSessionId,
        ...(workspaceOverlay ? { workspaceOverlay } : {}),
      };

      yield {
        type: 'final',
        executionId: request.executionId,
        result: finalResult,
      };

      return finalResult;
    }
  }
}

class OpenAiCompatibleEdgeRunner implements EdgeRunner {
  async *runTurn(
    request: ExecutionRequest,
    options?: {
      signal?: AbortSignal;
    },
  ): AsyncGenerator<ExecutionEvent, ExecutionFinalResult> {
    const signal = options?.signal;
    const directToolInvocation = resolveDirectToolInvocation(request);
    if (directToolInvocation) {
      return yield* emitDirectToolInvocationResult(
        request,
        signal,
        'edgejs-openai-compatible-runner',
        directToolInvocation,
      );
    }
    const providerSessionId = synthesizeProviderSessionId(request);
    let workspaceOverlay: WorkspaceOverlay | undefined;
    const messages = buildOpenAiCompatibleMessages(request);
    const tools = buildOpenAiCompatibleToolDefinitions(request);
    let toolCalls = 0;

    yield {
      type: 'ack',
      executionId: request.executionId,
      nodeId: 'edgejs-openai-compatible-runner',
    };

    while (true) {
      const abortError = buildAbortError(request, signal);
      if (abortError) {
        yield abortError;
        return {
          status: 'error',
          outputText: null,
          providerSessionId,
          workspaceOverlay,
          error: {
            code: abortError.code,
            message: abortError.message,
          },
        };
      }

      yield {
        type: 'heartbeat',
        executionId: request.executionId,
        at: new Date().toISOString(),
      };

      const apiKey =
        request.runner?.apiKey || EDGE_API_KEY || process.env.OPENAI_API_KEY;
      if (!apiKey) {
        const message =
          'Missing EDGE_API_KEY or OPENAI_API_KEY for openai-compatible edge runner.';
        yield {
          type: 'error',
          executionId: request.executionId,
          code: 'missing_api_key',
          message,
        };
        return {
          status: 'error',
          outputText: null,
          providerSessionId,
          workspaceOverlay,
          error: {
            code: 'missing_api_key',
            message,
          },
        };
      }

      const baseUrl = (
        request.runner?.apiBaseUrl ||
        EDGE_API_BASE_URL ||
        'https://api.openai.com/v1'
      ).replace(/\/+$/, '');
      const model = request.runner?.model || EDGE_MODEL || 'gpt-4o-mini';
      const response = yield* withHeartbeatWhilePending({
        executionId: request.executionId,
        signal,
        run: () =>
          edgeFetchText(`${baseUrl}/chat/completions`, {
            method: 'POST',
            headers: {
              'content-type': 'application/json',
              authorization: `Bearer ${apiKey}`,
            },
            body: JSON.stringify({
              model,
              messages,
              ...(tools.length > 0
                ? {
                    tools,
                    tool_choice: 'auto',
                  }
                : {}),
            }),
            signal,
          }),
      });

      if (!response.ok) {
        const body = await response.text();
        const message =
          `OpenAI-compatible edge request failed: ${response.status} ${body}`.slice(
            0,
            1000,
          );
        yield {
          type: 'error',
          executionId: request.executionId,
          code: 'openai_request_failed',
          message,
        };
        return {
          status: 'error',
          outputText: null,
          providerSessionId,
          workspaceOverlay,
          error: {
            code: 'openai_request_failed',
            message,
          },
        };
      }

      const data = JSON.parse(
        await response.text(),
      ) as OpenAiCompatibleResponse;
      const choice = data.choices?.[0];
      const assistantMessage = choice?.message;
      const assistantText =
        typeof assistantMessage?.content === 'string'
          ? assistantMessage.content.trim()
          : '';
      const toolUses = Array.isArray(assistantMessage?.tool_calls)
        ? assistantMessage.tool_calls.filter(
            (toolCall) =>
              toolCall.type === 'function' &&
              typeof toolCall.id === 'string' &&
              typeof toolCall.function?.name === 'string',
          )
        : [];

      messages.push({
        role: 'assistant',
        content: assistantMessage?.content ?? null,
        ...(toolUses.length > 0 ? { tool_calls: toolUses } : {}),
      });

      if (toolUses.length > 0) {
        if (toolCalls + toolUses.length > request.limits.maxToolCalls) {
          const message = `Edge execution exceeded maxToolCalls=${request.limits.maxToolCalls}.`;
          yield {
            type: 'error',
            executionId: request.executionId,
            code: 'max_tool_calls_exceeded',
            message,
          };
          return {
            status: 'error',
            outputText: assistantText || null,
            providerSessionId,
            workspaceOverlay,
            error: {
              code: 'max_tool_calls_exceeded',
              message,
            },
          };
        }

        toolCalls += toolUses.length;

        for (const toolUse of toolUses) {
          let parsedArgs: Record<string, unknown> = {};
          try {
            const rawArgs = toolUse.function.arguments?.trim();
            if (rawArgs) {
              const payload = JSON.parse(rawArgs) as unknown;
              if (
                payload &&
                typeof payload === 'object' &&
                !Array.isArray(payload)
              ) {
                parsedArgs = payload as Record<string, unknown>;
              }
            }
          } catch (error) {
            parsedArgs = {
              error: error instanceof Error ? error.message : String(error),
            };
          }

          yield {
            type: 'tool_call',
            executionId: request.executionId,
            tool: toolUse.function.name,
            args: parsedArgs,
          };

          let toolResult: EdgeToolExecutionResult;
          try {
            toolResult = await executeTool(
              request,
              normalizeToolInvocation({
                tool: toolUse.function.name,
                args: parsedArgs,
              }),
            );
            workspaceOverlay = appendOverlay(
              workspaceOverlay,
              toolResult.workspaceOverlay,
            );
          } catch (error) {
            const message =
              error instanceof Error ? error.message : String(error);
            toolResult = {
              result: { error: message },
              outputText: null,
            };
          }

          yield {
            type: 'tool_result',
            executionId: request.executionId,
            tool: toolUse.function.name,
            result: toolResult.result,
          };
          yield {
            type: 'checkpoint',
            executionId: request.executionId,
            providerSession: providerSessionId,
            summaryDelta: assistantText.slice(0, 120) || toolUse.function.name,
            workspaceOverlayDigest:
              toolResult.workspaceOverlayDigest ?? workspaceOverlay?.digest,
            workspaceOverlay,
          };

          messages.push({
            role: 'tool',
            tool_call_id: toolUse.id,
            content:
              typeof toolResult.result === 'string'
                ? toolResult.result
                : JSON.stringify(toolResult.result),
          });
        }
        continue;
      }

      yield {
        type: 'checkpoint',
        executionId: request.executionId,
        providerSession: providerSessionId,
        summaryDelta: assistantText.slice(0, 120),
        workspaceOverlayDigest:
          workspaceOverlay?.digest ?? 'workspace:unchanged',
        workspaceOverlay,
      };

      if (assistantText) {
        for (const text of splitIntoDeltas(assistantText)) {
          yield {
            type: 'output_delta',
            executionId: request.executionId,
            text,
          };
        }
        yield {
          type: 'output_message',
          executionId: request.executionId,
          text: assistantText,
        };
      }

      const finalResult: ExecutionFinalResult = {
        status: 'success',
        outputText: assistantText || null,
        providerSessionId,
        ...(workspaceOverlay ? { workspaceOverlay } : {}),
      };

      yield {
        type: 'final',
        executionId: request.executionId,
        result: finalResult,
      };

      return finalResult;
    }
  }
}

export const localEdgeRunner: EdgeRunner = new LocalEdgeRunner();
export const anthropicEdgeRunner: EdgeRunner = new AnthropicEdgeRunner();
export const openAiCompatibleEdgeRunner: EdgeRunner =
  new OpenAiCompatibleEdgeRunner();
