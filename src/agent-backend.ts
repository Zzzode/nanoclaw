import { ChildProcess } from 'child_process';

import { RegisteredGroup } from './types.js';

export interface ExecutionCapabilityBudget {
  capabilities: string[];
  maxToolCalls: number;
}

export interface ExecutionDeadline {
  deadlineMs: number;
  expiresAt?: string | null;
}

export interface ExecutionPlanFragment {
  kind: 'single_root' | 'edge_fanout_child' | 'edge_fanout_aggregate' | 'edge_team_planner';
  requestKind?: string;
  routeReason?: string;
  policyVersion?: string;
  routingProfile?: string;
  workspaceEdgeWritePolicy?: string;
  adaptiveFanoutLimit?: number | null;
  heavyFirstDowngradeThreshold?: number | null;
  heavyFirstDowngradeWindow?: number | null;
  shardedControlPlaneCandidate?: boolean;
  fallbackEligible?: boolean;
  fallbackReason?: string;
  fanoutTeamSize?: number;
  fanoutRole?: string;
}

export interface ExecutionContext {
  executionId: string;
  turnId: string;
  logicalSessionId: string;
  groupId?: string;
  graphId?: string;
  taskNodeId?: string;
  parentTaskId?: string | null;
  workerClass?: 'edge' | 'heavy';
  capabilityBudget?: ExecutionCapabilityBudget;
  deadline?: ExecutionDeadline;
  idempotencyKey?: string;
  planFragment?: ExecutionPlanFragment;
  baseWorkspaceVersion?: string | null;
}

export interface AgentRunInput {
  prompt: string;
  sessionId?: string;
  groupFolder: string;
  chatJid: string;
  isMain: boolean;
  isScheduledTask?: boolean;
  assistantName?: string;
  script?: string;
  shadowMode?: boolean;
  executionContext?: ExecutionContext;
}

export interface AgentRunOutput {
  status: 'success' | 'error';
  result: string | null;
  newSessionId?: string;
  error?: string;
  metadata?: {
    source?: 'edge' | 'heavy';
    event?: string;
    targetKey?: string;
    detail?: string;
    summary?: string;
  };
}

export interface StartedExecution {
  chatJid: string;
  process: ChildProcess;
  executionName: string;
  groupFolder?: string;
}

export type ExecutionStartedCallback = (execution: StartedExecution) => void;
export type AgentOutputCallback = (output: AgentRunOutput) => Promise<void>;

export interface ExecutionRequest {
  executionId: string;
  graphId: string;
  taskId: string;
  parentTaskId: string | null;
  logicalSessionId: string;
  workerClass: 'edge' | 'heavy';
  groupId: string;
  chatJid: string;
  turnId: string;
  modelProfile: string;
  workspaceRef: string;
  capabilityBudget: ExecutionCapabilityBudget;
  deadline: ExecutionDeadline;
  idempotencyKey: string;
  planFragment: ExecutionPlanFragment;
  promptPackage: {
    system: string;
    summary: string | null;
    recentMessages: Array<{
      role: 'user' | 'assistant';
      content: string;
    }>;
    taskContext?: {
      isScheduledTask: boolean;
      script?: string;
    };
  };
  workspace: {
    baseVersion: string;
    manifestRef: string;
  };
  memory: {
    groupMemoryVersion: string;
    globalMemoryVersion?: string;
  };
  limits: {
    maxToolCalls: number;
    deadlineMs: number;
    maxOutputBytes: number;
  };
  runner?: {
    provider?: 'local' | 'anthropic' | 'openai';
    apiBaseUrl?: string;
    apiKey?: string;
    model?: string;
  };
  policy: {
    allowedTools: string[];
    networkProfile: string;
    capabilities?: string[];
    execution?: {
      allowJsExecution?: boolean;
      maxJsExecutions?: number;
      allowedModuleImports?: string[];
    };
  };
}

export interface CommitDecision {
  status: 'accepted' | 'rejected' | 'deferred';
  reason?: string;
}

export interface ExecutionResult {
  status: 'success' | 'error';
  outputText: string | null;
  providerSessionId?: string;
  workspaceOverlay?: WorkspaceOverlay;
  commitDecision?: CommitDecision;
  error?: {
    code: string;
    message: string;
  };
}

export type ExecutionFinalResult = ExecutionResult;

export interface WorkspaceOverlayChange {
  op: 'write' | 'delete';
  path: string;
  content?: string;
}

export interface WorkspaceOverlay {
  changes: WorkspaceOverlayChange[];
  digest: string;
}

export type ExecutionEvent =
  | { type: 'ack'; executionId: string; nodeId: string }
  | { type: 'heartbeat'; executionId: string; at: string }
  | { type: 'progress'; executionId: string; message: string }
  | { type: 'output_delta'; executionId: string; text: string }
  | { type: 'output_message'; executionId: string; text: string }
  | { type: 'tool_call'; executionId: string; tool: string; args: unknown }
  | { type: 'tool_result'; executionId: string; tool: string; result: unknown }
  | { type: 'warning'; executionId: string; message: string }
  | {
      type: 'needs_fallback';
      executionId: string;
      reason: string;
      suggestedWorkerClass?: 'edge' | 'heavy';
    }
  | {
      type: 'checkpoint';
      executionId: string;
      providerSession?: unknown;
      summaryDelta?: string;
      workspaceOverlayDigest?: string;
      workspaceOverlay?: WorkspaceOverlay;
    }
  | { type: 'final'; executionId: string; result: ExecutionFinalResult }
  | { type: 'error'; executionId: string; code: string; message: string };

export interface ExecutionEventHooks {
  onAck?(event: Extract<ExecutionEvent, { type: 'ack' }>): Promise<void> | void;
  onHeartbeat?(
    event: Extract<ExecutionEvent, { type: 'heartbeat' }>,
  ): Promise<void> | void;
  onProgress?(
    event: Extract<ExecutionEvent, { type: 'progress' }>,
  ): Promise<void> | void;
  onWarning?(
    event: Extract<ExecutionEvent, { type: 'warning' }>,
  ): Promise<void> | void;
  onNeedsFallback?(
    event: Extract<ExecutionEvent, { type: 'needs_fallback' }>,
  ): Promise<void> | void;
  onCheckpoint?(
    event: Extract<ExecutionEvent, { type: 'checkpoint' }>,
  ): Promise<void> | void;
  onFinal?(
    event: Extract<ExecutionEvent, { type: 'final' }>,
  ): Promise<void> | void;
  onError?(
    event: Extract<ExecutionEvent, { type: 'error' }>,
  ): Promise<void> | void;
}

export interface AgentBackend {
  run(
    group: RegisteredGroup,
    input: AgentRunInput,
    onExecutionStarted?: ExecutionStartedCallback,
    onOutput?: AgentOutputCallback,
  ): Promise<AgentRunOutput>;
}
