import type { ExecutionContext } from './agent-backend.js';
import {
  beginExecution,
  deriveExecutionLeaseMs,
  type BeginExecutionOptions,
  type StartedExecutionLease,
} from './execution-state.js';
import {
  fallbackTaskNodeToHeavy,
  recordTaskNodeFailure,
  requireReplanForTaskNode,
  type TaskFallbackReason,
} from './task-graph-state.js';

export type RuntimeRecoveryDecision =
  | { kind: 'none' }
  | {
      kind: 'fallback';
      reason: Extract<
        TaskFallbackReason,
        'edge_timeout' | 'edge_runtime_unhealthy'
      >;
    }
  | {
      kind: 'replan';
      reason: Extract<TaskFallbackReason, 'state_conflict_requires_heavy'>;
    };

export function classifyRuntimeRecovery(options: {
  error: string;
  workerClass: 'edge' | 'heavy';
  fallbackEligible: boolean;
  visibleOutputEmitted?: boolean;
}): RuntimeRecoveryDecision {
  if (!options.error.trim()) {
    return { kind: 'none' };
  }

  if (/workspace version conflict/i.test(options.error)) {
    return {
      kind: 'replan',
      reason: 'state_conflict_requires_heavy',
    };
  }

  if (
    options.workerClass !== 'edge' ||
    !options.fallbackEligible ||
    options.visibleOutputEmitted === true ||
    /cancelled before completion/i.test(options.error)
  ) {
    return { kind: 'none' };
  }

  return {
    kind: 'fallback',
    reason: /deadline|timeout/i.test(options.error)
      ? 'edge_timeout'
      : 'edge_runtime_unhealthy',
  };
}

export function markTaskNodeForReplan(
  taskNodeId: string,
  reason: Extract<TaskFallbackReason, 'state_conflict_requires_heavy'>,
  now: Date = new Date(),
): void {
  requireReplanForTaskNode(taskNodeId, reason, now);
}

export function prepareHeavyFallbackExecution(options: {
  scope: Pick<
    BeginExecutionOptions,
    'scopeType' | 'scopeId' | 'groupJid' | 'taskId'
  >;
  taskNodeId: string;
  baseWorkspaceVersion?: string | null;
  previousContext: ExecutionContext;
  reason: Extract<
    TaskFallbackReason,
    'edge_timeout' | 'edge_runtime_unhealthy'
  >;
  now?: Date;
}): {
  execution: StartedExecutionLease;
  executionContext: ExecutionContext;
} {
  recordTaskNodeFailure({
    taskId: options.taskNodeId,
    error: `Edge fallback required: ${options.reason}`,
    failureClass: 'execution_failure',
    fallbackTarget: 'heavy',
    fallbackReason: options.reason,
    now: options.now,
  });
  fallbackTaskNodeToHeavy(options.taskNodeId, options.reason, options.now);

  const execution = beginExecution({
    ...options.scope,
    backend: 'container',
    taskNodeId: options.taskNodeId,
    baseWorkspaceVersion: options.baseWorkspaceVersion ?? undefined,
    leaseMs: deriveExecutionLeaseMs(
      options.previousContext.deadline?.deadlineMs,
    ),
    now: options.now,
  });

  return {
    execution,
    executionContext: {
      ...options.previousContext,
      executionId: execution.executionId,
      turnId: execution.turnId,
      logicalSessionId: execution.logicalSessionId,
      workerClass: 'heavy',
      idempotencyKey: `${execution.executionId}:${options.taskNodeId}`,
      planFragment: {
        ...(options.previousContext.planFragment ?? { kind: 'single_root' }),
        fallbackEligible: false,
        fallbackReason: options.reason,
      },
    },
  };
}
