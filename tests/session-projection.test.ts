import test from "node:test";
import assert from "node:assert/strict";
import {
  createRuntimeLifecycleEvent,
  type AgentRunFinishedEvent,
  type AgentRunStartedEvent,
  type AssistantMessageAddedEvent,
  type PermissionResolvedEvent,
  type ToolFinishedEvent,
  type ToolStartedEvent,
} from "../src/core/agent/lifecycle.js";
import {
  applySessionEvent,
  applySessionEvents,
  createEmptySessionSnapshot,
} from "../src/core/session/projection/projection.js";
import {
  createConversationMessage,
  createSessionEvent,
  createSessionRecord,
  type BackgroundFinishedEvent,
  type BackgroundStartedEvent,
  type ConversationMessageAddedEvent,
  type ReportWrittenEvent,
  type RuntimeLifecycleRecordedEvent,
  type SessionClosedEvent,
  type SessionCreatedEvent,
  type SessionResumedEvent,
  type SubagentFinishedEvent,
  type SubagentStartedEvent,
  type TaskChangedEvent,
} from "../src/core/session/types.js";

test("session_created initializes the snapshot session", () => {
  const snapshot = createEmptySessionSnapshot();
  const session = createSessionRecord({
    id: "session_1",
    workspaceRoot: "/tmp/workspace",
    now: "2026-01-01T00:00:00.000Z",
  });

  const next = applySessionEvent(
    snapshot,
    createSessionEvent<SessionCreatedEvent>({
      type: "session_created",
      sessionId: session.id,
      timestamp: session.createdAt,
      session,
    }),
  );

  assert.deepEqual(next.session, session);
  assert.deepEqual(snapshot.session, null);
});

test("conversation_message_added appends visible conversation", () => {
  const session = createSessionRecord({
    id: "session_1",
    workspaceRoot: "/tmp/workspace",
  });
  const message = createConversationMessage({
    id: "message_1",
    sessionId: session.id,
    role: "user",
    content: "hello",
    source: "user_input",
    now: "2026-01-01T00:00:01.000Z",
  });
  let snapshot = createEmptySessionSnapshot();
  snapshot = applySessionEvent(
    snapshot,
    createSessionEvent<SessionCreatedEvent>({
      type: "session_created",
      sessionId: session.id,
      session,
    }),
  );

  const next = applySessionEvent(
    snapshot,
    createSessionEvent<ConversationMessageAddedEvent>({
      type: "conversation_message_added",
      sessionId: session.id,
      timestamp: message.createdAt,
      message,
    }),
  );

  assert.deepEqual(next.conversationMessages, [message]);
  assert.equal(next.session?.updatedAt, "2026-01-01T00:00:01.000Z");
});

test("runtime lifecycle events update agent run and tool call projections", () => {
  let snapshot = createEmptySessionSnapshot();
  const sessionId = "session_1";
  const runStarted = createRuntimeLifecycleEvent<AgentRunStartedEvent>({
    id: "runtime_1",
    timestamp: "2026-01-01T00:00:01.000Z",
    type: "agent_run_started",
    runId: "run_1",
    sessionId,
    agentId: "lead",
    agentKind: "lead",
    trigger: { type: "user_message", messageId: "message_1" },
  });
  const runFinished = createRuntimeLifecycleEvent<AgentRunFinishedEvent>({
    id: "runtime_2",
    timestamp: "2026-01-01T00:00:04.000Z",
    type: "agent_run_finished",
    runId: "run_1",
    sessionId,
    agentId: "lead",
    agentKind: "lead",
    status: "completed",
    stopReason: "end_turn",
    resultSummary: "done",
    messageCount: 2,
  });
  const toolStarted = createRuntimeLifecycleEvent<ToolStartedEvent>({
    id: "runtime_3",
    timestamp: "2026-01-01T00:00:02.000Z",
    type: "tool_started",
    runId: "run_1",
    sessionId,
    agentId: "lead",
    agentKind: "lead",
    toolCallId: "toolu_1",
    toolName: "read_file",
    source: { type: "builtin" },
    inputSummary: "file.txt",
  });
  const toolFinished = createRuntimeLifecycleEvent<ToolFinishedEvent>({
    id: "runtime_4",
    timestamp: "2026-01-01T00:00:03.000Z",
    type: "tool_finished",
    runId: "run_1",
    sessionId,
    agentId: "lead",
    agentKind: "lead",
    toolCallId: "toolu_1",
    toolName: "read_file",
    source: { type: "builtin" },
    status: "completed",
    resultSummary: "output (10 chars, 1 line)",
    durationMs: 12,
  });

  for (const runtimeEvent of [runStarted, toolStarted, toolFinished, runFinished]) {
    snapshot = applySessionEvent(
      snapshot,
      createSessionEvent<RuntimeLifecycleRecordedEvent>({
        type: "runtime_lifecycle_recorded",
        sessionId,
        timestamp: runtimeEvent.timestamp,
        runtimeEvent,
      }),
    );
  }

  assert.equal(snapshot.agentRuns.length, 1);
  assert.equal(snapshot.agentRuns[0]?.id, "run_1");
  assert.equal(snapshot.agentRuns[0]?.status, "completed");
  assert.equal(snapshot.agentRuns[0]?.resultSummary, "done");
  assert.equal(snapshot.toolCalls.length, 1);
  assert.equal(snapshot.toolCalls[0]?.id, "toolu_1");
  assert.equal(snapshot.toolCalls[0]?.status, "completed");
  assert.deepEqual(snapshot.toolCalls[0]?.source, { type: "builtin" });
});

test("assistant_message_added usage accumulates into snapshot totals", () => {
  let snapshot = createEmptySessionSnapshot();
  const sessionId = "session_1";
  const usages = [
    { inputTokens: 7, outputTokens: 3 },
    { inputTokens: 9, outputTokens: 4 },
  ];
  for (const [index, usage] of usages.entries()) {
    const runtimeEvent = createRuntimeLifecycleEvent<AssistantMessageAddedEvent>({
      id: `runtime_usage_${index}`,
      timestamp: `2026-01-01T00:00:0${index + 1}.000Z`,
      type: "assistant_message_added",
      runId: "run_1",
      sessionId,
      agentId: "lead",
      agentKind: "lead",
      messageIndex: index,
      contentSummary: "reply",
      usage,
    });
    snapshot = applySessionEvent(
      snapshot,
      createSessionEvent<RuntimeLifecycleRecordedEvent>({
        type: "runtime_lifecycle_recorded",
        sessionId,
        timestamp: runtimeEvent.timestamp,
        runtimeEvent,
      }),
    );
  }

  assert.deepEqual(snapshot.usage, {
    inputTokens: 16,
    outputTokens: 7,
    apiCalls: 2,
    lastInputTokens: 9,
  });
});

test("usage without the field leaves totals untouched", () => {
  const snapshot = createEmptySessionSnapshot();
  const runtimeEvent = createRuntimeLifecycleEvent<AssistantMessageAddedEvent>({
    id: "runtime_no_usage",
    timestamp: "2026-01-01T00:00:01.000Z",
    type: "assistant_message_added",
    runId: "run_1",
    sessionId: "session_1",
    agentId: "lead",
    agentKind: "lead",
    messageIndex: 0,
    contentSummary: "reply",
  });
  const next = applySessionEvent(
    snapshot,
    createSessionEvent<RuntimeLifecycleRecordedEvent>({
      type: "runtime_lifecycle_recorded",
      sessionId: "session_1",
      timestamp: runtimeEvent.timestamp,
      runtimeEvent,
    }),
  );
  assert.deepEqual(next.usage, {
    inputTokens: 0,
    outputTokens: 0,
    apiCalls: 0,
    lastInputTokens: 0,
  });
});

test("late lifecycle finish does not overwrite an interrupted agent run", () => {
  const sessionId = "session_1";
  const runStarted = createRuntimeLifecycleEvent<AgentRunStartedEvent>({
    id: "runtime_1",
    timestamp: "2026-01-01T00:00:01.000Z",
    type: "agent_run_started",
    runId: "run_1",
    sessionId,
    agentId: "subagent_1",
    agentKind: "subagent",
    trigger: { type: "subagent", parentRunId: "parent_run_1" },
  });
  const runInterrupted = createRuntimeLifecycleEvent<AgentRunFinishedEvent>({
    id: "runtime_2",
    timestamp: "2026-01-01T00:00:02.000Z",
    type: "agent_run_finished",
    runId: "run_1",
    sessionId,
    agentId: "subagent_1",
    agentKind: "subagent",
    status: "interrupted",
    error: "Session closed",
  });
  const lateRunFinished = createRuntimeLifecycleEvent<AgentRunFinishedEvent>({
    id: "runtime_3",
    timestamp: "2026-01-01T00:00:03.000Z",
    type: "agent_run_finished",
    runId: "run_1",
    sessionId,
    agentId: "subagent_1",
    agentKind: "subagent",
    status: "completed",
    stopReason: "end_turn",
    resultSummary: "late completion",
    messageCount: 3,
  });

  const snapshot = applySessionEvents(
    createEmptySessionSnapshot(),
    [runStarted, runInterrupted, lateRunFinished].map((runtimeEvent) =>
      createSessionEvent<RuntimeLifecycleRecordedEvent>({
        type: "runtime_lifecycle_recorded",
        sessionId,
        timestamp: runtimeEvent.timestamp,
        runtimeEvent,
      }),
    ),
  );

  assert.equal(snapshot.agentRuns[0]?.status, "interrupted");
  assert.equal(snapshot.agentRuns[0]?.error, "Session closed");
  assert.equal(snapshot.agentRuns[0]?.finishedAt, "2026-01-01T00:00:02.000Z");
  assert.equal(snapshot.agentRuns[0]?.resultSummary, undefined);
  assert.equal(snapshot.agentRuns[0]?.messageCount, undefined);
});

test("projection records permission decisions from resolved lifecycle events", () => {
  const snapshot = applySessionEvents(createEmptySessionSnapshot(), [
    createSessionEvent<SessionCreatedEvent>({
      type: "session_created",
      sessionId: "s1",
      session: createSessionRecord({
        workspaceRoot: "/tmp/ws",
        id: "s1",
        now: "2026-01-01T00:00:00.000Z",
      }),
      timestamp: "2026-01-01T00:00:00.000Z",
    }),
    createSessionEvent<RuntimeLifecycleRecordedEvent>({
      type: "runtime_lifecycle_recorded",
      sessionId: "s1",
      timestamp: "2026-01-01T00:00:01.000Z",
      runtimeEvent: createRuntimeLifecycleEvent<PermissionResolvedEvent>({
        type: "permission_resolved",
        id: "evt_perm_resolved",
        timestamp: "2026-01-01T00:00:01.000Z",
        runId: "run1",
        sessionId: "s1",
        agentId: "lead",
        agentKind: "lead",
        permissionId: "perm1",
        toolCallId: "tool1",
        toolName: "bash",
        allowed: false,
        reason: "Blocked: dangerous command",
      }),
    }),
  ]);

  assert.deepEqual(snapshot.permissionDecisions, [
    {
      id: "perm1",
      sessionId: "s1",
      runId: "run1",
      toolCallId: "tool1",
      toolName: "bash",
      allowed: false,
      reason: "Blocked: dangerous command",
      decidedAt: "2026-01-01T00:00:01.000Z",
    },
  ]);
});

test("projection records task, background, subagent, report, resume, and close events", () => {
  const snapshot = applySessionEvents(createEmptySessionSnapshot(), [
    createSessionEvent<SessionCreatedEvent>({
      type: "session_created",
      sessionId: "s1",
      session: createSessionRecord({
        workspaceRoot: "/tmp/ws",
        id: "s1",
        now: "2026-01-01T00:00:00.000Z",
      }),
      timestamp: "2026-01-01T00:00:00.000Z",
    }),
    createSessionEvent<TaskChangedEvent>({
      type: "task_changed",
      sessionId: "s1",
      timestamp: "2026-01-01T00:00:01.000Z",
      task: {
        id: "1",
        sessionId: "s1",
        title: "Write tests",
        status: "in_progress",
        updatedAt: "2026-01-01T00:00:01.000Z",
      },
    }),
    createSessionEvent<BackgroundStartedEvent>({
      type: "background_started",
      sessionId: "s1",
      timestamp: "2026-01-01T00:00:02.000Z",
      command: {
        id: "bg1",
        sessionId: "s1",
        status: "running",
        commandSummary: "pnpm test",
        startedAt: "2026-01-01T00:00:02.000Z",
      },
    }),
    createSessionEvent<BackgroundFinishedEvent>({
      type: "background_finished",
      sessionId: "s1",
      timestamp: "2026-01-01T00:00:03.000Z",
      command: {
        id: "bg1",
        sessionId: "s1",
        status: "completed",
        commandSummary: "pnpm test",
        resultSummary: "ok",
        startedAt: "2026-01-01T00:00:02.000Z",
        finishedAt: "2026-01-01T00:00:03.000Z",
      },
    }),
    createSessionEvent<SubagentStartedEvent>({
      type: "subagent_started",
      sessionId: "s1",
      timestamp: "2026-01-01T00:00:04.000Z",
      subagent: {
        id: "sub1",
        sessionId: "s1",
        status: "running",
        promptSummary: "Review",
        startedAt: "2026-01-01T00:00:04.000Z",
      },
    }),
    createSessionEvent<SubagentFinishedEvent>({
      type: "subagent_finished",
      sessionId: "s1",
      timestamp: "2026-01-01T00:00:05.000Z",
      subagent: {
        id: "sub1",
        sessionId: "s1",
        status: "completed",
        promptSummary: "Review",
        resultSummary: "done",
        startedAt: "2026-01-01T00:00:04.000Z",
        finishedAt: "2026-01-01T00:00:05.000Z",
      },
    }),
    createSessionEvent<ReportWrittenEvent>({
      type: "report_written",
      sessionId: "s1",
      timestamp: "2026-01-01T00:00:06.000Z",
      report: {
        id: "report1",
        sessionId: "s1",
        title: "Run report",
        path: ".coil/sessions/s1/report.md",
        createdAt: "2026-01-01T00:00:06.000Z",
      },
    }),
    createSessionEvent<SessionResumedEvent>({
      type: "session_resumed",
      sessionId: "s1",
      timestamp: "2026-01-01T00:00:07.000Z",
    }),
    createSessionEvent<SessionClosedEvent>({
      type: "session_closed",
      sessionId: "s1",
      timestamp: "2026-01-01T00:00:08.000Z",
    }),
  ]);

  assert.equal(snapshot.tasks[0]?.status, "in_progress");
  assert.equal(snapshot.backgroundCommands[0]?.status, "completed");
  assert.equal(snapshot.subagents[0]?.status, "completed");
  assert.equal(snapshot.reports[0]?.title, "Run report");
  assert.equal(snapshot.session?.status, "closed");
});

test("projection records MCP server connected and failed events", () => {
  const snapshot = applySessionEvents(createEmptySessionSnapshot(), [
    createSessionEvent<SessionCreatedEvent>({
      type: "session_created",
      sessionId: "s1",
      session: createSessionRecord({
        workspaceRoot: "/tmp/ws",
        id: "s1",
        now: "2026-01-01T00:00:00.000Z",
      }),
      timestamp: "2026-01-01T00:00:00.000Z",
    }),
    {
      id: "mcp_1",
      type: "mcp_server_connected",
      sessionId: "s1",
      timestamp: "2026-01-01T00:00:01.000Z",
      server: {
        name: "github",
        status: "connected",
        toolCount: 2,
        updatedAt: "2026-01-01T00:00:01.000Z",
      },
    } as never,
    {
      id: "mcp_2",
      type: "mcp_server_failed",
      sessionId: "s1",
      timestamp: "2026-01-01T00:00:02.000Z",
      server: {
        name: "filesystem",
        status: "failed",
        reason: "failed to connect",
        updatedAt: "2026-01-01T00:00:02.000Z",
      },
    } as never,
    {
      id: "mcp_3",
      type: "mcp_server_connected",
      sessionId: "s1",
      timestamp: "2026-01-01T00:00:03.000Z",
      server: {
        name: "github",
        status: "connected",
        toolCount: 3,
        updatedAt: "2026-01-01T00:00:03.000Z",
      },
    } as never,
  ]);

  assert.deepEqual(snapshot.mcpServers, [
    {
      name: "github",
      status: "connected",
      toolCount: 3,
      updatedAt: "2026-01-01T00:00:03.000Z",
    },
    {
      name: "filesystem",
      status: "failed",
      reason: "failed to connect",
      updatedAt: "2026-01-01T00:00:02.000Z",
    },
  ]);
  assert.equal(snapshot.session?.updatedAt, "2026-01-01T00:00:03.000Z");
});
