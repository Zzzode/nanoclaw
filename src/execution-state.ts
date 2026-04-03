import { randomUUID } from 'crypto';

import { IDLE_TIMEOUT } from './config.js';
import {
  buildLogicalSessionId,
  createExecutionState,
  createLogicalSession,
  getExecutionState,
  getLogicalSession,
  getLogicalSessionById,
  LogicalSessionRecord,
  LogicalSessionScopeType,
  updateExecutionState,
  updateLogicalSession,
} from './db.js';

const DEFAULT_LEASE_MS = IDLE_TIMEOUT + 30_000;

export interface ExecutionScope {
  scopeType: LogicalSessionScopeType;
  scopeId: string;
}

export interface BeginExecutionOptions extends ExecutionScope {
  backend: string;
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

function toIso(now: Date): string {
  return now.toISOString();
}

function addMs(now: Date, ms: number): string {
  return new Date(now.getTime() + ms).toISOString();
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

export function heartbeatExecution(
  executionId: string,
  now: Date = new Date(),
  leaseMs: number = DEFAULT_LEASE_MS,
): void {
  const existing = getExecutionState(executionId);
  if (!existing) return;

  const timestamp = toIso(now);
  updateExecutionState(executionId, {
    lastHeartbeatAt: timestamp,
    leaseUntil: addMs(now, leaseMs),
    updatedAt: timestamp,
  });
}

export function requestExecutionCancel(
  executionId: string,
  now: Date = new Date(),
): void {
  if (!getExecutionState(executionId)) return;

  const timestamp = toIso(now);
  updateExecutionState(executionId, {
    status: 'cancel_requested',
    cancelRequestedAt: timestamp,
    updatedAt: timestamp,
  });
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
