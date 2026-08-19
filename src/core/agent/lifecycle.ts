import crypto from "node:crypto";
import type { AgentKind, AgentRun, AgentRunStatus, AgentRunTrigger } from "./run.js";
import type { ToolSource } from "../tools/types.js";

export type RuntimeLifecycleEventType =
  | "agent_run_started"
  | "agent_run_finished"
  | "assistant_message_added"
  | "tool_started"
  | "tool_finished"
  | "permission_requested"
  | "permission_resolved"
  | "compact_started"
  | "compact_finished";

export type RuntimeLifecycleEventBase<Type extends RuntimeLifecycleEventType> = {
  id: string;
  type: Type;
  timestamp: string;
  runId: string;
  sessionId?: string | undefined;
  agentId: string;
  agentKind: AgentKind;
  parentRunId?: string | undefined;
  parentToolCallId?: string | undefined;
};

export type RuntimeRunContext = {
  runId: string;
  sessionId?: string | undefined;
  agentId: string;
  agentKind: AgentKind;
  parentRunId?: string | undefined;
  parentToolCallId?: string | undefined;
};

export type AgentRunStartedEvent = RuntimeLifecycleEventBase<"agent_run_started"> & {
  trigger: AgentRunTrigger;
};

export type AgentRunFinishedEvent = RuntimeLifecycleEventBase<"agent_run_finished"> & {
  status: Exclude<AgentRunStatus, "created" | "running">;
  stopReason?: string | null | undefined;
  resultSummary?: string | undefined;
  error?: string | undefined;
  messageCount?: number | undefined;
  toolCallCount?: number | undefined;
};

export type AssistantMessageAddedEvent = RuntimeLifecycleEventBase<"assistant_message_added"> & {
  messageIndex: number;
  contentSummary: string;
  blockCount?: number | undefined;
  stopReason?: string | null | undefined;
  usage?: { inputTokens: number; outputTokens: number } | undefined;
};

export type ToolStartedEvent = RuntimeLifecycleEventBase<"tool_started"> & {
  toolCallId: string;
  toolName: string;
  source?: ToolSource | undefined;
  inputSummary?: string | undefined;
};

export type ToolFinishedEvent = RuntimeLifecycleEventBase<"tool_finished"> & {
  toolCallId: string;
  toolName: string;
  source?: ToolSource | undefined;
  status: "completed" | "blocked" | "permission_denied" | "error";
  resultSummary?: string | undefined;
  error?: string | undefined;
  durationMs?: number | undefined;
};

export type PermissionRequestedEvent = RuntimeLifecycleEventBase<"permission_requested"> & {
  permissionId: string;
  toolCallId: string;
  toolName: string;
  source?: ToolSource | undefined;
  reason: string;
  inputSummary?: string | undefined;
};

export type PermissionResolvedEvent = RuntimeLifecycleEventBase<"permission_resolved"> & {
  permissionId: string;
  toolCallId: string;
  toolName: string;
  source?: ToolSource | undefined;
  allowed: boolean;
  reason?: string | undefined;
};

export type CompactStartedEvent = RuntimeLifecycleEventBase<"compact_started"> & {
  compactId: string;
  reason: string;
  strategy: "micro" | "auto" | "manual" | "recovery";
  beforeMessageCount?: number | undefined;
};

export type CompactFinishedEvent = RuntimeLifecycleEventBase<"compact_finished"> & {
  compactId: string;
  reason: string;
  strategy: "micro" | "auto" | "manual" | "recovery";
  status: "completed" | "skipped" | "failed";
  beforeMessageCount?: number | undefined;
  afterMessageCount?: number | undefined;
  transcriptPath?: string | undefined;
  error?: string | undefined;
};

export type RuntimeLifecycleEvent =
  | AgentRunStartedEvent
  | AgentRunFinishedEvent
  | AssistantMessageAddedEvent
  | ToolStartedEvent
  | ToolFinishedEvent
  | PermissionRequestedEvent
  | PermissionResolvedEvent
  | CompactStartedEvent
  | CompactFinishedEvent;

export type NewRuntimeLifecycleEvent<Event extends RuntimeLifecycleEvent = RuntimeLifecycleEvent> =
  Omit<Event, "id" | "timestamp"> & {
    id?: string | undefined;
    timestamp?: string | undefined;
  };

export type RuntimeLifecycleSink = {
  emit(event: RuntimeLifecycleEvent): void;
};

export const noopRuntimeLifecycleSink: RuntimeLifecycleSink = {
  emit() {},
};

export function runtimeRunContextFromAgentRun(run: AgentRun): RuntimeRunContext {
  const context: RuntimeRunContext = {
    runId: run.id,
    agentId: run.agentId,
    agentKind: run.agentKind,
  };
  if (run.sessionId !== undefined) context.sessionId = run.sessionId;
  if (run.trigger.type === "subagent") {
    if (run.trigger.parentRunId !== undefined) {
      context.parentRunId = run.trigger.parentRunId;
    }
    if (run.trigger.parentToolCallId !== undefined) {
      context.parentToolCallId = run.trigger.parentToolCallId;
    }
  }
  return context;
}

export function runtimeLifecycleBase(context: RuntimeRunContext): RuntimeRunContext {
  const base: RuntimeRunContext = {
    runId: context.runId,
    agentId: context.agentId,
    agentKind: context.agentKind,
  };
  if (context.sessionId !== undefined) base.sessionId = context.sessionId;
  if (context.parentRunId !== undefined) base.parentRunId = context.parentRunId;
  if (context.parentToolCallId !== undefined) {
    base.parentToolCallId = context.parentToolCallId;
  }
  return base;
}

export function createRuntimeLifecycleEvent<Event extends RuntimeLifecycleEvent>(
  event: NewRuntimeLifecycleEvent<Event>,
): Event {
  return {
    ...event,
    id: event.id ?? crypto.randomUUID(),
    timestamp: event.timestamp ?? new Date().toISOString(),
  } as Event;
}

export function safeEmitRuntimeLifecycle(
  sink: RuntimeLifecycleSink | undefined,
  event: RuntimeLifecycleEvent,
): void {
  try {
    (sink ?? noopRuntimeLifecycleSink).emit(event);
  } catch {
    // Lifecycle observation must not affect agent execution.
  }
}

export class RuntimeLifecycleCollector implements RuntimeLifecycleSink {
  private readonly queued: RuntimeLifecycleEvent[] = [];

  get events(): readonly RuntimeLifecycleEvent[] {
    return this.queued;
  }

  emit(event: RuntimeLifecycleEvent): void {
    this.queued.push(event);
  }

  drain(): RuntimeLifecycleEvent[] {
    const events = this.queued.slice();
    this.queued.length = 0;
    return events;
  }
}

export function createRuntimeLifecycleCollector(): RuntimeLifecycleCollector {
  return new RuntimeLifecycleCollector();
}
