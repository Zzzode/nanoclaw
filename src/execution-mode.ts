export const EXECUTION_MODES = ['container', 'edge', 'auto'] as const;
export type ExecutionMode = (typeof EXECUTION_MODES)[number];

export const AGENT_BACKEND_IDS = ['container', 'edge'] as const;
export type AgentBackendId = (typeof AGENT_BACKEND_IDS)[number];

export function isExecutionMode(
  value: string | null | undefined,
): value is ExecutionMode {
  return value === 'container' || value === 'edge' || value === 'auto';
}

export function resolveExecutionMode(
  value: string | null | undefined,
  fallback: ExecutionMode,
): ExecutionMode {
  return isExecutionMode(value) ? value : fallback;
}

export function executionModeMayUseContainer(mode: ExecutionMode): boolean {
  return mode === 'container' || mode === 'auto';
}
