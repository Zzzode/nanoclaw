import type { ExecutionEventHooks, ExecutionRequest } from './agent-backend.js';
import {
  acknowledgeExecution,
  heartbeatExecution,
  persistExecutionCheckpoint,
} from './execution-state.js';
import {
  completeTerminalWorker,
  deriveTerminalWorkerKey,
  ensureTerminalWorker,
  failTerminalWorker,
  recordTerminalFallback,
  recordTerminalTimeline,
  updateTerminalTurnStage,
} from './terminal-observability.js';
import { commitWorkspaceOverlay } from './workspace-service.js';

function buildCheckpointKey(payload: {
  providerSession?: unknown;
  summaryDelta?: string;
  workspaceOverlayDigest?: string;
}): string {
  return JSON.stringify({
    providerSession:
      typeof payload.providerSession === 'string'
        ? payload.providerSession
        : null,
    summaryDelta: payload.summaryDelta ?? null,
    workspaceOverlayDigest: payload.workspaceOverlayDigest ?? null,
  });
}

export function createPersistentExecutionEventHooks(
  request: Pick<
    ExecutionRequest,
    | 'executionId'
    | 'logicalSessionId'
    | 'groupId'
    | 'workspace'
    | 'chatJid'
    | 'graphId'
    | 'taskId'
    | 'workerClass'
    | 'planFragment'
  >,
): ExecutionEventHooks {
  const workerKey = deriveTerminalWorkerKey({
    taskId: request.taskId,
    planKind: request.planFragment?.kind,
  });
  const roleTitle = request.planFragment?.fanoutRole ?? null;

  return {
    onAck(event) {
      acknowledgeExecution(event.executionId, event.nodeId);
      ensureTerminalWorker({
        chatJid: request.chatJid,
        key: workerKey,
        taskId: request.taskId,
        roleTitle,
        backendId: 'edge',
        workerClass: request.workerClass,
        executionId: event.executionId,
        status: 'running',
        activity: 'edge runner acknowledged request',
      });
    },
    onHeartbeat(event) {
      heartbeatExecution(event.executionId, new Date(event.at));
      ensureTerminalWorker({
        chatJid: request.chatJid,
        key: workerKey,
        taskId: request.taskId,
        roleTitle,
        backendId: 'edge',
        workerClass: request.workerClass,
        executionId: event.executionId,
        status: 'running',
        activity: 'edge runner heartbeat',
        at: event.at,
      });
    },
    onProgress(event) {
      ensureTerminalWorker({
        chatJid: request.chatJid,
        key: workerKey,
        taskId: request.taskId,
        roleTitle,
        backendId: 'edge',
        workerClass: request.workerClass,
        executionId: event.executionId,
        status: 'running',
        activity: event.message,
      });
    },
    onWarning(event) {
      recordTerminalTimeline({
        chatJid: request.chatJid,
        targetKey: workerKey,
        text: `${workerKey} warning · ${event.message}`,
      });
    },
    onNeedsFallback(event) {
      recordTerminalFallback({
        chatJid: request.chatJid,
        reason: event.reason,
        fromBackend: 'edge',
        toBackend: event.suggestedWorkerClass ?? 'heavy',
      });
      updateTerminalTurnStage({
        chatJid: request.chatJid,
        graphId: request.graphId,
        executionId: request.executionId,
        stage: 'edge_needs_fallback',
        backendId: 'edge',
        workerClass: request.workerClass,
        activity: event.reason,
      });
    },
    onCheckpoint(event) {
      persistExecutionCheckpoint(event.executionId, {
        checkpointKey: buildCheckpointKey(event),
        providerSessionId:
          typeof event.providerSession === 'string'
            ? event.providerSession
            : null,
        summaryDelta: event.summaryDelta,
        workspaceOverlayDigest: event.workspaceOverlayDigest,
      });
      if (event.summaryDelta || event.providerSession) {
        ensureTerminalWorker({
          chatJid: request.chatJid,
          key: workerKey,
          taskId: request.taskId,
          roleTitle,
          backendId: 'edge',
          workerClass: request.workerClass,
          executionId: event.executionId,
          status: 'running',
          activity: event.summaryDelta ?? 'checkpoint persisted',
          summary: event.summaryDelta,
        });
      }
    },
    onFinal(event) {
      if (event.result.status === 'success') {
        completeTerminalWorker({
          chatJid: request.chatJid,
          key: workerKey,
          activity: 'edge runner completed',
          summary: event.result.outputText ?? undefined,
        });
      } else {
        failTerminalWorker({
          chatJid: request.chatJid,
          key: workerKey,
          error: event.result.error?.message || 'Edge execution failed.',
        });
      }
      if (event.result.workspaceOverlay) {
        commitWorkspaceOverlay({
          groupFolder: request.groupId,
          logicalSessionId: request.logicalSessionId,
          baseWorkspaceVersion: request.workspace.baseVersion,
          overlay: event.result.workspaceOverlay,
          operationId: `${request.executionId}:workspace-commit`,
        });
      }
    },
    onError(event) {
      failTerminalWorker({
        chatJid: request.chatJid,
        key: workerKey,
        error: event.message,
      });
    },
  };
}
