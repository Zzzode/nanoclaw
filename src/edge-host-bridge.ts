import type { WorkspaceOverlay } from './agent-backend.js';

export interface EdgeHostToolInvocation {
  tool: string;
  args?: Record<string, unknown>;
}

export interface EdgeHostToolExecutionResult {
  result: unknown;
  outputText: string | null;
  workspaceOverlayDigest?: string;
  workspaceOverlay?: WorkspaceOverlay;
}

export interface EdgeHostBridge {
  executeTool(
    invocation: EdgeHostToolInvocation,
  ): Promise<EdgeHostToolExecutionResult>;
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
  }>;
}

let activeBridge: EdgeHostBridge | null = null;

export function setEdgeHostBridge(bridge: EdgeHostBridge | null): void {
  activeBridge = bridge;
}

export function getEdgeHostBridge(): EdgeHostBridge | null {
  return activeBridge;
}

export type EdgeRunnerProtocolMessage =
  | {
      type: 'execution_request';
      payload: unknown;
    }
  | {
      type: 'host_tool_call';
      id: string;
      tool: string;
      args?: Record<string, unknown>;
    }
  | {
      type: 'host_tool_result';
      id: string;
      ok: boolean;
      result?: unknown;
      outputText?: string | null;
      workspaceOverlayDigest?: string;
      workspaceOverlay?: WorkspaceOverlay;
      error?: string;
    }
  | {
      type: 'host_http_call';
      id: string;
      url: string;
      method?: string;
      headers?: Record<string, string>;
      body?: string;
    }
  | {
      type: 'host_http_result';
      id: string;
      ok: boolean;
      status?: number;
      url?: string;
      body?: string;
      error?: string;
    };

export function edgeToolRequiresHostBridge(tool: string): boolean {
  return (
    tool === 'task.create' ||
    tool === 'task.list' ||
    tool === 'task.delete' ||
    tool === 'task.update'
  );
}
