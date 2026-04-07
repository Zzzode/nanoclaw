import { randomUUID } from 'crypto';
import fs from 'fs';
import path from 'path';

import { CronExpressionParser } from 'cron-parser';

import type {
  ExecutionRequest,
  WorkspaceOverlay,
  WorkspaceOverlayChange,
} from './agent-backend.js';
import { deriveCapabilitiesFromTools } from './edge-capabilities.js';
import {
  edgeToolRequiresHostBridge,
  getEdgeHostBridge,
} from './edge-host-bridge.js';
import { resolveGroupFolderPath } from './group-folder.js';
import { TIMEZONE } from './config.js';
import type { ScheduledTask } from './types.js';
import { formatDisplayDateTime } from './timezone.js';

export interface EdgeToolInvocation {
  tool: string;
  args?: Record<string, unknown>;
}

export interface EdgeToolExecutionResult {
  result: unknown;
  outputText: string | null;
  workspaceOverlayDigest?: string;
  workspaceOverlay?: WorkspaceOverlay;
}

interface TaskListItem extends ScheduledTask {
  runtimeStatus: 'idle' | 'running';
  displayStatus: 'active' | 'paused' | 'completed' | 'running';
  formattedNextRun: string;
}

const inMemoryToolOperations = new Map<string, string>();

function assertObject(
  value: unknown,
  message: string,
): asserts value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(message);
  }
}

function assertString(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`Invalid ${field}`);
  }
  return value;
}

function rootPathForRequest(request: ExecutionRequest): string {
  return resolveGroupFolderPath(request.groupId);
}

function normalizeWorkspaceTarget(target: string): string {
  const normalized = target.trim().replace(/\\/g, '/');
  if (!normalized) return normalized;

  const knownPrefixes = [
    '/workspace/group/',
    '/workspace/group',
    'workspace/group/',
    'workspace/group',
    '/workspace/',
    'workspace/',
  ];

  for (const prefix of knownPrefixes) {
    if (normalized === prefix.replace(/\/$/, '')) {
      return '.';
    }
    if (normalized.startsWith(prefix)) {
      return normalized.slice(prefix.length) || '.';
    }
  }

  return normalized;
}

function resolveWorkspacePath(root: string, target: string): string {
  const normalized = normalizeWorkspaceTarget(target);
  if (!normalized || normalized === '.') return root;
  const resolved = path.resolve(root, normalized);
  const relative = path.relative(root, resolved);
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error(`Path escapes workspace root: ${target}`);
  }
  return resolved;
}

function listWorkspaceEntries(
  manifest: Record<string, string>,
  currentPath: string,
  recursive: boolean,
): string[] {
  const normalized =
    currentPath === '.' ? '' : `${currentPath.replace(/\/+$/, '')}/`;
  const entries = new Set<string>();

  for (const filePath of Object.keys(manifest)) {
    if (
      normalized &&
      !filePath.startsWith(normalized) &&
      filePath !== currentPath
    ) {
      continue;
    }

    const relative = normalized ? filePath.slice(normalized.length) : filePath;
    if (!relative) continue;
    const firstSegment = relative.split('/')[0];
    if (recursive || firstSegment === relative) {
      entries.add(
        normalized
          ? `${currentPath}/${firstSegment}`.replace(/^\.\//, '')
          : firstSegment,
      );
      if (recursive && firstSegment !== relative) {
        entries.add(filePath);
      }
    }
  }

  return [...entries].sort();
}

function searchWorkspace(
  manifest: Record<string, string>,
  currentPath: string,
  pattern: string,
): Array<{ path: string; line: number; text: string }> {
  const matches: Array<{ path: string; line: number; text: string }> = [];
  const normalized =
    currentPath === '.' ? '' : `${currentPath.replace(/\/+$/, '')}/`;

  for (const [filePath, content] of Object.entries(manifest)) {
    if (
      normalized &&
      !filePath.startsWith(normalized) &&
      filePath !== currentPath
    ) {
      continue;
    }
    for (const [index, line] of content.split('\n').entries()) {
      if (line.includes(pattern)) {
        matches.push({
          path: filePath,
          line: index + 1,
          text: line,
        });
      }
    }
  }
  return matches;
}

function formatTaskListOutput(tasks: TaskListItem[]): string {
  if (tasks.length === 0) {
    return '当前没有任务。';
  }

  return tasks
    .map((task) => {
      return [
        `taskId: ${task.id}`,
        `status: ${task.displayStatus}`,
        `scheduleValue: ${task.schedule_value}`,
        `nextRun: ${task.formattedNextRun}`,
      ].join('\n');
    })
    .join('\n\n');
}

async function buildVisibleTaskList(
  request: ExecutionRequest,
): Promise<TaskListItem[]> {
  const dbModule = await import('./db.js');
  dbModule.ensureDatabaseInitialized();
  const runningTaskIds = new Set(
    dbModule
      .listExecutionStates('running')
      .map((execution) => execution.taskId)
      .filter((taskId): taskId is string => typeof taskId === 'string'),
  );

  return dbModule
    .getAllTasks()
    .filter(
      (task) =>
        request.groupId === 'main' || task.group_folder === request.groupId,
    )
    .map((task) => {
      const runtimeStatus = runningTaskIds.has(task.id) ? 'running' : 'idle';
      const formattedNextRun = task.next_run
        ? formatDisplayDateTime(task.next_run, TIMEZONE)
        : 'none';
      return {
        ...task,
        runtimeStatus,
        displayStatus: runtimeStatus === 'running' ? 'running' : task.status,
        formattedNextRun,
      };
    });
}

function listFilesRecursive(root: string): string[] {
  const entries: string[] = [];
  const walk = (current: string) => {
    for (const name of fs.readdirSync(current).sort()) {
      const fullPath = path.join(current, name);
      const stat = fs.statSync(fullPath);
      if (stat.isDirectory()) {
        walk(fullPath);
      } else if (stat.isFile()) {
        entries.push(path.relative(root, fullPath));
      }
    }
  };

  if (fs.existsSync(root)) {
    walk(root);
  }
  return entries;
}

function snapshotWorkspaceManifest(root: string): Record<string, string> {
  const manifest: Record<string, string> = {};
  for (const relativePath of listFilesRecursive(root)) {
    manifest[relativePath] = fs.readFileSync(
      path.join(root, relativePath),
      'utf8',
    );
  }
  return manifest;
}

function applyPatchToLines(originalText: string, patchLines: string[]): string {
  const original = originalText.split('\n');
  const output: string[] = [];
  let index = 0;

  for (const line of patchLines) {
    if (line.startsWith('@@')) continue;

    const marker = line[0];
    const value = line.slice(1);

    if (marker === ' ') {
      while (index < original.length && original[index] !== value) {
        output.push(original[index]);
        index += 1;
      }
      if (original[index] !== value) {
        throw new Error(`Patch context not found: ${value}`);
      }
      output.push(original[index]);
      index += 1;
      continue;
    }

    if (marker === '-') {
      while (index < original.length && original[index] !== value) {
        output.push(original[index]);
        index += 1;
      }
      if (original[index] !== value) {
        throw new Error(`Patch removal target not found: ${value}`);
      }
      index += 1;
      continue;
    }

    if (marker === '+') {
      output.push(value);
      continue;
    }
  }

  while (index < original.length) {
    output.push(original[index]);
    index += 1;
  }

  return output.join('\n');
}

function applyWorkspacePatch(
  manifest: Record<string, string>,
  patch: string,
): { changedFiles: string[]; changes: WorkspaceOverlayChange[] } {
  const lines = patch.split('\n');
  if (lines[0] !== '*** Begin Patch') {
    throw new Error('Invalid patch header');
  }
  if (!lines.includes('*** End Patch')) {
    throw new Error('Invalid patch footer');
  }

  const changedFiles: string[] = [];
  const changes: WorkspaceOverlayChange[] = [];
  let index = 1;
  while (index < lines.length) {
    const line = lines[index];
    if (line === '*** End Patch') break;

    if (line.startsWith('*** Add File: ')) {
      const relPath = line.slice('*** Add File: '.length);
      index += 1;
      const content: string[] = [];
      while (index < lines.length && !lines[index].startsWith('*** ')) {
        if (!lines[index].startsWith('+')) {
          throw new Error(`Invalid add-file line: ${lines[index]}`);
        }
        content.push(lines[index].slice(1));
        index += 1;
      }
      manifest[relPath] = content.join('\n');
      changes.push({ op: 'write', path: relPath, content: manifest[relPath] });
      changedFiles.push(relPath);
      continue;
    }

    if (line.startsWith('*** Delete File: ')) {
      const relPath = line.slice('*** Delete File: '.length);
      delete manifest[relPath];
      changes.push({ op: 'delete', path: relPath });
      changedFiles.push(relPath);
      index += 1;
      continue;
    }

    if (line.startsWith('*** Update File: ')) {
      const relPath = line.slice('*** Update File: '.length);
      const original = manifest[relPath];
      if (typeof original !== 'string') {
        throw new Error(`Patch target not found: ${relPath}`);
      }
      index += 1;
      const patchLines: string[] = [];
      while (index < lines.length && !lines[index].startsWith('*** ')) {
        patchLines.push(lines[index]);
        index += 1;
      }
      manifest[relPath] = applyPatchToLines(original, patchLines);
      changes.push({ op: 'write', path: relPath, content: manifest[relPath] });
      changedFiles.push(relPath);
      continue;
    }

    throw new Error(`Unsupported patch directive: ${line}`);
  }

  return { changedFiles, changes };
}

async function runIdempotentOperation<T>(
  _request: ExecutionRequest,
  tool: string,
  operationId: string | undefined,
  fn: () => Promise<T> | T,
): Promise<T> {
  if (!operationId) return await fn();

  const existing = inMemoryToolOperations.get(operationId);
  if (existing) {
    return JSON.parse(existing) as T;
  }

  const result = await fn();
  inMemoryToolOperations.set(operationId, JSON.stringify(result));
  return result;
}

function buildTaskNextRun(
  scheduleType: 'cron' | 'interval' | 'once',
  scheduleValue: string,
): string | null {
  if (scheduleType === 'cron') {
    return CronExpressionParser.parse(scheduleValue, { tz: TIMEZONE })
      .next()
      .toISOString();
  }

  if (scheduleType === 'interval') {
    const ms = parseInt(scheduleValue, 10);
    if (!ms || ms <= 0) throw new Error('Invalid interval');
    return new Date(Date.now() + ms).toISOString();
  }

  const date = new Date(scheduleValue);
  if (Number.isNaN(date.getTime())) throw new Error('Invalid once timestamp');
  return date.toISOString();
}

function resolveUpdatedTaskNextRun(
  currentTask: {
    schedule_type: 'cron' | 'interval' | 'once';
    schedule_value: string;
    status: 'active' | 'paused' | 'completed';
  },
  updates: {
    schedule_type?: 'cron' | 'interval' | 'once';
    schedule_value?: string;
    status?: 'active' | 'paused';
  },
): string | null | undefined {
  const effectiveStatus = updates.status ?? currentTask.status;
  if (effectiveStatus === 'paused') {
    return null;
  }

  const nextScheduleType = updates.schedule_type ?? currentTask.schedule_type;
  const nextScheduleValue =
    updates.schedule_value ?? currentTask.schedule_value;

  if (
    updates.schedule_type !== undefined ||
    updates.schedule_value !== undefined ||
    updates.status === 'active'
  ) {
    return buildTaskNextRun(nextScheduleType, nextScheduleValue);
  }

  return undefined;
}

interface EdgeTaskMutableUpdates {
  prompt?: string;
  schedule_type?: 'cron' | 'interval' | 'once';
  schedule_value?: string;
  status?: 'active' | 'paused';
  next_run?: string | null;
}

function validateAllowedTool(request: ExecutionRequest, tool: string): void {
  if (!request.policy.allowedTools.includes(tool)) {
    throw new Error(`Tool not allowed: ${tool}`);
  }
}

function validateCapability(
  request: ExecutionRequest,
  capability: string,
): void {
  const capabilities =
    request.policy.capabilities ??
    deriveCapabilitiesFromTools(request.policy.allowedTools);
  if (!capabilities.includes(capability)) {
    throw new Error(`Capability not allowed: ${capability}`);
  }
}

function validateFetchUrl(networkProfile: string, url: URL): void {
  if (!['http:', 'https:'].includes(url.protocol)) {
    throw new Error(`Unsupported URL protocol: ${url.protocol}`);
  }
  if (networkProfile === 'disabled') {
    throw new Error('Network access is disabled');
  }
  if (networkProfile === 'local') {
    const hostname = url.hostname.toLowerCase();
    if (!['127.0.0.1', 'localhost', '::1'].includes(hostname)) {
      throw new Error(`Network profile local blocks host: ${url.hostname}`);
    }
  }
}

export async function executeEdgeTool(
  request: ExecutionRequest,
  invocation: EdgeToolInvocation,
): Promise<EdgeToolExecutionResult> {
  validateAllowedTool(request, invocation.tool);
  if (edgeToolRequiresHostBridge(invocation.tool)) {
    const bridge = getEdgeHostBridge();
    if (bridge) {
      return await bridge.executeTool(invocation);
    }
  }
  const args = invocation.args ?? {};
  assertObject(args, 'Invalid tool arguments');
  const root = rootPathForRequest(request);
  const baseManifest = snapshotWorkspaceManifest(root);
  const operationId =
    typeof args.operationId === 'string' ? args.operationId : undefined;

  switch (invocation.tool) {
    case 'workspace.read': {
      validateCapability(request, 'fs.read');
      const requestedPath = assertString(args.path, 'path');
      const relPath = normalizeWorkspaceTarget(requestedPath);
      resolveWorkspacePath(root, relPath);
      const content = baseManifest[relPath];
      if (typeof content !== 'string') {
        throw new Error(`File not found: ${requestedPath}`);
      }
      return {
        result: { path: requestedPath, content },
        outputText: content,
        workspaceOverlayDigest: 'workspace:unchanged',
      };
    }
    case 'workspace.list': {
      validateCapability(request, 'fs.read');
      const requestedPath =
        typeof args.path === 'string' && args.path.trim() ? args.path : '.';
      const relPath = normalizeWorkspaceTarget(requestedPath);
      const recursive = args.recursive === true;
      resolveWorkspacePath(root, relPath);
      const entries = listWorkspaceEntries(baseManifest, relPath, recursive);
      return {
        result: { path: requestedPath, entries },
        outputText: JSON.stringify(entries),
        workspaceOverlayDigest: 'workspace:unchanged',
      };
    }
    case 'workspace.search': {
      validateCapability(request, 'fs.read');
      const requestedPath =
        typeof args.path === 'string' && args.path.trim() ? args.path : '.';
      const relPath = normalizeWorkspaceTarget(requestedPath);
      const pattern = assertString(args.pattern, 'pattern');
      resolveWorkspacePath(root, relPath);
      const matches = searchWorkspace(baseManifest, relPath, pattern);
      return {
        result: { path: requestedPath, pattern, matches },
        outputText: JSON.stringify(matches),
        workspaceOverlayDigest: 'workspace:unchanged',
      };
    }
    case 'workspace.write': {
      validateCapability(request, 'fs.write');
      const requestedPath = assertString(args.path, 'path');
      const relPath = normalizeWorkspaceTarget(requestedPath);
      const content = assertString(args.content, 'content');
      const result = await runIdempotentOperation(
        request,
        invocation.tool,
        operationId,
        async () => {
          resolveWorkspacePath(root, relPath);
          return {
            path: requestedPath,
            bytesWritten: Buffer.byteLength(content),
          };
        },
      );
      const overlay: WorkspaceOverlay = {
        changes: [{ op: 'write', path: relPath, content }],
        digest: `workspace:overlay:${invocation.tool}:1`,
      };
      return {
        result,
        outputText: JSON.stringify(result),
        workspaceOverlayDigest: overlay.digest,
        workspaceOverlay: overlay,
      };
    }
    case 'workspace.apply_patch': {
      validateCapability(request, 'fs.write');
      const patch = assertString(args.patch, 'patch');
      const result = await runIdempotentOperation(
        request,
        invocation.tool,
        operationId,
        async () => applyWorkspacePatch({ ...baseManifest }, patch),
      );
      const overlay: WorkspaceOverlay = {
        changes: result.changes,
        digest: `workspace:overlay:${invocation.tool}:${result.changes.length}`,
      };
      return {
        result: { changedFiles: result.changedFiles },
        outputText: JSON.stringify(result),
        workspaceOverlayDigest: overlay.digest,
        workspaceOverlay: overlay,
      };
    }
    case 'message.send': {
      validateCapability(request, 'message.send');
      const text = assertString(args.text, 'text');
      const result = {
        operationId: operationId ?? `msg_${randomUUID()}`,
        chatJid:
          typeof args.chatJid === 'string' ? args.chatJid : request.chatJid,
        text,
      };
      return {
        result,
        outputText: null,
        workspaceOverlayDigest: 'workspace:unchanged',
      };
    }
    case 'task.create': {
      validateCapability(request, 'task.manage');
      const dbModule = await import('./db.js');
      dbModule.ensureDatabaseInitialized();
      const prompt = assertString(args.prompt, 'prompt');
      const scheduleType = args.scheduleType;
      if (
        scheduleType !== 'cron' &&
        scheduleType !== 'interval' &&
        scheduleType !== 'once'
      ) {
        throw new Error('Invalid scheduleType');
      }
      const scheduleValue = assertString(args.scheduleValue, 'scheduleValue');
      const contextMode = args.contextMode === 'group' ? 'group' : 'isolated';
      const result = await runIdempotentOperation(
        request,
        invocation.tool,
        operationId,
        async () => {
          const taskId = `task-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
          dbModule.createTask({
            id: taskId,
            group_folder: request.groupId,
            chat_jid:
              typeof args.chatJid === 'string' ? args.chatJid : request.chatJid,
            prompt,
            script: typeof args.script === 'string' ? args.script : undefined,
            schedule_type: scheduleType,
            schedule_value: scheduleValue,
            context_mode: contextMode,
            next_run: buildTaskNextRun(scheduleType, scheduleValue),
            status: 'active',
            created_at: new Date().toISOString(),
          });
          return { taskId };
        },
      );
      return {
        result,
        outputText: JSON.stringify(result),
        workspaceOverlayDigest: 'workspace:unchanged',
      };
    }
    case 'task.list': {
      validateCapability(request, 'task.manage');
      const tasks = await buildVisibleTaskList(request);
      return {
        result: { tasks },
        outputText: formatTaskListOutput(tasks),
        workspaceOverlayDigest: 'workspace:unchanged',
      };
    }
    case 'task.delete': {
      validateCapability(request, 'task.manage');
      const dbModule = await import('./db.js');
      dbModule.ensureDatabaseInitialized();
      const taskId = assertString(args.taskId, 'taskId');
      const result = await runIdempotentOperation(
        request,
        invocation.tool,
        operationId,
        async () => {
          const task = dbModule.getTaskById(taskId);
          if (!task) {
            throw new Error(`Task not found: ${taskId}`);
          }
          if (
            request.groupId !== 'main' &&
            task.group_folder !== request.groupId
          ) {
            throw new Error(`Task not visible to group: ${taskId}`);
          }
          const { deleteScheduledTask } = await import('./task-control.js');
          deleteScheduledTask(taskId);
          return { taskId, deleted: true };
        },
      );
      return {
        result,
        outputText: JSON.stringify(result),
        workspaceOverlayDigest: 'workspace:unchanged',
      };
    }
    case 'task.update': {
      validateCapability(request, 'task.manage');
      const dbModule = await import('./db.js');
      dbModule.ensureDatabaseInitialized();
      const taskId = assertString(args.taskId, 'taskId');
      const result = await runIdempotentOperation(
        request,
        invocation.tool,
        operationId,
        async () => {
          const task = dbModule.getTaskById(taskId);
          if (!task) {
            throw new Error(`Task not found: ${taskId}`);
          }
          if (
            request.groupId !== 'main' &&
            task.group_folder !== request.groupId
          ) {
            throw new Error(`Task not visible to group: ${taskId}`);
          }

          const updates: EdgeTaskMutableUpdates = {};
          if (typeof args.prompt === 'string') {
            updates.prompt = args.prompt;
          }
          if (args.scheduleType !== undefined) {
            if (
              args.scheduleType !== 'cron' &&
              args.scheduleType !== 'interval' &&
              args.scheduleType !== 'once'
            ) {
              throw new Error('Invalid scheduleType');
            }
            updates.schedule_type = args.scheduleType;
          }
          if (args.scheduleValue !== undefined) {
            updates.schedule_value = assertString(
              args.scheduleValue,
              'scheduleValue',
            );
          }
          if (args.status !== undefined) {
            if (args.status !== 'active' && args.status !== 'paused') {
              throw new Error('Invalid status');
            }
            updates.status = args.status;
          }

          const nextRun = resolveUpdatedTaskNextRun(task, updates);
          if (nextRun !== undefined) {
            updates.next_run = nextRun;
          }

          dbModule.updateTask(taskId, updates);
          const updatedTask = dbModule.getTaskById(taskId);
          return {
            taskId,
            updated: true,
            task: updatedTask,
          };
        },
      );
      return {
        result,
        outputText: JSON.stringify(result),
        workspaceOverlayDigest: 'workspace:unchanged',
      };
    }
    case 'http.fetch': {
      validateCapability(request, 'http.fetch');
      const urlString = assertString(args.url, 'url');
      const url = new URL(urlString);
      validateFetchUrl(request.policy.networkProfile, url);
      const response = await fetch(url, {
        method:
          typeof args.method === 'string' ? args.method.toUpperCase() : 'GET',
        headers:
          args.headers && typeof args.headers === 'object'
            ? (args.headers as Record<string, string>)
            : undefined,
        body: typeof args.body === 'string' ? args.body : undefined,
      });
      const bodyText = await response.text();
      const result = {
        status: response.status,
        ok: response.ok,
        url: response.url,
        body: bodyText,
      };
      return {
        result,
        outputText: bodyText,
        workspaceOverlayDigest: 'workspace:unchanged',
      };
    }
    case 'js.exec': {
      validateCapability(request, 'code.exec');
      if (request.policy.execution?.allowJsExecution === false) {
        throw new Error('JavaScript execution is disabled by policy');
      }

      const code = assertString(args.code, 'code');
      const AsyncFunction = Object.getPrototypeOf(async function placeholder() {
        return null;
      }).constructor as new (
        ...args: string[]
      ) => (sdk: Record<string, unknown>) => Promise<unknown>;

      const sdk = {
        workspace: {
          read: async (toolArgs: Record<string, unknown>) =>
            (
              await executeEdgeTool(request, {
                tool: 'workspace.read',
                args: toolArgs,
              })
            ).result,
          list: async (toolArgs: Record<string, unknown>) =>
            (
              await executeEdgeTool(request, {
                tool: 'workspace.list',
                args: toolArgs,
              })
            ).result,
          search: async (toolArgs: Record<string, unknown>) =>
            (
              await executeEdgeTool(request, {
                tool: 'workspace.search',
                args: toolArgs,
              })
            ).result,
          write: async (toolArgs: Record<string, unknown>) =>
            (
              await executeEdgeTool(request, {
                tool: 'workspace.write',
                args: toolArgs,
              })
            ).result,
          applyPatch: async (toolArgs: Record<string, unknown>) =>
            (
              await executeEdgeTool(request, {
                tool: 'workspace.apply_patch',
                args: toolArgs,
              })
            ).result,
        },
        http: {
          fetch: async (toolArgs: Record<string, unknown>) =>
            (
              await executeEdgeTool(request, {
                tool: 'http.fetch',
                args: toolArgs,
              })
            ).result,
        },
        message: {
          send: async (toolArgs: Record<string, unknown>) =>
            (
              await executeEdgeTool(request, {
                tool: 'message.send',
                args: toolArgs,
              })
            ).result,
        },
        task: {
          create: async (toolArgs: Record<string, unknown>) =>
            (
              await executeEdgeTool(request, {
                tool: 'task.create',
                args: toolArgs,
              })
            ).result,
          list: async (toolArgs: Record<string, unknown> = {}) =>
            (
              await executeEdgeTool(request, {
                tool: 'task.list',
                args: toolArgs,
              })
            ).result,
        },
      };

      const executor = new AsyncFunction('sdk', `"use strict";\n${code}`);
      const result = await executor(sdk);

      return {
        result:
          result === undefined
            ? { ok: true, value: null }
            : { ok: true, value: result },
        outputText:
          typeof result === 'string' ? result : JSON.stringify(result ?? null),
        workspaceOverlayDigest: 'workspace:unchanged',
      };
    }
    default:
      throw new Error(`Unsupported tool: ${invocation.tool}`);
  }
}

export function parseSingleToolInvocation(
  prompt: string,
): EdgeToolInvocation | null {
  const trimmed = prompt.trim();
  const prefix = 'EDGE_TOOL ';
  if (!trimmed.startsWith(prefix)) return null;

  const payload = JSON.parse(trimmed.slice(prefix.length)) as unknown;
  assertObject(payload, 'Invalid EDGE_TOOL payload');
  return {
    tool: assertString(payload.tool, 'tool'),
    args:
      payload.args && typeof payload.args === 'object'
        ? (payload.args as Record<string, unknown>)
        : {},
  };
}
