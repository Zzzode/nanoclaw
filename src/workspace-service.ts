import { randomUUID } from 'crypto';
import fs from 'fs';
import path from 'path';

import type { WorkspaceOverlay } from './agent-backend.js';
import {
  buildLogicalSessionId,
  createLogicalSession,
  createWorkspaceCommit,
  createWorkspaceVersion,
  ensureDatabaseInitialized,
  getLogicalSession,
  getWorkspaceCommit,
  getWorkspaceVersion,
  updateLogicalSession,
} from './db.js';
import { resolveGroupFolderPath } from './group-folder.js';

export type WorkspaceManifest = Record<string, string>;

const WORKSPACE_SNAPSHOT_EXCLUDED_DIRS = new Set([
  'node_modules',
  '.git',
  'dist',
  '.next',
  'coverage',
]);

const WORKSPACE_SNAPSHOT_EXCLUDED_SUFFIXES = [
  '.test.ts',
  '.spec.ts',
  '.test.js',
  '.spec.js',
  '.d.ts',
  '.map',
];

function listFilesRecursive(root: string): string[] {
  const entries: string[] = [];
  const walk = (current: string) => {
    for (const name of fs.readdirSync(current).sort()) {
      if (WORKSPACE_SNAPSHOT_EXCLUDED_DIRS.has(name)) continue;
      const fullPath = path.join(current, name);
      const stat = fs.statSync(fullPath);
      if (stat.isDirectory()) {
        walk(fullPath);
      } else if (stat.isFile()) {
        if (WORKSPACE_SNAPSHOT_EXCLUDED_SUFFIXES.some((s) => name.endsWith(s))) {
          continue;
        }
        entries.push(path.relative(root, fullPath));
      }
    }
  };

  if (fs.existsSync(root)) walk(root);
  return entries;
}

function snapshotManifest(groupFolder: string): WorkspaceManifest {
  const root = resolveGroupFolderPath(groupFolder);
  const manifest: WorkspaceManifest = {};
  for (const relativePath of listFilesRecursive(root)) {
    manifest[relativePath] = fs.readFileSync(
      path.join(root, relativePath),
      'utf8',
    );
  }
  return manifest;
}

function ensureGroupLogicalSession(groupFolder: string): string {
  const existing = getLogicalSession('group', groupFolder);
  if (existing) return existing.id;

  const now = new Date().toISOString();
  const id = buildLogicalSessionId('group', groupFolder);
  createLogicalSession({
    id,
    scopeType: 'group',
    scopeId: groupFolder,
    providerSessionId: null,
    status: 'active',
    lastTurnId: null,
    workspaceVersion: null,
    groupMemoryVersion: null,
    summaryRef: null,
    recentMessagesWindow: null,
    createdAt: now,
    updatedAt: now,
  });
  return id;
}

function writeWorkspaceChange(
  groupFolder: string,
  relativePath: string,
  content: string,
): void {
  const absolutePath = path.join(
    resolveGroupFolderPath(groupFolder),
    relativePath,
  );
  fs.mkdirSync(path.dirname(absolutePath), { recursive: true });
  fs.writeFileSync(absolutePath, content);
}

function deleteWorkspaceChange(
  groupFolder: string,
  relativePath: string,
): void {
  const absolutePath = path.join(
    resolveGroupFolderPath(groupFolder),
    relativePath,
  );
  fs.rmSync(absolutePath, { force: true });
}

export function ensureWorkspaceVersion(groupFolder: string): string {
  ensureDatabaseInitialized();
  const logicalSessionId = ensureGroupLogicalSession(groupFolder);
  const logicalSession = getLogicalSession('group', groupFolder);
  if (logicalSession?.workspaceVersion) {
    return logicalSession.workspaceVersion;
  }

  const versionId = `workspace:${randomUUID()}`;
  const createdAt = new Date().toISOString();
  createWorkspaceVersion({
    versionId,
    groupFolder,
    baseVersionId: null,
    manifestJson: JSON.stringify(snapshotManifest(groupFolder)),
    createdAt,
  });
  updateLogicalSession(logicalSessionId, {
    workspaceVersion: versionId,
    updatedAt: createdAt,
  });
  return versionId;
}

export function getWorkspaceManifest(versionId: string): WorkspaceManifest {
  ensureDatabaseInitialized();
  const version = getWorkspaceVersion(versionId);
  if (!version) {
    throw new Error(`Unknown workspace version: ${versionId}`);
  }
  return JSON.parse(version.manifestJson) as WorkspaceManifest;
}

export function commitWorkspaceOverlay(options: {
  groupFolder: string;
  logicalSessionId: string;
  baseWorkspaceVersion: string;
  overlay: WorkspaceOverlay;
  operationId: string;
}): string {
  ensureDatabaseInitialized();

  const existingCommit = getWorkspaceCommit(options.operationId);
  if (existingCommit) {
    return existingCommit.newVersionId;
  }

  const currentVersion = ensureWorkspaceVersion(options.groupFolder);
  if (currentVersion !== options.baseWorkspaceVersion) {
    throw new Error(
      `Workspace version conflict: expected ${options.baseWorkspaceVersion}, received ${currentVersion}`,
    );
  }

  const manifest = getWorkspaceManifest(options.baseWorkspaceVersion);
  for (const change of options.overlay.changes) {
    if (change.op === 'delete') {
      delete manifest[change.path];
      deleteWorkspaceChange(options.groupFolder, change.path);
      continue;
    }

    if (typeof change.content !== 'string') {
      throw new Error(`Workspace write is missing content for ${change.path}`);
    }
    manifest[change.path] = change.content;
    writeWorkspaceChange(options.groupFolder, change.path, change.content);
  }

  const newVersionId = `workspace:${randomUUID()}`;
  const createdAt = new Date().toISOString();
  createWorkspaceVersion({
    versionId: newVersionId,
    groupFolder: options.groupFolder,
    baseVersionId: options.baseWorkspaceVersion,
    manifestJson: JSON.stringify(manifest),
    createdAt,
  });
  createWorkspaceCommit({
    operationId: options.operationId,
    groupFolder: options.groupFolder,
    baseVersionId: options.baseWorkspaceVersion,
    newVersionId,
    createdAt,
  });

  updateLogicalSession(buildLogicalSessionId('group', options.groupFolder), {
    workspaceVersion: newVersionId,
    updatedAt: createdAt,
  });
  updateLogicalSession(options.logicalSessionId, {
    workspaceVersion: newVersionId,
    updatedAt: createdAt,
  });

  return newVersionId;
}
