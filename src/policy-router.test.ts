import { describe, expect, it } from 'vitest';

import {
  HEAVY_ONLY_CAPABILITY_SET,
  buildTaskNodeIntent,
  routeTaskNode,
} from './policy-router.js';

describe('policy router', () => {
  it('derives capability tags from scripts and explicit edge tools', () => {
    expect(
      buildTaskNodeIntent({
        script: 'echo 1',
        prompt: 'EDGE_TOOL {"tool":"message.send","args":{"text":"hi"}}',
      }),
    ).toEqual({
      requiredCapabilities: ['shell.exec', 'message.send'],
    });
  });

  it('keeps edge-pinned groups on edge even with heavy capabilities', () => {
    expect(
      routeTaskNode(
        { executionMode: 'edge' },
        { script: 'echo 1', prompt: 'run this' },
        'container',
      ),
    ).toMatchObject({
      backendId: 'edge',
      requiredCapabilities: ['shell.exec'],
      routeReason: 'group_pinned_edge',
      fallbackEligible: true,
    });
  });

  it('declares heavy-only capability groups explicitly', () => {
    expect([...HEAVY_ONLY_CAPABILITY_SET]).toEqual([
      'shell.exec',
      'browser.exec',
      'app.exec',
      'local.secret',
      'interactive.longlived',
    ]);
  });
});
