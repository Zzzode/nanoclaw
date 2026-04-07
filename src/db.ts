import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';

import {
  ASSISTANT_NAME,
  DATA_DIR,
  DEFAULT_EXECUTION_MODE,
  STORE_DIR,
} from './config.js';
import { resolveExecutionMode } from './execution-mode.js';
import { isValidGroupFolder } from './group-folder.js';
import { logger } from './logger.js';
import {
  NewMessage,
  RegisteredGroup,
  ScheduledTask,
  TaskRunLog,
} from './types.js';

let db: Database.Database;

export type LogicalSessionScopeType = 'group' | 'task';
export type LogicalSessionStatus = 'active' | 'stale' | 'closed';
export type ExecutionStatus =
  | 'running'
  | 'cancel_requested'
  | 'committed'
  | 'completed'
  | 'failed'
  | 'lost';
export type TaskGraphStatus = 'ready' | 'running' | 'completed' | 'failed';
export type TaskNodeStatus = 'ready' | 'running' | 'completed' | 'failed';
export type AggregatePolicy = 'strict' | 'quorum' | 'best_effort';
export type TaskFailureClass =
  | 'routing_failure'
  | 'execution_failure'
  | 'commit_failure'
  | 'semantic_failure';

export interface TaskGraphRecord {
  graphId: string;
  requestKind: string;
  scopeType: LogicalSessionScopeType;
  scopeId: string;
  groupFolder: string;
  chatJid: string;
  logicalSessionId: string;
  rootTaskId: string;
  status: TaskGraphStatus;
  error: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface TaskNodeRecord {
  taskId: string;
  graphId: string;
  parentTaskId: string | null;
  nodeKind: string;
  workerClass: string | null;
  backendId: string | null;
  requiredCapabilities: string[];
  routeReason: string | null;
  policyVersion: string | null;
  fallbackEligible: boolean;
  fallbackTarget: string | null;
  fallbackReason: string | null;
  failureClass: TaskFailureClass | null;
  aggregatePolicy: AggregatePolicy | null;
  quorumCount: number | null;
  status: TaskNodeStatus;
  error: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface TaskNodeDependencyRecord {
  taskId: string;
  dependsOnTaskId: string;
  createdAt: string;
}

export interface LogicalSessionRecord {
  id: string;
  scopeType: LogicalSessionScopeType;
  scopeId: string;
  providerSessionId: string | null;
  status: LogicalSessionStatus;
  lastTurnId: string | null;
  workspaceVersion: string | null;
  groupMemoryVersion: string | null;
  summaryRef: string | null;
  recentMessagesWindow: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ExecutionStateRecord {
  executionId: string;
  logicalSessionId: string;
  turnId: string;
  taskNodeId: string | null;
  groupJid: string | null;
  taskId: string | null;
  backend: string;
  edgeNodeId: string | null;
  baseWorkspaceVersion: string | null;
  leaseUntil: string;
  status: ExecutionStatus;
  lastHeartbeatAt: string | null;
  cancelRequestedAt: string | null;
  committedAt: string | null;
  finishedAt: string | null;
  error: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ExecutionCheckpointRecord {
  executionId: string;
  checkpointKey: string;
  providerSessionId: string | null;
  summaryDelta: string | null;
  workspaceOverlayDigest: string | null;
  createdAt: string;
}

export interface ToolOperationRecord {
  operationId: string;
  executionId: string;
  tool: string;
  resultJson: string;
  createdAt: string;
}

export interface WorkspaceVersionRecord {
  versionId: string;
  groupFolder: string;
  baseVersionId: string | null;
  manifestJson: string;
  createdAt: string;
}

export interface WorkspaceCommitRecord {
  operationId: string;
  groupFolder: string;
  baseVersionId: string;
  newVersionId: string;
  createdAt: string;
}

export interface ConversationMessageRecord {
  id: string;
  chatJid: string;
  sender: string;
  senderName: string;
  content: string;
  timestamp: string;
  isFromMe: boolean;
  isBotMessage: boolean;
}

export function buildLogicalSessionId(
  scopeType: LogicalSessionScopeType,
  scopeId: string,
): string {
  return `${scopeType}:${scopeId}`;
}

const LOGICAL_SESSION_SELECT = `
  SELECT
    id,
    scope_type AS scopeType,
    scope_id AS scopeId,
    provider_session_id AS providerSessionId,
    status,
    last_turn_id AS lastTurnId,
    workspace_version AS workspaceVersion,
    group_memory_version AS groupMemoryVersion,
    summary_ref AS summaryRef,
    recent_messages_window AS recentMessagesWindow,
    created_at AS createdAt,
    updated_at AS updatedAt
  FROM logical_sessions
`;

const EXECUTION_STATE_SELECT = `
  SELECT
    execution_id AS executionId,
    logical_session_id AS logicalSessionId,
    turn_id AS turnId,
    task_node_id AS taskNodeId,
    group_jid AS groupJid,
    task_id AS taskId,
    backend,
    edge_node_id AS edgeNodeId,
    base_workspace_version AS baseWorkspaceVersion,
    lease_until AS leaseUntil,
    status,
    last_heartbeat_at AS lastHeartbeatAt,
    cancel_requested_at AS cancelRequestedAt,
    committed_at AS committedAt,
    finished_at AS finishedAt,
    error,
    created_at AS createdAt,
    updated_at AS updatedAt
  FROM execution_state
`;

const TASK_GRAPH_SELECT = `
  SELECT
    graph_id AS graphId,
    request_kind AS requestKind,
    scope_type AS scopeType,
    scope_id AS scopeId,
    group_folder AS groupFolder,
    chat_jid AS chatJid,
    logical_session_id AS logicalSessionId,
    root_task_id AS rootTaskId,
    status,
    error,
    created_at AS createdAt,
    updated_at AS updatedAt
  FROM task_graphs
`;

const TASK_NODE_SELECT = `
  SELECT
    task_id AS taskId,
    graph_id AS graphId,
    parent_task_id AS parentTaskId,
    node_kind AS nodeKind,
    worker_class AS workerClass,
    backend_id AS backendId,
    required_capabilities_json AS requiredCapabilitiesJson,
    route_reason AS routeReason,
    policy_version AS policyVersion,
    fallback_eligible AS fallbackEligible,
    fallback_target AS fallbackTarget,
    fallback_reason AS fallbackReason,
    failure_class AS failureClass,
    aggregate_policy AS aggregatePolicy,
    quorum_count AS quorumCount,
    status,
    error,
    created_at AS createdAt,
    updated_at AS updatedAt
  FROM task_nodes
`;

const TASK_NODE_DEPENDENCY_SELECT = `
  SELECT
    task_id AS taskId,
    depends_on_task_id AS dependsOnTaskId,
    created_at AS createdAt
  FROM task_node_dependencies
`;

const EXECUTION_CHECKPOINT_SELECT = `
  SELECT
    execution_id AS executionId,
    checkpoint_key AS checkpointKey,
    provider_session_id AS providerSessionId,
    summary_delta AS summaryDelta,
    workspace_overlay_digest AS workspaceOverlayDigest,
    created_at AS createdAt
  FROM execution_checkpoints
`;

const TOOL_OPERATION_SELECT = `
  SELECT
    operation_id AS operationId,
    execution_id AS executionId,
    tool,
    result_json AS resultJson,
    created_at AS createdAt
  FROM tool_operations
`;

const WORKSPACE_VERSION_SELECT = `
  SELECT
    version_id AS versionId,
    group_folder AS groupFolder,
    base_version_id AS baseVersionId,
    manifest_json AS manifestJson,
    created_at AS createdAt
  FROM workspace_versions
`;

const WORKSPACE_COMMIT_SELECT = `
  SELECT
    operation_id AS operationId,
    group_folder AS groupFolder,
    base_version_id AS baseVersionId,
    new_version_id AS newVersionId,
    created_at AS createdAt
  FROM workspace_commits
`;

function createSchema(database: Database.Database): void {
  database.exec(`
    CREATE TABLE IF NOT EXISTS chats (
      jid TEXT PRIMARY KEY,
      name TEXT,
      last_message_time TEXT,
      channel TEXT,
      is_group INTEGER DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS messages (
      id TEXT,
      chat_jid TEXT,
      sender TEXT,
      sender_name TEXT,
      content TEXT,
      timestamp TEXT,
      is_from_me INTEGER,
      is_bot_message INTEGER DEFAULT 0,
      PRIMARY KEY (id, chat_jid),
      FOREIGN KEY (chat_jid) REFERENCES chats(jid)
    );
    CREATE INDEX IF NOT EXISTS idx_timestamp ON messages(timestamp);

    CREATE TABLE IF NOT EXISTS scheduled_tasks (
      id TEXT PRIMARY KEY,
      group_folder TEXT NOT NULL,
      chat_jid TEXT NOT NULL,
      prompt TEXT NOT NULL,
      schedule_type TEXT NOT NULL,
      schedule_value TEXT NOT NULL,
      next_run TEXT,
      last_run TEXT,
      last_result TEXT,
      status TEXT DEFAULT 'active',
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_next_run ON scheduled_tasks(next_run);
    CREATE INDEX IF NOT EXISTS idx_status ON scheduled_tasks(status);

    CREATE TABLE IF NOT EXISTS task_run_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      task_id TEXT NOT NULL,
      run_at TEXT NOT NULL,
      duration_ms INTEGER NOT NULL,
      status TEXT NOT NULL,
      result TEXT,
      error TEXT,
      FOREIGN KEY (task_id) REFERENCES scheduled_tasks(id)
    );
    CREATE INDEX IF NOT EXISTS idx_task_run_logs ON task_run_logs(task_id, run_at);

    CREATE TABLE IF NOT EXISTS router_state (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS sessions (
      group_folder TEXT PRIMARY KEY,
      session_id TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS logical_sessions (
      id TEXT PRIMARY KEY,
      scope_type TEXT NOT NULL,
      scope_id TEXT NOT NULL,
      provider_session_id TEXT,
      status TEXT NOT NULL DEFAULT 'active',
      last_turn_id TEXT,
      workspace_version TEXT,
      group_memory_version TEXT,
      summary_ref TEXT,
      recent_messages_window TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE (scope_type, scope_id)
    );
    CREATE INDEX IF NOT EXISTS idx_logical_sessions_scope
      ON logical_sessions(scope_type, scope_id);

    CREATE TABLE IF NOT EXISTS execution_state (
      execution_id TEXT PRIMARY KEY,
      logical_session_id TEXT NOT NULL,
      turn_id TEXT NOT NULL,
      task_node_id TEXT,
      group_jid TEXT,
      task_id TEXT,
      backend TEXT NOT NULL,
      edge_node_id TEXT,
      base_workspace_version TEXT,
      lease_until TEXT NOT NULL,
      status TEXT NOT NULL,
      last_heartbeat_at TEXT,
      cancel_requested_at TEXT,
      committed_at TEXT,
      finished_at TEXT,
      error TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      FOREIGN KEY (logical_session_id) REFERENCES logical_sessions(id)
    );
    CREATE INDEX IF NOT EXISTS idx_execution_state_status
      ON execution_state(status);
    CREATE INDEX IF NOT EXISTS idx_execution_state_lease
      ON execution_state(lease_until);
    CREATE INDEX IF NOT EXISTS idx_execution_state_session
      ON execution_state(logical_session_id);

    CREATE TABLE IF NOT EXISTS task_graphs (
      graph_id TEXT PRIMARY KEY,
      request_kind TEXT NOT NULL,
      scope_type TEXT NOT NULL,
      scope_id TEXT NOT NULL,
      group_folder TEXT NOT NULL,
      chat_jid TEXT NOT NULL,
      logical_session_id TEXT NOT NULL,
      root_task_id TEXT NOT NULL,
      status TEXT NOT NULL,
      error TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      FOREIGN KEY (logical_session_id) REFERENCES logical_sessions(id)
    );
    CREATE INDEX IF NOT EXISTS idx_task_graphs_scope
      ON task_graphs(scope_type, scope_id, created_at);
    CREATE INDEX IF NOT EXISTS idx_task_graphs_status
      ON task_graphs(status, created_at);

    CREATE TABLE IF NOT EXISTS task_nodes (
      task_id TEXT PRIMARY KEY,
      graph_id TEXT NOT NULL,
      parent_task_id TEXT,
      node_kind TEXT NOT NULL,
      worker_class TEXT,
      backend_id TEXT,
      required_capabilities_json TEXT NOT NULL DEFAULT '[]',
      route_reason TEXT,
      policy_version TEXT,
      fallback_eligible INTEGER NOT NULL DEFAULT 0,
      fallback_target TEXT,
      fallback_reason TEXT,
      failure_class TEXT,
      aggregate_policy TEXT,
      quorum_count INTEGER,
      status TEXT NOT NULL,
      error TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      FOREIGN KEY (graph_id) REFERENCES task_graphs(graph_id)
    );
    CREATE INDEX IF NOT EXISTS idx_task_nodes_graph
      ON task_nodes(graph_id, created_at);
    CREATE INDEX IF NOT EXISTS idx_task_nodes_status
      ON task_nodes(status, created_at);

    CREATE TABLE IF NOT EXISTS task_node_dependencies (
      task_id TEXT NOT NULL,
      depends_on_task_id TEXT NOT NULL,
      created_at TEXT NOT NULL,
      PRIMARY KEY (task_id, depends_on_task_id),
      FOREIGN KEY (task_id) REFERENCES task_nodes(task_id)
    );
    CREATE INDEX IF NOT EXISTS idx_task_node_dependencies_task
      ON task_node_dependencies(task_id, created_at);
    CREATE INDEX IF NOT EXISTS idx_task_node_dependencies_depends_on
      ON task_node_dependencies(depends_on_task_id, created_at);

    CREATE TABLE IF NOT EXISTS execution_checkpoints (
      execution_id TEXT NOT NULL,
      checkpoint_key TEXT NOT NULL,
      provider_session_id TEXT,
      summary_delta TEXT,
      workspace_overlay_digest TEXT,
      created_at TEXT NOT NULL,
      PRIMARY KEY (execution_id, checkpoint_key),
      FOREIGN KEY (execution_id) REFERENCES execution_state(execution_id)
    );
    CREATE INDEX IF NOT EXISTS idx_execution_checkpoints_execution
      ON execution_checkpoints(execution_id, created_at);

    CREATE TABLE IF NOT EXISTS tool_operations (
      operation_id TEXT PRIMARY KEY,
      execution_id TEXT NOT NULL,
      tool TEXT NOT NULL,
      result_json TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_tool_operations_execution
      ON tool_operations(execution_id, created_at);

    CREATE TABLE IF NOT EXISTS workspace_versions (
      version_id TEXT PRIMARY KEY,
      group_folder TEXT NOT NULL,
      base_version_id TEXT,
      manifest_json TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_workspace_versions_group
      ON workspace_versions(group_folder, created_at);

    CREATE TABLE IF NOT EXISTS workspace_commits (
      operation_id TEXT PRIMARY KEY,
      group_folder TEXT NOT NULL,
      base_version_id TEXT NOT NULL,
      new_version_id TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_workspace_commits_group
      ON workspace_commits(group_folder, created_at);

    CREATE TABLE IF NOT EXISTS registered_groups (
      jid TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      folder TEXT NOT NULL UNIQUE,
      trigger_pattern TEXT NOT NULL,
      added_at TEXT NOT NULL,
      execution_mode TEXT,
      container_config TEXT,
      requires_trigger INTEGER DEFAULT 1
    );
  `);

  // Add context_mode column if it doesn't exist (migration for existing DBs)
  try {
    database.exec(
      `ALTER TABLE scheduled_tasks ADD COLUMN context_mode TEXT DEFAULT 'isolated'`,
    );
  } catch {
    /* column already exists */
  }

  // Add script column if it doesn't exist (migration for existing DBs)
  try {
    database.exec(`ALTER TABLE scheduled_tasks ADD COLUMN script TEXT`);
  } catch {
    /* column already exists */
  }

  try {
    database.exec(`ALTER TABLE execution_state ADD COLUMN task_node_id TEXT`);
  } catch {
    /* column already exists */
  }

  try {
    database.exec(`
      CREATE INDEX IF NOT EXISTS idx_execution_state_task_node
        ON execution_state(task_node_id, created_at)
    `);
  } catch {
    /* index creation will succeed after task_node_id exists */
  }

  try {
    database.exec(
      `ALTER TABLE task_nodes ADD COLUMN required_capabilities_json TEXT NOT NULL DEFAULT '[]'`,
    );
  } catch {
    /* column already exists */
  }

  try {
    database.exec(`ALTER TABLE task_nodes ADD COLUMN route_reason TEXT`);
  } catch {
    /* column already exists */
  }

  try {
    database.exec(`ALTER TABLE task_nodes ADD COLUMN policy_version TEXT`);
  } catch {
    /* column already exists */
  }

  try {
    database.exec(
      `ALTER TABLE task_nodes ADD COLUMN fallback_eligible INTEGER NOT NULL DEFAULT 0`,
    );
  } catch {
    /* column already exists */
  }

  try {
    database.exec(`ALTER TABLE task_nodes ADD COLUMN fallback_target TEXT`);
  } catch {
    /* column already exists */
  }

  try {
    database.exec(`ALTER TABLE task_nodes ADD COLUMN fallback_reason TEXT`);
  } catch {
    /* column already exists */
  }

  try {
    database.exec(`ALTER TABLE task_nodes ADD COLUMN failure_class TEXT`);
  } catch {
    /* column already exists */
  }

  try {
    database.exec(`ALTER TABLE task_nodes ADD COLUMN aggregate_policy TEXT`);
  } catch {
    /* column already exists */
  }

  try {
    database.exec(`ALTER TABLE task_nodes ADD COLUMN quorum_count INTEGER`);
  } catch {
    /* column already exists */
  }

  try {
    database.exec(`
      CREATE TABLE IF NOT EXISTS task_node_dependencies (
        task_id TEXT NOT NULL,
        depends_on_task_id TEXT NOT NULL,
        created_at TEXT NOT NULL,
        PRIMARY KEY (task_id, depends_on_task_id),
        FOREIGN KEY (task_id) REFERENCES task_nodes(task_id)
      )
    `);
    database.exec(`
      CREATE INDEX IF NOT EXISTS idx_task_node_dependencies_task
        ON task_node_dependencies(task_id, created_at)
    `);
    database.exec(`
      CREATE INDEX IF NOT EXISTS idx_task_node_dependencies_depends_on
        ON task_node_dependencies(depends_on_task_id, created_at)
    `);
  } catch {
    /* table or indexes already exist */
  }

  // Add is_bot_message column if it doesn't exist (migration for existing DBs)
  try {
    database.exec(
      `ALTER TABLE messages ADD COLUMN is_bot_message INTEGER DEFAULT 0`,
    );
    // Backfill: mark existing bot messages that used the content prefix pattern
    database
      .prepare(`UPDATE messages SET is_bot_message = 1 WHERE content LIKE ?`)
      .run(`${ASSISTANT_NAME}:%`);
  } catch {
    /* column already exists */
  }

  // Add is_main column if it doesn't exist (migration for existing DBs)
  try {
    database.exec(
      `ALTER TABLE registered_groups ADD COLUMN is_main INTEGER DEFAULT 0`,
    );
    // Backfill: existing rows with folder = 'main' are the main group
    database.exec(
      `UPDATE registered_groups SET is_main = 1 WHERE folder = 'main'`,
    );
  } catch {
    /* column already exists */
  }

  // Add execution_mode column if it doesn't exist (migration for existing DBs)
  try {
    database.exec(
      `ALTER TABLE registered_groups ADD COLUMN execution_mode TEXT`,
    );
  } catch {
    /* column already exists */
  }

  // Add channel and is_group columns if they don't exist (migration for existing DBs)
  try {
    database.exec(`ALTER TABLE chats ADD COLUMN channel TEXT`);
    database.exec(`ALTER TABLE chats ADD COLUMN is_group INTEGER DEFAULT 0`);
    // Backfill from JID patterns
    database.exec(
      `UPDATE chats SET channel = 'whatsapp', is_group = 1 WHERE jid LIKE '%@g.us'`,
    );
    database.exec(
      `UPDATE chats SET channel = 'whatsapp', is_group = 0 WHERE jid LIKE '%@s.whatsapp.net'`,
    );
    database.exec(
      `UPDATE chats SET channel = 'discord', is_group = 1 WHERE jid LIKE 'dc:%'`,
    );
    database.exec(
      `UPDATE chats SET channel = 'telegram', is_group = 0 WHERE jid LIKE 'tg:%'`,
    );
  } catch {
    /* columns already exist */
  }

  database.exec(`
    INSERT OR IGNORE INTO logical_sessions (
      id,
      scope_type,
      scope_id,
      provider_session_id,
      status,
      created_at,
      updated_at
    )
    SELECT
      'group:' || group_folder,
      'group',
      group_folder,
      session_id,
      'active',
      strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
      strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
    FROM sessions;

    UPDATE logical_sessions
    SET
      provider_session_id = (
        SELECT session_id
        FROM sessions
        WHERE sessions.group_folder = logical_sessions.scope_id
      ),
      updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
    WHERE scope_type = 'group'
      AND provider_session_id IS NULL
      AND EXISTS (
        SELECT 1
        FROM sessions
        WHERE sessions.group_folder = logical_sessions.scope_id
      );
  `);
}

function mapLogicalSessionRow(row: {
  id: string;
  scopeType: LogicalSessionScopeType;
  scopeId: string;
  providerSessionId: string | null;
  status: LogicalSessionStatus;
  lastTurnId: string | null;
  workspaceVersion: string | null;
  groupMemoryVersion: string | null;
  summaryRef: string | null;
  recentMessagesWindow: string | null;
  createdAt: string;
  updatedAt: string;
}): LogicalSessionRecord {
  return row;
}

function mapExecutionStateRow(row: {
  executionId: string;
  logicalSessionId: string;
  turnId: string;
  taskNodeId: string | null;
  groupJid: string | null;
  taskId: string | null;
  backend: string;
  edgeNodeId: string | null;
  baseWorkspaceVersion: string | null;
  leaseUntil: string;
  status: ExecutionStatus;
  lastHeartbeatAt: string | null;
  cancelRequestedAt: string | null;
  committedAt: string | null;
  finishedAt: string | null;
  error: string | null;
  createdAt: string;
  updatedAt: string;
}): ExecutionStateRecord {
  return row;
}

function mapTaskGraphRow(row: {
  graphId: string;
  requestKind: string;
  scopeType: LogicalSessionScopeType;
  scopeId: string;
  groupFolder: string;
  chatJid: string;
  logicalSessionId: string;
  rootTaskId: string;
  status: TaskGraphStatus;
  error: string | null;
  createdAt: string;
  updatedAt: string;
}): TaskGraphRecord {
  return row;
}

function mapTaskNodeRow(row: {
  taskId: string;
  graphId: string;
  parentTaskId: string | null;
  nodeKind: string;
  workerClass: string | null;
  backendId: string | null;
  requiredCapabilitiesJson: string | null;
  routeReason: string | null;
  policyVersion: string | null;
  fallbackEligible: number;
  fallbackTarget: string | null;
  fallbackReason: string | null;
  failureClass: TaskFailureClass | null;
  aggregatePolicy: AggregatePolicy | null;
  quorumCount: number | null;
  status: TaskNodeStatus;
  error: string | null;
  createdAt: string;
  updatedAt: string;
}): TaskNodeRecord {
  let requiredCapabilities: string[] = [];
  if (row.requiredCapabilitiesJson) {
    try {
      const parsed = JSON.parse(row.requiredCapabilitiesJson) as unknown;
      if (Array.isArray(parsed)) {
        requiredCapabilities = parsed.filter(
          (value): value is string => typeof value === 'string',
        );
      }
    } catch {
      requiredCapabilities = [];
    }
  }

  return {
    taskId: row.taskId,
    graphId: row.graphId,
    parentTaskId: row.parentTaskId,
    nodeKind: row.nodeKind,
    workerClass: row.workerClass,
    backendId: row.backendId,
    requiredCapabilities,
    routeReason: row.routeReason,
    policyVersion: row.policyVersion,
    fallbackEligible: row.fallbackEligible === 1,
    fallbackTarget: row.fallbackTarget,
    fallbackReason: row.fallbackReason,
    failureClass: row.failureClass,
    aggregatePolicy: row.aggregatePolicy,
    quorumCount: row.quorumCount,
    status: row.status,
    error: row.error,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function mapTaskNodeDependencyRow(row: {
  taskId: string;
  dependsOnTaskId: string;
  createdAt: string;
}): TaskNodeDependencyRecord {
  return row;
}

function mapExecutionCheckpointRow(row: {
  executionId: string;
  checkpointKey: string;
  providerSessionId: string | null;
  summaryDelta: string | null;
  workspaceOverlayDigest: string | null;
  createdAt: string;
}): ExecutionCheckpointRecord {
  return row;
}

function mapToolOperationRow(row: {
  operationId: string;
  executionId: string;
  tool: string;
  resultJson: string;
  createdAt: string;
}): ToolOperationRecord {
  return row;
}

function mapWorkspaceVersionRow(row: {
  versionId: string;
  groupFolder: string;
  baseVersionId: string | null;
  manifestJson: string;
  createdAt: string;
}): WorkspaceVersionRecord {
  return row;
}

function mapWorkspaceCommitRow(row: {
  operationId: string;
  groupFolder: string;
  baseVersionId: string;
  newVersionId: string;
  createdAt: string;
}): WorkspaceCommitRecord {
  return row;
}

export function initDatabase(): void {
  const dbPath = path.join(STORE_DIR, 'messages.db');
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });

  db = new Database(dbPath);
  createSchema(db);

  // Migrate from JSON files if they exist
  migrateJsonState();
}

export function ensureDatabaseInitialized(): void {
  if (!db) {
    initDatabase();
  }
}

/** @internal - for tests only. Creates a fresh in-memory database. */
export function _initTestDatabase(): void {
  db = new Database(':memory:');
  createSchema(db);
}

/** @internal - for tests only. */
export function _closeDatabase(): void {
  db.close();
}

/**
 * Store chat metadata only (no message content).
 * Used for all chats to enable group discovery without storing sensitive content.
 */
export function storeChatMetadata(
  chatJid: string,
  timestamp: string,
  name?: string,
  channel?: string,
  isGroup?: boolean,
): void {
  const ch = channel ?? null;
  const group = isGroup === undefined ? null : isGroup ? 1 : 0;

  if (name) {
    // Update with name, preserving existing timestamp if newer
    db.prepare(
      `
      INSERT INTO chats (jid, name, last_message_time, channel, is_group) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(jid) DO UPDATE SET
        name = excluded.name,
        last_message_time = MAX(last_message_time, excluded.last_message_time),
        channel = COALESCE(excluded.channel, channel),
        is_group = COALESCE(excluded.is_group, is_group)
    `,
    ).run(chatJid, name, timestamp, ch, group);
  } else {
    // Update timestamp only, preserve existing name if any
    db.prepare(
      `
      INSERT INTO chats (jid, name, last_message_time, channel, is_group) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(jid) DO UPDATE SET
        last_message_time = MAX(last_message_time, excluded.last_message_time),
        channel = COALESCE(excluded.channel, channel),
        is_group = COALESCE(excluded.is_group, is_group)
    `,
    ).run(chatJid, chatJid, timestamp, ch, group);
  }
}

/**
 * Update chat name without changing timestamp for existing chats.
 * New chats get the current time as their initial timestamp.
 * Used during group metadata sync.
 */
export function updateChatName(chatJid: string, name: string): void {
  db.prepare(
    `
    INSERT INTO chats (jid, name, last_message_time) VALUES (?, ?, ?)
    ON CONFLICT(jid) DO UPDATE SET name = excluded.name
  `,
  ).run(chatJid, name, new Date().toISOString());
}

export interface ChatInfo {
  jid: string;
  name: string;
  last_message_time: string;
  channel: string;
  is_group: number;
}

/**
 * Get all known chats, ordered by most recent activity.
 */
export function getAllChats(): ChatInfo[] {
  return db
    .prepare(
      `
    SELECT jid, name, last_message_time, channel, is_group
    FROM chats
    ORDER BY last_message_time DESC
  `,
    )
    .all() as ChatInfo[];
}

/**
 * Get timestamp of last group metadata sync.
 */
export function getLastGroupSync(): string | null {
  // Store sync time in a special chat entry
  const row = db
    .prepare(`SELECT last_message_time FROM chats WHERE jid = '__group_sync__'`)
    .get() as { last_message_time: string } | undefined;
  return row?.last_message_time || null;
}

/**
 * Record that group metadata was synced.
 */
export function setLastGroupSync(): void {
  const now = new Date().toISOString();
  db.prepare(
    `INSERT OR REPLACE INTO chats (jid, name, last_message_time) VALUES ('__group_sync__', '__group_sync__', ?)`,
  ).run(now);
}

/**
 * Store a message with full content.
 * Only call this for registered groups where message history is needed.
 */
export function storeMessage(msg: NewMessage): void {
  db.prepare(
    `INSERT OR REPLACE INTO messages (id, chat_jid, sender, sender_name, content, timestamp, is_from_me, is_bot_message) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    msg.id,
    msg.chat_jid,
    msg.sender,
    msg.sender_name,
    msg.content,
    msg.timestamp,
    msg.is_from_me ? 1 : 0,
    msg.is_bot_message ? 1 : 0,
  );
}

/**
 * Store a message directly.
 */
export function storeMessageDirect(msg: {
  id: string;
  chat_jid: string;
  sender: string;
  sender_name: string;
  content: string;
  timestamp: string;
  is_from_me: boolean;
  is_bot_message?: boolean;
}): void {
  db.prepare(
    `INSERT OR REPLACE INTO messages (id, chat_jid, sender, sender_name, content, timestamp, is_from_me, is_bot_message) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    msg.id,
    msg.chat_jid,
    msg.sender,
    msg.sender_name,
    msg.content,
    msg.timestamp,
    msg.is_from_me ? 1 : 0,
    msg.is_bot_message ? 1 : 0,
  );
}

export function getNewMessages(
  jids: string[],
  lastTimestamp: string,
  botPrefix: string,
  limit: number = 200,
): { messages: NewMessage[]; newTimestamp: string } {
  if (jids.length === 0) return { messages: [], newTimestamp: lastTimestamp };

  const placeholders = jids.map(() => '?').join(',');
  // Filter bot messages using both the is_bot_message flag AND the content
  // prefix as a backstop for messages written before the migration ran.
  // Subquery takes the N most recent, outer query re-sorts chronologically.
  const sql = `
    SELECT * FROM (
      SELECT id, chat_jid, sender, sender_name, content, timestamp, is_from_me
      FROM messages
      WHERE timestamp > ? AND chat_jid IN (${placeholders})
        AND is_bot_message = 0 AND content NOT LIKE ?
        AND content != '' AND content IS NOT NULL
      ORDER BY timestamp DESC
      LIMIT ?
    ) ORDER BY timestamp
  `;

  const rows = db
    .prepare(sql)
    .all(lastTimestamp, ...jids, `${botPrefix}:%`, limit) as NewMessage[];

  let newTimestamp = lastTimestamp;
  for (const row of rows) {
    if (row.timestamp > newTimestamp) newTimestamp = row.timestamp;
  }

  return { messages: rows, newTimestamp };
}

export function getMessagesSince(
  chatJid: string,
  sinceTimestamp: string,
  botPrefix: string,
  limit: number = 200,
): NewMessage[] {
  // Filter bot messages using both the is_bot_message flag AND the content
  // prefix as a backstop for messages written before the migration ran.
  // Subquery takes the N most recent, outer query re-sorts chronologically.
  const sql = `
    SELECT * FROM (
      SELECT id, chat_jid, sender, sender_name, content, timestamp, is_from_me
      FROM messages
      WHERE chat_jid = ? AND timestamp > ?
        AND is_bot_message = 0 AND content NOT LIKE ?
        AND content != '' AND content IS NOT NULL
      ORDER BY timestamp DESC
      LIMIT ?
    ) ORDER BY timestamp
  `;
  return db
    .prepare(sql)
    .all(chatJid, sinceTimestamp, `${botPrefix}:%`, limit) as NewMessage[];
}

export function getRecentConversationMessages(
  chatJid: string,
  limit: number = 20,
): ConversationMessageRecord[] {
  const rows = db
    .prepare(
      `
        SELECT * FROM (
          SELECT
            id,
            chat_jid AS chatJid,
            sender,
            sender_name AS senderName,
            content,
            timestamp,
            is_from_me AS isFromMe,
            is_bot_message AS isBotMessage
          FROM messages
          WHERE chat_jid = ? AND content != '' AND content IS NOT NULL
          ORDER BY timestamp DESC
          LIMIT ?
        ) ORDER BY timestamp ASC
      `,
    )
    .all(chatJid, limit) as Array<{
    id: string;
    chatJid: string;
    sender: string;
    senderName: string;
    content: string;
    timestamp: string;
    isFromMe: number;
    isBotMessage: number;
  }>;

  return rows.map((row) => ({
    ...row,
    isFromMe: row.isFromMe === 1,
    isBotMessage: row.isBotMessage === 1,
  }));
}

export function getLastBotMessageTimestamp(
  chatJid: string,
  botPrefix: string,
): string | undefined {
  const row = db
    .prepare(
      `SELECT MAX(timestamp) as ts FROM messages
       WHERE chat_jid = ? AND (is_bot_message = 1 OR content LIKE ?)`,
    )
    .get(chatJid, `${botPrefix}:%`) as { ts: string | null } | undefined;
  return row?.ts ?? undefined;
}

export function createTask(
  task: Omit<ScheduledTask, 'last_run' | 'last_result'>,
): void {
  db.prepare(
    `
    INSERT INTO scheduled_tasks (id, group_folder, chat_jid, prompt, script, schedule_type, schedule_value, context_mode, next_run, status, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `,
  ).run(
    task.id,
    task.group_folder,
    task.chat_jid,
    task.prompt,
    task.script || null,
    task.schedule_type,
    task.schedule_value,
    task.context_mode || 'isolated',
    task.next_run,
    task.status,
    task.created_at,
  );
}

export function getTaskById(id: string): ScheduledTask | undefined {
  return db.prepare('SELECT * FROM scheduled_tasks WHERE id = ?').get(id) as
    | ScheduledTask
    | undefined;
}

export function getTasksForGroup(groupFolder: string): ScheduledTask[] {
  return db
    .prepare(
      'SELECT * FROM scheduled_tasks WHERE group_folder = ? ORDER BY created_at DESC',
    )
    .all(groupFolder) as ScheduledTask[];
}

export function getAllTasks(): ScheduledTask[] {
  return db
    .prepare('SELECT * FROM scheduled_tasks ORDER BY created_at DESC')
    .all() as ScheduledTask[];
}

export function updateTask(
  id: string,
  updates: Partial<
    Pick<
      ScheduledTask,
      | 'prompt'
      | 'script'
      | 'schedule_type'
      | 'schedule_value'
      | 'next_run'
      | 'status'
    >
  >,
): void {
  const fields: string[] = [];
  const values: unknown[] = [];

  if (updates.prompt !== undefined) {
    fields.push('prompt = ?');
    values.push(updates.prompt);
  }
  if (updates.script !== undefined) {
    fields.push('script = ?');
    values.push(updates.script || null);
  }
  if (updates.schedule_type !== undefined) {
    fields.push('schedule_type = ?');
    values.push(updates.schedule_type);
  }
  if (updates.schedule_value !== undefined) {
    fields.push('schedule_value = ?');
    values.push(updates.schedule_value);
  }
  if (updates.next_run !== undefined) {
    fields.push('next_run = ?');
    values.push(updates.next_run);
  }
  if (updates.status !== undefined) {
    fields.push('status = ?');
    values.push(updates.status);
  }

  if (fields.length === 0) return;

  values.push(id);
  db.prepare(
    `UPDATE scheduled_tasks SET ${fields.join(', ')} WHERE id = ?`,
  ).run(...values);
}

export function deleteTask(id: string): void {
  // Delete child records first (FK constraint)
  db.prepare('DELETE FROM task_run_logs WHERE task_id = ?').run(id);
  db.prepare('DELETE FROM scheduled_tasks WHERE id = ?').run(id);
}

export function getDueTasks(): ScheduledTask[] {
  const now = new Date().toISOString();
  return db
    .prepare(
      `
    SELECT * FROM scheduled_tasks
    WHERE status = 'active' AND next_run IS NOT NULL AND next_run <= ?
    ORDER BY next_run
  `,
    )
    .all(now) as ScheduledTask[];
}

export function updateTaskAfterRun(
  id: string,
  nextRun: string | null,
  lastResult: string,
): void {
  const now = new Date().toISOString();
  db.prepare(
    `
    UPDATE scheduled_tasks
    SET next_run = ?, last_run = ?, last_result = ?, status = CASE WHEN ? IS NULL THEN 'completed' ELSE status END
    WHERE id = ?
  `,
  ).run(nextRun, now, lastResult, nextRun, id);
}

export function logTaskRun(log: TaskRunLog): void {
  db.prepare(
    `
    INSERT INTO task_run_logs (task_id, run_at, duration_ms, status, result, error)
    VALUES (?, ?, ?, ?, ?, ?)
  `,
  ).run(
    log.task_id,
    log.run_at,
    log.duration_ms,
    log.status,
    log.result,
    log.error,
  );
}

// --- Router state accessors ---

export function getRouterState(key: string): string | undefined {
  const row = db
    .prepare('SELECT value FROM router_state WHERE key = ?')
    .get(key) as { value: string } | undefined;
  return row?.value;
}

export function setRouterState(key: string, value: string): void {
  db.prepare(
    'INSERT OR REPLACE INTO router_state (key, value) VALUES (?, ?)',
  ).run(key, value);
}

// --- Logical session accessors ---

export function getLogicalSession(
  scopeType: LogicalSessionScopeType,
  scopeId: string,
): LogicalSessionRecord | undefined {
  const row = db
    .prepare(`${LOGICAL_SESSION_SELECT} WHERE scope_type = ? AND scope_id = ?`)
    .get(scopeType, scopeId) as
    | {
        id: string;
        scopeType: LogicalSessionScopeType;
        scopeId: string;
        providerSessionId: string | null;
        status: LogicalSessionStatus;
        lastTurnId: string | null;
        workspaceVersion: string | null;
        groupMemoryVersion: string | null;
        summaryRef: string | null;
        recentMessagesWindow: string | null;
        createdAt: string;
        updatedAt: string;
      }
    | undefined;
  return row ? mapLogicalSessionRow(row) : undefined;
}

export function getLogicalSessionById(
  id: string,
): LogicalSessionRecord | undefined {
  const row = db.prepare(`${LOGICAL_SESSION_SELECT} WHERE id = ?`).get(id) as
    | {
        id: string;
        scopeType: LogicalSessionScopeType;
        scopeId: string;
        providerSessionId: string | null;
        status: LogicalSessionStatus;
        lastTurnId: string | null;
        workspaceVersion: string | null;
        groupMemoryVersion: string | null;
        summaryRef: string | null;
        recentMessagesWindow: string | null;
        createdAt: string;
        updatedAt: string;
      }
    | undefined;
  return row ? mapLogicalSessionRow(row) : undefined;
}

export function listLogicalSessions(
  scopeType?: LogicalSessionScopeType,
): LogicalSessionRecord[] {
  const rows = scopeType
    ? (db
        .prepare(
          `${LOGICAL_SESSION_SELECT} WHERE scope_type = ? ORDER BY created_at ASC`,
        )
        .all(scopeType) as Array<{
        id: string;
        scopeType: LogicalSessionScopeType;
        scopeId: string;
        providerSessionId: string | null;
        status: LogicalSessionStatus;
        lastTurnId: string | null;
        workspaceVersion: string | null;
        groupMemoryVersion: string | null;
        summaryRef: string | null;
        recentMessagesWindow: string | null;
        createdAt: string;
        updatedAt: string;
      }>)
    : (db
        .prepare(`${LOGICAL_SESSION_SELECT} ORDER BY created_at ASC`)
        .all() as Array<{
        id: string;
        scopeType: LogicalSessionScopeType;
        scopeId: string;
        providerSessionId: string | null;
        status: LogicalSessionStatus;
        lastTurnId: string | null;
        workspaceVersion: string | null;
        groupMemoryVersion: string | null;
        summaryRef: string | null;
        recentMessagesWindow: string | null;
        createdAt: string;
        updatedAt: string;
      }>);
  return rows.map(mapLogicalSessionRow);
}

export function createLogicalSession(session: LogicalSessionRecord): void {
  db.prepare(
    `
      INSERT INTO logical_sessions (
        id,
        scope_type,
        scope_id,
        provider_session_id,
        status,
        last_turn_id,
        workspace_version,
        group_memory_version,
        summary_ref,
        recent_messages_window,
        created_at,
        updated_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `,
  ).run(
    session.id,
    session.scopeType,
    session.scopeId,
    session.providerSessionId,
    session.status,
    session.lastTurnId,
    session.workspaceVersion,
    session.groupMemoryVersion,
    session.summaryRef,
    session.recentMessagesWindow,
    session.createdAt,
    session.updatedAt,
  );
}

export function updateLogicalSession(
  id: string,
  updates: Partial<
    Pick<
      LogicalSessionRecord,
      | 'providerSessionId'
      | 'status'
      | 'lastTurnId'
      | 'workspaceVersion'
      | 'groupMemoryVersion'
      | 'summaryRef'
      | 'recentMessagesWindow'
      | 'updatedAt'
    >
  >,
): void {
  const fields: string[] = [];
  const values: unknown[] = [];

  if (updates.providerSessionId !== undefined) {
    fields.push('provider_session_id = ?');
    values.push(updates.providerSessionId);
  }
  if (updates.status !== undefined) {
    fields.push('status = ?');
    values.push(updates.status);
  }
  if (updates.lastTurnId !== undefined) {
    fields.push('last_turn_id = ?');
    values.push(updates.lastTurnId);
  }
  if (updates.workspaceVersion !== undefined) {
    fields.push('workspace_version = ?');
    values.push(updates.workspaceVersion);
  }
  if (updates.groupMemoryVersion !== undefined) {
    fields.push('group_memory_version = ?');
    values.push(updates.groupMemoryVersion);
  }
  if (updates.summaryRef !== undefined) {
    fields.push('summary_ref = ?');
    values.push(updates.summaryRef);
  }
  if (updates.recentMessagesWindow !== undefined) {
    fields.push('recent_messages_window = ?');
    values.push(updates.recentMessagesWindow);
  }
  if (updates.updatedAt !== undefined) {
    fields.push('updated_at = ?');
    values.push(updates.updatedAt);
  }

  if (fields.length === 0) return;

  values.push(id);
  db.prepare(
    `UPDATE logical_sessions SET ${fields.join(', ')} WHERE id = ?`,
  ).run(...values);
}

// --- Execution state accessors ---

export function getExecutionState(
  executionId: string,
): ExecutionStateRecord | undefined {
  const row = db
    .prepare(`${EXECUTION_STATE_SELECT} WHERE execution_id = ?`)
    .get(executionId) as
    | {
        executionId: string;
        logicalSessionId: string;
        turnId: string;
        taskNodeId: string | null;
        groupJid: string | null;
        taskId: string | null;
        backend: string;
        edgeNodeId: string | null;
        baseWorkspaceVersion: string | null;
        leaseUntil: string;
        status: ExecutionStatus;
        lastHeartbeatAt: string | null;
        cancelRequestedAt: string | null;
        committedAt: string | null;
        finishedAt: string | null;
        error: string | null;
        createdAt: string;
        updatedAt: string;
      }
    | undefined;
  return row ? mapExecutionStateRow(row) : undefined;
}

export function getTaskGraph(graphId: string): TaskGraphRecord | undefined {
  const row = db
    .prepare(`${TASK_GRAPH_SELECT} WHERE graph_id = ?`)
    .get(graphId) as
    | {
        graphId: string;
        requestKind: string;
        scopeType: LogicalSessionScopeType;
        scopeId: string;
        groupFolder: string;
        chatJid: string;
        logicalSessionId: string;
        rootTaskId: string;
        status: TaskGraphStatus;
        error: string | null;
        createdAt: string;
        updatedAt: string;
      }
    | undefined;
  return row ? mapTaskGraphRow(row) : undefined;
}

export function listTaskGraphs(status?: TaskGraphStatus): TaskGraphRecord[] {
  const rows = status
    ? (db
        .prepare(
          `${TASK_GRAPH_SELECT} WHERE status = ? ORDER BY created_at ASC`,
        )
        .all(status) as Array<{
        graphId: string;
        requestKind: string;
        scopeType: LogicalSessionScopeType;
        scopeId: string;
        groupFolder: string;
        chatJid: string;
        logicalSessionId: string;
        rootTaskId: string;
        status: TaskGraphStatus;
        error: string | null;
        createdAt: string;
        updatedAt: string;
      }>)
    : (db
        .prepare(`${TASK_GRAPH_SELECT} ORDER BY created_at ASC`)
        .all() as Array<{
        graphId: string;
        requestKind: string;
        scopeType: LogicalSessionScopeType;
        scopeId: string;
        groupFolder: string;
        chatJid: string;
        logicalSessionId: string;
        rootTaskId: string;
        status: TaskGraphStatus;
        error: string | null;
        createdAt: string;
        updatedAt: string;
      }>);
  return rows.map(mapTaskGraphRow);
}

export function createTaskGraph(record: TaskGraphRecord): void {
  db.prepare(
    `
      INSERT INTO task_graphs (
        graph_id,
        request_kind,
        scope_type,
        scope_id,
        group_folder,
        chat_jid,
        logical_session_id,
        root_task_id,
        status,
        error,
        created_at,
        updated_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `,
  ).run(
    record.graphId,
    record.requestKind,
    record.scopeType,
    record.scopeId,
    record.groupFolder,
    record.chatJid,
    record.logicalSessionId,
    record.rootTaskId,
    record.status,
    record.error,
    record.createdAt,
    record.updatedAt,
  );
}

export function updateTaskGraph(
  graphId: string,
  updates: Partial<Pick<TaskGraphRecord, 'status' | 'error' | 'updatedAt'>>,
): void {
  const fields: string[] = [];
  const values: unknown[] = [];

  if (updates.status !== undefined) {
    fields.push('status = ?');
    values.push(updates.status);
  }
  if (updates.error !== undefined) {
    fields.push('error = ?');
    values.push(updates.error);
  }
  if (updates.updatedAt !== undefined) {
    fields.push('updated_at = ?');
    values.push(updates.updatedAt);
  }

  if (fields.length === 0) return;
  values.push(graphId);
  db.prepare(
    `UPDATE task_graphs SET ${fields.join(', ')} WHERE graph_id = ?`,
  ).run(...values);
}

export function getTaskNode(taskId: string): TaskNodeRecord | undefined {
  const row = db
    .prepare(`${TASK_NODE_SELECT} WHERE task_id = ?`)
    .get(taskId) as
    | {
        taskId: string;
        graphId: string;
        parentTaskId: string | null;
        nodeKind: string;
        workerClass: string | null;
        backendId: string | null;
        requiredCapabilitiesJson: string | null;
        routeReason: string | null;
        policyVersion: string | null;
        fallbackEligible: number;
        fallbackTarget: string | null;
        fallbackReason: string | null;
        failureClass: TaskFailureClass | null;
        aggregatePolicy: AggregatePolicy | null;
        quorumCount: number | null;
        status: TaskNodeStatus;
        error: string | null;
        createdAt: string;
        updatedAt: string;
      }
    | undefined;
  return row ? mapTaskNodeRow(row) : undefined;
}

export function listTaskNodes(graphId?: string): TaskNodeRecord[] {
  const rows = graphId
    ? (db
        .prepare(
          `${TASK_NODE_SELECT} WHERE graph_id = ? ORDER BY created_at ASC`,
        )
        .all(graphId) as Array<{
        taskId: string;
        graphId: string;
        parentTaskId: string | null;
        nodeKind: string;
        workerClass: string | null;
        backendId: string | null;
        requiredCapabilitiesJson: string | null;
        routeReason: string | null;
        policyVersion: string | null;
        fallbackEligible: number;
        fallbackTarget: string | null;
        fallbackReason: string | null;
        failureClass: TaskFailureClass | null;
        aggregatePolicy: AggregatePolicy | null;
        quorumCount: number | null;
        status: TaskNodeStatus;
        error: string | null;
        createdAt: string;
        updatedAt: string;
      }>)
    : (db
        .prepare(`${TASK_NODE_SELECT} ORDER BY created_at ASC`)
        .all() as Array<{
        taskId: string;
        graphId: string;
        parentTaskId: string | null;
        nodeKind: string;
        workerClass: string | null;
        backendId: string | null;
        requiredCapabilitiesJson: string | null;
        routeReason: string | null;
        policyVersion: string | null;
        fallbackEligible: number;
        fallbackTarget: string | null;
        fallbackReason: string | null;
        failureClass: TaskFailureClass | null;
        aggregatePolicy: AggregatePolicy | null;
        quorumCount: number | null;
        status: TaskNodeStatus;
        error: string | null;
        createdAt: string;
        updatedAt: string;
      }>);
  return rows.map(mapTaskNodeRow);
}

export function createTaskNode(record: TaskNodeRecord): void {
  db.prepare(
    `
      INSERT INTO task_nodes (
        task_id,
        graph_id,
        parent_task_id,
        node_kind,
        worker_class,
        backend_id,
        required_capabilities_json,
        route_reason,
        policy_version,
        fallback_eligible,
        fallback_target,
        fallback_reason,
        failure_class,
        aggregate_policy,
        quorum_count,
        status,
        error,
        created_at,
        updated_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `,
  ).run(
    record.taskId,
    record.graphId,
    record.parentTaskId,
    record.nodeKind,
    record.workerClass,
    record.backendId,
    JSON.stringify(record.requiredCapabilities),
    record.routeReason,
    record.policyVersion,
    record.fallbackEligible ? 1 : 0,
    record.fallbackTarget,
    record.fallbackReason,
    record.failureClass,
    record.aggregatePolicy,
    record.quorumCount,
    record.status,
    record.error,
    record.createdAt,
    record.updatedAt,
  );
}

export function createTaskNodeDependency(
  record: TaskNodeDependencyRecord,
): void {
  db.prepare(
    `
      INSERT OR IGNORE INTO task_node_dependencies (
        task_id,
        depends_on_task_id,
        created_at
      )
      VALUES (?, ?, ?)
    `,
  ).run(record.taskId, record.dependsOnTaskId, record.createdAt);
}

export function listTaskNodeDependencies(
  taskId?: string,
): TaskNodeDependencyRecord[] {
  const rows = taskId
    ? (db
        .prepare(
          `${TASK_NODE_DEPENDENCY_SELECT} WHERE task_id = ? ORDER BY created_at ASC`,
        )
        .all(taskId) as Array<{
        taskId: string;
        dependsOnTaskId: string;
        createdAt: string;
      }>)
    : (db
        .prepare(`${TASK_NODE_DEPENDENCY_SELECT} ORDER BY created_at ASC`)
        .all() as Array<{
        taskId: string;
        dependsOnTaskId: string;
        createdAt: string;
      }>);
  return rows.map(mapTaskNodeDependencyRow);
}

export function updateTaskNode(
  taskId: string,
  updates: Partial<
    Pick<
      TaskNodeRecord,
      | 'workerClass'
      | 'backendId'
      | 'requiredCapabilities'
      | 'routeReason'
      | 'policyVersion'
      | 'fallbackEligible'
      | 'fallbackTarget'
      | 'fallbackReason'
      | 'failureClass'
      | 'aggregatePolicy'
      | 'quorumCount'
      | 'status'
      | 'error'
      | 'updatedAt'
    >
  >,
): void {
  const fields: string[] = [];
  const values: unknown[] = [];

  if (updates.workerClass !== undefined) {
    fields.push('worker_class = ?');
    values.push(updates.workerClass);
  }
  if (updates.backendId !== undefined) {
    fields.push('backend_id = ?');
    values.push(updates.backendId);
  }
  if (updates.requiredCapabilities !== undefined) {
    fields.push('required_capabilities_json = ?');
    values.push(JSON.stringify(updates.requiredCapabilities));
  }
  if (updates.routeReason !== undefined) {
    fields.push('route_reason = ?');
    values.push(updates.routeReason);
  }
  if (updates.policyVersion !== undefined) {
    fields.push('policy_version = ?');
    values.push(updates.policyVersion);
  }
  if (updates.fallbackEligible !== undefined) {
    fields.push('fallback_eligible = ?');
    values.push(updates.fallbackEligible ? 1 : 0);
  }
  if (updates.fallbackTarget !== undefined) {
    fields.push('fallback_target = ?');
    values.push(updates.fallbackTarget);
  }
  if (updates.fallbackReason !== undefined) {
    fields.push('fallback_reason = ?');
    values.push(updates.fallbackReason);
  }
  if (updates.failureClass !== undefined) {
    fields.push('failure_class = ?');
    values.push(updates.failureClass);
  }
  if (updates.aggregatePolicy !== undefined) {
    fields.push('aggregate_policy = ?');
    values.push(updates.aggregatePolicy);
  }
  if (updates.quorumCount !== undefined) {
    fields.push('quorum_count = ?');
    values.push(updates.quorumCount);
  }
  if (updates.status !== undefined) {
    fields.push('status = ?');
    values.push(updates.status);
  }
  if (updates.error !== undefined) {
    fields.push('error = ?');
    values.push(updates.error);
  }
  if (updates.updatedAt !== undefined) {
    fields.push('updated_at = ?');
    values.push(updates.updatedAt);
  }

  if (fields.length === 0) return;
  values.push(taskId);
  db.prepare(
    `UPDATE task_nodes SET ${fields.join(', ')} WHERE task_id = ?`,
  ).run(...values);
}

export function listExecutionStates(
  status?: ExecutionStatus,
): ExecutionStateRecord[] {
  const rows = status
    ? (db
        .prepare(
          `${EXECUTION_STATE_SELECT} WHERE status = ? ORDER BY created_at ASC`,
        )
        .all(status) as Array<{
        executionId: string;
        logicalSessionId: string;
        turnId: string;
        taskNodeId: string | null;
        groupJid: string | null;
        taskId: string | null;
        backend: string;
        edgeNodeId: string | null;
        baseWorkspaceVersion: string | null;
        leaseUntil: string;
        status: ExecutionStatus;
        lastHeartbeatAt: string | null;
        cancelRequestedAt: string | null;
        committedAt: string | null;
        finishedAt: string | null;
        error: string | null;
        createdAt: string;
        updatedAt: string;
      }>)
    : (db
        .prepare(`${EXECUTION_STATE_SELECT} ORDER BY created_at ASC`)
        .all() as Array<{
        executionId: string;
        logicalSessionId: string;
        turnId: string;
        taskNodeId: string | null;
        groupJid: string | null;
        taskId: string | null;
        backend: string;
        edgeNodeId: string | null;
        baseWorkspaceVersion: string | null;
        leaseUntil: string;
        status: ExecutionStatus;
        lastHeartbeatAt: string | null;
        cancelRequestedAt: string | null;
        committedAt: string | null;
        finishedAt: string | null;
        error: string | null;
        createdAt: string;
        updatedAt: string;
      }>);
  return rows.map(mapExecutionStateRow);
}

export function listExecutionStatesForTaskNode(
  taskNodeId: string,
): ExecutionStateRecord[] {
  const rows = db
    .prepare(
      `${EXECUTION_STATE_SELECT} WHERE task_node_id = ? ORDER BY created_at ASC`,
    )
    .all(taskNodeId) as Array<{
    executionId: string;
    logicalSessionId: string;
    turnId: string;
    taskNodeId: string | null;
    groupJid: string | null;
    taskId: string | null;
    backend: string;
    edgeNodeId: string | null;
    baseWorkspaceVersion: string | null;
    leaseUntil: string;
    status: ExecutionStatus;
    lastHeartbeatAt: string | null;
    cancelRequestedAt: string | null;
    committedAt: string | null;
    finishedAt: string | null;
    error: string | null;
    createdAt: string;
    updatedAt: string;
  }>;
  return rows.map(mapExecutionStateRow);
}

export function listExecutionCheckpoints(
  executionId?: string,
): ExecutionCheckpointRecord[] {
  const rows = executionId
    ? (db
        .prepare(
          `${EXECUTION_CHECKPOINT_SELECT} WHERE execution_id = ? ORDER BY created_at ASC`,
        )
        .all(executionId) as Array<{
        executionId: string;
        checkpointKey: string;
        providerSessionId: string | null;
        summaryDelta: string | null;
        workspaceOverlayDigest: string | null;
        createdAt: string;
      }>)
    : (db
        .prepare(`${EXECUTION_CHECKPOINT_SELECT} ORDER BY created_at ASC`)
        .all() as Array<{
        executionId: string;
        checkpointKey: string;
        providerSessionId: string | null;
        summaryDelta: string | null;
        workspaceOverlayDigest: string | null;
        createdAt: string;
      }>);

  return rows.map(mapExecutionCheckpointRow);
}

export function createExecutionState(record: ExecutionStateRecord): void {
  db.prepare(
    `
      INSERT INTO execution_state (
        execution_id,
        logical_session_id,
        turn_id,
        task_node_id,
        group_jid,
        task_id,
        backend,
        edge_node_id,
        base_workspace_version,
        lease_until,
        status,
        last_heartbeat_at,
        cancel_requested_at,
        committed_at,
        finished_at,
        error,
        created_at,
        updated_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `,
  ).run(
    record.executionId,
    record.logicalSessionId,
    record.turnId,
    record.taskNodeId,
    record.groupJid,
    record.taskId,
    record.backend,
    record.edgeNodeId,
    record.baseWorkspaceVersion,
    record.leaseUntil,
    record.status,
    record.lastHeartbeatAt,
    record.cancelRequestedAt,
    record.committedAt,
    record.finishedAt,
    record.error,
    record.createdAt,
    record.updatedAt,
  );
}

export function createExecutionCheckpoint(
  record: ExecutionCheckpointRecord,
): void {
  db.prepare(
    `
      INSERT OR IGNORE INTO execution_checkpoints (
        execution_id,
        checkpoint_key,
        provider_session_id,
        summary_delta,
        workspace_overlay_digest,
        created_at
      )
      VALUES (?, ?, ?, ?, ?, ?)
    `,
  ).run(
    record.executionId,
    record.checkpointKey,
    record.providerSessionId,
    record.summaryDelta,
    record.workspaceOverlayDigest,
    record.createdAt,
  );
}

export function getToolOperation(
  operationId: string,
): ToolOperationRecord | undefined {
  const row = db
    .prepare(`${TOOL_OPERATION_SELECT} WHERE operation_id = ?`)
    .get(operationId) as
    | {
        operationId: string;
        executionId: string;
        tool: string;
        resultJson: string;
        createdAt: string;
      }
    | undefined;

  return row ? mapToolOperationRow(row) : undefined;
}

export function listToolOperations(
  executionId?: string,
): ToolOperationRecord[] {
  const rows = executionId
    ? (db
        .prepare(
          `${TOOL_OPERATION_SELECT} WHERE execution_id = ? ORDER BY created_at ASC`,
        )
        .all(executionId) as Array<{
        operationId: string;
        executionId: string;
        tool: string;
        resultJson: string;
        createdAt: string;
      }>)
    : (db
        .prepare(`${TOOL_OPERATION_SELECT} ORDER BY created_at ASC`)
        .all() as Array<{
        operationId: string;
        executionId: string;
        tool: string;
        resultJson: string;
        createdAt: string;
      }>);

  return rows.map(mapToolOperationRow);
}

export function createToolOperation(record: ToolOperationRecord): void {
  db.prepare(
    `
      INSERT OR IGNORE INTO tool_operations (
        operation_id,
        execution_id,
        tool,
        result_json,
        created_at
      )
      VALUES (?, ?, ?, ?, ?)
    `,
  ).run(
    record.operationId,
    record.executionId,
    record.tool,
    record.resultJson,
    record.createdAt,
  );
}

export function getWorkspaceVersion(
  versionId: string,
): WorkspaceVersionRecord | undefined {
  const row = db
    .prepare(`${WORKSPACE_VERSION_SELECT} WHERE version_id = ?`)
    .get(versionId) as
    | {
        versionId: string;
        groupFolder: string;
        baseVersionId: string | null;
        manifestJson: string;
        createdAt: string;
      }
    | undefined;
  return row ? mapWorkspaceVersionRow(row) : undefined;
}

export function listWorkspaceVersions(
  groupFolder?: string,
): WorkspaceVersionRecord[] {
  const rows = groupFolder
    ? (db
        .prepare(
          `${WORKSPACE_VERSION_SELECT} WHERE group_folder = ? ORDER BY created_at ASC`,
        )
        .all(groupFolder) as Array<{
        versionId: string;
        groupFolder: string;
        baseVersionId: string | null;
        manifestJson: string;
        createdAt: string;
      }>)
    : (db
        .prepare(`${WORKSPACE_VERSION_SELECT} ORDER BY created_at ASC`)
        .all() as Array<{
        versionId: string;
        groupFolder: string;
        baseVersionId: string | null;
        manifestJson: string;
        createdAt: string;
      }>);
  return rows.map(mapWorkspaceVersionRow);
}

export function createWorkspaceVersion(record: WorkspaceVersionRecord): void {
  db.prepare(
    `
      INSERT INTO workspace_versions (
        version_id,
        group_folder,
        base_version_id,
        manifest_json,
        created_at
      )
      VALUES (?, ?, ?, ?, ?)
    `,
  ).run(
    record.versionId,
    record.groupFolder,
    record.baseVersionId,
    record.manifestJson,
    record.createdAt,
  );
}

export function getWorkspaceCommit(
  operationId: string,
): WorkspaceCommitRecord | undefined {
  const row = db
    .prepare(`${WORKSPACE_COMMIT_SELECT} WHERE operation_id = ?`)
    .get(operationId) as
    | {
        operationId: string;
        groupFolder: string;
        baseVersionId: string;
        newVersionId: string;
        createdAt: string;
      }
    | undefined;
  return row ? mapWorkspaceCommitRow(row) : undefined;
}

export function listWorkspaceCommits(
  groupFolder?: string,
): WorkspaceCommitRecord[] {
  const rows = groupFolder
    ? (db
        .prepare(
          `${WORKSPACE_COMMIT_SELECT} WHERE group_folder = ? ORDER BY created_at ASC`,
        )
        .all(groupFolder) as Array<{
        operationId: string;
        groupFolder: string;
        baseVersionId: string;
        newVersionId: string;
        createdAt: string;
      }>)
    : (db
        .prepare(`${WORKSPACE_COMMIT_SELECT} ORDER BY created_at ASC`)
        .all() as Array<{
        operationId: string;
        groupFolder: string;
        baseVersionId: string;
        newVersionId: string;
        createdAt: string;
      }>);

  return rows.map(mapWorkspaceCommitRow);
}

export function createWorkspaceCommit(record: WorkspaceCommitRecord): void {
  db.prepare(
    `
      INSERT OR IGNORE INTO workspace_commits (
        operation_id,
        group_folder,
        base_version_id,
        new_version_id,
        created_at
      )
      VALUES (?, ?, ?, ?, ?)
    `,
  ).run(
    record.operationId,
    record.groupFolder,
    record.baseVersionId,
    record.newVersionId,
    record.createdAt,
  );
}

export function updateExecutionState(
  executionId: string,
  updates: Partial<
    Pick<
      ExecutionStateRecord,
      | 'taskNodeId'
      | 'backend'
      | 'edgeNodeId'
      | 'baseWorkspaceVersion'
      | 'leaseUntil'
      | 'status'
      | 'lastHeartbeatAt'
      | 'cancelRequestedAt'
      | 'committedAt'
      | 'finishedAt'
      | 'error'
      | 'updatedAt'
    >
  >,
): void {
  const fields: string[] = [];
  const values: unknown[] = [];

  if (updates.taskNodeId !== undefined) {
    fields.push('task_node_id = ?');
    values.push(updates.taskNodeId);
  }
  if (updates.backend !== undefined) {
    fields.push('backend = ?');
    values.push(updates.backend);
  }
  if (updates.edgeNodeId !== undefined) {
    fields.push('edge_node_id = ?');
    values.push(updates.edgeNodeId);
  }
  if (updates.baseWorkspaceVersion !== undefined) {
    fields.push('base_workspace_version = ?');
    values.push(updates.baseWorkspaceVersion);
  }
  if (updates.leaseUntil !== undefined) {
    fields.push('lease_until = ?');
    values.push(updates.leaseUntil);
  }
  if (updates.status !== undefined) {
    fields.push('status = ?');
    values.push(updates.status);
  }
  if (updates.lastHeartbeatAt !== undefined) {
    fields.push('last_heartbeat_at = ?');
    values.push(updates.lastHeartbeatAt);
  }
  if (updates.cancelRequestedAt !== undefined) {
    fields.push('cancel_requested_at = ?');
    values.push(updates.cancelRequestedAt);
  }
  if (updates.committedAt !== undefined) {
    fields.push('committed_at = ?');
    values.push(updates.committedAt);
  }
  if (updates.finishedAt !== undefined) {
    fields.push('finished_at = ?');
    values.push(updates.finishedAt);
  }
  if (updates.error !== undefined) {
    fields.push('error = ?');
    values.push(updates.error);
  }
  if (updates.updatedAt !== undefined) {
    fields.push('updated_at = ?');
    values.push(updates.updatedAt);
  }

  if (fields.length === 0) return;

  values.push(executionId);
  db.prepare(
    `UPDATE execution_state SET ${fields.join(', ')} WHERE execution_id = ?`,
  ).run(...values);
}

// --- Session accessors ---

export function getSession(groupFolder: string): string | undefined {
  const logicalSession = getLogicalSession('group', groupFolder);
  if (logicalSession?.providerSessionId) {
    return logicalSession.providerSessionId;
  }

  const row = db
    .prepare('SELECT session_id FROM sessions WHERE group_folder = ?')
    .get(groupFolder) as { session_id: string } | undefined;
  return row?.session_id;
}

export function setSession(groupFolder: string, sessionId: string): void {
  const now = new Date().toISOString();
  db.prepare(
    'INSERT OR REPLACE INTO sessions (group_folder, session_id) VALUES (?, ?)',
  ).run(groupFolder, sessionId);

  const logicalSessionId = buildLogicalSessionId('group', groupFolder);
  const existing = getLogicalSessionById(logicalSessionId);
  if (existing) {
    updateLogicalSession(logicalSessionId, {
      providerSessionId: sessionId,
      status: 'active',
      updatedAt: now,
    });
    return;
  }

  createLogicalSession({
    id: logicalSessionId,
    scopeType: 'group',
    scopeId: groupFolder,
    providerSessionId: sessionId,
    status: 'active',
    lastTurnId: null,
    workspaceVersion: null,
    groupMemoryVersion: null,
    summaryRef: null,
    recentMessagesWindow: null,
    createdAt: now,
    updatedAt: now,
  });
}

export function deleteSession(groupFolder: string): void {
  const now = new Date().toISOString();
  db.prepare('DELETE FROM sessions WHERE group_folder = ?').run(groupFolder);

  const logicalSessionId = buildLogicalSessionId('group', groupFolder);
  const existing = getLogicalSessionById(logicalSessionId);
  if (existing) {
    updateLogicalSession(logicalSessionId, {
      providerSessionId: null,
      status: 'stale',
      updatedAt: now,
    });
    return;
  }

  createLogicalSession({
    id: logicalSessionId,
    scopeType: 'group',
    scopeId: groupFolder,
    providerSessionId: null,
    status: 'stale',
    lastTurnId: null,
    workspaceVersion: null,
    groupMemoryVersion: null,
    summaryRef: null,
    recentMessagesWindow: null,
    createdAt: now,
    updatedAt: now,
  });
}

export function getAllSessions(): Record<string, string> {
  const result: Record<string, string> = {};
  for (const session of listLogicalSessions('group')) {
    if (session.providerSessionId) {
      result[session.scopeId] = session.providerSessionId;
    }
  }

  const legacyRows = db
    .prepare('SELECT group_folder, session_id FROM sessions')
    .all() as Array<{ group_folder: string; session_id: string }>;
  for (const row of legacyRows) {
    if (!result[row.group_folder]) {
      result[row.group_folder] = row.session_id;
    }
  }

  return result;
}

// --- Registered group accessors ---

export function getRegisteredGroup(
  jid: string,
): (RegisteredGroup & { jid: string }) | undefined {
  const row = db
    .prepare('SELECT * FROM registered_groups WHERE jid = ?')
    .get(jid) as
    | {
        jid: string;
        name: string;
        folder: string;
        trigger_pattern: string;
        added_at: string;
        execution_mode: string | null;
        container_config: string | null;
        requires_trigger: number | null;
        is_main: number | null;
      }
    | undefined;
  if (!row) return undefined;
  if (!isValidGroupFolder(row.folder)) {
    logger.warn(
      { jid: row.jid, folder: row.folder },
      'Skipping registered group with invalid folder',
    );
    return undefined;
  }
  return {
    jid: row.jid,
    name: row.name,
    folder: row.folder,
    trigger: row.trigger_pattern,
    added_at: row.added_at,
    executionMode: row.execution_mode
      ? resolveExecutionMode(row.execution_mode, DEFAULT_EXECUTION_MODE)
      : undefined,
    containerConfig: row.container_config
      ? JSON.parse(row.container_config)
      : undefined,
    requiresTrigger:
      row.requires_trigger === null ? undefined : row.requires_trigger === 1,
    isMain: row.is_main === 1 ? true : undefined,
  };
}

export function setRegisteredGroup(jid: string, group: RegisteredGroup): void {
  if (!isValidGroupFolder(group.folder)) {
    throw new Error(`Invalid group folder "${group.folder}" for JID ${jid}`);
  }
  db.prepare(
    `INSERT OR REPLACE INTO registered_groups (jid, name, folder, trigger_pattern, added_at, execution_mode, container_config, requires_trigger, is_main)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    jid,
    group.name,
    group.folder,
    group.trigger,
    group.added_at,
    group.executionMode ?? null,
    group.containerConfig ? JSON.stringify(group.containerConfig) : null,
    group.requiresTrigger === undefined ? 1 : group.requiresTrigger ? 1 : 0,
    group.isMain ? 1 : 0,
  );
}

export function getAllRegisteredGroups(): Record<string, RegisteredGroup> {
  const rows = db.prepare('SELECT * FROM registered_groups').all() as Array<{
    jid: string;
    name: string;
    folder: string;
    trigger_pattern: string;
    added_at: string;
    execution_mode: string | null;
    container_config: string | null;
    requires_trigger: number | null;
    is_main: number | null;
  }>;
  const result: Record<string, RegisteredGroup> = {};
  for (const row of rows) {
    if (!isValidGroupFolder(row.folder)) {
      logger.warn(
        { jid: row.jid, folder: row.folder },
        'Skipping registered group with invalid folder',
      );
      continue;
    }
    result[row.jid] = {
      name: row.name,
      folder: row.folder,
      trigger: row.trigger_pattern,
      added_at: row.added_at,
      executionMode: row.execution_mode
        ? resolveExecutionMode(row.execution_mode, DEFAULT_EXECUTION_MODE)
        : undefined,
      containerConfig: row.container_config
        ? JSON.parse(row.container_config)
        : undefined,
      requiresTrigger:
        row.requires_trigger === null ? undefined : row.requires_trigger === 1,
      isMain: row.is_main === 1 ? true : undefined,
    };
  }
  return result;
}

// --- JSON migration ---

function migrateJsonState(): void {
  const migrateFile = (filename: string) => {
    const filePath = path.join(DATA_DIR, filename);
    if (!fs.existsSync(filePath)) return null;
    try {
      const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
      fs.renameSync(filePath, `${filePath}.migrated`);
      return data;
    } catch {
      return null;
    }
  };

  // Migrate router_state.json
  const routerState = migrateFile('router_state.json') as {
    last_timestamp?: string;
    last_agent_timestamp?: Record<string, string>;
  } | null;
  if (routerState) {
    if (routerState.last_timestamp) {
      setRouterState('last_timestamp', routerState.last_timestamp);
    }
    if (routerState.last_agent_timestamp) {
      setRouterState(
        'last_agent_timestamp',
        JSON.stringify(routerState.last_agent_timestamp),
      );
    }
  }

  // Migrate sessions.json
  const sessions = migrateFile('sessions.json') as Record<
    string,
    string
  > | null;
  if (sessions) {
    for (const [folder, sessionId] of Object.entries(sessions)) {
      setSession(folder, sessionId);
    }
  }

  // Migrate registered_groups.json
  const groups = migrateFile('registered_groups.json') as Record<
    string,
    RegisteredGroup
  > | null;
  if (groups) {
    for (const [jid, group] of Object.entries(groups)) {
      try {
        setRegisteredGroup(jid, group);
      } catch (err) {
        logger.warn(
          { jid, folder: group.folder, err },
          'Skipping migrated registered group with invalid folder',
        );
      }
    }
  }
}
