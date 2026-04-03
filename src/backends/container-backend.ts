import {
  AgentBackend,
  AgentOutputCallback,
  AgentRunInput,
  AgentRunOutput,
  ExecutionStartedCallback,
} from '../agent-backend.js';
import { ensureContainerRuntimeRunning } from '../container-runtime.js';
import { runContainerAgent } from '../container-runner.js';
import { RegisteredGroup } from '../types.js';

class ContainerBackend implements AgentBackend {
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

export const containerBackend = new ContainerBackend();
