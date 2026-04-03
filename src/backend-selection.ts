import type { AgentRunInput } from './agent-backend.js';
import {
  executionModeMayUseContainer,
  type AgentBackendId,
  type ExecutionMode,
} from './execution-mode.js';
import type { RegisteredGroup } from './types.js';

export type BackendFallbackReason = 'script_requires_container';

export interface BackendSelection {
  executionMode: ExecutionMode;
  backendId: AgentBackendId;
  fallbackReason?: BackendFallbackReason;
}

export function resolveGroupExecutionMode(
  group: Pick<RegisteredGroup, 'executionMode'> | undefined,
  defaultExecutionMode: ExecutionMode,
): ExecutionMode {
  return group?.executionMode ?? defaultExecutionMode;
}

export function selectAgentBackend(
  group: Pick<RegisteredGroup, 'executionMode'> | undefined,
  input: Pick<AgentRunInput, 'script'>,
  defaultExecutionMode: ExecutionMode,
): BackendSelection {
  const executionMode = resolveGroupExecutionMode(group, defaultExecutionMode);

  if (executionMode === 'container') {
    return { executionMode, backendId: 'container' };
  }

  if (executionMode === 'edge') {
    return { executionMode, backendId: 'edge' };
  }

  if (input.script) {
    return {
      executionMode,
      backendId: 'container',
      fallbackReason: 'script_requires_container',
    };
  }

  return { executionMode, backendId: 'edge' };
}

export function groupMayUseContainerRuntime(
  group: Pick<RegisteredGroup, 'executionMode'> | undefined,
  defaultExecutionMode: ExecutionMode,
): boolean {
  return executionModeMayUseContainer(
    resolveGroupExecutionMode(group, defaultExecutionMode),
  );
}

export function deploymentRequiresContainerRuntime(
  groups: ReadonlyArray<Pick<RegisteredGroup, 'executionMode'>>,
  defaultExecutionMode: ExecutionMode,
): boolean {
  if (defaultExecutionMode !== 'edge') {
    return true;
  }

  return groups.some((group) =>
    groupMayUseContainerRuntime(group, defaultExecutionMode),
  );
}
