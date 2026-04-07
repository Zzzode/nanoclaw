import {
  createTaskNodeDependency,
  createTaskGraph,
  createTaskNode,
  getTaskGraph,
  getTaskNode,
  listTaskNodes,
  listTaskNodeDependencies,
  type AggregatePolicy,
  type LogicalSessionScopeType,
  type TaskFailureClass,
  type TaskGraphRecord,
  type TaskNodeRecord,
  updateTaskGraph,
  updateTaskNode,
} from './db.js';
import { FRAMEWORK_POLICY_VERSION } from './framework-policy.js';

export type FrameworkRequestKind = 'group_turn' | 'scheduled_task';
export type WorkerClass = 'edge' | 'heavy';
export type TaskFallbackReason =
  | 'unsupported_capability'
  | 'policy_denied'
  | 'edge_timeout'
  | 'edge_runtime_unhealthy'
  | 'state_conflict_requires_heavy'
  | 'human_review_required';
export type TaskFallbackTarget = WorkerClass | 'replan' | 'human_review';

function nowIso(now: Date = new Date()): string {
  return now.toISOString();
}

export function createRootTaskGraph(options: {
  graphId: string;
  rootTaskId: string;
  requestKind: FrameworkRequestKind;
  scopeType: LogicalSessionScopeType;
  scopeId: string;
  groupFolder: string;
  chatJid: string;
  logicalSessionId: string;
  workerClass: WorkerClass;
  backendId: string;
  requiredCapabilities?: string[];
  routeReason?: string | null;
  policyVersion?: string | null;
  fallbackEligible?: boolean;
  now?: Date;
}): {
  graph: TaskGraphRecord;
  rootNode: TaskNodeRecord;
} {
  const timestamp = nowIso(options.now);
  const graph: TaskGraphRecord = {
    graphId: options.graphId,
    requestKind: options.requestKind,
    scopeType: options.scopeType,
    scopeId: options.scopeId,
    groupFolder: options.groupFolder,
    chatJid: options.chatJid,
    logicalSessionId: options.logicalSessionId,
    rootTaskId: options.rootTaskId,
    status: 'ready',
    error: null,
    createdAt: timestamp,
    updatedAt: timestamp,
  };
  const rootNode: TaskNodeRecord = {
    taskId: options.rootTaskId,
    graphId: options.graphId,
    parentTaskId: null,
    nodeKind: 'root',
    workerClass: options.workerClass,
    backendId: options.backendId,
    requiredCapabilities: options.requiredCapabilities ?? [],
    routeReason: options.routeReason ?? null,
    policyVersion: options.policyVersion ?? null,
    fallbackEligible: options.fallbackEligible ?? false,
    fallbackTarget: null,
    fallbackReason: null,
    failureClass: null,
    aggregatePolicy: null,
    quorumCount: null,
    status: 'ready',
    error: null,
    createdAt: timestamp,
    updatedAt: timestamp,
  };

  createTaskGraph(graph);
  createTaskNode(rootNode);

  return { graph, rootNode };
}

export function createTaskNodeInGraph(options: {
  taskId: string;
  graphId: string;
  parentTaskId: string | null;
  nodeKind: string;
  workerClass: WorkerClass;
  backendId: string;
  requiredCapabilities?: string[];
  routeReason?: string | null;
  policyVersion?: string | null;
  fallbackEligible?: boolean;
  aggregatePolicy?: AggregatePolicy | null;
  quorumCount?: number | null;
  now?: Date;
}): TaskNodeRecord {
  const timestamp = nowIso(options.now);
  const node: TaskNodeRecord = {
    taskId: options.taskId,
    graphId: options.graphId,
    parentTaskId: options.parentTaskId,
    nodeKind: options.nodeKind,
    workerClass: options.workerClass,
    backendId: options.backendId,
    requiredCapabilities: options.requiredCapabilities ?? [],
    routeReason: options.routeReason ?? null,
    policyVersion: options.policyVersion ?? null,
    fallbackEligible: options.fallbackEligible ?? false,
    fallbackTarget: null,
    fallbackReason: null,
    failureClass: null,
    aggregatePolicy: options.aggregatePolicy ?? null,
    quorumCount: options.quorumCount ?? null,
    status: 'ready',
    error: null,
    createdAt: timestamp,
    updatedAt: timestamp,
  };
  createTaskNode(node);
  return node;
}

export function addTaskNodeDependency(
  taskId: string,
  dependsOnTaskId: string,
  now: Date = new Date(),
): void {
  createTaskNodeDependency({
    taskId,
    dependsOnTaskId,
    createdAt: nowIso(now),
  });
}

export function createAggregateTaskNode(options: {
  taskId: string;
  graphId: string;
  parentTaskId: string | null;
  workerClass: WorkerClass;
  backendId: string;
  aggregatePolicy: AggregatePolicy;
  quorumCount?: number | null;
  dependsOnTaskIds: string[];
  requiredCapabilities?: string[];
  routeReason?: string | null;
  policyVersion?: string | null;
  fallbackEligible?: boolean;
  now?: Date;
}): TaskNodeRecord {
  const node = createTaskNodeInGraph({
    taskId: options.taskId,
    graphId: options.graphId,
    parentTaskId: options.parentTaskId,
    nodeKind: 'aggregate',
    workerClass: options.workerClass,
    backendId: options.backendId,
    requiredCapabilities: options.requiredCapabilities,
    routeReason: options.routeReason,
    policyVersion: options.policyVersion ?? null,
    fallbackEligible: options.fallbackEligible,
    aggregatePolicy: options.aggregatePolicy,
    quorumCount: options.quorumCount ?? null,
    now: options.now,
  });

  for (const dependsOnTaskId of options.dependsOnTaskIds) {
    addTaskNodeDependency(node.taskId, dependsOnTaskId, options.now);
  }

  return node;
}

export function createFanoutTaskGraph(options: {
  graphId: string;
  rootTaskId: string;
  aggregateTaskId: string;
  requestKind: FrameworkRequestKind;
  scopeType: LogicalSessionScopeType;
  scopeId: string;
  groupFolder: string;
  chatJid: string;
  logicalSessionId: string;
  childTasks: Array<{
    taskId: string;
    requiredCapabilities?: string[];
    routeReason?: string | null;
  }>;
  aggregatePolicy: AggregatePolicy;
  quorumCount?: number | null;
  now?: Date;
}): {
  graph: TaskGraphRecord;
  rootNode: TaskNodeRecord;
  childNodes: TaskNodeRecord[];
  aggregateNode: TaskNodeRecord;
} {
  const { graph, rootNode } = createRootTaskGraph({
    graphId: options.graphId,
    rootTaskId: options.rootTaskId,
    requestKind: options.requestKind,
    scopeType: options.scopeType,
    scopeId: options.scopeId,
    groupFolder: options.groupFolder,
    chatJid: options.chatJid,
    logicalSessionId: options.logicalSessionId,
    workerClass: 'edge',
    backendId: 'edge',
    routeReason: 'edge.fanout',
    policyVersion: FRAMEWORK_POLICY_VERSION,
    now: options.now,
  });

  const childNodes = options.childTasks.map((child) =>
    createTaskNodeInGraph({
      taskId: child.taskId,
      graphId: graph.graphId,
      parentTaskId: rootNode.taskId,
      nodeKind: 'fanout_child',
      workerClass: 'edge',
      backendId: 'edge',
      requiredCapabilities: child.requiredCapabilities,
      routeReason: child.routeReason ?? 'capability_match_edge',
      policyVersion: FRAMEWORK_POLICY_VERSION,
      fallbackEligible: true,
      now: options.now,
    }),
  );

  const aggregateNode = createAggregateTaskNode({
    taskId: options.aggregateTaskId,
    graphId: graph.graphId,
    parentTaskId: rootNode.taskId,
    workerClass: 'edge',
    backendId: 'edge',
    aggregatePolicy: options.aggregatePolicy,
    quorumCount: options.quorumCount ?? null,
    dependsOnTaskIds: childNodes.map((child) => child.taskId),
    requiredCapabilities: ['fs.read'],
    routeReason: 'edge.aggregate',
    policyVersion: FRAMEWORK_POLICY_VERSION,
    fallbackEligible: true,
    now: options.now,
  });

  addTaskNodeDependency(rootNode.taskId, aggregateNode.taskId, options.now);

  return { graph, rootNode, childNodes, aggregateNode };
}

export function markTaskNodeRunning(
  graphId: string,
  taskId: string,
  now: Date = new Date(),
): void {
  const timestamp = nowIso(now);
  updateTaskGraph(graphId, {
    status: 'running',
    updatedAt: timestamp,
  });
  updateTaskNode(taskId, {
    status: 'running',
    updatedAt: timestamp,
  });
}

export function completeTaskNode(taskId: string, now: Date = new Date()): void {
  updateTaskNode(taskId, {
    status: 'completed',
    error: null,
    fallbackTarget: null,
    fallbackReason: null,
    failureClass: null,
    updatedAt: nowIso(now),
  });
}

export function failTaskNode(
  taskId: string,
  error: string,
  now: Date = new Date(),
): void {
  updateTaskNode(taskId, {
    status: 'failed',
    error,
    failureClass: 'execution_failure',
    updatedAt: nowIso(now),
  });
}

export function recordTaskNodeFailure(options: {
  taskId: string;
  error: string;
  failureClass: TaskFailureClass;
  fallbackTarget?: TaskFallbackTarget | null;
  fallbackReason?: TaskFallbackReason | null;
  now?: Date;
}): void {
  updateTaskNode(options.taskId, {
    status: 'failed',
    error: options.error,
    failureClass: options.failureClass,
    fallbackTarget: options.fallbackTarget ?? null,
    fallbackReason: options.fallbackReason ?? null,
    updatedAt: nowIso(options.now),
  });
}

export function retryTaskNodeOnSameWorker(
  taskId: string,
  now: Date = new Date(),
): void {
  updateTaskNode(taskId, {
    status: 'ready',
    error: null,
    failureClass: null,
    fallbackTarget: null,
    fallbackReason: null,
    updatedAt: nowIso(now),
  });
}

export function fallbackTaskNodeToHeavy(
  taskId: string,
  reason: TaskFallbackReason,
  now: Date = new Date(),
): void {
  updateTaskNode(taskId, {
    workerClass: 'heavy',
    backendId: 'container',
    status: 'ready',
    error: null,
    failureClass: null,
    fallbackTarget: 'heavy',
    fallbackReason: reason,
    updatedAt: nowIso(now),
  });
}

export function requireReplanForTaskNode(
  taskId: string,
  reason: TaskFallbackReason,
  now: Date = new Date(),
): void {
  updateTaskNode(taskId, {
    status: 'failed',
    error: `Replan required: ${reason}`,
    failureClass: 'commit_failure',
    fallbackTarget: 'replan',
    fallbackReason: reason,
    updatedAt: nowIso(now),
  });
}

export function requestHumanReviewForTaskNode(
  taskId: string,
  reason: Extract<TaskFallbackReason, 'human_review_required'>,
  now: Date = new Date(),
): void {
  updateTaskNode(taskId, {
    status: 'failed',
    error: `Human review required: ${reason}`,
    failureClass: 'semantic_failure',
    fallbackTarget: 'human_review',
    fallbackReason: reason,
    updatedAt: nowIso(now),
  });
}

export function completeRootTaskGraph(
  graphId: string,
  rootTaskId: string,
  now: Date = new Date(),
): void {
  const timestamp = nowIso(now);
  updateTaskNode(rootTaskId, {
    status: 'completed',
    error: null,
    updatedAt: timestamp,
  });
  updateTaskGraph(graphId, {
    status: 'completed',
    error: null,
    updatedAt: timestamp,
  });
}

export function failRootTaskGraph(
  graphId: string,
  rootTaskId: string,
  error: string,
  now: Date = new Date(),
): void {
  const timestamp = nowIso(now);
  updateTaskNode(rootTaskId, {
    status: 'failed',
    error,
    updatedAt: timestamp,
  });
  updateTaskGraph(graphId, {
    status: 'failed',
    error,
    updatedAt: timestamp,
  });
}

export function listRunnableTaskNodes(graphId: string): TaskNodeRecord[] {
  const graph = getTaskGraph(graphId);
  if (!graph) return [];

  const nodes = listTaskNodes(graphId);
  const nodeMap = new Map(nodes.map((node) => [node.taskId, node]));

  return nodes.filter((node) => {
    if (node.status !== 'ready') return false;

    const dependencies = listTaskNodeDependencies(node.taskId);
    if (dependencies.length === 0) return true;

    const dependencyNodes = dependencies
      .map((dependency) => nodeMap.get(dependency.dependsOnTaskId))
      .filter((dependencyNode): dependencyNode is TaskNodeRecord =>
        Boolean(dependencyNode),
      );

    const completedCount = dependencyNodes.filter(
      (dependencyNode) => dependencyNode.status === 'completed',
    ).length;
    const failedCount = dependencyNodes.filter(
      (dependencyNode) => dependencyNode.status === 'failed',
    ).length;
    const terminalCount = completedCount + failedCount;

    switch (node.aggregatePolicy) {
      case 'quorum': {
        const quorumCount = node.quorumCount ?? dependencyNodes.length;
        return completedCount >= quorumCount;
      }
      case 'best_effort':
        return terminalCount === dependencyNodes.length && completedCount > 0;
      case 'strict':
      default:
        return completedCount === dependencyNodes.length;
    }
  });
}

export function reconcileAggregateTaskNode(
  taskId: string,
  now: Date = new Date(),
): TaskNodeRecord | undefined {
  const node = getTaskNode(taskId);
  if (!node || node.nodeKind !== 'aggregate' || !node.aggregatePolicy) {
    return node;
  }

  const dependencies = listTaskNodeDependencies(taskId);
  const dependencyNodes = dependencies
    .map((dependency) => getTaskNode(dependency.dependsOnTaskId))
    .filter((dependencyNode): dependencyNode is TaskNodeRecord =>
      Boolean(dependencyNode),
    );

  const total = dependencyNodes.length;
  const completedCount = dependencyNodes.filter(
    (dependencyNode) => dependencyNode.status === 'completed',
  ).length;
  const failedCount = dependencyNodes.filter(
    (dependencyNode) => dependencyNode.status === 'failed',
  ).length;
  const terminalCount = completedCount + failedCount;

  let error: string | null = null;

  switch (node.aggregatePolicy) {
    case 'strict':
      if (failedCount > 0) {
        error = `Strict aggregate blocked by ${failedCount} failed dependency`;
      }
      break;
    case 'quorum': {
      const quorumCount = node.quorumCount ?? total;
      const remainingPossible = total - failedCount;
      if (completedCount < quorumCount && remainingPossible < quorumCount) {
        error = `Quorum aggregate cannot reach quorum=${quorumCount}`;
      }
      break;
    }
    case 'best_effort':
      if (terminalCount === total && completedCount === 0) {
        error = 'Best-effort aggregate received no successful dependencies';
      }
      break;
  }

  if (!error) return node;

  failTaskNode(taskId, error, now);
  return getTaskNode(taskId);
}

export function continueTaskGraph(
  graphId: string,
  now: Date = new Date(),
): TaskNodeRecord[] {
  for (const node of listTaskNodes(graphId)) {
    if (node.nodeKind === 'aggregate') {
      reconcileAggregateTaskNode(node.taskId, now);
    }
  }

  return listRunnableTaskNodes(graphId);
}
