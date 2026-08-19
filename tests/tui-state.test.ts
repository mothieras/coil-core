import test from "node:test";
import assert from "node:assert/strict";
import {
  createTuiState,
  applyTuiEvent,
  logFromSnapshot,
  selectRunningTools,
  appendInfoLog,
  selectRunningSubagents,
  selectRunningBackground,
} from "../src/tui/state.js";
import type { SessionSnapshot } from "../src/core/session/types.js";
import type { SessionViewEvent } from "../src/core/session/viewEvents.js";

function emptySnapshot(): SessionSnapshot {
  return {
    session: {
      id: "s1",
      workspaceRoot: "/repo",
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
      status: "active",
      title: "Demo",
    },
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

test("logFromSnapshot seeds messages + finished tool calls in time order", () => {
  const snap = emptySnapshot();
  snap.conversationMessages = [
    {
      id: "m1",
      sessionId: "s1",
      role: "user",
      content: "hi",
      createdAt: "2026-01-01T00:00:01.000Z",
      source: "user_input",
    },
  ];
  snap.toolCalls = [
    {
      id: "t1",
      sessionId: "s1",
      runId: "r1",
      agentId: "lead",
      agentKind: "lead",
      toolName: "read_file",
      status: "completed",
      finishedAt: "2026-01-01T00:00:02.000Z",
      resultSummary: "ok",
    },
  ];
  const log = logFromSnapshot(snap);
  assert.deepEqual(
    log.map((l) => l.kind),
    ["message", "tool"],
  );
  assert.equal(log[0]?.title, "hi");
  assert.equal(log[1]?.title, "read_file");
});

test("applyTuiEvent appends assistant message and a finished tool, ignores running tool", () => {
  let state = createTuiState(emptySnapshot(), { model: "m" });
  const asst: SessionViewEvent = {
    id: "e1",
    type: "assistant_message_added",
    sessionId: "s1",
    timestamp: "2026-01-01T00:00:03.000Z",
    sourceEventId: "se1",
    message: {
      id: "m2",
      sessionId: "s1",
      role: "assistant",
      content: "done",
      createdAt: "2026-01-01T00:00:03.000Z",
      source: "agent_result",
    },
  };
  state = applyTuiEvent(state, asst, emptySnapshot());
  assert.equal(state.log.at(-1)?.kind, "message");
  assert.equal(state.log.at(-1)?.role, "assistant");

  const before = state.log.length;
  const running: SessionViewEvent = {
    id: "e2",
    type: "tool_started",
    sessionId: "s1",
    timestamp: "2026-01-01T00:00:04.000Z",
    sourceEventId: "se2",
    toolCall: {
      id: "t2",
      sessionId: "s1",
      runId: "r1",
      agentId: "lead",
      agentKind: "lead",
      toolName: "bash",
      status: "running",
      startedAt: "2026-01-01T00:00:04.000Z",
    },
  };
  state = applyTuiEvent(state, running, emptySnapshot());
  assert.equal(state.log.length, before, "running tool must NOT append to log");
});

test("selectRunningTools filters snapshot by running status", () => {
  const snap = emptySnapshot();
  snap.toolCalls = [
    {
      id: "t1",
      sessionId: "s1",
      runId: "r1",
      agentId: "lead",
      agentKind: "lead",
      toolName: "a",
      status: "running",
    },
    {
      id: "t2",
      sessionId: "s1",
      runId: "r1",
      agentId: "lead",
      agentKind: "lead",
      toolName: "b",
      status: "completed",
    },
  ];
  assert.deepEqual(
    selectRunningTools(snap).map((t) => t.toolName),
    ["a"],
  );
});

test("log item ids are unique across message + finished tool", () => {
  const snap = emptySnapshot();
  snap.conversationMessages = [
    {
      id: "x",
      sessionId: "s1",
      role: "user",
      content: "a",
      createdAt: "2026-01-01T00:00:01.000Z",
      source: "user_input",
    },
  ];
  snap.toolCalls = [
    {
      id: "x",
      sessionId: "s1",
      runId: "r1",
      agentId: "lead",
      agentKind: "lead",
      toolName: "b",
      status: "completed",
      finishedAt: "2026-01-01T00:00:02.000Z",
    },
  ];
  const ids = logFromSnapshot(snap).map((l) => l.id);
  assert.equal(new Set(ids).size, ids.length, "ids must be unique even when source ids collide");
});

test("appendInfoLog appends an info log item", () => {
  const state = createTuiState(emptySnapshot());
  const next = appendInfoLog(state, { id: "i1", title: "Status", detail: "all good" });
  assert.equal(next.log.at(-1)?.kind, "info");
  assert.equal(next.log.at(-1)?.title, "Status");
  assert.equal(next.log.at(-1)?.detail, "all good");
});

test("mcp log id matches between snapshot seed and live event", () => {
  const snap = emptySnapshot();
  snap.mcpServers = [
    { name: "demo", status: "connected", toolCount: 1, updatedAt: "2026-01-01T00:00:05.000Z" },
  ];
  const seededId = logFromSnapshot(snap).find((l) => l.kind === "mcp")?.id;
  const event: SessionViewEvent = {
    id: "evt-mcp",
    type: "mcp_server_connected",
    sessionId: "s1",
    timestamp: "2026-01-01T00:00:06.000Z",
    sourceEventId: "se-mcp",
    server: {
      name: "demo",
      status: "connected",
      toolCount: 1,
      updatedAt: "2026-01-01T00:00:06.000Z",
    },
  };
  const liveId = applyTuiEvent(createTuiState(emptySnapshot()), event, emptySnapshot()).log.at(
    -1,
  )?.id;
  assert.equal(liveId, seededId);
});

test("selectRunningSubagents and selectRunningBackground filter by running status", () => {
  const snap = emptySnapshot();
  snap.subagents = [
    { id: "s1", sessionId: "s1", status: "running", promptSummary: "a" },
    { id: "s2", sessionId: "s1", status: "completed", promptSummary: "b" },
  ];
  snap.backgroundCommands = [
    { id: "b1", sessionId: "s1", status: "running", commandSummary: "x" },
    { id: "b2", sessionId: "s1", status: "completed", commandSummary: "y" },
  ];
  assert.deepEqual(
    selectRunningSubagents(snap).map((s) => s.id),
    ["s1"],
  );
  assert.deepEqual(
    selectRunningBackground(snap).map((b) => b.id),
    ["b1"],
  );
});
