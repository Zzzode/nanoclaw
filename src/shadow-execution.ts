import type {
  AgentBackend,
  AgentRunInput,
  AgentRunOutput,
} from './agent-backend.js';
import { parseRequestedEdgeTool } from './edge-capabilities.js';
import type { AgentBackendId } from './execution-mode.js';
import { logger } from './logger.js';
import type { RegisteredGroup } from './types.js';

export const SHADOW_EXECUTION_MODES = ['off', 'edge'] as const;
export type ShadowExecutionMode = (typeof SHADOW_EXECUTION_MODES)[number];

export type ShadowDisableReason =
  | 'shadow_disabled'
  | 'primary_is_edge'
  | 'script_requires_container'
  | 'explicit_tool_prompt';

export interface ShadowExecutionSelection {
  enabled: boolean;
  backendId?: AgentBackendId;
  reason: ShadowDisableReason;
}

export function isShadowExecutionMode(
  value: string | null | undefined,
): value is ShadowExecutionMode {
  return value === 'off' || value === 'edge';
}

export function resolveShadowExecutionMode(
  value: string | null | undefined,
): ShadowExecutionMode {
  return isShadowExecutionMode(value) ? value : 'off';
}

export function selectShadowExecution(
  primaryBackendId: AgentBackendId,
  input: Pick<AgentRunInput, 'prompt' | 'script'>,
  shadowMode: ShadowExecutionMode,
): ShadowExecutionSelection {
  if (shadowMode === 'off') {
    return { enabled: false, reason: 'shadow_disabled' };
  }

  if (primaryBackendId === 'edge') {
    return { enabled: false, reason: 'primary_is_edge' };
  }

  if (input.script) {
    return { enabled: false, reason: 'script_requires_container' };
  }

  if (parseRequestedEdgeTool(input.prompt)) {
    return { enabled: false, reason: 'explicit_tool_prompt' };
  }

  return {
    enabled: true,
    backendId: shadowMode,
    reason: 'shadow_disabled',
  };
}

function summarize(value: string | null | undefined): string | null {
  if (!value) return null;
  const normalized = value.replace(/\s+/g, ' ').trim();
  return normalized.length > 120
    ? `${normalized.slice(0, 117)}...`
    : normalized;
}

function outputsDiverged(
  primaryOutput: AgentRunOutput,
  shadowOutput: AgentRunOutput,
): boolean {
  return (
    primaryOutput.status !== shadowOutput.status ||
    (primaryOutput.result ?? null) !== (shadowOutput.result ?? null) ||
    (primaryOutput.error ?? null) !== (shadowOutput.error ?? null)
  );
}

export async function runShadowExecutionComparison(options: {
  selection: ShadowExecutionSelection;
  backends: Record<AgentBackendId, AgentBackend>;
  group: RegisteredGroup;
  input: AgentRunInput;
  primaryBackendId: AgentBackendId;
  primaryOutput: AgentRunOutput;
  scope: 'group' | 'task';
  scopeId: string;
  fallbackReason?: string;
}): Promise<void> {
  if (!options.selection.enabled || !options.selection.backendId) {
    logger.debug(
      {
        scope: options.scope,
        scopeId: options.scopeId,
        primaryBackendId: options.primaryBackendId,
        shadowEnabled: false,
        shadowReason: options.selection.reason,
        fallbackReason: options.fallbackReason,
      },
      'Shadow execution skipped',
    );
    return;
  }

  const backend = options.backends[options.selection.backendId];
  const streamed: AgentRunOutput[] = [];
  const startedAt = Date.now();

  try {
    const shadowOutput = await backend.run(
      options.group,
      {
        ...options.input,
        shadowMode: true,
      },
      undefined,
      async (output) => {
        streamed.push(output);
      },
    );

    logger.info(
      {
        scope: options.scope,
        scopeId: options.scopeId,
        primaryBackendId: options.primaryBackendId,
        shadowBackendId: options.selection.backendId,
        fallbackReason: options.fallbackReason,
        durationMs: Date.now() - startedAt,
        primaryStatus: options.primaryOutput.status,
        shadowStatus: shadowOutput.status,
        diverged: outputsDiverged(options.primaryOutput, shadowOutput),
        primaryResult: summarize(
          options.primaryOutput.result ?? options.primaryOutput.error,
        ),
        shadowResult: summarize(shadowOutput.result ?? shadowOutput.error),
        shadowStreamCount: streamed.length,
      },
      'Shadow execution comparison completed',
    );
  } catch (err) {
    logger.warn(
      {
        err,
        scope: options.scope,
        scopeId: options.scopeId,
        primaryBackendId: options.primaryBackendId,
        shadowBackendId: options.selection.backendId,
        fallbackReason: options.fallbackReason,
      },
      'Shadow execution comparison failed',
    );
  }
}
