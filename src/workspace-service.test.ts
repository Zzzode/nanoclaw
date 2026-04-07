import fs from 'fs';
import path from 'path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  _initTestDatabase,
  getLogicalSession,
  getWorkspaceCommit,
  getWorkspaceVersion,
} from './db.js';
import { GROUPS_DIR } from './config.js';
import {
  commitWorkspaceOverlay,
  ensureWorkspaceVersion,
  getWorkspaceManifest,
} from './workspace-service.js';

describe('workspace service', () => {
  let groupFolder: string;
  let groupPath: string;

  beforeEach(() => {
    _initTestDatabase();
    groupFolder = `workspace_service_${Date.now()}`;
    groupPath = path.join(GROUPS_DIR, groupFolder);
    fs.mkdirSync(groupPath, { recursive: true });
    fs.writeFileSync(path.join(groupPath, 'base.txt'), 'base');
  });

  afterEach(() => {
    fs.rmSync(groupPath, { recursive: true, force: true });
  });

  it('creates an initial version from disk and commits overlays', () => {
    const baseVersion = ensureWorkspaceVersion(groupFolder);
    const groupSession = getLogicalSession('group', groupFolder);

    expect(getWorkspaceManifest(baseVersion)).toEqual({
      'base.txt': 'base',
    });

    const newVersion = commitWorkspaceOverlay({
      groupFolder,
      logicalSessionId: groupSession!.id,
      baseWorkspaceVersion: baseVersion,
      operationId: 'commit-1',
      overlay: {
        digest: 'workspace:overlay:test',
        changes: [
          { op: 'write', path: 'base.txt', content: 'updated' },
          { op: 'write', path: 'new.txt', content: 'created' },
        ],
      },
    });

    expect(newVersion).not.toBe(baseVersion);
    expect(getWorkspaceVersion(newVersion)).toBeDefined();
    expect(getWorkspaceCommit('commit-1')).toMatchObject({
      operationId: 'commit-1',
      baseVersionId: baseVersion,
      newVersionId: newVersion,
    });
    expect(fs.readFileSync(path.join(groupPath, 'base.txt'), 'utf8')).toBe(
      'updated',
    );
    expect(fs.readFileSync(path.join(groupPath, 'new.txt'), 'utf8')).toBe(
      'created',
    );
    expect(getLogicalSession('group', groupFolder)).toMatchObject({
      workspaceVersion: newVersion,
    });
  });

  it('rejects stale workspace writes', () => {
    const baseVersion = ensureWorkspaceVersion(groupFolder);
    const groupSession = getLogicalSession('group', groupFolder)!;

    const nextVersion = commitWorkspaceOverlay({
      groupFolder,
      logicalSessionId: groupSession.id,
      baseWorkspaceVersion: baseVersion,
      operationId: 'commit-2',
      overlay: {
        digest: 'workspace:overlay:test',
        changes: [{ op: 'write', path: 'base.txt', content: 'updated once' }],
      },
    });
    expect(nextVersion).not.toBe(baseVersion);

    expect(() =>
      commitWorkspaceOverlay({
        groupFolder,
        logicalSessionId: groupSession.id,
        baseWorkspaceVersion: baseVersion,
        operationId: 'commit-stale',
        overlay: {
          digest: 'workspace:overlay:test-stale',
          changes: [{ op: 'write', path: 'base.txt', content: 'stale write' }],
        },
      }),
    ).toThrow(/workspace version conflict/i);
  });

  it('replays duplicate commits idempotently', () => {
    const baseVersion = ensureWorkspaceVersion(groupFolder);
    const groupSession = getLogicalSession('group', groupFolder)!;

    const first = commitWorkspaceOverlay({
      groupFolder,
      logicalSessionId: groupSession.id,
      baseWorkspaceVersion: baseVersion,
      operationId: 'commit-3',
      overlay: {
        digest: 'workspace:overlay:test',
        changes: [{ op: 'write', path: 'base.txt', content: 'idempotent' }],
      },
    });
    const second = commitWorkspaceOverlay({
      groupFolder,
      logicalSessionId: groupSession.id,
      baseWorkspaceVersion: baseVersion,
      operationId: 'commit-3',
      overlay: {
        digest: 'workspace:overlay:test',
        changes: [{ op: 'write', path: 'base.txt', content: 'idempotent' }],
      },
    });

    expect(second).toBe(first);
  });
});
