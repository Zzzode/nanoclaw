import {
  AgentOutputCallback,
  AgentRunInput,
  AgentRunOutput,
  ExecutionStartedCallback,
} from '../agent-backend.js';
import { ensureContainerRuntimeRunning } from '../container-runtime.js';
import type { FrameworkWorker } from '../framework-worker.js';
import { PLANNED_HEAVY_RUNTIME_SPECIALIZATIONS } from '../framework-policy.js';
import { runContainerAgent } from '../container-runner.js';
import { RegisteredGroup } from '../types.js';

class HeavyWorker implements FrameworkWorker {
  readonly backendId = 'container' as const;
  readonly workerClass = 'heavy' as const;
  readonly runtimeClass = 'container';
  readonly plannedSpecializations = PLANNED_HEAVY_RUNTIME_SPECIALIZATIONS;
  readonly capabilityEnvelope = [
    'shell.exec',
    'browser.exec',
    'app.exec',
    'local.secret',
    'interactive.longlived',
  ] as const;

  async run(
    group: RegisteredGroup,
    input: AgentRunInput,
    onExecutionStarted?: ExecutionStartedCallback,
    onOutput?: AgentOutputCallback,
  ): Promise<AgentRunOutput> {
    ensureContainerRuntimeRunning();

    return runContainerAgent(
      group,
      input,
      (process, executionName) =>
        onExecutionStarted?.({
          chatJid: input.chatJid,
          process,
          executionName,
          groupFolder: group.folder,
        }),
      onOutput,
    );
  }
}

export const heavyWorker = new HeavyWorker();
export const containerBackend = heavyWorker;
