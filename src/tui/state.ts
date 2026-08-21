import { createEmptySessionSnapshot } from "../core/session/projection/projection.js";
import type {
  ConversationRole,
  ConversationMessage,
  SessionSnapshot,
  ToolCallProjection,
  SubagentProjection,
  BackgroundCommandProjection,
} from "../core/session/types.js";
import type { SessionViewEvent } from "../core/session/viewEvents.js";
import type { ToolSource } from "../core/tools/types.js";

export type LogItemKind =
  | "message"
  | "tool"
  | "subagent"
  | "background"
  | "permission"
  | "compact"
  | "report"
  | "mcp"
  | "session"
  | "info";

export type LogItem = {
  id: string;
  kind: LogItemKind;
  title: string;
  role?: ConversationRole | undefined;
  status?: string | undefined;
  summary?: string | undefined;
  detail?: string | undefined;
  source?: string | undefined;
  durationMs?: number | undefined;
  timestamp?: string | undefined;
};

export type TuiState = {
  snapshot: SessionSnapshot;
  log: LogItem[];
  model?: string | undefined;
};

export type CreateTuiStateOptions = { model?: string | undefined };

export function createTuiState(
  snapshot: SessionSnapshot = createEmptySessionSnapshot(),
  options: CreateTuiStateOptions = {},
): TuiState {
  const state: TuiState = { snapshot, log: logFromSnapshot(snapshot) };
  if (options.model !== undefined) state.model = options.model;
  return state;
}

export function applyTuiEvent(
  state: TuiState,
  event: SessionViewEvent,
  snapshot: SessionSnapshot,
): TuiState {
  const item = logItemFromEvent(event);
  return {
    ...state,
    snapshot,
    log: item ? [...state.log, item] : state.log,
  };
}

export function appendInfoLog(
  state: TuiState,
  line: { id: string; title: string; detail?: string | undefined },
): TuiState {
  const item: LogItem = { id: line.id, kind: "info", title: line.title };
  if (line.detail !== undefined) item.detail = line.detail;
  return { ...state, log: [...state.log, item] };
}

export function selectRunningTools(s: SessionSnapshot): ToolCallProjection[] {
  return s.toolCalls.filter((t) => t.status === "running");
}
export function selectRunningSubagents(s: SessionSnapshot): SubagentProjection[] {
  return s.subagents.filter((x) => x.status === "running");
}
export function selectRunningBackground(s: SessionSnapshot): BackgroundCommandProjection[] {
  return s.backgroundCommands.filter((c) => c.status === "running");
}

export function logFromSnapshot(snapshot: SessionSnapshot): LogItem[] {
  const items: LogItem[] = [];
  for (const m of snapshot.conversationMessages) items.push(messageItem(m));
  for (const t of snapshot.toolCalls) if (t.status !== "running") items.push(toolItem(t));
  for (const s of snapshot.subagents) if (s.status !== "running") items.push(subagentItem(s));
  for (const b of snapshot.backgroundCommands)
    if (b.status !== "running") items.push(backgroundItem(b));
  for (const d of snapshot.permissionDecisions) {
    const it: LogItem = {
      id: `permission:${d.id}`,
      kind: "permission",
      title: d.toolName,
      status: d.allowed ? "allowed" : "denied",
      timestamp: d.decidedAt,
    };
    if (d.reason !== undefined) it.detail = d.reason;
    items.push(it);
  }
  for (const r of snapshot.reports) {
    items.push({
      id: `report:${r.id}`,
      kind: "report",
      title: r.title,
      status: "written",
      detail: r.path,
      timestamp: r.createdAt,
    });
  }
  for (const sv of snapshot.mcpServers) {
    items.push({
      id: `mcp:${sv.name}:${sv.status}`,
      kind: "mcp",
      title: sv.name,
      status: sv.status,
      detail: sv.reason ?? `${sv.toolCount ?? 0} tools`,
      timestamp: sv.updatedAt,
    });
  }
  return items.sort(byTimestamp);
}

function logItemFromEvent(event: SessionViewEvent): LogItem | null {
  switch (event.type) {
    case "user_message_added":
    case "assistant_message_added":
    case "system_message_added":
      return messageItem(event.message);
    case "tool_finished":
      return toolItem(event.toolCall);
    case "subagent_finished":
      return subagentItem(event.subagent);
    case "background_finished":
      return backgroundItem(event.command);
    case "permission_resolved": {
      const it: LogItem = {
        id: `permission:${event.decision.id}`,
        kind: "permission",
        title: event.decision.toolName,
        status: event.decision.allowed ? "allowed" : "denied",
        timestamp: event.timestamp,
      };
      if (event.decision.reason !== undefined) it.detail = event.decision.reason;
      return it;
    }
    case "compact_finished": {
      const it: LogItem = {
        id: `compact:${event.compact.id}`,
        kind: "compact",
        title: "compact",
        status: event.compact.status ?? "finished",
        timestamp: event.timestamp,
      };
      if (event.compact.error !== undefined) it.detail = event.compact.error;
      else if (event.compact.transcriptPath !== undefined) it.detail = event.compact.transcriptPath;
      return it;
    }
    case "report_written":
      return {
        id: `report:${event.report.id}`,
        kind: "report",
        title: event.report.title,
        status: "written",
        detail: event.report.path,
        timestamp: event.timestamp,
      };
    case "mcp_server_connected":
    case "mcp_server_failed":
      return {
        id: `mcp:${event.server.name}:${event.server.status}`,
        kind: "mcp",
        title: event.server.name,
        status: event.server.status,
        detail: event.server.reason ?? `${event.server.toolCount ?? 0} tools`,
        timestamp: event.timestamp,
      };
    case "session_started":
      return {
        id: `session:${event.id}`,
        kind: "session",
        title: "session",
        status: event.mode,
        detail: event.session.title,
        timestamp: event.timestamp,
      };
    case "session_finished":
      return {
        id: `session:${event.id}`,
        kind: "session",
        title: "session",
        status: "finished",
        detail: event.session.id,
        timestamp: event.timestamp,
      };
    // live-only (rendered in footer from snapshot), never logged:
    case "tool_started":
    case "subagent_started":
    case "background_started":
    case "permission_requested":
    case "task_changed":
    case "compact_started":
    case "session_titled":
      return null;
  }
}

function messageItem(m: ConversationMessage): LogItem {
  return {
    id: `msg:${m.id}`,
    kind: "message",
    role: m.role,
    title: m.content,
    timestamp: m.createdAt,
  };
}

function toolItem(t: ToolCallProjection): LogItem {
  const it: LogItem = { id: `tool:${t.id}`, kind: "tool", title: t.toolName, status: t.status };
  const ts = t.finishedAt ?? t.startedAt;
  if (ts !== undefined) it.timestamp = ts;
  if (t.inputSummary !== undefined) it.summary = t.inputSummary;
  if (t.error !== undefined) it.detail = t.error;
  else if (t.resultSummary !== undefined) it.detail = t.resultSummary;
  if (t.durationMs !== undefined) it.durationMs = t.durationMs;
  const src = formatToolSource(t.source);
  if (src !== undefined) it.source = src;
  return it;
}

function subagentItem(s: SubagentProjection): LogItem {
  const it: LogItem = {
    id: `subagent:${s.id}`,
    kind: "subagent",
    title: s.promptSummary,
    status: s.status,
  };
  const ts = s.finishedAt ?? s.startedAt;
  if (ts !== undefined) it.timestamp = ts;
  const detail = joinDetail([
    s.resultSummary,
    s.messageCount !== undefined ? `${s.messageCount} messages` : undefined,
  ]);
  if (detail !== undefined) it.detail = detail;
  return it;
}

function backgroundItem(b: BackgroundCommandProjection): LogItem {
  const it: LogItem = {
    id: `background:${b.id}`,
    kind: "background",
    title: b.commandSummary,
    status: b.status,
  };
  const ts = b.finishedAt ?? b.startedAt;
  if (ts !== undefined) it.timestamp = ts;
  if (b.resultSummary !== undefined) it.detail = b.resultSummary;
  return it;
}

function byTimestamp(a: LogItem, b: LogItem): number {
  return (a.timestamp ?? "").localeCompare(b.timestamp ?? "");
}

function joinDetail(parts: Array<string | undefined>): string | undefined {
  const detail = parts.filter((p): p is string => p !== undefined && p !== "");
  return detail.length > 0 ? detail.join(" | ") : undefined;
}

function formatToolSource(source: ToolSource | undefined): string | undefined {
  if (source === undefined) return undefined;
  if (source.type === "builtin") return "builtin";
  return `mcp:${source.serverName}`;
}
