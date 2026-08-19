import type {
  BackgroundCommandProjection,
  ConversationMessage,
  McpServerProjection,
  PermissionDecisionProjection,
  ReportProjection,
  SessionEvent,
  SessionRecord,
  SessionSnapshot,
  SubagentProjection,
  TaskProjection,
  ToolCallProjection,
} from "./types.js";
import type { CompactFinishedEvent, CompactStartedEvent } from "../agent/lifecycle.js";
import type { ToolSource } from "../tools/types.js";

export type SessionViewEventBase<Type extends string> = {
  id: string;
  type: Type;
  sessionId: string;
  timestamp: string;
  sourceEventId: string;
};

export type SessionStartedViewEvent = SessionViewEventBase<"session_started"> & {
  mode: "created" | "resumed";
  session: SessionRecord;
};

export type SessionFinishedViewEvent = SessionViewEventBase<"session_finished"> & {
  session: SessionRecord;
};

export type SessionTitledViewEvent = SessionViewEventBase<"session_titled"> & {
  title: string;
};

export type ConversationMessageViewEvent = SessionViewEventBase<
  "user_message_added" | "assistant_message_added" | "system_message_added"
> & {
  message: ConversationMessage;
};

export type ToolStartedViewEvent = SessionViewEventBase<"tool_started"> & {
  toolCall: ToolCallProjection;
};

export type ToolFinishedViewEvent = SessionViewEventBase<"tool_finished"> & {
  toolCall: ToolCallProjection;
};

export type PermissionRequestProjection = {
  id: string;
  sessionId: string;
  runId: string;
  toolCallId: string;
  toolName: string;
  reason: string;
  inputSummary?: string | undefined;
  source?: ToolSource | undefined;
  requestedAt: string;
};

export type PermissionRequestedViewEvent = SessionViewEventBase<"permission_requested"> & {
  permission: PermissionRequestProjection;
};

export type PermissionResolvedViewEvent = SessionViewEventBase<"permission_resolved"> & {
  decision: PermissionDecisionProjection;
};

export type TaskChangedViewEvent = SessionViewEventBase<"task_changed"> & {
  task: TaskProjection;
};

export type BackgroundStartedViewEvent = SessionViewEventBase<"background_started"> & {
  command: BackgroundCommandProjection;
};

export type BackgroundFinishedViewEvent = SessionViewEventBase<"background_finished"> & {
  command: BackgroundCommandProjection;
};

export type SubagentStartedViewEvent = SessionViewEventBase<"subagent_started"> & {
  subagent: SubagentProjection;
};

export type SubagentFinishedViewEvent = SessionViewEventBase<"subagent_finished"> & {
  subagent: SubagentProjection;
};

export type CompactProjection = {
  id: string;
  sessionId: string;
  runId: string;
  reason: string;
  strategy: CompactStartedEvent["strategy"];
  status?: CompactFinishedEvent["status"] | undefined;
  beforeMessageCount?: number | undefined;
  afterMessageCount?: number | undefined;
  transcriptPath?: string | undefined;
  error?: string | undefined;
  startedAt?: string | undefined;
  finishedAt?: string | undefined;
};

export type CompactStartedViewEvent = SessionViewEventBase<"compact_started"> & {
  compact: CompactProjection;
};

export type CompactFinishedViewEvent = SessionViewEventBase<"compact_finished"> & {
  compact: CompactProjection;
};

export type ReportWrittenViewEvent = SessionViewEventBase<"report_written"> & {
  report: ReportProjection;
};

export type McpServerViewEvent = SessionViewEventBase<
  "mcp_server_connected" | "mcp_server_failed"
> & {
  server: McpServerProjection;
};

export type SessionViewEvent =
  | SessionStartedViewEvent
  | SessionFinishedViewEvent
  | SessionTitledViewEvent
  | ConversationMessageViewEvent
  | ToolStartedViewEvent
  | ToolFinishedViewEvent
  | PermissionRequestedViewEvent
  | PermissionResolvedViewEvent
  | TaskChangedViewEvent
  | BackgroundStartedViewEvent
  | BackgroundFinishedViewEvent
  | SubagentStartedViewEvent
  | SubagentFinishedViewEvent
  | CompactStartedViewEvent
  | CompactFinishedViewEvent
  | ReportWrittenViewEvent
  | McpServerViewEvent;

export type SessionViewEventListener = (event: SessionViewEvent, snapshot: SessionSnapshot) => void;

export function toSessionViewEvents(
  event: SessionEvent,
  snapshot: SessionSnapshot,
): SessionViewEvent[] {
  switch (event.type) {
    case "session_created":
      return [
        {
          ...base(event, "session_started"),
          mode: "created",
          session: event.session,
        },
      ];
    case "session_resumed":
      return snapshot.session
        ? [
            {
              ...base(event, "session_started"),
              mode: "resumed",
              session: snapshot.session,
            },
          ]
        : [];
    case "session_closed":
      return snapshot.session
        ? [
            {
              ...base(event, "session_finished"),
              session: snapshot.session,
            },
          ]
        : [];
    case "session_titled":
      return [{ ...base(event, "session_titled"), title: event.title }];
    case "conversation_message_added":
      return [conversationMessageViewEvent(event, event.message)];
    case "runtime_lifecycle_recorded":
      return runtimeLifecycleViewEvents(event, snapshot);
    case "task_changed":
      return [{ ...base(event, "task_changed"), task: event.task }];
    case "background_started":
      return [{ ...base(event, "background_started"), command: event.command }];
    case "background_finished":
      return [{ ...base(event, "background_finished"), command: event.command }];
    case "subagent_started":
      return [{ ...base(event, "subagent_started"), subagent: event.subagent }];
    case "subagent_finished":
      return [{ ...base(event, "subagent_finished"), subagent: event.subagent }];
    case "report_written":
      return [{ ...base(event, "report_written"), report: event.report }];
    case "mcp_server_connected":
      return [{ ...base(event, "mcp_server_connected"), server: event.server }];
    case "mcp_server_failed":
      return [{ ...base(event, "mcp_server_failed"), server: event.server }];
    case "lead_agent_state_saved":
      return [];
  }
}

function base<Type extends SessionViewEvent["type"]>(
  event: SessionEvent,
  type: Type,
): SessionViewEventBase<Type> {
  return {
    id: event.id,
    type,
    sessionId: event.sessionId,
    timestamp: event.timestamp,
    sourceEventId: event.id,
  };
}

function conversationMessageViewEvent(
  event: SessionEvent,
  message: ConversationMessage,
): ConversationMessageViewEvent {
  switch (message.role) {
    case "user":
      return { ...base(event, "user_message_added"), message };
    case "assistant":
      return { ...base(event, "assistant_message_added"), message };
    case "system":
      return { ...base(event, "system_message_added"), message };
  }
}

function runtimeLifecycleViewEvents(
  event: Extract<SessionEvent, { type: "runtime_lifecycle_recorded" }>,
  snapshot: SessionSnapshot,
): SessionViewEvent[] {
  const runtimeEvent = event.runtimeEvent;
  switch (runtimeEvent.type) {
    case "tool_started":
      return [
        {
          ...base(event, "tool_started"),
          toolCall:
            snapshot.toolCalls.find((call) => call.id === runtimeEvent.toolCallId) ??
            toolCallFromStartedEvent(event.sessionId, runtimeEvent),
        },
      ];
    case "tool_finished":
      return [
        {
          ...base(event, "tool_finished"),
          toolCall:
            snapshot.toolCalls.find((call) => call.id === runtimeEvent.toolCallId) ??
            toolCallFromFinishedEvent(event.sessionId, runtimeEvent),
        },
      ];
    case "permission_requested":
      return [
        {
          ...base(event, "permission_requested"),
          permission: permissionRequestFromRuntimeEvent(event.sessionId, runtimeEvent),
        },
      ];
    case "permission_resolved":
      return [
        {
          ...base(event, "permission_resolved"),
          decision:
            snapshot.permissionDecisions.find(
              (decision) => decision.id === runtimeEvent.permissionId,
            ) ?? permissionDecisionFromRuntimeEvent(event.sessionId, runtimeEvent),
        },
      ];
    case "compact_started":
      return [
        {
          ...base(event, "compact_started"),
          compact: compactFromStartedEvent(event.sessionId, runtimeEvent),
        },
      ];
    case "compact_finished":
      return [
        {
          ...base(event, "compact_finished"),
          compact: compactFromFinishedEvent(event.sessionId, runtimeEvent),
        },
      ];
    case "agent_run_started":
    case "agent_run_finished":
    case "assistant_message_added":
      return [];
  }
}

function toolCallFromStartedEvent(
  sessionId: string,
  event: Extract<SessionEvent, { type: "runtime_lifecycle_recorded" }>["runtimeEvent"] & {
    type: "tool_started";
  },
): ToolCallProjection {
  const toolCall: ToolCallProjection = {
    id: event.toolCallId,
    sessionId,
    runId: event.runId,
    agentId: event.agentId,
    agentKind: event.agentKind,
    toolName: event.toolName,
    status: "running",
    startedAt: event.timestamp,
  };
  if (event.source !== undefined) toolCall.source = event.source;
  if (event.inputSummary !== undefined) toolCall.inputSummary = event.inputSummary;
  return toolCall;
}

function toolCallFromFinishedEvent(
  sessionId: string,
  event: Extract<SessionEvent, { type: "runtime_lifecycle_recorded" }>["runtimeEvent"] & {
    type: "tool_finished";
  },
): ToolCallProjection {
  const toolCall: ToolCallProjection = {
    id: event.toolCallId,
    sessionId,
    runId: event.runId,
    agentId: event.agentId,
    agentKind: event.agentKind,
    toolName: event.toolName,
    status: event.status,
    finishedAt: event.timestamp,
  };
  if (event.source !== undefined) toolCall.source = event.source;
  if (event.resultSummary !== undefined) {
    toolCall.resultSummary = event.resultSummary;
  }
  if (event.error !== undefined) toolCall.error = event.error;
  if (event.durationMs !== undefined) toolCall.durationMs = event.durationMs;
  return toolCall;
}

function permissionRequestFromRuntimeEvent(
  sessionId: string,
  event: Extract<SessionEvent, { type: "runtime_lifecycle_recorded" }>["runtimeEvent"] & {
    type: "permission_requested";
  },
): PermissionRequestProjection {
  const permission: PermissionRequestProjection = {
    id: event.permissionId,
    sessionId,
    runId: event.runId,
    toolCallId: event.toolCallId,
    toolName: event.toolName,
    reason: event.reason,
    requestedAt: event.timestamp,
  };
  if (event.inputSummary !== undefined) {
    permission.inputSummary = event.inputSummary;
  }
  if (event.source !== undefined) permission.source = event.source;
  return permission;
}

function permissionDecisionFromRuntimeEvent(
  sessionId: string,
  event: Extract<SessionEvent, { type: "runtime_lifecycle_recorded" }>["runtimeEvent"] & {
    type: "permission_resolved";
  },
): PermissionDecisionProjection {
  const decision: PermissionDecisionProjection = {
    id: event.permissionId,
    sessionId,
    runId: event.runId,
    toolCallId: event.toolCallId,
    toolName: event.toolName,
    allowed: event.allowed,
    decidedAt: event.timestamp,
  };
  if (event.reason !== undefined) decision.reason = event.reason;
  return decision;
}

function compactFromStartedEvent(sessionId: string, event: CompactStartedEvent): CompactProjection {
  const compact: CompactProjection = {
    id: event.compactId,
    sessionId,
    runId: event.runId,
    reason: event.reason,
    strategy: event.strategy,
    startedAt: event.timestamp,
  };
  if (event.beforeMessageCount !== undefined) {
    compact.beforeMessageCount = event.beforeMessageCount;
  }
  return compact;
}

function compactFromFinishedEvent(
  sessionId: string,
  event: CompactFinishedEvent,
): CompactProjection {
  const compact: CompactProjection = {
    id: event.compactId,
    sessionId,
    runId: event.runId,
    reason: event.reason,
    strategy: event.strategy,
    status: event.status,
    finishedAt: event.timestamp,
  };
  if (event.beforeMessageCount !== undefined) {
    compact.beforeMessageCount = event.beforeMessageCount;
  }
  if (event.afterMessageCount !== undefined) {
    compact.afterMessageCount = event.afterMessageCount;
  }
  if (event.transcriptPath !== undefined) {
    compact.transcriptPath = event.transcriptPath;
  }
  if (event.error !== undefined) compact.error = event.error;
  return compact;
}
