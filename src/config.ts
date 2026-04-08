import path from 'path';

import { readEnvFile } from './env.js';
import { resolveExecutionMode } from './execution-mode.js';
import { resolveShadowExecutionMode } from './shadow-execution.js';
import { isValidTimezone } from './timezone.js';

// Read config values from .env (falls back to process.env).
const envConfig = readEnvFile([
  'ASSISTANT_NAME',
  'ASSISTANT_HAS_OWN_NUMBER',
  'ANTHROPIC_BASE_URL',
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_MODEL',
  'DEFAULT_EXECUTION_MODE',
  'EDGEJS_BIN',
  'EDGE_API_BASE_URL',
  'EDGE_API_KEY',
  'EDGE_MODEL',
  'EDGE_ANTHROPIC_API_BASE_URL',
  'EDGE_ANTHROPIC_API_KEY',
  'EDGE_ANTHROPIC_MODEL',
  'EDGE_RUNNER_MODE',
  'EDGE_RUNNER_PROVIDER',
  'EDGE_ENABLE_TOOLS',
  'EDGE_DISABLE_FALLBACK',
  'SHADOW_EXECUTION_MODE',
  'TERMINAL_CHANNEL',
  'TERMINAL_GROUP_EXECUTION_MODE',
  'TERMINAL_GROUP_FOLDER',
  'TERMINAL_GROUP_JID',
  'TERMINAL_GROUP_NAME',
  'TERMINAL_RESET_SESSION_ON_START',
  'TERMINAL_USER_JID',
  'TERMINAL_USER_NAME',
  'ONECLI_URL',
  'TZ',
]);

export const ASSISTANT_NAME =
  process.env.ASSISTANT_NAME || envConfig.ASSISTANT_NAME || 'Andy';
export const ASSISTANT_HAS_OWN_NUMBER =
  (process.env.ASSISTANT_HAS_OWN_NUMBER ||
    envConfig.ASSISTANT_HAS_OWN_NUMBER) === 'true';
export const POLL_INTERVAL = 2000;
export const SCHEDULER_POLL_INTERVAL = 60000;

// Absolute paths needed for container mounts
const PROJECT_ROOT = process.cwd();
function resolveHomeDir(): string {
  return process.env.HOME || PROJECT_ROOT;
}
const HOME_DIR = resolveHomeDir();

// Mount security: allowlist stored OUTSIDE project root, never mounted into containers
export const MOUNT_ALLOWLIST_PATH = path.join(
  HOME_DIR,
  '.config',
  'nanoclaw',
  'mount-allowlist.json',
);
export const SENDER_ALLOWLIST_PATH = path.join(
  HOME_DIR,
  '.config',
  'nanoclaw',
  'sender-allowlist.json',
);
export const STORE_DIR = path.resolve(
  process.env.NANOCLAW_STORE_DIR || path.join(PROJECT_ROOT, 'store'),
);
export const GROUPS_DIR = path.resolve(
  process.env.NANOCLAW_GROUPS_DIR || path.join(PROJECT_ROOT, 'groups'),
);
export const DATA_DIR = path.resolve(
  process.env.NANOCLAW_DATA_DIR || path.join(PROJECT_ROOT, 'data'),
);

export const CONTAINER_IMAGE =
  process.env.CONTAINER_IMAGE || 'nanoclaw-agent:latest';
export const ANTHROPIC_BASE_URL =
  process.env.ANTHROPIC_BASE_URL ||
  envConfig.ANTHROPIC_BASE_URL ||
  undefined;
export const ANTHROPIC_API_KEY =
  process.env.ANTHROPIC_API_KEY ||
  envConfig.ANTHROPIC_API_KEY ||
  undefined;
export const ANTHROPIC_MODEL =
  process.env.ANTHROPIC_MODEL ||
  envConfig.ANTHROPIC_MODEL ||
  undefined;
export const EDGE_RUNNER_MODE =
  process.env.EDGE_RUNNER_MODE || envConfig.EDGE_RUNNER_MODE || 'node';
export const EDGE_RUNNER_PROVIDER =
  process.env.EDGE_RUNNER_PROVIDER || envConfig.EDGE_RUNNER_PROVIDER || 'local';
export const EDGE_ENABLE_TOOLS =
  (process.env.EDGE_ENABLE_TOOLS || envConfig.EDGE_ENABLE_TOOLS) === 'true';
export const EDGE_DISABLE_FALLBACK =
  (process.env.EDGE_DISABLE_FALLBACK || envConfig.EDGE_DISABLE_FALLBACK) ===
  'true';
export const EDGEJS_BIN =
  process.env.EDGEJS_BIN || envConfig.EDGEJS_BIN || undefined;
export const EDGE_API_BASE_URL =
  process.env.EDGE_API_BASE_URL || envConfig.EDGE_API_BASE_URL || undefined;
export const EDGE_API_KEY =
  process.env.EDGE_API_KEY || envConfig.EDGE_API_KEY || undefined;
export const EDGE_MODEL =
  process.env.EDGE_MODEL || envConfig.EDGE_MODEL || undefined;
export const EDGE_ANTHROPIC_API_BASE_URL =
  process.env.EDGE_ANTHROPIC_API_BASE_URL ||
  envConfig.EDGE_ANTHROPIC_API_BASE_URL ||
  undefined;
export const EDGE_ANTHROPIC_API_KEY =
  process.env.EDGE_ANTHROPIC_API_KEY ||
  envConfig.EDGE_ANTHROPIC_API_KEY ||
  undefined;
export const EDGE_ANTHROPIC_MODEL =
  process.env.EDGE_ANTHROPIC_MODEL ||
  envConfig.EDGE_ANTHROPIC_MODEL ||
  'claude-sonnet-4-20250514';
export const DEFAULT_EXECUTION_MODE = resolveExecutionMode(
  process.env.DEFAULT_EXECUTION_MODE || envConfig.DEFAULT_EXECUTION_MODE,
  'container',
);
export const SHADOW_EXECUTION_MODE = resolveShadowExecutionMode(
  process.env.SHADOW_EXECUTION_MODE || envConfig.SHADOW_EXECUTION_MODE,
);
export const TERMINAL_CHANNEL_ENABLED =
  (process.env.TERMINAL_CHANNEL || envConfig.TERMINAL_CHANNEL) === 'true';
export const TERMINAL_GROUP_JID =
  process.env.TERMINAL_GROUP_JID ||
  envConfig.TERMINAL_GROUP_JID ||
  'term:canary-group';
export const TERMINAL_GROUP_NAME =
  process.env.TERMINAL_GROUP_NAME ||
  envConfig.TERMINAL_GROUP_NAME ||
  'Terminal Canary';
export const TERMINAL_RESET_SESSION_ON_START =
  (process.env.TERMINAL_RESET_SESSION_ON_START ||
    envConfig.TERMINAL_RESET_SESSION_ON_START) === 'true';
export const TERMINAL_GROUP_FOLDER =
  process.env.TERMINAL_GROUP_FOLDER ||
  envConfig.TERMINAL_GROUP_FOLDER ||
  'terminal_canary';
export const TERMINAL_GROUP_EXECUTION_MODE = resolveExecutionMode(
  process.env.TERMINAL_GROUP_EXECUTION_MODE ||
    envConfig.TERMINAL_GROUP_EXECUTION_MODE,
  'edge',
);
export const TERMINAL_USER_JID =
  process.env.TERMINAL_USER_JID || envConfig.TERMINAL_USER_JID || 'term:user';
export const TERMINAL_USER_NAME =
  process.env.TERMINAL_USER_NAME || envConfig.TERMINAL_USER_NAME || 'You';
export const CONTAINER_TIMEOUT = parseInt(
  process.env.CONTAINER_TIMEOUT || '1800000',
  10,
);
export const CONTAINER_MAX_OUTPUT_SIZE = parseInt(
  process.env.CONTAINER_MAX_OUTPUT_SIZE || '10485760',
  10,
); // 10MB default
export const ONECLI_URL =
  process.env.ONECLI_URL || envConfig.ONECLI_URL || 'http://localhost:10254';
export const MAX_MESSAGES_PER_PROMPT = Math.max(
  1,
  parseInt(process.env.MAX_MESSAGES_PER_PROMPT || '10', 10) || 10,
);
export const IPC_POLL_INTERVAL = 1000;
export const IDLE_TIMEOUT = parseInt(process.env.IDLE_TIMEOUT || '1800000', 10); // 30min default — how long to keep container alive after last result
export const MAX_CONCURRENT_CONTAINERS = Math.max(
  1,
  parseInt(process.env.MAX_CONCURRENT_CONTAINERS || '5', 10) || 5,
);

function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function buildTriggerPattern(trigger: string): RegExp {
  return new RegExp(`^${escapeRegex(trigger.trim())}\\b`, 'i');
}

export const DEFAULT_TRIGGER = `@${ASSISTANT_NAME}`;

export function getTriggerPattern(trigger?: string): RegExp {
  const normalizedTrigger = trigger?.trim();
  return buildTriggerPattern(normalizedTrigger || DEFAULT_TRIGGER);
}

export const TRIGGER_PATTERN = buildTriggerPattern(DEFAULT_TRIGGER);

// Timezone for scheduled tasks, message formatting, etc.
// Validates each candidate is a real IANA identifier before accepting.
function resolveConfigTimezone(): string {
  const candidates = [
    process.env.TZ,
    envConfig.TZ,
    Intl.DateTimeFormat().resolvedOptions().timeZone,
  ];
  for (const tz of candidates) {
    if (tz && isValidTimezone(tz)) return tz;
  }
  return 'UTC';
}
export const TIMEZONE = resolveConfigTimezone();
