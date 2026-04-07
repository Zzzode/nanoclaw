export const FRAMEWORK_POLICY_VERSION = '2026-04-06.v1';

export type FrameworkPolicyRequestKind = 'group_turn' | 'scheduled_task';

export type FrameworkRoutingProfile =
  | 'default'
  | 'group_turn_edge_first'
  | 'scheduled_task_edge_first';

export type WorkspaceEdgeWritePolicy =
  | 'inherit'
  | 'read_only'
  | 'workspace_write_allowed';

export type FrameworkRuntimeClass =
  | 'edge-subprocess'
  | 'container'
  | 'local-shell'
  | 'browser-worker'
  | 'app-worker';

export type PlannedHeavyRuntimeSpecialization =
  | 'local-shell'
  | 'browser-worker'
  | 'app-worker';

export interface FrameworkAdaptivePolicy {
  routingProfile: FrameworkRoutingProfile;
  workspaceEdgeWritePolicy: WorkspaceEdgeWritePolicy;
  adaptiveFanoutLimit: number | null;
  heavyFirstDowngradeThreshold: number | null;
  heavyFirstDowngradeWindow: number | null;
  shardedControlPlaneCandidate: boolean;
}

export const PLANNED_HEAVY_RUNTIME_SPECIALIZATIONS = [
  'local-shell',
  'browser-worker',
  'app-worker',
] as const satisfies readonly PlannedHeavyRuntimeSpecialization[];

export function resolveFrameworkAdaptivePolicy(
  requestKind?: FrameworkPolicyRequestKind,
): FrameworkAdaptivePolicy {
  switch (requestKind) {
    case 'group_turn':
      return {
        routingProfile: 'group_turn_edge_first',
        workspaceEdgeWritePolicy: 'inherit',
        adaptiveFanoutLimit: 8,
        heavyFirstDowngradeThreshold: null,
        heavyFirstDowngradeWindow: null,
        shardedControlPlaneCandidate: false,
      };
    case 'scheduled_task':
      return {
        routingProfile: 'scheduled_task_edge_first',
        workspaceEdgeWritePolicy: 'inherit',
        adaptiveFanoutLimit: 4,
        heavyFirstDowngradeThreshold: null,
        heavyFirstDowngradeWindow: null,
        shardedControlPlaneCandidate: false,
      };
    default:
      return {
        routingProfile: 'default',
        workspaceEdgeWritePolicy: 'inherit',
        adaptiveFanoutLimit: null,
        heavyFirstDowngradeThreshold: null,
        heavyFirstDowngradeWindow: null,
        shardedControlPlaneCandidate: false,
      };
  }
}
