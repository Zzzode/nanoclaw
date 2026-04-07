import { spawn } from 'child_process';
import fs from 'fs';
import { createRequire } from 'module';
import path from 'path';
import { fileURLToPath } from 'url';
import readline from 'readline';

import type { ExecutionEvent, ExecutionRequest } from './agent-backend.js';
import { EDGEJS_BIN, EDGE_RUNNER_MODE } from './config.js';
import type { EdgeRunnerProtocolMessage } from './edge-host-bridge.js';
import type { EdgeRunner } from './edge-runner.js';
import { executeEdgeTool } from './edge-tool-host.js';

const MAX_STDERR_BYTES = 8192;
const HOST_HTTP_TIMEOUT_MS = 120_000;

interface RunnerCommand {
  command: string;
  args: string[];
  cwd?: string;
}

function looksLikeJsonProtocolLine(line: string): boolean {
  const first = line.trimStart()[0];
  return first === '{' || first === '[';
}

function resolveNanoclawRoot(): string {
  const srcRoot = fileURLToPath(new URL('..', import.meta.url));
  const distRoot = fileURLToPath(new URL('../..', import.meta.url));
  return fs.existsSync(path.join(srcRoot, 'package.json')) ? srcRoot : distRoot;
}

function resolveEdgeJsBin(): string | null {
  if (EDGEJS_BIN && fs.existsSync(EDGEJS_BIN)) {
    return EDGEJS_BIN;
  }

  const siblingBin = path.resolve(
    resolveNanoclawRoot(),
    '..',
    'edgejs',
    'build-edge',
    'edge',
  );
  if (fs.existsSync(siblingBin)) {
    return siblingBin;
  }

  return null;
}

export function resolveRunnerCommand(): RunnerCommand {
  const nanoclawRoot = resolveNanoclawRoot();
  const distEntry = path.join(nanoclawRoot, 'dist', 'edge-runner-cli.js');
  if (EDGE_RUNNER_MODE === 'edgejs') {
    const edgeBin = resolveEdgeJsBin();
    if (!edgeBin) {
      throw new Error(
        'EDGE_RUNNER_MODE=edgejs requires EDGEJS_BIN or ../edgejs/build-edge/edge.',
      );
    }
    if (!fs.existsSync(distEntry)) {
      throw new Error(
        'EDGE_RUNNER_MODE=edgejs requires a built dist/edge-runner-cli.js. Run npm run build first.',
      );
    }
    return {
      command: edgeBin,
      args: ['--safe', 'dist/edge-runner-cli.js'],
      cwd: nanoclawRoot,
    };
  }

  if (fs.existsSync(distEntry)) {
    return {
      command: process.execPath,
      args: [distEntry],
      cwd: nanoclawRoot,
    };
  }

  const sourceEntry = fileURLToPath(
    new URL('./edge-runner-cli.ts', import.meta.url),
  );
  const require = createRequire(import.meta.url);

  return {
    command: process.execPath,
    args: ['--import', require.resolve('tsx'), sourceEntry],
    cwd: nanoclawRoot,
  };
}

class EdgeSubprocessRunner implements EdgeRunner {
  async *runTurn(
    request: ExecutionRequest,
    options?: {
      signal?: AbortSignal;
    },
  ): AsyncGenerator<ExecutionEvent> {
    const runner = resolveRunnerCommand();
    const child = spawn(runner.command, runner.args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      cwd: runner.cwd,
    });
    const signal = options?.signal;
    const handleAbort = () => {
      child.kill('SIGTERM');
    };
    signal?.addEventListener('abort', handleAbort, { once: true });

    let stderr = '';
    child.stderr.on('data', (chunk) => {
      if (stderr.length >= MAX_STDERR_BYTES) return;
      const text = chunk.toString();
      const remaining = MAX_STDERR_BYTES - stderr.length;
      stderr += text.slice(0, remaining);
    });

    const exitPromise = new Promise<number | null>((resolve, reject) => {
      child.once('error', reject);
      child.once('close', (code) => resolve(code));
    });

    child.stdin.write(
      `${JSON.stringify({
        type: 'execution_request',
        payload: request,
      } satisfies EdgeRunnerProtocolMessage)}\n`,
    );

    const rl = readline.createInterface({
      input: child.stdout,
      crlfDelay: Infinity,
    });

    try {
      for await (const line of rl) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        if (!looksLikeJsonProtocolLine(trimmed)) {
          continue;
        }

        const parsed = JSON.parse(trimmed) as
          | EdgeRunnerProtocolMessage
          | ExecutionEvent;
        if (
          parsed &&
          typeof parsed === 'object' &&
          !Array.isArray(parsed) &&
          'type' in parsed &&
          parsed.type === 'host_tool_call'
        ) {
          try {
            const result = await executeEdgeTool(request, {
              tool: parsed.tool,
              args: parsed.args ?? {},
            });
            child.stdin.write(
              `${JSON.stringify({
                type: 'host_tool_result',
                id: parsed.id,
                ok: true,
                result: result.result,
                outputText: result.outputText,
                workspaceOverlayDigest: result.workspaceOverlayDigest,
                workspaceOverlay: result.workspaceOverlay,
              } satisfies EdgeRunnerProtocolMessage)}\n`,
            );
          } catch (error) {
            child.stdin.write(
              `${JSON.stringify({
                type: 'host_tool_result',
                id: parsed.id,
                ok: false,
                error: error instanceof Error ? error.message : String(error),
              } satisfies EdgeRunnerProtocolMessage)}\n`,
            );
          }
          continue;
        }

        if (
          parsed &&
          typeof parsed === 'object' &&
          !Array.isArray(parsed) &&
          'type' in parsed &&
          parsed.type === 'host_http_call'
        ) {
          try {
            const controller = new AbortController();
            const timeout = setTimeout(
              () => controller.abort(),
              HOST_HTTP_TIMEOUT_MS,
            );
            try {
              const response = await fetch(parsed.url, {
                method: parsed.method || 'GET',
                headers: parsed.headers,
                body: parsed.body,
                signal: controller.signal,
              });
              const body = await response.text();
              child.stdin.write(
                `${JSON.stringify({
                  type: 'host_http_result',
                  id: parsed.id,
                  ok: response.ok,
                  status: response.status,
                  url: response.url,
                  body,
                  ...(response.ok
                    ? {}
                    : {
                        error: `HTTP ${response.status}`,
                      }),
                } satisfies EdgeRunnerProtocolMessage)}\n`,
              );
            } finally {
              clearTimeout(timeout);
            }
          } catch (error) {
            child.stdin.write(
              `${JSON.stringify({
                type: 'host_http_result',
                id: parsed.id,
                ok: false,
                error: error instanceof Error ? error.message : String(error),
              } satisfies EdgeRunnerProtocolMessage)}\n`,
            );
          }
          continue;
        }

        let event: ExecutionEvent;
        try {
          event = parsed as ExecutionEvent;
        } catch (error) {
          const message =
            error instanceof Error ? error.message : String(error);
          throw new Error(`Invalid edge runner event JSON: ${message}`);
        }

        yield event;
      }
    } finally {
      rl.close();
      child.stdin.end();
      signal?.removeEventListener('abort', handleAbort);
    }

    const exitCode = await exitPromise;
    if (signal?.aborted && exitCode !== 0) {
      return;
    }
    if (exitCode !== 0) {
      throw new Error(
        stderr.trim()
          ? `Edge runner exited with code ${exitCode}: ${stderr.trim()}`
          : `Edge runner exited with code ${exitCode}`,
      );
    }
  }
}

export function createSubprocessEdgeRunner(): EdgeRunner {
  return new EdgeSubprocessRunner();
}
