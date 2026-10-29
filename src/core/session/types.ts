import crypto from "node:crypto";
import type { Message } from "@earendil-works/pi-ai";
import type { AgentKind, AgentRunStatus, AgentRunTrigger } from "../agent/run.js";
import type { RuntimeLifecycleEvent } from "../agent/lifecycle.js";
import type { ToolSource } from "../tools/types.js";

export type SessionStatus = "active" | "closed";

export type SessionRecord = {
  id: string;
  workspaceRoot: string;
  createdAt: string;
  updatedAt: string;
  status: SessionStatus;
  title: string;
};

export type ConversationRole = "user" | "assistant" | "system";

export type ConversationMessage = {
  id: string;
  sessionId: string;
  role: ConversationRole;
  content: string;
  createdAt: string;
  source: "user_input" | "agent_result" | "system";
};

export type LeadAgentState = {
  sessionId: string;
  messages: Message[];
  updatedAt: string;
};

export type LeadAgentMessageProjection = {
  role: Message["role"];
  contentSummary: string;
};

export type LeadAgentStateProjection = {
  sessionId: string;
  messages: LeadAgentMessageProjection[];
  messageCount: number;
  updatedAt: string;
};

export type AgentRunProjection = {
  id: string;
  sessionId: string;
  agentId: string;
  agentKind: AgentKind;
  trigger: AgentRunTrigger;
  status: Exclude<AgentRunStatus, "created">;
  startedAt?: string | undefined;
  finishedAt?: string | undefined;
  stopReason?: string | null | undefined;
  resultSummary?: string | undefined;
  error?: string | undefined;
  messageCount?: number | undefined;
  toolCallCount?: number | undefined;
};

export type ToolCallStatus = "running" | "completed" | "blocked" | "permission_denied" | "error";

export type ToolCallProjection = {
  id: string;
  sessionId: string;
  runId: string;
  agentId: string;
  agentKind: AgentKind;
  toolName: string;
  source?: ToolSource | undefined;
  status: ToolCallStatus;
  inputSummary?: string | undefined;
  resultSummary?: string | undefined;
  error?: string | undefined;
  startedAt?: string | undefined;
  finishedAt?: string | undefined;
  durationMs?: number | undefined;
};

export type PermissionDecisionProjection = {
  id: string;
  sessionId: string;
  runId: string;
  toolCallId: string;
  toolName: string;
  allowed: boolean;
  reason?: string | undefined;
  decidedAt: string;
};

export type BackgroundCommandProjection = {
  id: string;
  sessionId: string;
  status: "running" | "completed" | "timeout" | "error" | "interrupted";
  commandSummary: string;
  resultSummary?: string | undefined;
  toolCallId?: string | undefined;
  startedAt?: string | undefined;
  finishedAt?: string | undefined;
};

export type SubagentProjection = {
  id: string;
  sessionId: string;
  status: "running" | "completed" | "error" | "interrupted";
  promptSummary: string;
  resultSummary?: string | undefined;
  taskId?: string | undefined;
  runId?: string | undefined;
  parentRunId?: string | undefined;
  parentToolCallId?: string | undefined;
  messageCount?: number | undefined;
  startedAt?: string | undefined;
  finishedAt?: string | undefined;
};

export type TaskProjection = {
  id: string;
  sessionId: string;
  status: string;
  title: string;
  updatedAt: string;
};

export type ReportProjection = {
  id: string;
  sessionId: string;
  title: string;
  path: string;
  createdAt: string;
};

export type McpServerProjection = {
  name: string;
  status: "connected" | "failed";
  toolCount?: number | undefined;
  reason?: string | undefined;
  updatedAt: string;
};

export type SessionUsageTotals = {
  inputTokens: number;
  outputTokens: number;
  apiCalls: number;
  lastInputTokens: number;
};

export type SessionSnapshot = {
  session: SessionRecord | null;
  conversationMessages: ConversationMessage[];
  leadAgentMessages: LeadAgentMessageProjection[];
  agentRuns: AgentRunProjection[];
  toolCalls: ToolCallProjection[];
  permissionDecisions: PermissionDecisionProjection[];
  backgroundCommands: BackgroundCommandProjection[];
  subagents: SubagentProjection[];
  tasks: TaskProjection[];
  reports: ReportProjection[];
  mcpServers: McpServerProjection[];
  usage: SessionUsageTotals;
};

export type SessionEventType =
  | "session_created"
  | "session_resumed"
  | "session_closed"
  | "session_titled"
  | "conversation_message_added"
  | "lead_agent_state_saved"
  | "runtime_lifecycle_recorded"
  | "task_changed"
  | "background_started"
  | "background_finished"
  | "subagent_started"
  | "subagent_finished"
  | "report_written"
  | "mcp_server_connected"
  | "mcp_server_failed";

export type SessionEventBase<Type extends SessionEventType> = {
  id: string;
  type: Type;
  sessionId: string;
  timestamp: string;
};

export type SessionCreatedEvent = SessionEventBase<"session_created"> & {
  session: SessionRecord;
};

export type SessionResumedEvent = SessionEventBase<"session_resumed">;

export type SessionClosedEvent = SessionEventBase<"session_closed">;

export type SessionTitledEvent = SessionEventBase<"session_titled"> & {
  title: string;
};

export type ConversationMessageAddedEvent = SessionEventBase<"conversation_message_added"> & {
  message: ConversationMessage;
};

export type LeadAgentStateSavedEvent = SessionEventBase<"lead_agent_state_saved"> & {
  state: LeadAgentStateProjection;
};

export type RuntimeLifecycleRecordedEvent = SessionEventBase<"runtime_lifecycle_recorded"> & {
  runtimeEvent: RuntimeLifecycleEvent;
};

export type TaskChangedEvent = SessionEventBase<"task_changed"> & {
  task: TaskProjection;
};

export type BackgroundStartedEvent = SessionEventBase<"background_started"> & {
  command: BackgroundCommandProjection;
};

export type BackgroundFinishedEvent = SessionEventBase<"background_finished"> & {
  command: BackgroundCommandProjection;
};

export type SubagentStartedEvent = SessionEventBase<"subagent_started"> & {
  subagent: SubagentProjection;
};

export type SubagentFinishedEvent = SessionEventBase<"subagent_finished"> & {
  subagent: SubagentProjection;
};

export type ReportWrittenEvent = SessionEventBase<"report_written"> & {
  report: ReportProjection;
};

export type McpServerConnectedEvent = SessionEventBase<"mcp_server_connected"> & {
  server: McpServerProjection;
};

export type McpServerFailedEvent = SessionEventBase<"mcp_server_failed"> & {
  server: McpServerProjection;
};

export type SessionEvent =
  | SessionCreatedEvent
  | SessionResumedEvent
  | SessionClosedEvent
  | SessionTitledEvent
  | ConversationMessageAddedEvent
  | LeadAgentStateSavedEvent
  | RuntimeLifecycleRecordedEvent
  | TaskChangedEvent
  | BackgroundStartedEvent
  | BackgroundFinishedEvent
  | SubagentStartedEvent
  | SubagentFinishedEvent
  | ReportWrittenEvent
  | McpServerConnectedEvent
  | McpServerFailedEvent;

export type NewSessionEvent<Event extends SessionEvent = SessionEvent> = Omit<
  Event,
  "id" | "timestamp"
> & {
  id?: string | undefined;
  timestamp?: string | undefined;
};

export function createSessionRecord(options: {
  workspaceRoot: string;
  id?: string | undefined;
  title?: string | undefined;
  now?: string | undefined;
}): SessionRecord {
  const now = options.now ?? timestamp();
  return {
    id: options.id ?? crypto.randomUUID(),
    workspaceRoot: options.workspaceRoot,
    createdAt: now,
    updatedAt: now,
    status: "active",
    title: options.title ?? "Untitled session",
  };
}

export function createConversationMessage(options: {
  sessionId: string;
  role: ConversationRole;
  content: string;
  source: ConversationMessage["source"];
  id?: string | undefined;
  now?: string | undefined;
}): ConversationMessage {
  return {
    id: options.id ?? crypto.randomUUID(),
    sessionId: options.sessionId,
    role: options.role,
    content: options.content,
    createdAt: options.now ?? timestamp(),
    source: options.source,
  };
}

export function createSessionEvent<Event extends SessionEvent>(
  event: NewSessionEvent<Event>,
): Event {
  return {
    ...event,
    id: event.id ?? crypto.randomUUID(),
    timestamp: event.timestamp ?? timestamp(),
  } as Event;
}

function timestamp(): string {
  return new Date().toISOString();
}
