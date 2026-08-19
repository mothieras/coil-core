import type {
  AgentRunProjection,
  McpServerProjection,
  PermissionDecisionProjection,
  SessionEvent,
  SessionSnapshot,
  ToolCallProjection,
} from "../types.js";

export function createEmptySessionSnapshot(): SessionSnapshot {
  return {
    session: null,
    conversationMessages: [],
    leadAgentMessages: [],
    agentRuns: [],
    toolCalls: [],
    permissionDecisions: [],
    backgroundCommands: [],
    subagents: [],
    tasks: [],
    reports: [],
    mcpServers: [],
    usage: { inputTokens: 0, outputTokens: 0, apiCalls: 0, lastInputTokens: 0 },
  };
}

export function applySessionEvent(snapshot: SessionSnapshot, event: SessionEvent): SessionSnapshot {
  switch (event.type) {
    case "session_created":
      return {
        ...snapshot,
        session: event.session,
      };
    case "session_resumed":
      return {
        ...snapshot,
        session: resumeSession(snapshot, event.timestamp),
      };
    case "session_closed":
      return {
        ...snapshot,
        session: closeSession(snapshot, event.timestamp),
      };
    case "session_titled":
      return snapshot.session
        ? {
            ...snapshot,
            session: {
              ...snapshot.session,
              title: event.title,
              updatedAt: event.timestamp,
            },
          }
        : snapshot;
    case "conversation_message_added":
      return {
        ...snapshot,
        conversationMessages: [...snapshot.conversationMessages, event.message],
        session: touchSession(snapshot, event.timestamp),
      };
    case "lead_agent_state_saved":
      return {
        ...snapshot,
        leadAgentMessages: event.state.messages,
        session: touchSession(snapshot, event.timestamp),
      };
    case "runtime_lifecycle_recorded":
      return applyRuntimeLifecycleEvent(snapshot, event);
    case "task_changed":
      return {
        ...snapshot,
        tasks: upsertProjection(snapshot.tasks, event.task),
        session: touchSession(snapshot, event.timestamp),
      };
    case "background_started":
    case "background_finished":
      return {
        ...snapshot,
        backgroundCommands: upsertProjection(snapshot.backgroundCommands, event.command),
        session: touchSession(snapshot, event.timestamp),
      };
    case "subagent_started":
    case "subagent_finished":
      return {
        ...snapshot,
        subagents: upsertProjection(snapshot.subagents, event.subagent),
        session: touchSession(snapshot, event.timestamp),
      };
    case "report_written":
      return {
        ...snapshot,
        reports: upsertProjection(snapshot.reports, event.report),
        session: touchSession(snapshot, event.timestamp),
      };
    case "mcp_server_connected":
    case "mcp_server_failed":
      return {
        ...snapshot,
        mcpServers: upsertMcpServer(snapshot.mcpServers, event.server),
        session: touchSession(snapshot, event.timestamp),
      };
  }
}

export function applySessionEvents(
  snapshot: SessionSnapshot,
  events: readonly SessionEvent[],
): SessionSnapshot {
  let next = snapshot;
  for (const event of events) next = applySessionEvent(next, event);
  return next;
}

function applyRuntimeLifecycleEvent(
  snapshot: SessionSnapshot,
  event: Extract<SessionEvent, { type: "runtime_lifecycle_recorded" }>,
): SessionSnapshot {
  const runtimeEvent = event.runtimeEvent;
  switch (runtimeEvent.type) {
    case "agent_run_started":
      return {
        ...snapshot,
        agentRuns: upsertAgentRun(snapshot.agentRuns, {
          id: runtimeEvent.runId,
          sessionId: event.sessionId,
          agentId: runtimeEvent.agentId,
          agentKind: runtimeEvent.agentKind,
          trigger: runtimeEvent.trigger,
          status: "running",
          startedAt: runtimeEvent.timestamp,
        }),
        session: touchSession(snapshot, event.timestamp),
      };
    case "agent_run_finished": {
      const existing = snapshot.agentRuns.find((run) => run.id === runtimeEvent.runId);
      if (!existing) return snapshot;
      if (existing.status === "interrupted") return snapshot;
      const updated: AgentRunProjection = {
        ...existing,
        status: runtimeEvent.status,
        finishedAt: runtimeEvent.timestamp,
      };
      if (runtimeEvent.stopReason !== undefined) {
        updated.stopReason = runtimeEvent.stopReason;
      }
      if (runtimeEvent.resultSummary !== undefined) {
        updated.resultSummary = runtimeEvent.resultSummary;
      }
      if (runtimeEvent.error !== undefined) updated.error = runtimeEvent.error;
      if (runtimeEvent.messageCount !== undefined) {
        updated.messageCount = runtimeEvent.messageCount;
      }
      if (runtimeEvent.toolCallCount !== undefined) {
        updated.toolCallCount = runtimeEvent.toolCallCount;
      }
      return {
        ...snapshot,
        agentRuns: upsertAgentRun(snapshot.agentRuns, updated),
        session: touchSession(snapshot, event.timestamp),
      };
    }
    case "tool_started": {
      const toolCall: ToolCallProjection = {
        id: runtimeEvent.toolCallId,
        sessionId: event.sessionId,
        runId: runtimeEvent.runId,
        agentId: runtimeEvent.agentId,
        agentKind: runtimeEvent.agentKind,
        toolName: runtimeEvent.toolName,
        status: "running",
        startedAt: runtimeEvent.timestamp,
      };
      if (runtimeEvent.source !== undefined) toolCall.source = runtimeEvent.source;
      if (runtimeEvent.inputSummary !== undefined) {
        toolCall.inputSummary = runtimeEvent.inputSummary;
      }
      return {
        ...snapshot,
        toolCalls: upsertToolCall(snapshot.toolCalls, toolCall),
        session: touchSession(snapshot, event.timestamp),
      };
    }
    case "tool_finished": {
      const existing = snapshot.toolCalls.find((call) => call.id === runtimeEvent.toolCallId);
      const updated: ToolCallProjection = existing
        ? { ...existing }
        : {
            id: runtimeEvent.toolCallId,
            sessionId: event.sessionId,
            runId: runtimeEvent.runId,
            agentId: runtimeEvent.agentId,
            agentKind: runtimeEvent.agentKind,
            toolName: runtimeEvent.toolName,
            status: runtimeEvent.status,
          };
      updated.status = runtimeEvent.status;
      updated.finishedAt = runtimeEvent.timestamp;
      if (runtimeEvent.source !== undefined) updated.source = runtimeEvent.source;
      if (runtimeEvent.resultSummary !== undefined) {
        updated.resultSummary = runtimeEvent.resultSummary;
      }
      if (runtimeEvent.error !== undefined) updated.error = runtimeEvent.error;
      if (runtimeEvent.durationMs !== undefined) {
        updated.durationMs = runtimeEvent.durationMs;
      }
      return {
        ...snapshot,
        toolCalls: upsertToolCall(snapshot.toolCalls, updated),
        session: touchSession(snapshot, event.timestamp),
      };
    }
    case "assistant_message_added": {
      if (!runtimeEvent.usage) {
        return {
          ...snapshot,
          session: touchSession(snapshot, event.timestamp),
        };
      }
      return {
        ...snapshot,
        usage: {
          inputTokens: snapshot.usage.inputTokens + runtimeEvent.usage.inputTokens,
          outputTokens: snapshot.usage.outputTokens + runtimeEvent.usage.outputTokens,
          apiCalls: snapshot.usage.apiCalls + 1,
          lastInputTokens: runtimeEvent.usage.inputTokens,
        },
        session: touchSession(snapshot, event.timestamp),
      };
    }
    case "permission_resolved": {
      const decision: PermissionDecisionProjection = {
        id: runtimeEvent.permissionId,
        sessionId: event.sessionId,
        runId: runtimeEvent.runId,
        toolCallId: runtimeEvent.toolCallId,
        toolName: runtimeEvent.toolName,
        allowed: runtimeEvent.allowed,
        decidedAt: runtimeEvent.timestamp,
      };
      if (runtimeEvent.reason !== undefined) decision.reason = runtimeEvent.reason;
      return {
        ...snapshot,
        permissionDecisions: upsertProjection(snapshot.permissionDecisions, decision),
        session: touchSession(snapshot, event.timestamp),
      };
    }
    default:
      return {
        ...snapshot,
        session: touchSession(snapshot, event.timestamp),
      };
  }
}

function upsertAgentRun(
  runs: readonly AgentRunProjection[],
  run: AgentRunProjection,
): AgentRunProjection[] {
  const index = runs.findIndex((item) => item.id === run.id);
  if (index === -1) return [...runs, run];
  return runs.map((item, idx) => (idx === index ? run : item));
}

function upsertToolCall(
  calls: readonly ToolCallProjection[],
  call: ToolCallProjection,
): ToolCallProjection[] {
  const index = calls.findIndex((item) => item.id === call.id);
  if (index === -1) return [...calls, call];
  return calls.map((item, idx) => (idx === index ? call : item));
}

function upsertProjection<Projection extends { id: string }>(
  items: readonly Projection[],
  item: Projection,
): Projection[] {
  const index = items.findIndex((existing) => existing.id === item.id);
  if (index === -1) return [...items, item];
  return items.map((existing, idx) => (idx === index ? item : existing));
}

function upsertMcpServer(
  servers: readonly McpServerProjection[],
  server: McpServerProjection,
): McpServerProjection[] {
  const index = servers.findIndex((item) => item.name === server.name);
  if (index === -1) return [...servers, server];
  return servers.map((item, idx) => (idx === index ? server : item));
}

function touchSession(snapshot: SessionSnapshot, updatedAt: string): SessionSnapshot["session"] {
  if (!snapshot.session) return null;
  return { ...snapshot.session, updatedAt };
}

function resumeSession(snapshot: SessionSnapshot, updatedAt: string): SessionSnapshot["session"] {
  if (!snapshot.session) return null;
  return { ...snapshot.session, status: "active", updatedAt };
}

function closeSession(snapshot: SessionSnapshot, updatedAt: string): SessionSnapshot["session"] {
  if (!snapshot.session) return null;
  return { ...snapshot.session, status: "closed", updatedAt };
}
