import type { AgentRunInput, ExecutionContext } from './agent-backend.js';
import {
  type CapabilityTag,
  type BackendFallbackReason,
  type RouteReason,
  selectAgentBackend,
} from './backend-selection.js';
import {
  beginExecution,
  deriveExecutionLeaseMs,
  linkExecutionToTaskNode,
  type BeginExecutionOptions,
  type StartedExecutionLease,
} from './execution-state.js';
import type { AgentBackendId, ExecutionMode } from './execution-mode.js';
import {
  resolveFrameworkAdaptivePolicy,
  type FrameworkAdaptivePolicy,
} from './framework-policy.js';
import {
  createRootTaskGraph,
  markTaskNodeRunning,
  type FrameworkRequestKind,
  type WorkerClass,
} from './task-graph-state.js';
import type { RegisteredGroup } from './types.js';
import { ensureWorkspaceVersion } from './workspace-service.js';

export interface FrameworkRootTaskGraph {
  graphId: string;
  rootTaskId: string;
  requestKind: FrameworkRequestKind;
  scopeType: BeginExecutionOptions['scopeType'];
  scopeId: string;
  groupFolder: string;
  chatJid: string;
}

export interface FrameworkWorkerPlacement {
  executionMode: ExecutionMode;
  backendId: AgentBackendId;
  workerClass: WorkerClass;
  requiredCapabilities: CapabilityTag[];
  routeReason: RouteReason;
  policyVersion: string;
  adaptivePolicy: FrameworkAdaptivePolicy;
  fallbackEligible: boolean;
  fallbackReason?: BackendFallbackReason;
}

export interface FrameworkRunContext {
  graph: FrameworkRootTaskGraph;
  placement: FrameworkWorkerPlacement;
  execution: StartedExecutionLease;
  baseWorkspaceVersion: string;
  executionContext: ExecutionContext;
}

function buildFrameworkGraphId(turnId: string): string {
  return `graph:${turnId}`;
}

function buildFrameworkRootTaskId(turnId: string): string {
  return `task:${turnId}:root`;
}

export function mapBackendIdToWorkerClass(
  backendId: AgentBackendId,
): WorkerClass {
  return backendId === 'container' ? 'heavy' : 'edge';
}

export function createFrameworkRunContext(options: {
  requestKind: FrameworkRequestKind;
  group: RegisteredGroup;
  input: Pick<AgentRunInput, 'prompt' | 'script' | 'chatJid'>;
  defaultExecutionMode: ExecutionMode;
  executionScope: Pick<
    BeginExecutionOptions,
    'scopeType' | 'scopeId' | 'groupJid' | 'taskId'
  >;
}): FrameworkRunContext {
  const selection = selectAgentBackend(
    options.group,
    {
      prompt: options.input.prompt,
      script: options.input.script,
    },
    options.defaultExecutionMode,
  );
  const adaptivePolicy = resolveFrameworkAdaptivePolicy(options.requestKind);
  const baseWorkspaceVersion = ensureWorkspaceVersion(options.group.folder);
  const deadlineMs = options.group.containerConfig?.timeout ?? 5 * 60 * 1000;
  const execution = beginExecution({
    ...options.executionScope,
    backend: selection.backendId,
    baseWorkspaceVersion,
    leaseMs: deriveExecutionLeaseMs(deadlineMs),
  });
  const graph: FrameworkRootTaskGraph = {
    graphId: buildFrameworkGraphId(execution.turnId),
    rootTaskId: buildFrameworkRootTaskId(execution.turnId),
    requestKind: options.requestKind,
    scopeType: options.executionScope.scopeType,
    scopeId: options.executionScope.scopeId,
    groupFolder: options.group.folder,
    chatJid: options.input.chatJid,
  };
  const workerClass = mapBackendIdToWorkerClass(selection.backendId);

  createRootTaskGraph({
    graphId: graph.graphId,
    rootTaskId: graph.rootTaskId,
    requestKind: options.requestKind,
    scopeType: options.executionScope.scopeType,
    scopeId: options.executionScope.scopeId,
    groupFolder: options.group.folder,
    chatJid: options.input.chatJid,
    logicalSessionId: execution.logicalSessionId,
    workerClass,
    backendId: selection.backendId,
    requiredCapabilities: selection.requiredCapabilities,
    routeReason: selection.routeReason,
    policyVersion: selection.policyVersion,
    fallbackEligible: selection.fallbackEligible,
  });
  linkExecutionToTaskNode(execution.executionId, graph.rootTaskId);
  markTaskNodeRunning(graph.graphId, graph.rootTaskId);

  return {
    graph,
    placement: {
      ...selection,
      workerClass,
      adaptivePolicy,
    },
    execution,
    baseWorkspaceVersion,
    executionContext: {
      executionId: execution.executionId,
      turnId: execution.turnId,
      logicalSessionId: execution.logicalSessionId,
      groupId: options.group.folder,
      graphId: graph.graphId,
      taskNodeId: graph.rootTaskId,
      parentTaskId: null,
      workerClass,
      capabilityBudget: {
        capabilities: selection.requiredCapabilities,
        maxToolCalls: 12,
      },
      deadline: {
        deadlineMs,
      },
      idempotencyKey: `${execution.executionId}:${graph.rootTaskId}`,
      planFragment: {
        kind: 'single_root',
        requestKind: options.requestKind,
        routeReason: selection.routeReason,
        policyVersion: selection.policyVersion,
        routingProfile: adaptivePolicy.routingProfile,
        workspaceEdgeWritePolicy: adaptivePolicy.workspaceEdgeWritePolicy,
        adaptiveFanoutLimit: adaptivePolicy.adaptiveFanoutLimit,
        heavyFirstDowngradeThreshold:
          adaptivePolicy.heavyFirstDowngradeThreshold,
        heavyFirstDowngradeWindow: adaptivePolicy.heavyFirstDowngradeWindow,
        shardedControlPlaneCandidate:
          adaptivePolicy.shardedControlPlaneCandidate,
        fallbackEligible: selection.fallbackEligible,
        fallbackReason: selection.fallbackReason,
      },
      baseWorkspaceVersion,
    },
  };
}
