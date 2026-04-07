import { describe, expect, it } from 'vitest';

import { heavyWorker } from './backends/container-backend.js';
import { edgeBackend } from './backends/edge-backend.js';

describe('framework worker contract', () => {
  it('exposes heavy and edge as peer worker classes', () => {
    expect(edgeBackend).toMatchObject({
      backendId: 'edge',
      workerClass: 'edge',
      runtimeClass: 'edge-subprocess',
      capabilityEnvelope: [
        'fs.read',
        'fs.write',
        'http.fetch',
        'task.manage',
        'message.send',
        'code.exec',
      ],
    });

    expect(heavyWorker).toMatchObject({
      backendId: 'container',
      workerClass: 'heavy',
      runtimeClass: 'container',
      plannedSpecializations: ['local-shell', 'browser-worker', 'app-worker'],
      capabilityEnvelope: [
        'shell.exec',
        'browser.exec',
        'app.exec',
        'local.secret',
        'interactive.longlived',
      ],
    });
  });

  it('keeps a shared top-level run contract across worker classes', () => {
    for (const worker of [edgeBackend, heavyWorker]) {
      expect(typeof worker.run).toBe('function');
      expect(
        worker.backendId === 'edge' || worker.backendId === 'container',
      ).toBe(true);
      expect(
        worker.workerClass === 'edge' || worker.workerClass === 'heavy',
      ).toBe(true);
    }
  });
});
