import {
  AgentBackend,
  AgentOutputCallback,
  AgentRunInput,
  AgentRunOutput,
  ExecutionStartedCallback,
} from '../agent-backend.js';
import { RegisteredGroup } from '../types.js';

const EDGE_STUB_PREFIX = '[edge backend stub]';

function buildStubResult(
  group: RegisteredGroup,
  input: AgentRunInput,
): AgentRunOutput {
  if (input.script) {
    return {
      status: 'error',
      result: null,
      error: 'Edge backend stub does not support scheduled task scripts yet.',
    };
  }

  const promptPreview = input.prompt.trim().slice(0, 200);
  const suffix = input.prompt.trim().length > promptPreview.length ? '...' : '';

  return {
    status: 'success',
    result: `${EDGE_STUB_PREFIX} Edge execution for group "${group.name}" is not implemented yet. Prompt preview: ${promptPreview}${suffix}`,
  };
}

class EdgeBackend implements AgentBackend {
  async run(
    group: RegisteredGroup,
    input: AgentRunInput,
    _onExecutionStarted?: ExecutionStartedCallback,
    onOutput?: AgentOutputCallback,
  ): Promise<AgentRunOutput> {
    const output = buildStubResult(group, input);
    await onOutput?.(output);
    return output;
  }
}

export const edgeBackend = new EdgeBackend();
