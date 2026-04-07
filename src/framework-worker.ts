import type { AgentBackend } from './agent-backend.js';
import type { AgentBackendId } from './execution-mode.js';
import type {
  FrameworkRuntimeClass,
  PlannedHeavyRuntimeSpecialization,
} from './framework-policy.js';
import type { CapabilityTag } from './policy-router.js';

export type FrameworkWorkerClass = 'edge' | 'heavy';

export interface FrameworkWorker extends AgentBackend {
  readonly backendId: AgentBackendId;
  readonly workerClass: FrameworkWorkerClass;
  readonly runtimeClass: FrameworkRuntimeClass;
  readonly plannedSpecializations?: readonly PlannedHeavyRuntimeSpecialization[];
  readonly capabilityEnvelope: readonly CapabilityTag[];
}

export type FrameworkWorkerRegistry = Record<AgentBackendId, FrameworkWorker>;

export function createFrameworkWorkerRegistry(
  workers: FrameworkWorkerRegistry,
): FrameworkWorkerRegistry {
  return workers;
}
