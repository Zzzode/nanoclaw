import type { AgentRunInput } from './agent-backend.js';
import {
  executionModeMayUseContainer,
  type AgentBackendId,
  type ExecutionMode,
} from './execution-mode.js';
import {
  resolveGroupExecutionMode,
  routeTaskNode,
  type BackendFallbackReason,
  type CapabilityTag,
  type RouteReason,
} from './policy-router.js';
import type { RegisteredGroup } from './types.js';

export type {
  BackendFallbackReason,
  CapabilityTag,
  RouteReason,
} from './policy-router.js';
export { resolveGroupExecutionMode } from './policy-router.js';

export interface BackendSelection {
  executionMode: ExecutionMode;
  backendId: AgentBackendId;
  requiredCapabilities: CapabilityTag[];
  routeReason: RouteReason;
  policyVersion: string;
  fallbackEligible: boolean;
  fallbackReason?: BackendFallbackReason;
}

export function selectAgentBackend(
  group: Pick<RegisteredGroup, 'executionMode'> | undefined,
  input: Pick<AgentRunInput, 'script' | 'prompt'>,
  defaultExecutionMode: ExecutionMode,
): BackendSelection {
  return routeTaskNode(group, input, defaultExecutionMode);
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
