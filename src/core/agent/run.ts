import crypto from "node:crypto";

export type AgentKind = "lead" | "subagent";

export type AgentRunTrigger =
  | { type: "user_message"; messageId?: string | undefined }
  | {
      type: "auto_wake";
      reason: "async_work_finished" | "background_finished" | "subagent_finished";
    }
  | {
      type: "subagent";
      parentAgentId?: string | undefined;
      parentRunId?: string | undefined;
      parentToolCallId?: string | undefined;
    };

export type AgentRunStatus = "created" | "running" | "completed" | "failed" | "interrupted";

export type AgentRun = {
  id: string;
  sessionId?: string | undefined;
  agentId: string;
  agentKind: AgentKind;
  trigger: AgentRunTrigger;
  status: AgentRunStatus;
  createdAt: string;
  startedAt?: string | undefined;
  finishedAt?: string | undefined;
  stopReason?: string | null | undefined;
  resultSummary?: string | undefined;
  error?: string | undefined;
  messageCount?: number | undefined;
  toolCallCount?: number | undefined;
};

export type CreateAgentRunOptions = {
  id?: string | undefined;
  sessionId?: string | undefined;
  agentId: string;
  agentKind: AgentKind;
  trigger: AgentRunTrigger;
  now?: string | undefined;
};

export type CompleteAgentRunOptions = {
  stopReason?: string | null | undefined;
  resultSummary?: string | undefined;
  messageCount?: number | undefined;
  toolCallCount?: number | undefined;
  now?: string | undefined;
};

export function createAgentRun(options: CreateAgentRunOptions): AgentRun {
  const run: AgentRun = {
    id: options.id ?? crypto.randomUUID(),
    agentId: options.agentId,
    agentKind: options.agentKind,
    trigger: options.trigger,
    status: "created",
    createdAt: options.now ?? timestamp(),
  };
  if (options.sessionId !== undefined) run.sessionId = options.sessionId;
  return run;
}

export function startAgentRun(run: AgentRun, now = timestamp()): AgentRun {
  run.status = "running";
  run.startedAt = now;
  return run;
}

export function completeAgentRun(run: AgentRun, options: CompleteAgentRunOptions = {}): AgentRun {
  run.status = "completed";
  run.finishedAt = options.now ?? timestamp();
  if (options.stopReason !== undefined) run.stopReason = options.stopReason;
  if (options.resultSummary !== undefined) {
    run.resultSummary = options.resultSummary;
  }
  if (options.messageCount !== undefined) run.messageCount = options.messageCount;
  if (options.toolCallCount !== undefined) {
    run.toolCallCount = options.toolCallCount;
  }
  return run;
}

export function failAgentRun(run: AgentRun, error: unknown, now = timestamp()): AgentRun {
  run.status = "failed";
  run.finishedAt = now;
  run.error = formatRunError(error);
  return run;
}

export function interruptAgentRun(run: AgentRun, reason: string, now = timestamp()): AgentRun {
  run.status = "interrupted";
  run.finishedAt = now;
  run.error = reason;
  return run;
}

function timestamp(): string {
  return new Date().toISOString();
}

function formatRunError(error: unknown): string {
  if (error instanceof Error) return `${error.name}: ${error.message}`;
  return String(error);
}
