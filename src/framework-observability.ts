import {
  getWorkspaceCommit,
  getWorkspaceVersion,
  listExecutionStates,
  listTaskGraphs,
  listTaskNodes,
  listToolOperations,
  type ExecutionStateRecord,
} from './db.js';

type WorkspaceManifest = Record<string, string>;

export interface FrameworkRouteObservation {
  graphId: string;
  taskId: string;
  nodeKind: string;
  workerClass: string | null;
  backendId: string | null;
  requiredCapabilities: string[];
  routeReason: string | null;
  policyVersion: string | null;
  fallbackEligible: boolean;
  fallbackTarget: string | null;
  fallbackReason: string | null;
}

export type ExecutionHeartbeatHealth =
  | 'healthy'
  | 'missing'
  | 'stale'
  | 'terminal';

export type ExecutionCommitStatus =
  | 'not_attempted'
  | 'accepted_without_overlay'
  | 'applied'
  | 'conflict';

export interface FrameworkExecutionObservation {
  executionId: string;
  graphId: string | null;
  taskNodeId: string | null;
  backend: string;
  workerClass: string | null;
  routeReason: string | null;
  policyVersion: string | null;
  status: ExecutionStateRecord['status'];
  queueDelayMs: number;
  durationMs: number | null;
  timedOut: boolean;
  heartbeatHealth: ExecutionHeartbeatHealth;
  toolCallCount: number;
  workspaceChangeCount: number;
  workspaceOverlayBytes: number;
  commitStatus: ExecutionCommitStatus;
}

export interface FrameworkGovernanceSummary {
  totalGraphs: number;
  totalExecutions: number;
  routeReasonCounts: Record<string, number>;
  workerClassCounts: Record<string, number>;
  edgeOnlyCompletionRate: number;
  edgeToHeavyFallbackRate: number;
  averageFanoutWidth: number;
  averageGraphCompletionLatencyMs: number;
  commitSuccessRate: number;
  commitConflictRate: number;
}

export interface FrameworkObservabilitySnapshot {
  scope: { kind: 'global' } | { kind: 'group'; id: string };
  generatedAt: string;
  governance: FrameworkGovernanceSummary;
  routes: FrameworkRouteObservation[];
  executions: FrameworkExecutionObservation[];
}

function parseTimestamp(value: string | null | undefined): number | null {
  if (!value) return null;
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? null : parsed;
}

function safeParseManifest(manifestJson: string): WorkspaceManifest {
  try {
    const parsed = JSON.parse(manifestJson) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return {};
    }

    const manifest: WorkspaceManifest = {};
    for (const [key, value] of Object.entries(parsed)) {
      if (typeof value === 'string') {
        manifest[key] = value;
      }
    }
    return manifest;
  } catch {
    return {};
  }
}

function diffWorkspaceStats(
  base: WorkspaceManifest,
  next: WorkspaceManifest,
): {
  changeCount: number;
  overlayBytes: number;
} {
  const paths = new Set([...Object.keys(base), ...Object.keys(next)]);
  let changeCount = 0;
  let overlayBytes = 0;

  for (const path of paths) {
    const previous = base[path];
    const current = next[path];
    if (previous === current) continue;

    changeCount += 1;
    overlayBytes += Buffer.byteLength(current ?? '', 'utf8');
  }

  return { changeCount, overlayBytes };
}

function resolveWorkspaceCommitStats(executionId: string): {
  changeCount: number;
  overlayBytes: number;
  commitStatus: Exclude<ExecutionCommitStatus, 'conflict'>;
} {
  const commit = getWorkspaceCommit(`${executionId}:workspace-commit`);
  if (!commit) {
    return {
      changeCount: 0,
      overlayBytes: 0,
      commitStatus: 'not_attempted',
    };
  }

  const baseVersion = getWorkspaceVersion(commit.baseVersionId);
  const newVersion = getWorkspaceVersion(commit.newVersionId);
  if (!baseVersion || !newVersion) {
    return {
      changeCount: 0,
      overlayBytes: 0,
      commitStatus: 'applied',
    };
  }

  const stats = diffWorkspaceStats(
    safeParseManifest(baseVersion.manifestJson),
    safeParseManifest(newVersion.manifestJson),
  );
  return {
    ...stats,
    commitStatus: 'applied',
  };
}

function resolveHeartbeatHealth(
  execution: ExecutionStateRecord,
  now: Date,
): ExecutionHeartbeatHealth {
  if (
    execution.status === 'completed' ||
    execution.status === 'failed' ||
    execution.status === 'committed' ||
    execution.status === 'lost'
  ) {
    return 'terminal';
  }

  if (!execution.lastHeartbeatAt) {
    return 'missing';
  }

  const leaseUntil = parseTimestamp(execution.leaseUntil);
  if (leaseUntil === null) {
    return 'missing';
  }

  return leaseUntil >= now.getTime() ? 'healthy' : 'stale';
}

function resolveDurationMs(execution: ExecutionStateRecord): number | null {
  const startedAt = parseTimestamp(execution.createdAt);
  const finishedAt = parseTimestamp(execution.finishedAt);
  if (startedAt === null || finishedAt === null) {
    return null;
  }
  return Math.max(0, finishedAt - startedAt);
}

function resolveTimedOut(execution: ExecutionStateRecord): boolean {
  return (
    execution.status === 'lost' ||
    /timeout|deadline|lease expired/i.test(execution.error ?? '')
  );
}

function average(values: number[]): number {
  if (values.length === 0) return 0;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function summarizeFrameworkGovernanceFromRecords(
  graphs: ReturnType<typeof listTaskGraphs>,
  nodes: ReturnType<typeof listTaskNodes>,
  executions: FrameworkExecutionObservation[],
): FrameworkGovernanceSummary {
  const executionsByGraph = new Map<string, FrameworkExecutionObservation[]>();

  for (const execution of executions) {
    if (!execution.graphId) continue;
    const bucket = executionsByGraph.get(execution.graphId) ?? [];
    bucket.push(execution);
    executionsByGraph.set(execution.graphId, bucket);
  }

  const routeReasonCounts: Record<string, number> = {};
  const workerClassCounts: Record<string, number> = {};
  for (const node of nodes) {
    if (node.routeReason) {
      routeReasonCounts[node.routeReason] =
        (routeReasonCounts[node.routeReason] ?? 0) + 1;
    }
    if (node.workerClass) {
      workerClassCounts[node.workerClass] =
        (workerClassCounts[node.workerClass] ?? 0) + 1;
    }
  }

  const completedGraphs = graphs.filter(
    (graph) => graph.status === 'completed',
  );
  const edgeOnlyCompletedGraphs = completedGraphs.filter((graph) => {
    const graphExecutions = executionsByGraph.get(graph.graphId) ?? [];
    return (
      graphExecutions.length > 0 &&
      graphExecutions.every((execution) => execution.backend === 'edge')
    );
  });

  const eligibleNodes = nodes.filter((node) => node.fallbackEligible);
  const heavyFallbackNodes = eligibleNodes.filter(
    (node) => node.fallbackTarget === 'heavy',
  );

  const fanoutWidths = [...new Set(nodes.map((node) => node.graphId))]
    .map(
      (graphId) =>
        nodes.filter(
          (node) =>
            node.graphId === graphId && node.nodeKind === 'fanout_child',
        ).length,
    )
    .filter((width) => width > 0);

  const terminalGraphLatencies = graphs
    .filter(
      (graph) => graph.status === 'completed' || graph.status === 'failed',
    )
    .map((graph) => {
      const createdAt = parseTimestamp(graph.createdAt);
      const updatedAt = parseTimestamp(graph.updatedAt);
      if (createdAt === null || updatedAt === null) {
        return 0;
      }
      return Math.max(0, updatedAt - createdAt);
    });

  const commitCandidates = executions.filter(
    (execution) => execution.commitStatus !== 'not_attempted',
  );
  const successfulCommits = commitCandidates.filter(
    (execution) =>
      execution.commitStatus === 'applied' ||
      execution.commitStatus === 'accepted_without_overlay',
  );

  return {
    totalGraphs: graphs.length,
    totalExecutions: executions.length,
    routeReasonCounts,
    workerClassCounts,
    edgeOnlyCompletionRate:
      completedGraphs.length > 0
        ? edgeOnlyCompletedGraphs.length / completedGraphs.length
        : 0,
    edgeToHeavyFallbackRate:
      eligibleNodes.length > 0
        ? heavyFallbackNodes.length / eligibleNodes.length
        : 0,
    averageFanoutWidth: average(fanoutWidths),
    averageGraphCompletionLatencyMs: average(terminalGraphLatencies),
    commitSuccessRate:
      commitCandidates.length > 0
        ? successfulCommits.length / commitCandidates.length
        : 0,
    commitConflictRate:
      nodes.length > 0
        ? nodes.filter((node) => node.failureClass === 'commit_failure')
            .length / nodes.length
        : 0,
  };
}

export function listFrameworkRouteObservations(
  graphId?: string,
): FrameworkRouteObservation[] {
  return listTaskNodes(graphId).map((node) => ({
    graphId: node.graphId,
    taskId: node.taskId,
    nodeKind: node.nodeKind,
    workerClass: node.workerClass,
    backendId: node.backendId,
    requiredCapabilities: node.requiredCapabilities,
    routeReason: node.routeReason,
    policyVersion: node.policyVersion,
    fallbackEligible: node.fallbackEligible,
    fallbackTarget: node.fallbackTarget,
    fallbackReason: node.fallbackReason,
  }));
}

export function listFrameworkExecutionObservations(
  options: {
    graphId?: string;
    now?: Date;
  } = {},
): FrameworkExecutionObservation[] {
  const now = options.now ?? new Date();
  const nodes = listTaskNodes(options.graphId);
  const nodeMap = new Map(nodes.map((node) => [node.taskId, node]));
  const allNodes = options.graphId === undefined ? nodes : listTaskNodes();
  const allowedTaskIds =
    options.graphId === undefined
      ? null
      : new Set(nodes.map((node) => node.taskId));

  return listExecutionStates()
    .filter((execution) =>
      allowedTaskIds
        ? execution.taskNodeId !== null &&
          allowedTaskIds.has(execution.taskNodeId)
        : true,
    )
    .map((execution) => {
      const node =
        execution.taskNodeId !== null
          ? (nodeMap.get(execution.taskNodeId) ??
            allNodes.find(
              (candidate) => candidate.taskId === execution.taskNodeId,
            ))
          : undefined;
      const commitStats = resolveWorkspaceCommitStats(execution.executionId);
      const commitStatus: ExecutionCommitStatus =
        node?.failureClass === 'commit_failure'
          ? 'conflict'
          : execution.committedAt &&
              commitStats.commitStatus === 'not_attempted'
            ? 'accepted_without_overlay'
            : commitStats.commitStatus;

      return {
        executionId: execution.executionId,
        graphId: node?.graphId ?? null,
        taskNodeId: execution.taskNodeId,
        backend: execution.backend,
        workerClass: execution.backend === 'container' ? 'heavy' : 'edge',
        routeReason: node?.routeReason ?? null,
        policyVersion: node?.policyVersion ?? null,
        status: execution.status,
        queueDelayMs: 0,
        durationMs: resolveDurationMs(execution),
        timedOut: resolveTimedOut(execution),
        heartbeatHealth: resolveHeartbeatHealth(execution, now),
        toolCallCount: listToolOperations(execution.executionId).length,
        workspaceChangeCount: commitStats.changeCount,
        workspaceOverlayBytes: commitStats.overlayBytes,
        commitStatus,
      };
    });
}

export function summarizeFrameworkGovernance(
  now: Date = new Date(),
): FrameworkGovernanceSummary {
  const graphs = listTaskGraphs();
  const nodes = listTaskNodes();
  const executions = listFrameworkExecutionObservations({ now });
  return summarizeFrameworkGovernanceFromRecords(graphs, nodes, executions);
}

export function buildFrameworkObservabilitySnapshot(
  options: {
    now?: Date;
    groupFolder?: string;
  } = {},
): FrameworkObservabilitySnapshot {
  const now = options.now ?? new Date();
  const allGraphs = listTaskGraphs();
  const graphs = options.groupFolder
    ? allGraphs.filter((graph) => graph.groupFolder === options.groupFolder)
    : allGraphs;
  const allowedGraphIds = new Set(graphs.map((graph) => graph.graphId));
  const allNodes = listTaskNodes();
  const nodes = options.groupFolder
    ? allNodes.filter((node) => allowedGraphIds.has(node.graphId))
    : allNodes;
  const executions = options.groupFolder
    ? listFrameworkExecutionObservations({ now }).filter(
        (execution) =>
          execution.graphId !== null && allowedGraphIds.has(execution.graphId),
      )
    : listFrameworkExecutionObservations({ now });

  return {
    scope: options.groupFolder
      ? { kind: 'group', id: options.groupFolder }
      : { kind: 'global' },
    generatedAt: now.toISOString(),
    governance: summarizeFrameworkGovernanceFromRecords(
      graphs,
      nodes,
      executions,
    ),
    routes: nodes.map((node) => ({
      graphId: node.graphId,
      taskId: node.taskId,
      nodeKind: node.nodeKind,
      workerClass: node.workerClass,
      backendId: node.backendId,
      requiredCapabilities: node.requiredCapabilities,
      routeReason: node.routeReason,
      policyVersion: node.policyVersion,
      fallbackEligible: node.fallbackEligible,
      fallbackTarget: node.fallbackTarget,
      fallbackReason: node.fallbackReason,
    })),
    executions,
  };
}
