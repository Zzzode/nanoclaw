import type { AgentRunInput } from './agent-backend.js';
import {
  deriveCapabilitiesFromTools,
  edgeToolIsSupported,
  parseRequestedEdgeTool,
} from './edge-capabilities.js';
import { FRAMEWORK_POLICY_VERSION } from './framework-policy.js';
import { EDGE_DISABLE_FALLBACK } from './config.js';
import type { AgentBackendId, ExecutionMode } from './execution-mode.js';
import type { RegisteredGroup } from './types.js';

export type CapabilityTag =
  | 'fs.read'
  | 'fs.write'
  | 'http.fetch'
  | 'task.manage'
  | 'message.send'
  | 'code.exec'
  | 'shell.exec'
  | 'browser.exec'
  | 'app.exec'
  | 'local.secret'
  | 'interactive.longlived'
  | `unknown:${string}`;

export type RouteReason =
  | 'group_pinned_heavy'
  | 'group_pinned_edge'
  | 'script_requires_heavy'
  | 'unsupported_capability'
  | 'unknown_capability_default_heavy'
  | 'capability_match_edge'
  | 'no_special_capabilities';

export type BackendFallbackReason =
  | 'script_requires_container'
  | 'unsupported_edge_tool';

export interface TaskNodeIntent {
  requiredCapabilities: CapabilityTag[];
}

export interface PolicyRouteDecision {
  executionMode: ExecutionMode;
  backendId: AgentBackendId;
  requiredCapabilities: CapabilityTag[];
  routeReason: RouteReason;
  policyVersion: string;
  fallbackEligible: boolean;
  fallbackReason?: BackendFallbackReason;
}

const EDGE_CAPABILITY_SET = new Set<CapabilityTag>([
  'fs.read',
  'fs.write',
  'http.fetch',
  'task.manage',
  'message.send',
  'code.exec',
]);

export const HEAVY_ONLY_CAPABILITY_SET = new Set<CapabilityTag>([
  'shell.exec',
  'browser.exec',
  'app.exec',
  'local.secret',
  'interactive.longlived',
]);

function uniqueCapabilities(capabilities: CapabilityTag[]): CapabilityTag[] {
  return [...new Set(capabilities)];
}

function inferUnsupportedToolCapabilities(tool: string): CapabilityTag[] {
  switch (tool) {
    case 'bash':
    case 'sh':
    case 'shell.exec':
      return ['shell.exec'];
    case 'browser.exec':
    case 'playwright.exec':
      return ['browser.exec'];
    case 'app.exec':
      return ['app.exec'];
    default:
      return [`unknown:${tool}`];
  }
}

export function buildTaskNodeIntent(
  input: Pick<AgentRunInput, 'prompt' | 'script'>,
): TaskNodeIntent {
  const capabilities: CapabilityTag[] = [];

  if (input.script) {
    capabilities.push('shell.exec');
  }

  const requestedTool = parseRequestedEdgeTool(input.prompt);
  if (requestedTool) {
    if (edgeToolIsSupported(requestedTool)) {
      capabilities.push(
        ...(deriveCapabilitiesFromTools([requestedTool]) as CapabilityTag[]),
      );
    } else {
      capabilities.push(...inferUnsupportedToolCapabilities(requestedTool));
    }
  }

  return {
    requiredCapabilities: uniqueCapabilities(capabilities),
  };
}

function intentRequiresHeavy(intent: TaskNodeIntent): boolean {
  return intent.requiredCapabilities.some(
    (capability) =>
      capability.startsWith('unknown:') ||
      HEAVY_ONLY_CAPABILITY_SET.has(capability) ||
      !EDGE_CAPABILITY_SET.has(capability),
  );
}

export function resolveGroupExecutionMode(
  group: Pick<RegisteredGroup, 'executionMode'> | undefined,
  defaultExecutionMode: ExecutionMode,
): ExecutionMode {
  return group?.executionMode ?? defaultExecutionMode;
}

export function routeTaskNode(
  group: Pick<RegisteredGroup, 'executionMode'> | undefined,
  input: Pick<AgentRunInput, 'prompt' | 'script'>,
  defaultExecutionMode: ExecutionMode,
): PolicyRouteDecision {
  const executionMode = resolveGroupExecutionMode(group, defaultExecutionMode);
  const intent = buildTaskNodeIntent(input);

  if (executionMode === 'container') {
    return {
      executionMode,
      backendId: 'container',
      requiredCapabilities: intent.requiredCapabilities,
      routeReason: 'group_pinned_heavy',
      policyVersion: FRAMEWORK_POLICY_VERSION,
      fallbackEligible: false,
    };
  }

  if (executionMode === 'edge') {
    return {
      executionMode,
      backendId: 'edge',
      requiredCapabilities: intent.requiredCapabilities,
      routeReason: 'group_pinned_edge',
      policyVersion: FRAMEWORK_POLICY_VERSION,
      fallbackEligible: !EDGE_DISABLE_FALLBACK,
    };
  }

  if (input.script) {
    return {
      executionMode,
      backendId: 'container',
      requiredCapabilities: intent.requiredCapabilities,
      routeReason: 'script_requires_heavy',
      policyVersion: FRAMEWORK_POLICY_VERSION,
      fallbackEligible: false,
      fallbackReason: 'script_requires_container',
    };
  }

  if (
    intent.requiredCapabilities.some((capability) =>
      capability.startsWith('unknown:'),
    )
  ) {
    return {
      executionMode,
      backendId: 'container',
      requiredCapabilities: intent.requiredCapabilities,
      routeReason: 'unknown_capability_default_heavy',
      policyVersion: FRAMEWORK_POLICY_VERSION,
      fallbackEligible: false,
      fallbackReason: 'unsupported_edge_tool',
    };
  }

  if (intentRequiresHeavy(intent)) {
    return {
      executionMode,
      backendId: 'container',
      requiredCapabilities: intent.requiredCapabilities,
      routeReason: 'unsupported_capability',
      policyVersion: FRAMEWORK_POLICY_VERSION,
      fallbackEligible: false,
      fallbackReason: 'unsupported_edge_tool',
    };
  }

  return {
    executionMode,
    backendId: 'edge',
    requiredCapabilities: intent.requiredCapabilities,
    routeReason:
      intent.requiredCapabilities.length > 0
        ? 'capability_match_edge'
        : 'no_special_capabilities',
    policyVersion: FRAMEWORK_POLICY_VERSION,
    fallbackEligible: !EDGE_DISABLE_FALLBACK,
  };
}
