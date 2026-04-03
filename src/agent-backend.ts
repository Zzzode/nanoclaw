import { ChildProcess } from 'child_process';

import { RegisteredGroup } from './types.js';

export interface AgentRunInput {
  prompt: string;
  sessionId?: string;
  groupFolder: string;
  chatJid: string;
  isMain: boolean;
  isScheduledTask?: boolean;
  assistantName?: string;
  script?: string;
}

export interface AgentRunOutput {
  status: 'success' | 'error';
  result: string | null;
  newSessionId?: string;
  error?: string;
}

export interface StartedExecution {
  chatJid: string;
  process: ChildProcess;
  executionName: string;
  groupFolder?: string;
}

export type ExecutionStartedCallback = (execution: StartedExecution) => void;
export type AgentOutputCallback = (output: AgentRunOutput) => Promise<void>;

export interface AgentBackend {
  run(
    group: RegisteredGroup,
    input: AgentRunInput,
    onExecutionStarted?: ExecutionStartedCallback,
    onOutput?: AgentOutputCallback,
  ): Promise<AgentRunOutput>;
}
