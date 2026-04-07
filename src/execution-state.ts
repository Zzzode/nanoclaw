import { randomUUID } from 'crypto';

import { IDLE_TIMEOUT } from './config.js';
import {
  buildLogicalSessionId,
  createExecutionCheckpoint,
  createExecutionState,
  createLogicalSession,
  getExecutionState,
  getTaskGraph,
  getTaskNode,
  getLogicalSession,
  getLogicalSessionById,
  listExecutionStates,
  LogicalSessionRecord,
  LogicalSessionScopeType,
  updateTaskGraph,
  updateTaskNode,
  updateExecutionState,
  updateLogicalSession,
} from './db.js';

const DEFAULT_LEASE_MS = IDLE_TIMEOUT + 30_000;
const EXECUTION_LEASE_GRACE_MS = 5_000;

export interface ExecutionScope {
  scopeType: LogicalSessionScopeType;
  scopeId: string;
}

export interface BeginExecutionOptions extends ExecutionScope {
  backend: string;
  taskNodeId?: string;
  groupJid?: string;
  taskId?: string;
  edgeNodeId?: string;
  baseWorkspaceVersion?: string;
  leaseMs?: number;
  now?: Date;
}

export interface StartedExecutionLease {
  executionId: string;
  turnId: string;
  logicalSessionId: string;
  leaseUntil: string;
}

export interface ExecutionCheckpointInput {
  checkpointKey: string;
  providerSessionId?: string | null;
  summaryDelta?: string;
  workspaceOverlayDigest?: string;
}

function toIso(now: Date): string {
  return now.toISOString();
}

function addMs(now: Date, ms: number): string {
  return new Date(now.getTime() + ms).toISOString();
}

function parseMs(value: string | null | undefined): number | null {
  if (!value) return null;
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? null : parsed;
}

function resolveLeaseMs(
  execution: {
    createdAt: string;
    lastHeartbeatAt: string | null;
    leaseUntil: string;
  },
  requestedLeaseMs?: number,
): number {
  if (
    requestedLeaseMs !== undefined &&
    Number.isFinite(requestedLeaseMs) &&
    requestedLeaseMs > 0
  ) {
    return Math.max(1, Math.trunc(requestedLeaseMs));
  }

  const anchorMs =
    parseMs(execution.lastHeartbeatAt) ?? parseMs(execution.createdAt);
  const leaseUntilMs = parseMs(execution.leaseUntil);
  if (anchorMs !== null && leaseUntilMs !== null && leaseUntilMs > anchorMs) {
    return leaseUntilMs - anchorMs;
  }

  return DEFAULT_LEASE_MS;
}

export function deriveExecutionLeaseMs(deadlineMs?: number | null): number {
  if (!deadlineMs || !Number.isFinite(deadlineMs) || deadlineMs <= 0) {
    return DEFAULT_LEASE_MS;
  }
  return Math.max(1, Math.trunc(deadlineMs)) + EXECUTION_LEASE_GRACE_MS;
}

export function ensureLogicalSession(
  scopeType: LogicalSessionScopeType,
  scopeId: string,
  now: Date = new Date(),
): LogicalSessionRecord {
  const existing = getLogicalSession(scopeType, scopeId);
  if (existing) return existing;

  const timestamp = toIso(now);
  const session: LogicalSessionRecord = {
    id: buildLogicalSessionId(scopeType, scopeId),
    scopeType,
    scopeId,
    providerSessionId: null,
    status: 'active',
    lastTurnId: null,
    workspaceVersion: null,
    groupMemoryVersion: null,
    summaryRef: null,
    recentMessagesWindow: null,
    createdAt: timestamp,
    updatedAt: timestamp,
  };
  createLogicalSession(session);
  return session;
}

export function beginExecution(
  options: BeginExecutionOptions,
): StartedExecutionLease {
  const now = options.now ?? new Date();
  const logicalSession = ensureLogicalSession(
    options.scopeType,
    options.scopeId,
    now,
  );
  const executionId = `exec_${randomUUID()}`;
  const turnId = `turn_${randomUUID()}`;
  const timestamp = toIso(now);
  const leaseUntil = addMs(now, options.leaseMs ?? DEFAULT_LEASE_MS);

  createExecutionState({
    executionId,
    logicalSessionId: logicalSession.id,
    turnId,
    taskNodeId: options.taskNodeId ?? null,
    groupJid: options.groupJid ?? null,
    taskId: options.taskId ?? null,
    backend: options.backend,
    edgeNodeId: options.edgeNodeId ?? null,
    baseWorkspaceVersion: options.baseWorkspaceVersion ?? null,
    leaseUntil,
    status: 'running',
    lastHeartbeatAt: null,
    cancelRequestedAt: null,
    committedAt: null,
    finishedAt: null,
    error: null,
    createdAt: timestamp,
    updatedAt: timestamp,
  });

  return {
    executionId,
    turnId,
    logicalSessionId: logicalSession.id,
    leaseUntil,
  };
}

export function linkExecutionToTaskNode(
  executionId: string,
  taskNodeId: string,
  now: Date = new Date(),
): void {
  if (!getExecutionState(executionId)) return;

  updateExecutionState(executionId, {
    taskNodeId,
    updatedAt: toIso(now),
  });
}

export function heartbeatExecution(
  executionId: string,
  now: Date = new Date(),
  leaseMs?: number,
): void {
  const existing = getExecutionState(executionId);
  if (!existing) return;

  const timestamp = toIso(now);
  const nextLeaseMs = resolveLeaseMs(existing, leaseMs);
  updateExecutionState(executionId, {
    lastHeartbeatAt: timestamp,
    leaseUntil: addMs(now, nextLeaseMs),
    updatedAt: timestamp,
  });
}

export function acknowledgeExecution(
  executionId: string,
  nodeId: string,
  now: Date = new Date(),
  leaseMs?: number,
): void {
  const existing = getExecutionState(executionId);
  if (!existing) return;

  const timestamp = toIso(now);
  const nextLeaseMs = resolveLeaseMs(existing, leaseMs);
  updateExecutionState(executionId, {
    edgeNodeId: nodeId,
    lastHeartbeatAt: timestamp,
    leaseUntil: addMs(now, nextLeaseMs),
    updatedAt: timestamp,
  });
}

export function persistExecutionCheckpoint(
  executionId: string,
  checkpoint: ExecutionCheckpointInput,
  now: Date = new Date(),
): void {
  const execution = getExecutionState(executionId);
  if (!execution) return;

  const timestamp = toIso(now);
  const nextLeaseMs = resolveLeaseMs(execution);
  createExecutionCheckpoint({
    executionId,
    checkpointKey: checkpoint.checkpointKey,
    providerSessionId: checkpoint.providerSessionId ?? null,
    summaryDelta: checkpoint.summaryDelta ?? null,
    workspaceOverlayDigest: checkpoint.workspaceOverlayDigest ?? null,
    createdAt: timestamp,
  });

  if (checkpoint.providerSessionId) {
    updateLogicalSession(execution.logicalSessionId, {
      providerSessionId: checkpoint.providerSessionId,
      status: 'active',
      updatedAt: timestamp,
    });
  }

  updateExecutionState(executionId, {
    lastHeartbeatAt: timestamp,
    leaseUntil: addMs(now, nextLeaseMs),
    updatedAt: timestamp,
  });
}

export function requestExecutionCancel(
  executionId: string,
  now: Date = new Date(),
): void {
  const execution = getExecutionState(executionId);
  if (!execution) return;
  if (
    execution.status === 'completed' ||
    execution.status === 'failed' ||
    execution.status === 'lost'
  ) {
    return;
  }

  const timestamp = toIso(now);
  updateExecutionState(executionId, {
    status: 'cancel_requested',
    cancelRequestedAt: timestamp,
    updatedAt: timestamp,
  });
}

export function requestTaskExecutionsCancel(
  taskId: string,
  now: Date = new Date(),
): string[] {
  const executions = listExecutionStates().filter(
    (execution) =>
      execution.taskId === taskId &&
      (execution.status === 'running' ||
        execution.status === 'cancel_requested'),
  );

  for (const execution of executions) {
    requestExecutionCancel(execution.executionId, now);
  }

  return executions.map((execution) => execution.executionId);
}

export function commitExecution(
  executionId: string,
  now: Date = new Date(),
): void {
  const execution = getExecutionState(executionId);
  if (!execution) return;

  const timestamp = toIso(now);
  const logicalSession = getLogicalSessionById(execution.logicalSessionId);
  if (logicalSession) {
    updateLogicalSession(logicalSession.id, {
      status: 'active',
      lastTurnId: execution.turnId,
      updatedAt: timestamp,
    });
  }

  updateExecutionState(executionId, {
    status: 'committed',
    committedAt: timestamp,
    updatedAt: timestamp,
  });
}

export function completeExecution(
  executionId: string,
  now: Date = new Date(),
): void {
  if (!getExecutionState(executionId)) return;

  const timestamp = toIso(now);
  updateExecutionState(executionId, {
    status: 'completed',
    finishedAt: timestamp,
    updatedAt: timestamp,
  });
}

export function failExecution(
  executionId: string,
  error: string,
  now: Date = new Date(),
): void {
  if (!getExecutionState(executionId)) return;

  const timestamp = toIso(now);
  updateExecutionState(executionId, {
    status: 'failed',
    error,
    finishedAt: timestamp,
    updatedAt: timestamp,
  });
}

export function loseExecution(
  executionId: string,
  error: string,
  now: Date = new Date(),
): void {
  if (!getExecutionState(executionId)) return;

  const timestamp = toIso(now);
  updateExecutionState(executionId, {
    status: 'lost',
    error,
    finishedAt: timestamp,
    updatedAt: timestamp,
  });
}

export function markExpiredExecutionsLost(now: Date = new Date()): string[] {
  const timestamp = now.toISOString();
  const expired = listExecutionStates().filter((execution) => {
    if (!['running', 'cancel_requested'].includes(execution.status)) {
      return false;
    }
    return execution.leaseUntil <= timestamp;
  });

  for (const execution of expired) {
    const error = `Execution lease expired at ${execution.leaseUntil}`;
    loseExecution(execution.executionId, error, now);

    if (execution.taskNodeId) {
      const taskNode = getTaskNode(execution.taskNodeId);
      if (taskNode && taskNode.status === 'running') {
        updateTaskNode(taskNode.taskId, {
          status: 'failed',
          error,
          failureClass: 'execution_failure',
          updatedAt: timestamp,
        });
      }

      const graph = taskNode ? getTaskGraph(taskNode.graphId) : undefined;
      if (graph && graph.status === 'running') {
        if (graph.rootTaskId !== taskNode?.taskId) {
          updateTaskNode(graph.rootTaskId, {
            status: 'failed',
            error,
            updatedAt: timestamp,
          });
        }
        updateTaskGraph(graph.graphId, {
          status: 'failed',
          error,
          updatedAt: timestamp,
        });
      }
    }
  }

  return expired.map((execution) => execution.executionId);
}
