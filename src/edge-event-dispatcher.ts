import type { ExecutionEventHooks, ExecutionRequest } from './agent-backend.js';
import {
  acknowledgeExecution,
  heartbeatExecution,
  persistExecutionCheckpoint,
} from './execution-state.js';
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
    'executionId' | 'logicalSessionId' | 'groupId' | 'workspace'
  >,
): ExecutionEventHooks {
  return {
    onAck(event) {
      acknowledgeExecution(event.executionId, event.nodeId);
    },
    onHeartbeat(event) {
      heartbeatExecution(event.executionId, new Date(event.at));
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
    },
    onFinal(event) {
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
  };
}
