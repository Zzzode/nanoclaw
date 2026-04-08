import { TERMINAL_GROUP_JID, TIMEZONE } from './config.js';
import { formatDisplayDateTime } from './timezone.js';

const TERMINAL_TIMELINE_LIMIT = 40;
const TERMINAL_PANEL_TIMELINE_LIMIT = 4;
const TERMINAL_FOCUS_TIMELINE_LIMIT = 8;

export type TerminalTurnStatus = 'running' | 'completed' | 'failed';
export type TerminalWorkerStatus = 'pending' | 'running' | 'completed' | 'failed';

export interface TerminalTimelineEntry {
  at: string;
  text: string;
  targetKey: string | null;
}

export interface TerminalWorkerState {
  key: string;
  label: string;
  taskId: string | null;
  nodeKind: string | null;
  roleTitle: string | null;
  status: TerminalWorkerStatus;
  backendId: string | null;
  workerClass: string | null;
  executionId: string | null;
  startedAt: string | null;
  updatedAt: string;
  lastActivity: string | null;
  summary: string | null;
  error: string | null;
}

export interface TerminalFallbackState {
  at: string;
  fromBackend: string | null;
  toBackend: string | null;
  reason: string;
  detail: string | null;
}

export interface TerminalTurnState {
  chatJid: string;
  graphId: string;
  rootTaskId: string | null;
  executionId: string | null;
  status: TerminalTurnStatus;
  stage: string;
  backendId: string | null;
  workerClass: string | null;
  startedAt: string;
  updatedAt: string;
  lastActivity: string | null;
  error: string | null;
  fallback: TerminalFallbackState | null;
  workers: Map<string, TerminalWorkerState>;
  timeline: TerminalTimelineEntry[];
  focusKey: string;
}

const terminalTurns = new Map<string, TerminalTurnState>();

function nowIso(): string {
  return new Date().toISOString();
}

function formatTerminalTime(value: string): string {
  return formatDisplayDateTime(value, TIMEZONE);
}

function previewText(text: string | null | undefined, max = 160): string | null {
  const normalized =
    typeof text === 'string' ? text.replace(/\s+/g, ' ').trim() : '';
  if (!normalized) return null;
  if (normalized.length <= max) return normalized;
  return `${normalized.slice(0, max)}...`;
}

function workerSortRank(key: string): number {
  if (key === 'root') return 0;
  if (key === 'planner') return 1;
  const workerMatch = key.match(/^worker-(\d+)$/);
  if (workerMatch) return 10 + Number.parseInt(workerMatch[1] || '0', 10);
  if (key === 'aggregate') return 100;
  return 200;
}

function sortedWorkers(turn: TerminalTurnState): TerminalWorkerState[] {
  return [...turn.workers.values()].sort((left, right) => {
    const rankDiff = workerSortRank(left.key) - workerSortRank(right.key);
    if (rankDiff !== 0) return rankDiff;
    return left.label.localeCompare(right.label);
  });
}

function buildWorkerLabel(key: string): string {
  if (key === 'root') return 'root';
  if (key === 'planner') return 'planner';
  if (key === 'aggregate') return 'aggregate';
  const match = key.match(/^worker-(\d+)$/);
  if (match) return `worker ${match[1]}`;
  return key;
}

function normalizeFocusKey(target: string): string | null {
  const normalized = target.trim().toLowerCase();
  if (!normalized) return null;
  if (normalized === 'root') return 'root';
  if (normalized === 'planner') return 'planner';
  if (normalized === 'aggregate') return 'aggregate';
  const workerMatch =
    normalized.match(/^worker(?:\s|-)?(\d+)$/) ?? normalized.match(/^(\d+)$/);
  if (workerMatch) {
    return `worker-${workerMatch[1]}`;
  }
  return null;
}

function ensureWorker(
  turn: TerminalTurnState,
  key: string,
  patch: Partial<TerminalWorkerState> = {},
): TerminalWorkerState {
  const existing = turn.workers.get(key);
  const updatedAt = patch.updatedAt ?? nowIso();
  const next: TerminalWorkerState = {
    key,
    label: patch.label ?? existing?.label ?? buildWorkerLabel(key),
    taskId: patch.taskId ?? existing?.taskId ?? null,
    nodeKind: patch.nodeKind ?? existing?.nodeKind ?? null,
    roleTitle: patch.roleTitle ?? existing?.roleTitle ?? null,
    status: patch.status ?? existing?.status ?? 'pending',
    backendId: patch.backendId ?? existing?.backendId ?? null,
    workerClass: patch.workerClass ?? existing?.workerClass ?? null,
    executionId: patch.executionId ?? existing?.executionId ?? null,
    startedAt: patch.startedAt ?? existing?.startedAt ?? null,
    updatedAt,
    lastActivity: patch.lastActivity ?? existing?.lastActivity ?? null,
    summary: patch.summary ?? existing?.summary ?? null,
    error: patch.error ?? existing?.error ?? null,
  };
  turn.workers.set(key, next);
  turn.updatedAt = updatedAt;
  return next;
}

function pushTimeline(
  turn: TerminalTurnState,
  text: string,
  targetKey: string | null,
  at: string,
): void {
  const normalized = previewText(text, 240);
  if (!normalized) return;
  const previous = turn.timeline[turn.timeline.length - 1];
  if (
    previous &&
    previous.text === normalized &&
    previous.targetKey === targetKey
  ) {
    previous.at = at;
    return;
  }
  turn.timeline.push({ at, text: normalized, targetKey });
  if (turn.timeline.length > TERMINAL_TIMELINE_LIMIT) {
    turn.timeline.splice(0, turn.timeline.length - TERMINAL_TIMELINE_LIMIT);
  }
}

function ensureTurn(options: {
  chatJid: string;
  graphId: string;
  rootTaskId?: string | null;
  executionId?: string | null;
  stage?: string;
  backendId?: string | null;
  workerClass?: string | null;
  at?: string;
}): TerminalTurnState {
  const at = options.at ?? nowIso();
  const existing = terminalTurns.get(options.chatJid);
  if (existing && existing.graphId === options.graphId) {
    existing.rootTaskId = options.rootTaskId ?? existing.rootTaskId;
    existing.executionId = options.executionId ?? existing.executionId;
    existing.stage = options.stage ?? existing.stage;
    existing.backendId = options.backendId ?? existing.backendId;
    existing.workerClass = options.workerClass ?? existing.workerClass;
    existing.updatedAt = at;
    ensureWorker(existing, 'root', {
      taskId: options.rootTaskId ?? existing.rootTaskId,
      nodeKind: 'root',
      executionId: options.executionId ?? existing.executionId,
      backendId: options.backendId ?? existing.backendId,
      workerClass: options.workerClass ?? existing.workerClass,
      status:
        existing.status === 'failed'
          ? 'failed'
          : existing.status === 'completed'
            ? 'completed'
            : 'running',
      updatedAt: at,
    });
    return existing;
  }

  const turn: TerminalTurnState = {
    chatJid: options.chatJid,
    graphId: options.graphId,
    rootTaskId: options.rootTaskId ?? null,
    executionId: options.executionId ?? null,
    status: 'running',
    stage: options.stage ?? 'starting',
    backendId: options.backendId ?? null,
    workerClass: options.workerClass ?? null,
    startedAt: at,
    updatedAt: at,
    lastActivity: null,
    error: null,
    fallback: null,
    workers: new Map<string, TerminalWorkerState>(),
    timeline: [],
    focusKey: 'root',
  };
  terminalTurns.set(options.chatJid, turn);
  ensureWorker(turn, 'root', {
    label: 'root',
    taskId: turn.rootTaskId,
    nodeKind: 'root',
    executionId: turn.executionId,
    backendId: turn.backendId,
    workerClass: turn.workerClass,
    status: 'running',
    startedAt: at,
    updatedAt: at,
  });
  return turn;
}

function buildFocusState(turn: TerminalTurnState): TerminalWorkerState | null {
  return turn.workers.get(turn.focusKey) ?? turn.workers.get('root') ?? null;
}

function workerLines(worker: TerminalWorkerState, isFocused: boolean): string {
  return [
    `agent: ${worker.label}${isFocused ? ' [focus]' : ''}`,
    `status: ${worker.status}`,
    `backend: ${worker.backendId ?? 'unknown'}/${worker.workerClass ?? 'unknown'}`,
    `taskId: ${worker.taskId ?? 'none'}`,
    `role: ${worker.roleTitle ?? 'none'}`,
    `activity: ${worker.lastActivity ?? 'none'}`,
    `summary: ${worker.summary ?? 'none'}`,
    `error: ${worker.error ?? 'none'}`,
    `updatedAt: ${formatTerminalTime(worker.updatedAt)}`,
  ].join('\n');
}

export function deriveTerminalWorkerKey(options: {
  taskId?: string | null;
  nodeKind?: string | null;
  planKind?: string | null;
}): string {
  if (
    options.nodeKind === 'aggregate' ||
    options.planKind === 'edge_fanout_aggregate'
  ) {
    return 'aggregate';
  }
  if (options.planKind === 'edge_team_planner') {
    return 'planner';
  }
  if (options.nodeKind === 'root') {
    return 'root';
  }
  const match = options.taskId?.match(/:child-(\d+)$/);
  if (match) return `worker-${match[1]}`;
  return 'root';
}

export function beginTerminalTurn(options: {
  chatJid: string;
  graphId: string;
  rootTaskId?: string | null;
  executionId?: string | null;
  stage: string;
  backendId?: string | null;
  workerClass?: string | null;
  activity?: string;
  at?: string;
}): void {
  const at = options.at ?? nowIso();
  const turn = ensureTurn(options);
  turn.stage = options.stage;
  turn.status = 'running';
  turn.backendId = options.backendId ?? turn.backendId;
  turn.workerClass = options.workerClass ?? turn.workerClass;
  turn.updatedAt = at;
  turn.error = null;
  if (options.activity) {
    turn.lastActivity = previewText(options.activity);
    pushTimeline(turn, options.activity, 'root', at);
  }
  ensureWorker(turn, 'root', {
    status: 'running',
    backendId: turn.backendId,
    workerClass: turn.workerClass,
    executionId: options.executionId ?? turn.executionId,
    taskId: options.rootTaskId ?? turn.rootTaskId,
    lastActivity: previewText(options.activity),
    updatedAt: at,
    startedAt: turn.startedAt,
    error: null,
  });
}

export function updateTerminalTurnStage(options: {
  chatJid: string;
  graphId?: string;
  rootTaskId?: string | null;
  executionId?: string | null;
  stage: string;
  backendId?: string | null;
  workerClass?: string | null;
  activity?: string;
  error?: string | null;
  at?: string;
}): void {
  const existing = terminalTurns.get(options.chatJid);
  if (!existing && !options.graphId) return;
  const at = options.at ?? nowIso();
  const graphId = options.graphId ?? existing?.graphId;
  if (!graphId) return;
  const turn = ensureTurn({
    chatJid: options.chatJid,
    graphId,
    rootTaskId: options.rootTaskId ?? existing?.rootTaskId,
    executionId: options.executionId ?? existing?.executionId,
    stage: options.stage,
    backendId: options.backendId ?? existing?.backendId,
    workerClass: options.workerClass ?? existing?.workerClass,
    at,
  });
  turn.stage = options.stage;
  turn.backendId = options.backendId ?? turn.backendId;
  turn.workerClass = options.workerClass ?? turn.workerClass;
  turn.updatedAt = at;
  if (options.activity) {
    turn.lastActivity = previewText(options.activity);
    pushTimeline(turn, options.activity, 'root', at);
  }
  if (options.error) {
    turn.error = previewText(options.error, 240);
  }
  ensureWorker(turn, 'root', {
    status:
      turn.status === 'failed'
        ? 'failed'
        : turn.status === 'completed'
          ? 'completed'
          : 'running',
    backendId: turn.backendId,
    workerClass: turn.workerClass,
    executionId: options.executionId ?? turn.executionId,
    taskId: turn.rootTaskId,
    lastActivity: previewText(options.activity) ?? turn.lastActivity,
    error: options.error ? previewText(options.error, 240) : turn.error,
    updatedAt: at,
  });
}

export function recordTerminalTimeline(options: {
  chatJid: string;
  text: string;
  targetKey?: string | null;
  at?: string;
}): void {
  const turn = terminalTurns.get(options.chatJid);
  if (!turn) return;
  const at = options.at ?? nowIso();
  turn.updatedAt = at;
  pushTimeline(turn, options.text, options.targetKey ?? null, at);
}

export function getTerminalWorkerLabel(key: string): string {
  return buildWorkerLabel(key);
}

export function ensureTerminalWorker(options: {
  chatJid: string;
  key: string;
  taskId?: string | null;
  nodeKind?: string | null;
  roleTitle?: string | null;
  backendId?: string | null;
  workerClass?: string | null;
  executionId?: string | null;
  status?: TerminalWorkerStatus;
  activity?: string;
  summary?: string;
  error?: string;
  at?: string;
}): void {
  const turn = terminalTurns.get(options.chatJid);
  if (!turn) return;
  const at = options.at ?? nowIso();
  const activity = previewText(options.activity);
  const summary = previewText(options.summary, 240);
  const error = previewText(options.error, 240);
  ensureWorker(turn, options.key, {
    taskId: options.taskId,
    nodeKind: options.nodeKind,
    roleTitle: options.roleTitle,
    backendId: options.backendId,
    workerClass: options.workerClass,
    executionId: options.executionId,
    status: options.status,
    lastActivity: activity,
    summary,
    error,
    updatedAt: at,
    startedAt: options.status === 'running' ? at : undefined,
  });
  if (activity) {
    turn.lastActivity = `${buildWorkerLabel(options.key)}: ${activity}`;
    pushTimeline(
      turn,
      `${buildWorkerLabel(options.key)} · ${activity}`,
      options.key,
      at,
    );
  }
}

export function completeTerminalWorker(options: {
  chatJid: string;
  key: string;
  summary?: string;
  activity?: string;
  at?: string;
}): void {
  const turn = terminalTurns.get(options.chatJid);
  if (!turn) return;
  const at = options.at ?? nowIso();
  const activity = previewText(options.activity);
  const summary = previewText(options.summary, 240);
  ensureWorker(turn, options.key, {
    status: 'completed',
    lastActivity: activity,
    summary,
    error: null,
    updatedAt: at,
  });
  if (activity) {
    turn.lastActivity = `${buildWorkerLabel(options.key)}: ${activity}`;
    pushTimeline(
      turn,
      `${buildWorkerLabel(options.key)} · ${activity}`,
      options.key,
      at,
    );
  }
}

export function failTerminalWorker(options: {
  chatJid: string;
  key: string;
  error: string;
  activity?: string;
  at?: string;
}): void {
  const turn = terminalTurns.get(options.chatJid);
  if (!turn) return;
  const at = options.at ?? nowIso();
  const error = previewText(options.error, 240);
  const activity = previewText(options.activity) ?? error;
  ensureWorker(turn, options.key, {
    status: 'failed',
    lastActivity: activity,
    error,
    updatedAt: at,
  });
  turn.lastActivity = `${buildWorkerLabel(options.key)}: ${activity}`;
  pushTimeline(
    turn,
    `${buildWorkerLabel(options.key)} · ${activity}`,
    options.key,
    at,
  );
}

export function recordTerminalFallback(options: {
  chatJid: string;
  reason: string;
  detail?: string;
  fromBackend?: string | null;
  toBackend?: string | null;
  at?: string;
}): void {
  const turn = terminalTurns.get(options.chatJid);
  if (!turn) return;
  const at = options.at ?? nowIso();
  turn.fallback = {
    at,
    fromBackend: options.fromBackend ?? null,
    toBackend: options.toBackend ?? null,
    reason: options.reason,
    detail: previewText(options.detail, 240),
  };
  turn.stage = 'fallback';
  turn.updatedAt = at;
  turn.lastActivity = `fallback: ${options.reason}`;
  pushTimeline(
    turn,
    `fallback · ${(options.fromBackend ?? 'unknown')} -> ${(options.toBackend ?? 'unknown')} · ${options.reason}${options.detail ? ` · ${previewText(options.detail, 180)}` : ''}`,
    'root',
    at,
  );
}

export function completeTerminalTurn(options: {
  chatJid: string;
  activity?: string;
  stage?: string;
  summary?: string;
  at?: string;
}): void {
  const turn = terminalTurns.get(options.chatJid);
  if (!turn) return;
  const at = options.at ?? nowIso();
  turn.status = 'completed';
  turn.stage = options.stage ?? 'completed';
  turn.updatedAt = at;
  turn.error = null;
  if (options.activity) {
    turn.lastActivity = previewText(options.activity);
    pushTimeline(turn, options.activity, 'root', at);
  }
  ensureWorker(turn, 'root', {
    status: 'completed',
    lastActivity: previewText(options.activity) ?? turn.lastActivity,
    summary: previewText(options.summary, 240),
    error: null,
    updatedAt: at,
  });
}

export function failTerminalTurn(options: {
  chatJid: string;
  error: string;
  stage?: string;
  activity?: string;
  at?: string;
}): void {
  const turn = terminalTurns.get(options.chatJid);
  if (!turn) return;
  const at = options.at ?? nowIso();
  const error = previewText(options.error, 240) ?? 'Unknown error';
  const activity = previewText(options.activity) ?? error;
  turn.status = 'failed';
  turn.stage = options.stage ?? 'failed';
  turn.updatedAt = at;
  turn.error = error;
  turn.lastActivity = activity;
  pushTimeline(turn, activity, 'root', at);
  ensureWorker(turn, 'root', {
    status: 'failed',
    lastActivity: activity,
    error,
    updatedAt: at,
  });
}

export function resetTerminalObservability(chatJid = TERMINAL_GROUP_JID): void {
  terminalTurns.delete(chatJid);
}

export function getTerminalTurnState(
  chatJid = TERMINAL_GROUP_JID,
): TerminalTurnState | null {
  return terminalTurns.get(chatJid) ?? null;
}

export function hasTerminalObservability(
  chatJid = TERMINAL_GROUP_JID,
): boolean {
  return terminalTurns.has(chatJid);
}

export function setTerminalFocus(
  target: string,
  chatJid = TERMINAL_GROUP_JID,
): string {
  const turn = terminalTurns.get(chatJid);
  if (!turn) {
    return '当前没有可观察的 active turn。';
  }
  if (target.trim().toLowerCase() === 'clear') {
    turn.focusKey = 'root';
    return 'focus -> root';
  }
  const normalized = normalizeFocusKey(target);
  if (!normalized || !turn.workers.has(normalized)) {
    const candidates = sortedWorkers(turn)
      .map((worker) => worker.label)
      .join(', ');
    return `focus 目标不存在：${target}。可选：${candidates || 'root'}`;
  }
  turn.focusKey = normalized;
  return `focus -> ${turn.workers.get(normalized)?.label ?? normalized}`;
}

export function cycleTerminalFocus(
  direction: 1 | -1,
  chatJid = TERMINAL_GROUP_JID,
): string | null {
  const turn = terminalTurns.get(chatJid);
  if (!turn) return null;
  const workers = sortedWorkers(turn);
  if (workers.length === 0) return null;
  const currentIndex = workers.findIndex((worker) => worker.key === turn.focusKey);
  const baseIndex = currentIndex === -1 ? 0 : currentIndex;
  const nextIndex = (baseIndex + direction + workers.length) % workers.length;
  const next = workers[nextIndex];
  if (!next) return null;
  turn.focusKey = next.key;
  return next.label;
}

function buildTimelineLines(turn: TerminalTurnState, limit: number): string[] {
  const entries = turn.timeline.slice(-limit);
  return entries.map(
    (entry) => `- [${formatTerminalTime(entry.at)}] ${entry.text}`,
  );
}

function buildFocusedTimelineLines(
  turn: TerminalTurnState,
  focusKey: string,
  limit: number,
): string[] {
  const entries =
    focusKey === 'root'
      ? turn.timeline.slice(-limit)
      : turn.timeline.filter(
          (entry) =>
            entry.targetKey === focusKey || entry.targetKey === 'root',
        ).slice(-limit);
  return entries.map(
    (entry) => `- [${formatTerminalTime(entry.at)}] ${entry.text}`,
  );
}

export function buildTerminalFocusSummary(
  chatJid = TERMINAL_GROUP_JID,
): string | null {
  const turn = terminalTurns.get(chatJid);
  if (!turn) return null;
  const focus = buildFocusState(turn);
  if (!focus) return null;
  const lines = [
    `graph: ${turn.graphId}`,
    `status: ${turn.status}`,
    `stage: ${turn.stage}`,
    `focus: ${focus.label} (${focus.status})`,
    `backend: ${turn.backendId ?? 'unknown'}/${turn.workerClass ?? 'unknown'}`,
    `activity: ${focus.lastActivity ?? turn.lastActivity ?? 'none'}`,
  ];
  if (focus.summary) {
    lines.push(`summary: ${focus.summary}`);
  }
  if (focus.error) {
    lines.push(`error: ${focus.error}`);
  }
  if (turn.fallback) {
    lines.push(
      `fallback: ${(turn.fallback.fromBackend ?? 'unknown')} -> ${(turn.fallback.toBackend ?? 'unknown')} · ${turn.fallback.reason}${turn.fallback.detail ? ` · ${turn.fallback.detail}` : ''}`,
    );
  }
  const timelineLines = buildFocusedTimelineLines(
    turn,
    focus.key,
    focus.key === 'root'
      ? TERMINAL_PANEL_TIMELINE_LIMIT
      : TERMINAL_FOCUS_TIMELINE_LIMIT,
  );
  if (timelineLines.length > 0) {
    lines.push(focus.key === 'root' ? 'recent:' : 'focusRecent:');
    lines.push(...timelineLines);
  }
  return lines.join('\n');
}

export function buildTerminalActiveTurnSummary(
  chatJid = TERMINAL_GROUP_JID,
): string {
  const turn = terminalTurns.get(chatJid);
  if (!turn) {
    return 'activeTurn: none';
  }
  const focus = buildFocusState(turn);
  return [
    `activeTurn.graphId: ${turn.graphId}`,
    `activeTurn.status: ${turn.status}`,
    `activeTurn.stage: ${turn.stage}`,
    `activeTurn.backend: ${turn.backendId ?? 'unknown'}/${turn.workerClass ?? 'unknown'}`,
    `activeTurn.focus: ${focus?.label ?? 'root'}`,
    `activeTurn.activity: ${focus?.lastActivity ?? turn.lastActivity ?? 'none'}`,
    `activeTurn.fallback: ${turn.fallback ? `${turn.fallback.reason}${turn.fallback.detail ? ` · ${turn.fallback.detail}` : ''}` : 'none'}`,
    `activeTurn.error: ${turn.error ?? 'none'}`,
  ].join('\n');
}

export function buildTerminalAgentsSummaryFromObservability(
  chatJid = TERMINAL_GROUP_JID,
): string | null {
  const turn = terminalTurns.get(chatJid);
  if (!turn) return null;
  const workers = sortedWorkers(turn).filter((worker) => worker.key !== 'root');
  return [
    `graphId: ${turn.graphId}`,
    `graphStatus: ${turn.status}`,
    `graphStage: ${turn.stage}`,
    `focus: ${buildFocusState(turn)?.label ?? 'root'}`,
    `lastActivity: ${turn.lastActivity ?? 'none'}`,
    ...(turn.fallback
      ? [
          `fallback: ${(turn.fallback.fromBackend ?? 'unknown')} -> ${(turn.fallback.toBackend ?? 'unknown')} · ${turn.fallback.reason}${turn.fallback.detail ? ` · ${turn.fallback.detail}` : ''}`,
        ]
      : []),
    '',
    ...(workers.length > 0
      ? workers.map((worker) =>
          workerLines(worker, worker.key === turn.focusKey),
        )
      : ['当前 graph 还没有 fanout agents。']),
  ].join('\n\n');
}

export function buildTerminalGraphSummaryFromObservability(
  chatJid = TERMINAL_GROUP_JID,
): string | null {
  const turn = terminalTurns.get(chatJid);
  if (!turn) return null;
  const focus = buildFocusState(turn);
  const lines = [
    `graphId: ${turn.graphId}`,
    `graphStatus: ${turn.status}`,
    `graphStage: ${turn.stage}`,
    `rootTaskId: ${turn.rootTaskId ?? 'none'}`,
    `executionId: ${turn.executionId ?? 'none'}`,
    `backend: ${turn.backendId ?? 'unknown'}/${turn.workerClass ?? 'unknown'}`,
    `focus: ${focus?.label ?? 'root'}`,
    `createdAt: ${formatTerminalTime(turn.startedAt)}`,
    `updatedAt: ${formatTerminalTime(turn.updatedAt)}`,
    `lastActivity: ${turn.lastActivity ?? 'none'}`,
    `fallback: ${turn.fallback ? `${(turn.fallback.fromBackend ?? 'unknown')} -> ${(turn.fallback.toBackend ?? 'unknown')} · ${turn.fallback.reason}${turn.fallback.detail ? ` · ${turn.fallback.detail}` : ''}` : 'none'}`,
    `error: ${turn.error ?? 'none'}`,
    '',
    'timeline:',
    ...(buildTimelineLines(turn, 10).length > 0
      ? buildTimelineLines(turn, 10)
      : ['- none']),
    '',
    'workers:',
    ...sortedWorkers(turn).map((worker) => workerLines(worker, worker.key === turn.focusKey)),
  ];
  return lines.join('\n');
}
