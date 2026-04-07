import readline from 'readline';

import type { ExecutionRequest } from './agent-backend.js';
import type {
  EdgeHostToolExecutionResult,
  EdgeHostToolInvocation,
  EdgeRunnerProtocolMessage,
} from './edge-host-bridge.js';
import {
  anthropicEdgeRunner,
  localEdgeRunner,
  openAiCompatibleEdgeRunner,
} from './edge-runner.js';
import { setEdgeHostBridge } from './edge-host-bridge.js';

function resolveRunner(request: ExecutionRequest) {
  if (request.runner?.provider === 'anthropic') {
    return anthropicEdgeRunner;
  }
  if (request.runner?.provider === 'openai') {
    return openAiCompatibleEdgeRunner;
  }
  return localEdgeRunner;
}

class StdIoEdgeHostBridge {
  private nextId = 0;
  private readonly pending = new Map<
    string,
    {
      resolve: (result: any) => void;
      reject: (error: Error) => void;
    }
  >();

  executeTool(
    invocation: EdgeHostToolInvocation,
  ): Promise<EdgeHostToolExecutionResult> {
    const id = `host-tool-${++this.nextId}`;
    process.stdout.write(
      `${JSON.stringify({
        type: 'host_tool_call',
        id,
        tool: invocation.tool,
        args: invocation.args ?? {},
      } satisfies EdgeRunnerProtocolMessage)}\n`,
    );

    return new Promise<EdgeHostToolExecutionResult>((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
    });
  }

  requestHttp(input: {
    url: string;
    method?: string;
    headers?: Record<string, string>;
    body?: string;
  }): Promise<{
    status: number;
    ok: boolean;
    url: string;
    body: string;
  }> {
    const id = `host-http-${++this.nextId}`;
    process.stdout.write(
      `${JSON.stringify({
        type: 'host_http_call',
        id,
        url: input.url,
        method: input.method,
        headers: input.headers,
        body: input.body,
      } satisfies EdgeRunnerProtocolMessage)}\n`,
    );

    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
    }) as Promise<{
      status: number;
      ok: boolean;
      url: string;
      body: string;
    }>;
  }

  handleMessage(message: EdgeRunnerProtocolMessage): boolean {
    if (
      message.type !== 'host_tool_result' &&
      message.type !== 'host_http_result'
    ) {
      return false;
    }

    const pending = this.pending.get(message.id);
    if (!pending) {
      throw new Error(`Unknown host tool result id: ${message.id}`);
    }
    this.pending.delete(message.id);

    if (!message.ok) {
      pending.reject(new Error(message.error || 'Host tool execution failed.'));
      return true;
    }

    if (message.type === 'host_tool_result') {
      pending.resolve({
        result: message.result ?? null,
        outputText:
          typeof message.outputText === 'string' ? message.outputText : null,
        workspaceOverlayDigest: message.workspaceOverlayDigest,
        workspaceOverlay: message.workspaceOverlay,
      } satisfies EdgeHostToolExecutionResult);
      return true;
    }

    pending.resolve({
      status: message.status ?? 0,
      ok: message.ok,
      url: message.url ?? '',
      body: message.body ?? '',
    });
    return true;
  }

  failPending(error: Error): void {
    for (const pending of this.pending.values()) {
      pending.reject(error);
    }
    this.pending.clear();
  }
}

async function main(): Promise<void> {
  const rl = readline.createInterface({
    input: process.stdin,
    crlfDelay: Infinity,
  });
  const iterator = rl[Symbol.asyncIterator]();
  const first = await iterator.next();
  if (first.done || !first.value.trim()) {
    throw new Error('Missing execution request on stdin');
  }

  const firstMessage = JSON.parse(
    first.value.trim(),
  ) as EdgeRunnerProtocolMessage;
  if (firstMessage.type !== 'execution_request') {
    throw new Error('Expected execution_request on stdin');
  }

  const request = firstMessage.payload as ExecutionRequest;
  const runner = resolveRunner(request);
  const bridge = new StdIoEdgeHostBridge();
  setEdgeHostBridge(bridge);

  const pumpInput = (async () => {
    while (true) {
      const next = await iterator.next();
      if (next.done) break;
      const trimmed = next.value.trim();
      if (!trimmed) continue;
      const message = JSON.parse(trimmed) as EdgeRunnerProtocolMessage;
      bridge.handleMessage(message);
    }
  })();

  try {
    for await (const event of runner.runTurn(request)) {
      process.stdout.write(`${JSON.stringify(event)}\n`);
    }
  } finally {
    setEdgeHostBridge(null);
    bridge.failPending(new Error('Edge runner stdin closed.'));
    rl.close();
    await pumpInput.catch(() => undefined);
  }
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
});
