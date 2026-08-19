import type Anthropic from "@anthropic-ai/sdk";
import {
  summarizeLifecycleText,
  summarizeLifecycleValue,
  summarizeToolInput,
  summarizeToolResult,
} from "../agent/lifecycleSummary.js";
import type { RuntimeLifecycleEvent } from "../agent/lifecycle.js";
import type { TaskRecord } from "../tools/task/taskManager.js";
import type { BackgroundCommandRecord } from "../tools/background/backgroundManager.js";
import type { SubagentRecord } from "../tools/subagent/subagentRunner.js";
import type { ProviderDiagnostic } from "../tools/types.js";
import {
  createSessionEvent,
  type ConversationMessage,
  type ConversationMessageAddedEvent,
  type LeadAgentMessageProjection,
  type LeadAgentStateSavedEvent,
  type McpServerConnectedEvent,
  type McpServerFailedEvent,
  type ReportProjection,
  type ReportWrittenEvent,
  type RuntimeLifecycleRecordedEvent,
  type SessionEvent,
  type SessionTitledEvent,
  type SubagentFinishedEvent,
  type SubagentProjection,
  type SubagentStartedEvent,
  type TaskChangedEvent,
  type BackgroundStartedEvent,
  type BackgroundFinishedEvent,
} from "./types.js";

export function taskChangedEvent(sessionId: string, task: TaskRecord): TaskChangedEvent {
  const now = new Date().toISOString();
  return createSessionEvent<TaskChangedEvent>({
    type: "task_changed",
    sessionId,
    timestamp: now,
    task: {
      id: String(task.id),
      sessionId,
      title: task.subject,
      status: task.status,
      updatedAt: now,
    },
  });
}

export function backgroundStartedEvent(
  sessionId: string,
  record: BackgroundCommandRecord,
): BackgroundStartedEvent {
  return createSessionEvent<BackgroundStartedEvent>({
    type: "background_started",
    sessionId,
    timestamp: record.startedAt,
    command: {
      id: record.id,
      sessionId,
      status: "running",
      commandSummary: record.commandSummary,
      startedAt: record.startedAt,
    },
  });
}

export function backgroundFinishedEvent(
  sessionId: string,
  record: BackgroundCommandRecord,
): BackgroundFinishedEvent {
  const command: BackgroundFinishedEvent["command"] = {
    id: record.id,
    sessionId,
    status: record.status,
    commandSummary: record.commandSummary,
    startedAt: record.startedAt,
  };
  if (record.resultSummary !== undefined) {
    command.resultSummary = record.resultSummary;
  }
  if (record.finishedAt !== undefined) {
    command.finishedAt = record.finishedAt;
  }
  return createSessionEvent<BackgroundFinishedEvent>({
    type: "background_finished",
    sessionId,
    timestamp: record.finishedAt,
    command,
  });
}

export function subagentProjection(sessionId: string, record: SubagentRecord): SubagentProjection {
  const subagent: SubagentProjection = {
    id: record.id,
    sessionId,
    status: record.status,
    promptSummary: record.promptSummary,
  };
  if (record.resultSummary !== undefined) {
    subagent.resultSummary = record.resultSummary;
  }
  if (record.taskId !== undefined) subagent.taskId = record.taskId;
  if (record.runId !== undefined) subagent.runId = record.runId;
  if (record.parentRunId !== undefined) {
    subagent.parentRunId = record.parentRunId;
  }
  if (record.parentToolCallId !== undefined) {
    subagent.parentToolCallId = record.parentToolCallId;
  }
  if (record.messageCount !== undefined) subagent.messageCount = record.messageCount;
  if (record.startedAt !== undefined) subagent.startedAt = record.startedAt;
  if (record.finishedAt !== undefined) subagent.finishedAt = record.finishedAt;
  return subagent;
}

export function subagentStartedEvent(
  sessionId: string,
  record: SubagentRecord,
): SubagentStartedEvent {
  return createSessionEvent<SubagentStartedEvent>({
    type: "subagent_started",
    sessionId,
    timestamp: record.startedAt,
    subagent: subagentProjection(sessionId, record),
  });
}

export function subagentFinishedEvent(
  sessionId: string,
  record: SubagentRecord,
): SubagentFinishedEvent {
  return createSessionEvent<SubagentFinishedEvent>({
    type: "subagent_finished",
    sessionId,
    timestamp: record.finishedAt,
    subagent: subagentProjection(sessionId, record),
  });
}

export function mcpServerEvents(
  sessionId: string,
  diagnostics: readonly ProviderDiagnostic[],
  now: string,
): SessionEvent[] {
  const events: SessionEvent[] = [];
  for (const diagnostic of diagnostics) {
    if (diagnostic.sourceType !== "mcp") continue;
    if (diagnostic.status === "available") {
      events.push(
        createSessionEvent<McpServerConnectedEvent>({
          type: "mcp_server_connected",
          sessionId,
          timestamp: now,
          server: {
            name: diagnostic.providerName,
            status: "connected",
            ...(diagnostic.toolCount !== undefined ? { toolCount: diagnostic.toolCount } : {}),
            updatedAt: now,
          },
        }),
      );
    } else if (diagnostic.status === "unavailable") {
      events.push(
        createSessionEvent<McpServerFailedEvent>({
          type: "mcp_server_failed",
          sessionId,
          timestamp: now,
          server: {
            name: diagnostic.providerName,
            status: "failed",
            reason: summarizeLifecycleText(diagnostic.reason),
            updatedAt: now,
          },
        }),
      );
    }
  }
  return events;
}

export function conversationMessageEvent(
  message: ConversationMessage,
): ConversationMessageAddedEvent {
  return createSessionEvent<ConversationMessageAddedEvent>({
    type: "conversation_message_added",
    sessionId: message.sessionId,
    timestamp: message.createdAt,
    message,
  });
}

export function runtimeLifecycleRecordedEvent(
  sessionId: string,
  runtimeEvent: RuntimeLifecycleEvent,
): RuntimeLifecycleRecordedEvent {
  return createSessionEvent<RuntimeLifecycleRecordedEvent>({
    type: "runtime_lifecycle_recorded",
    sessionId,
    timestamp: runtimeEvent.timestamp,
    runtimeEvent,
  });
}

export function sessionTitledEvent(sessionId: string, title: string): SessionTitledEvent {
  return createSessionEvent<SessionTitledEvent>({
    type: "session_titled",
    sessionId,
    title,
  });
}

export function reportWrittenEvent(
  sessionId: string,
  report: ReportProjection,
): ReportWrittenEvent {
  return createSessionEvent<ReportWrittenEvent>({
    type: "report_written",
    sessionId,
    timestamp: report.createdAt,
    report,
  });
}

export function leadAgentStateSavedEvent(
  sessionId: string,
  leadMessages: readonly Anthropic.Messages.MessageParam[],
  updatedAt: string,
): LeadAgentStateSavedEvent {
  return createSessionEvent<LeadAgentStateSavedEvent>({
    type: "lead_agent_state_saved",
    sessionId,
    state: {
      sessionId,
      messages: leadMessages.map(summarizeLeadAgentMessage),
      messageCount: leadMessages.length,
      updatedAt,
    },
  });
}

function summarizeLeadAgentMessage(
  message: Anthropic.Messages.MessageParam,
): LeadAgentMessageProjection {
  return {
    role: message.role,
    contentSummary: summarizeLeadAgentContent(message.content),
  };
}

function summarizeLeadAgentContent(content: Anthropic.Messages.MessageParam["content"]): string {
  if (typeof content === "string") return summarizeLifecycleText(content);
  return summarizeLifecycleValue(content.map(summarizeLeadAgentContentBlock));
}

function summarizeLeadAgentContentBlock(block: unknown): unknown {
  if (typeof block !== "object" || block === null) {
    return summarizeLifecycleValue(block);
  }
  const record = block as Record<string, unknown>;
  if (record.type === "tool_use") return summarizeToolUseBlock(record);
  if (record.type === "tool_result") return summarizeToolResultBlock(record);
  return summarizeLifecycleValue(block);
}

function summarizeToolUseBlock(record: Record<string, unknown>): Record<string, unknown> {
  const toolName = typeof record.name === "string" ? record.name : "unknown";
  return {
    type: "tool_use",
    name: toolName,
    inputSummary: summarizeToolInput(toolName, record.input),
  };
}

function summarizeToolResultBlock(record: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = {
    type: "tool_result",
    resultSummary: summarizeToolResult(stringifyToolResultContent(record.content)),
  };
  if (typeof record.tool_use_id === "string") {
    result.tool_use_id = record.tool_use_id;
  }
  if (typeof record.is_error === "boolean") result.is_error = record.is_error;
  return result;
}

function stringifyToolResultContent(content: unknown): string {
  if (typeof content === "string") return content;
  try {
    return JSON.stringify(content);
  } catch {
    return String(content);
  }
}
