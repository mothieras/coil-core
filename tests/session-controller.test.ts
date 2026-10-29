import test from "node:test";
import assert from "node:assert/strict";
import fs, { mkdtemp, readFile, rm } from "node:fs/promises";
import os, { tmpdir } from "node:os";
import path from "node:path";
import type { AssistantMessage, Message } from "@earendil-works/pi-ai";
import { Agent } from "../src/core/agent/agent.js";
import { SessionController } from "../src/core/session/controller.js";
import type { SessionCompactResult } from "../src/core/session/commands/actions.js";
import { createEmptySessionSnapshot } from "../src/core/session/projection/projection.js";
import { SessionStore, sessionPath } from "../src/core/session/store/sessionStore.js";
import type {
  ConversationMessage,
  SessionEvent,
  SessionRecord,
  SessionSnapshot,
} from "../src/core/session/types.js";
import { createSessionRecord } from "../src/core/session/types.js";
import type { SessionViewEvent } from "../src/core/session/viewEvents.js";
import {
  fakeProvider,
  textMessage,
  toolCall,
  toolCallMessage,
  usage,
  userMessage,
} from "./helpers/pi.js";

function textResponse(text: string): AssistantMessage {
  return textMessage(text);
}

function toolUseResponse(name: string, input: Record<string, unknown>): AssistantMessage {
  return toolCallMessage([toolCall(name, input, "toolu_session_controller_test")]);
}

function emptyRuntime() {
  return {
    getToolDefinitions: () => [],
    invokeTool: async () => "",
  } as never;
}

function testLeadAgent(
  workspaceRoot: string,
  createMessage: () => Promise<AssistantMessage>,
): Agent {
  return new Agent({
    id: "lead",
    workspaceRoot,
    toolRuntime: emptyRuntime(),
    provider: fakeProvider(() => createMessage()),
  });
}

class FlakyFlushStore extends SessionStore {
  readonly appendedEventIds: string[][] = [];
  private failConversation = true;

  constructor(workspaceRoot: string) {
    super(workspaceRoot);
  }

  override async create(_record: SessionRecord): Promise<void> {}

  override async appendEvents(_sessionId: string, events: readonly SessionEvent[]): Promise<void> {
    this.appendedEventIds.push(events.map((event) => event.id));
  }

  override async saveConversation(
    _sessionId: string,
    _messages: readonly ConversationMessage[],
  ): Promise<void> {
    if (!this.failConversation) return;
    this.failConversation = false;
    throw new Error("transient save failure");
  }

  override async saveLeadMessages(
    _sessionId: string,
    _messages: readonly Message[],
  ): Promise<void> {}

  override async saveSnapshot(_sessionId: string, _snapshot: SessionSnapshot): Promise<void> {}
}

async function tempWorkspace(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), "coil-session-controller-"));
}

test("SessionController records report_written events without generating report content", async () => {
  const workspace = await mkdtemp(path.join(tmpdir(), "session-controller-"));
  try {
    const controller = await SessionController.createNew({
      sessionId: "session_report",
      workspaceRoot: workspace,
    });

    controller.recordReportWritten({
      id: "report1",
      title: "Manual report",
      path: ".coil/sessions/session_report/report.md",
      createdAt: "2026-01-01T00:00:00.000Z",
    });
    await controller.flush();

    assert.deepEqual(controller.getSnapshot().reports, [
      {
        id: "report1",
        sessionId: "session_report",
        title: "Manual report",
        path: ".coil/sessions/session_report/report.md",
        createdAt: "2026-01-01T00:00:00.000Z",
      },
    ]);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("SessionController records MCP provider diagnostics at session creation", async () => {
  const workspace = await mkdtemp(path.join(tmpdir(), "session-controller-"));
  let closed = false;
  try {
    const controller = await SessionController.createNew({
      sessionId: "session_mcp_diagnostics",
      workspaceRoot: workspace,
      toolProviderResults: [
        {
          tools: [],
          diagnostics: [
            {
              providerName: "demo",
              sourceType: "mcp",
              namespacePrefix: "mcp__demo__",
              status: "available",
              reason: "1 tool(s) loaded.",
              toolCount: 1,
            },
            {
              providerName: "broken",
              sourceType: "mcp",
              namespacePrefix: "mcp__broken__",
              status: "unavailable",
              reason: "Authorization: Bearer sk-ant-secret failed",
            },
          ],
          close: () => {
            closed = true;
          },
        },
      ],
    } as never);

    assert.deepEqual(controller.getSnapshot().mcpServers, [
      {
        name: "demo",
        status: "connected",
        toolCount: 1,
        updatedAt: controller.getSnapshot().mcpServers[0]?.updatedAt,
      },
      {
        name: "broken",
        status: "failed",
        reason: "Authorization: [redacted] [redacted] failed",
        updatedAt: controller.getSnapshot().mcpServers[1]?.updatedAt,
      },
    ]);
    await controller.close();
    assert.equal(closed, true);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("SessionController.resume records current MCP provider diagnostics", async () => {
  const workspace = await mkdtemp(path.join(tmpdir(), "session-controller-"));
  try {
    const store = new SessionStore(workspace);
    const session = createSessionRecord({
      id: "session_resume_mcp",
      workspaceRoot: workspace,
    });
    await store.create(session);
    await store.saveLeadMessages(session.id, []);
    await store.saveSnapshot(session.id, {
      ...createEmptySessionSnapshot(),
      session,
    });

    const controller = await SessionController.resume({
      sessionId: session.id,
      workspaceRoot: workspace,
      store,
      toolProviderResults: [
        {
          tools: [],
          diagnostics: [
            {
              providerName: "demo",
              sourceType: "mcp",
              namespacePrefix: "mcp__demo__",
              status: "available",
              reason: "1 tool(s) loaded.",
              toolCount: 1,
            },
          ],
        },
      ],
    });

    assert.equal(controller.getSnapshot().mcpServers[0]?.name, "demo");
    assert.equal(controller.getSnapshot().mcpServers[0]?.status, "connected");
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("SessionController.resume clears stale MCP provider diagnostics", async () => {
  const workspace = await mkdtemp(path.join(tmpdir(), "session-controller-"));
  try {
    const store = new SessionStore(workspace);
    const session = createSessionRecord({
      id: "session_resume_mcp_removed",
      workspaceRoot: workspace,
    });
    await store.create(session);
    await store.saveLeadMessages(session.id, []);
    await store.saveSnapshot(session.id, {
      ...createEmptySessionSnapshot(),
      session,
      mcpServers: [
        {
          name: "old",
          status: "connected",
          toolCount: 1,
          updatedAt: "2026-01-01T00:00:00.000Z",
        },
      ],
    });

    const controller = await SessionController.resume({
      sessionId: session.id,
      workspaceRoot: workspace,
      store,
      toolProviderResults: [],
    });

    assert.deepEqual(controller.getSnapshot().mcpServers, []);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("SessionController.compact records compact events and saves lead state", async () => {
  const workspace = await mkdtemp(path.join(tmpdir(), "session-controller-"));
  const provider = fakeProvider(() => textResponse("compacted summary"));
  try {
    const store = new SessionStore(workspace);
    const controller = await SessionController.createNew({
      sessionId: "session_compact_action",
      workspaceRoot: workspace,
      store,
      provider,
    });
    controller.leadAgentState.messages.push(userMessage("hello"));

    const result = await controller.compact("manual slash command");

    assert.equal(result.compacted, true);
    assert.equal(
      controller.getSnapshot().leadAgentMessages.length,
      controller.leadAgentState.messages.length,
    );
    const events = (
      await readFile(
        path.join(sessionPath(workspace, "session_compact_action"), "events.jsonl"),
        "utf8",
      )
    )
      .trim()
      .split("\n")
      .map(
        (line) =>
          JSON.parse(line) as {
            type: string;
            runtimeEvent?: { type: string; transcriptPath?: string };
          },
      );
    const compactFinished = events.find(
      (event) =>
        event.type === "runtime_lifecycle_recorded" &&
        event.runtimeEvent?.type === "compact_finished",
    );
    assert.equal(
      events.some(
        (event) =>
          event.type === "runtime_lifecycle_recorded" &&
          event.runtimeEvent?.type === "compact_started",
      ),
      true,
    );
    assert.equal(typeof compactFinished?.runtimeEvent?.transcriptPath, "string");
    assert.equal(
      await readFile(compactFinished!.runtimeEvent!.transcriptPath!, "utf8").then((text) =>
        text.includes("hello"),
      ),
      true,
    );
    assert.equal(
      events.some(
        (event) =>
          event.type === "runtime_lifecycle_recorded" &&
          event.runtimeEvent?.type === "compact_finished",
      ),
      true,
    );
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("SessionController refuses to compact while a turn is running", async () => {
  const workspace = await mkdtemp(path.join(tmpdir(), "session-controller-"));
  let calls = 0;
  let releaseTurn: () => void = () => {};
  const turnGate = new Promise<void>((resolve) => {
    releaseTurn = resolve;
  });
  const provider = fakeProvider(async () => {
    calls += 1;
    if (calls === 1) await turnGate; // hold the lead turn open mid-flight
    return textMessage("assistant reply", "stop", usage(1, 1));
  });
  try {
    const store = new SessionStore(workspace);
    const controller = await SessionController.createNew({
      sessionId: "session_compact_busy",
      workspaceRoot: workspace,
      store,
      provider,
    });
    controller.leadAgentState.messages.push(userMessage("hello"));

    // Start a turn that blocks inside the model call; `running` is now true.
    const turn = controller.handleUserMessage("hello");

    const blocked = await controller.handleSlashCommand("/compact");
    assert.equal(blocked.action, "compact");
    assert.equal((blocked as SessionCompactResult).compacted, false);
    assert.match((blocked as SessionCompactResult).message, /running/i);
    // The live message array must not have been spliced while the turn runs.
    assert.equal(controller.leadAgentState.messages[0]?.content, "hello");

    // Once the turn finishes, compaction proceeds normally.
    releaseTurn();
    await turn;
    // The turn's model responses carried usage — it must land in the snapshot.
    assert.ok(controller.getSnapshot().usage.apiCalls >= 1);
    assert.ok(controller.getSnapshot().usage.inputTokens >= 1);
    const ok = await controller.handleSlashCommand("/compact");
    assert.equal((ok as SessionCompactResult).compacted, true);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("SessionController.writeReport writes report.md and records report_written", async () => {
  const workspace = await mkdtemp(path.join(tmpdir(), "session-controller-"));
  try {
    const store = new SessionStore(workspace);
    const controller = await SessionController.createNew({
      sessionId: "session_report_action",
      workspaceRoot: workspace,
      store,
    });

    const report = await controller.writeReport({ title: "Manual report" });

    assert.equal(report.title, "Manual report");
    assert.match(report.path, /report\.md$/);
    const markdown = await readFile(report.path, "utf8");
    assert.match(markdown, /# Manual report/);
    assert.match(markdown, /Session/);
    assert.match(markdown, /Verification/);
    assert.equal(controller.getSnapshot().reports.at(-1)?.path, report.path);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("SessionController.handleSlashCommand returns notices and writes reports", async () => {
  const workspace = await mkdtemp(path.join(tmpdir(), "session-controller-"));
  try {
    const controller = await SessionController.createNew({
      sessionId: "session_slash_action",
      workspaceRoot: workspace,
    });

    const status = await controller.handleSlashCommand("/status");
    assert.equal(status.action, "notice");
    assert.equal(status.title, "Status");
    assert.equal(status.focus, "status");
    assert.match(status.body, /session=session_slash_action/);

    const report = await controller.handleSlashCommand("/report");
    assert.equal(report.action, "report");
    assert.match(report.message, /Report written:/);
    assert.equal(
      await readFile(report.report.path, "utf8").then((text) => text.includes("# Session report")),
      true,
    );
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("SessionController.handleSlashCommand /ping reports latency and surfaces failures", async () => {
  const workspace = await mkdtemp(path.join(tmpdir(), "session-controller-"));
  const originalModel = process.env.MODEL_ID;
  process.env.MODEL_ID = "test-model";
  const scripts = [
    () => textResponse("pong"),
    (): AssistantMessage => {
      throw new Error("api unreachable");
    },
  ];
  const provider = fakeProvider(() => {
    const next = scripts.shift();
    if (!next) throw new Error("unexpected extra model call");
    return next();
  });
  try {
    const controller = await SessionController.createNew({
      sessionId: "session_ping_action",
      workspaceRoot: workspace,
      provider,
    });

    const ok = await controller.handleSlashCommand("/ping");
    assert.equal(ok.action, "notice");
    assert.equal(ok.title, "Ping OK");
    assert.match(ok.body, /^\d+ms model=test-model in=0 out=0$/);

    const failed = await controller.handleSlashCommand("/ping");
    assert.equal(failed.action, "notice");
    assert.equal(failed.title, "Ping Failed");
    assert.match(failed.body, /model=test-model error=api unreachable/);
  } finally {
    process.env.MODEL_ID = originalModel;
    await rm(workspace, { recursive: true, force: true });
  }
});

test("SessionController auto-titles the session after the first turn", async () => {
  const workspace = await mkdtemp(path.join(tmpdir(), "session-controller-"));
  let calls = 0;
  const provider = fakeProvider(() => {
    calls += 1;
    // Call 1: the first turn. Call 2: the title request. Call 3: second turn.
    return calls === 2 ? textResponse("Fix Login Flow") : textResponse("assistant reply");
  });
  try {
    const store = new SessionStore(workspace);
    const controller = await SessionController.createNew({
      sessionId: "session_autotitle",
      workspaceRoot: workspace,
      store,
      provider,
    });

    await controller.handleUserMessage("please fix the login bug");
    assert.equal(controller.getSnapshot().session?.title, "Fix Login Flow");
    const listed = await store.listSessions();
    assert.equal(listed.find((s) => s.id === "session_autotitle")?.title, "Fix Login Flow");

    const callsAfterFirst = calls;
    await controller.handleUserMessage("second message");
    assert.equal(calls, callsAfterFirst + 1, "second turn must not re-title");
    assert.equal(controller.getSnapshot().session?.title, "Fix Login Flow");
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("SessionController expands .coil/commands templates as message commands", async () => {
  const workspace = await mkdtemp(path.join(tmpdir(), "session-controller-"));
  try {
    const commandsDir = path.join(workspace, ".coil", "commands");
    await fs.mkdir(commandsDir, { recursive: true });
    await fs.writeFile(
      path.join(commandsDir, "review.md"),
      "---\ndescription: run a review\n---\nReview this file: $@\nBe thorough.\n",
      "utf8",
    );
    const controller = await SessionController.createNew({
      sessionId: "session_template",
      workspaceRoot: workspace,
    });

    const expanded = await controller.handleSlashCommand("/review src/a.ts");
    assert.equal(expanded.action, "message");
    assert.equal(expanded.text, "Review this file: src/a.ts\nBe thorough.");

    const missing = await controller.handleSlashCommand("/definitely-missing");
    assert.equal(missing.action, "notice");
    assert.equal(missing.title, "Unknown command");
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("SessionController stores task state under the active session and projects task changes", async () => {
  const workspace = await mkdtemp(path.join(tmpdir(), "session-controller-"));
  try {
    const store = new SessionStore(workspace);
    const leadAgent = testLeadAgent(workspace, async () => textResponse("done"));
    const controller = await SessionController.createNew({
      sessionId: "session_tasks",
      workspaceRoot: workspace,
      leadAgent,
      store,
    });

    const created = await controller.appContext.toolRuntime.invokeTool("update_tasks", {
      tasks: [{ subject: "Write tests", description: "Cover session tasks" }],
    });
    assert.match(created, /#1: Write tests/);

    await controller.flush();

    const taskFile = path.join(sessionPath(workspace, "session_tasks"), "tasks", "task_1.json");
    assert.equal(JSON.parse(await readFile(taskFile, "utf8")).subject, "Write tests");
    assert.equal(controller.getSnapshot().tasks[0]?.title, "Write tests");
    assert.equal(controller.getSnapshot().tasks[0]?.status, "pending");
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("SessionController marks running background commands interrupted on close", async () => {
  const workspace = await mkdtemp(path.join(tmpdir(), "session-controller-"));
  try {
    const store = new SessionStore(workspace);
    const leadAgent = testLeadAgent(workspace, async () => textResponse("done"));
    const controller = await SessionController.createNew({
      sessionId: "session_bg",
      workspaceRoot: workspace,
      leadAgent,
      store,
    });

    await controller.appContext.toolRuntime.invokeTool("background_run", {
      command: 'node -e "setTimeout(() => {}, 1000)"',
    });
    assert.equal(controller.getSnapshot().backgroundCommands[0]?.status, "running");

    await controller.close();

    assert.equal(controller.getSnapshot().backgroundCommands[0]?.status, "interrupted");
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("SessionController exposes pending async work status", async () => {
  const workspace = await mkdtemp(path.join(tmpdir(), "session-controller-"));
  try {
    const store = new SessionStore(workspace);
    const leadAgent = testLeadAgent(workspace, async () => textResponse("done"));
    const controller = await SessionController.createNew({
      sessionId: "session_pending_work",
      workspaceRoot: workspace,
      leadAgent,
      store,
    });

    assert.equal(controller.hasPendingAsyncWork(), false);

    await controller.appContext.toolRuntime.invokeTool("background_run", {
      command: 'node -e "setTimeout(() => {}, 1000)"',
    });

    assert.equal(controller.hasPendingAsyncWork(), true);

    await controller.close();
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("SessionController.waitForAsyncWork returns completed when no async work is running", async () => {
  const workspace = await mkdtemp(path.join(tmpdir(), "session-controller-"));
  try {
    const controller = await SessionController.createNew({
      sessionId: "session_wait_idle",
      workspaceRoot: workspace,
    });

    assert.equal(await controller.waitForAsyncWork({ pollMs: 1 }), "completed");
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("SessionController.waitForAsyncWork can be interrupted by caller", async () => {
  const workspace = await mkdtemp(path.join(tmpdir(), "session-controller-"));
  try {
    const controller = await SessionController.createNew({
      sessionId: "session_wait_interrupted",
      workspaceRoot: workspace,
    });
    await controller.appContext.toolRuntime.invokeTool("background_run", {
      command: 'node -e "setTimeout(() => {}, 1000)"',
    });

    assert.equal(
      await controller.waitForAsyncWork({ pollMs: 1, shouldStop: () => true }),
      "interrupted",
    );
    await controller.close();
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("SessionController.waitForAsyncWork preserves interruption when work finishes during sleep", async () => {
  const workspace = await mkdtemp(path.join(tmpdir(), "session-controller-"));
  try {
    const controller = await SessionController.createNew({
      sessionId: "session_wait_race",
      workspaceRoot: workspace,
    });
    let running = true;
    let interrupted = false;
    const controllerWithMock = controller as SessionController & {
      hasPendingAsyncWork: () => boolean;
    };
    controllerWithMock.hasPendingAsyncWork = () => running;

    const waiting = controller.waitForAsyncWork({
      pollMs: 20,
      shouldStop: () => interrupted,
    });
    setTimeout(() => {
      interrupted = true;
      running = false;
    }, 1);

    assert.equal(await waiting, "interrupted");
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("SessionController.close records a closed session", async () => {
  const workspace = await mkdtemp(path.join(tmpdir(), "session-controller-"));
  try {
    const store = new SessionStore(workspace);
    const controller = await SessionController.createNew({
      sessionId: "session_close",
      workspaceRoot: workspace,
      store,
    });

    await controller.close();

    assert.equal(controller.getSnapshot().session?.status, "closed");
    assert.equal((await store.loadSnapshot("session_close")).session?.status, "closed");
    const events = (
      await readFile(path.join(sessionPath(workspace, "session_close"), "events.jsonl"), "utf8")
    )
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as { type: string });
    assert.equal(events.at(-1)?.type, "session_closed");
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("SessionController.resume restores lead messages and continues the same session", async () => {
  const workspace = await mkdtemp(path.join(tmpdir(), "session-controller-"));
  let calls = 0;
  const provider = fakeProvider(() => {
    calls += 1;
    return textResponse(calls === 1 ? "first reply" : "second reply");
  });
  try {
    const store = new SessionStore(workspace);
    const first = await SessionController.createNew({
      sessionId: "session_resume",
      workspaceRoot: workspace,
      store,
      provider,
    });
    await first.handleUserMessage("first");
    await first.flush();

    const resumed = await SessionController.resume({
      sessionId: "session_resume",
      workspaceRoot: workspace,
      store,
      provider,
    });
    assert.equal(resumed.getSnapshot().session?.id, "session_resume");
    assert.equal(resumed.leadAgentState.messages.length, first.leadAgentState.messages.length);

    await resumed.handleUserMessage("second");
    await resumed.flush();

    assert.equal(resumed.getSnapshot().conversationMessages.at(-1)?.content, "second reply");
    assert.equal(resumed.getSnapshot().session?.id, "session_resume");
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("SessionController.resume applies checkPermission to the default lead agent", async () => {
  const workspace = await mkdtemp(path.join(tmpdir(), "session-controller-"));
  const permissionContexts: string[] = [];
  let calls = 0;
  const provider = fakeProvider(() => {
    calls += 1;
    return calls === 1
      ? toolUseResponse("bash", { command: "rm resumed-important" })
      : textResponse("assistant reply");
  });
  try {
    const store = new SessionStore(workspace);
    const first = await SessionController.createNew({
      sessionId: "session_resume_permission",
      workspaceRoot: workspace,
      store,
      provider,
    });
    await first.flush();

    const resumed = await SessionController.resume({
      sessionId: "session_resume_permission",
      workspaceRoot: workspace,
      store,
      provider,
      checkPermission: async (context) => {
        permissionContexts.push(`${context.sessionId}:${context.toolName}:${context.agentKind}`);
        return { allowed: false, requested: true, reason: "blocked after resume" };
      },
    });

    await resumed.handleUserMessage("run a command");

    assert.deepEqual(permissionContexts, ["session_resume_permission:bash:lead"]);
    assert.equal(resumed.getSnapshot().permissionDecisions[0]?.allowed, false);
    assert.equal(resumed.getSnapshot().permissionDecisions[0]?.reason, "blocked after resume");
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("SessionController.resume reopens a closed session and close records it again", async () => {
  const workspace = await mkdtemp(path.join(tmpdir(), "session-controller-"));
  try {
    const store = new SessionStore(workspace);
    const first = await SessionController.createNew({
      sessionId: "session_resume_closed",
      workspaceRoot: workspace,
      store,
    });
    await first.close();

    const resumed = await SessionController.resume({
      sessionId: "session_resume_closed",
      workspaceRoot: workspace,
      store,
    });

    assert.equal(resumed.getSnapshot().session?.status, "active");

    await resumed.close();

    assert.equal(resumed.getSnapshot().session?.status, "closed");
    assert.equal((await store.loadSnapshot("session_resume_closed")).session?.status, "closed");
    const events = (
      await readFile(
        path.join(sessionPath(workspace, "session_resume_closed"), "events.jsonl"),
        "utf8",
      )
    )
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as { type: string });
    assert.equal(events.filter((event) => event.type === "session_closed").length, 2);
    assert.equal(events.at(-1)?.type, "session_closed");
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("SessionController.handleAutoWake records an auto-wake agent run", async () => {
  const workspace = await mkdtemp(path.join(tmpdir(), "session-controller-"));
  const provider = fakeProvider(() => textResponse("handled async result"));
  try {
    const controller = await SessionController.createNew({
      sessionId: "session_wake",
      workspaceRoot: workspace,
      provider,
    });

    await controller.handleAutoWake("subagent_finished");

    assert.equal(controller.getSnapshot().agentRuns[0]?.trigger.type, "auto_wake");
    assert.equal(controller.getSnapshot().agentRuns[0]?.status, "completed");
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("SessionController.createNew applies checkPermission to the default lead agent", async () => {
  const workspace = await mkdtemp(path.join(tmpdir(), "session-controller-"));
  const permissionContexts: string[] = [];
  let calls = 0;
  const provider = fakeProvider(() => {
    calls += 1;
    return calls === 1
      ? toolUseResponse("bash", { command: "rm important" })
      : textResponse("assistant reply");
  });
  try {
    const controller = await SessionController.createNew({
      sessionId: "session_default_permission",
      workspaceRoot: workspace,
      provider,
      checkPermission: async (context) => {
        permissionContexts.push(`${context.sessionId}:${context.toolName}:${context.agentKind}`);
        return { allowed: false, requested: true, reason: "blocked by test" };
      },
    });

    await controller.handleUserMessage("run a command");

    assert.deepEqual(permissionContexts, ["session_default_permission:bash:lead"]);
    assert.equal(controller.getSnapshot().permissionDecisions[0]?.allowed, false);
    assert.equal(controller.getSnapshot().permissionDecisions[0]?.reason, "blocked by test");
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("SessionController records subagent started and finished projections", async () => {
  const workspace = await tempWorkspace();
  const provider = fakeProvider((request) => {
    const messages = request.messages;
    const last = messages[messages.length - 1];
    if (messages.length === 1 && last?.role === "user" && last.content === "spawn reviewer") {
      return toolUseResponse("subagent", { prompt: "review docs" });
    }
    if (messages.length === 1 && last?.role === "user" && last.content === "review docs") {
      return textResponse("sub done");
    }
    return textResponse("assistant reply");
  });
  try {
    const leadAgent = new Agent({
      id: "lead",
      workspaceRoot: workspace,
      toolRuntime: emptyRuntime(),
      provider,
    });
    const controller = await SessionController.createNew({
      workspaceRoot: workspace,
      leadAgent,
      sessionId: "session_subagent_lifecycle",
      now: "2026-01-01T00:00:00.000Z",
    });

    await controller.handleUserMessage("spawn reviewer");
    while (controller.appContext.subAgentRunner.hasRunning()) {
      await new Promise((resolve) => setImmediate(resolve));
    }

    assert.equal(controller.getSnapshot().subagents[0]?.status, "completed");
    assert.equal(
      controller.getSnapshot().subagents[0]?.parentRunId,
      controller.getSnapshot().agentRuns[0]?.id,
    );
    assert.ok(controller.getSnapshot().subagents[0]?.parentToolCallId);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("SessionController.close marks running subagents interrupted before closing", async () => {
  const workspace = await tempWorkspace();
  const provider = fakeProvider((request) => {
    const messages = request.messages;
    const last = messages[messages.length - 1];
    if (messages.length === 1 && last?.role === "user" && last.content === "spawn slow reviewer") {
      return toolUseResponse("subagent", { prompt: "slow review" });
    }
    if (messages.length === 1 && last?.role === "user" && last.content === "slow review") {
      return new Promise<AssistantMessage>(() => {});
    }
    return textResponse("lead done");
  });
  try {
    const controller = await SessionController.createNew({
      workspaceRoot: workspace,
      sessionId: "session_close_running_subagent",
      now: "2026-01-01T00:00:00.000Z",
      provider,
    });

    await controller.handleUserMessage("spawn slow reviewer");
    assert.equal(controller.getSnapshot().subagents[0]?.status, "running");
    const runningSubagentRun = controller
      .getSnapshot()
      .agentRuns.find((run) => run.id === controller.getSnapshot().subagents[0]?.runId);
    assert.equal(runningSubagentRun?.status, "running");

    await controller.close();

    const snapshot = controller.getSnapshot();
    const subagent = snapshot.subagents[0];
    const subagentRun = snapshot.agentRuns.find((run) => run.id === subagent?.runId);
    assert.equal(subagent?.status, "interrupted");
    assert.equal(subagentRun?.status, "interrupted");
    assert.equal(controller.getSnapshot().session?.status, "closed");
    const persisted = await new SessionStore(workspace).loadSnapshot(
      "session_close_running_subagent",
    );
    assert.equal(persisted.subagents[0]?.status, "interrupted");
    assert.equal(
      persisted.agentRuns.find((run) => run.id === persisted.subagents[0]?.runId)?.status,
      "interrupted",
    );
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("SessionController handles a lead user turn and persists session state", async () => {
  const provider = fakeProvider(() => textResponse("assistant reply"));
  const workspace = await tempWorkspace();
  try {
    const store = new SessionStore(workspace);
    const leadAgent = new Agent({
      id: "lead",
      workspaceRoot: workspace,
      toolRuntime: emptyRuntime(),
      provider,
    });
    const controller = await SessionController.createNew({
      workspaceRoot: workspace,
      leadAgent,
      store,
      sessionId: "session_controller",
      now: "2026-01-01T00:00:00.000Z",
    });

    const turn = await controller.handleUserMessage("hello");

    assert.equal(turn.run.sessionId, "session_controller");
    assert.equal(turn.run.status, "completed");
    assert.equal(turn.userMessage.content, "hello");
    assert.equal(turn.assistantMessage.content, "assistant reply");

    const snapshot = controller.getSnapshot();
    assert.equal(snapshot.session?.id, "session_controller");
    assert.deepEqual(
      snapshot.conversationMessages.map((message) => [message.role, message.content]),
      [
        ["user", "hello"],
        ["assistant", "assistant reply"],
      ],
    );
    assert.deepEqual(
      snapshot.leadAgentMessages.map((message) => message.role),
      ["user", "assistant"],
    );
    assert.equal(snapshot.agentRuns.length, 1);
    assert.equal(snapshot.agentRuns[0]?.sessionId, "session_controller");
    assert.equal(snapshot.agentRuns[0]?.status, "completed");

    const dir = sessionPath(workspace, "session_controller");
    const eventLines = (await fs.readFile(path.join(dir, "events.jsonl"), "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as { type: string; runtimeEvent?: { type: string } });
    assert.deepEqual(
      eventLines.map((event) => event.type),
      [
        "session_created",
        "conversation_message_added",
        "runtime_lifecycle_recorded",
        "runtime_lifecycle_recorded",
        "runtime_lifecycle_recorded",
        "conversation_message_added",
        "lead_agent_state_saved",
        "session_titled",
      ],
    );
    assert.deepEqual(
      eventLines
        .filter((event) => event.type === "runtime_lifecycle_recorded")
        .map((event) => event.runtimeEvent?.type),
      ["agent_run_started", "assistant_message_added", "agent_run_finished"],
    );

    assert.deepEqual(await store.loadSnapshot("session_controller"), snapshot);
    const leadMessages = JSON.parse(
      await fs.readFile(path.join(dir, "lead-messages.json"), "utf8"),
    ) as Message[];
    assert.deepEqual(
      leadMessages.map((message) => message.role),
      ["user", "assistant"],
    );
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("SessionController keeps raw lead messages out of event and snapshot files", async () => {
  const rawSecret = "RAW_SESSION_SECRET_VALUE";
  let calls = 0;
  const provider = fakeProvider(() => {
    calls += 1;
    if (calls === 1) return toolUseResponse("read_file", { api_key: rawSecret });
    return textResponse("assistant reply");
  });
  const workspace = await tempWorkspace();
  try {
    const leadAgent = new Agent({
      id: "lead",
      workspaceRoot: workspace,
      toolRuntime: emptyRuntime(),
      provider,
    });
    const controller = await SessionController.createNew({
      workspaceRoot: workspace,
      leadAgent,
      sessionId: "session_sanitized",
      now: "2026-01-01T00:00:00.000Z",
    });

    await controller.handleUserMessage("hello");

    const dir = sessionPath(workspace, "session_sanitized");
    const events = await fs.readFile(path.join(dir, "events.jsonl"), "utf8");
    const snapshot = await fs.readFile(path.join(dir, "snapshot.json"), "utf8");
    const leadMessages = await fs.readFile(path.join(dir, "lead-messages.json"), "utf8");

    assert.equal(events.includes(rawSecret), false);
    assert.equal(snapshot.includes(rawSecret), false);
    assert.equal(leadMessages.includes(rawSecret), true);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("SessionController summarizes raw tool input and output in session files", async () => {
  const rawToolInput = "UNIQUE_RAW_FILE_CONTENT_FROM_TOOL_INPUT";
  const rawToolOutput = "UNIQUE_RAW_TOOL_RESULT_OUTPUT";
  let calls = 0;
  const provider = fakeProvider(() => {
    calls += 1;
    if (calls === 1) {
      return toolUseResponse("raw_output", {
        api_key: rawToolInput,
      });
    }
    return textResponse("assistant reply");
  });
  const workspace = await tempWorkspace();
  try {
    const leadAgent = new Agent({
      id: "lead",
      workspaceRoot: workspace,
      toolRuntime: emptyRuntime(),
      provider,
    });
    const controller = await SessionController.createNew({
      workspaceRoot: workspace,
      leadAgent,
      sessionId: "session_tool_summary",
      now: "2026-01-01T00:00:00.000Z",
    });
    controller.appContext.toolRuntime.registerTool({
      name: "raw_output",
      definition: {
        name: "raw_output",
        description: "Return raw output for session controller tests.",
        parameters: {
          type: "object",
          properties: {
            api_key: { type: "string" },
          },
        },
      },
      handler: () => rawToolOutput,
      source: { type: "builtin" },
    });

    await controller.handleUserMessage("hello");

    const dir = sessionPath(workspace, "session_tool_summary");
    const events = await fs.readFile(path.join(dir, "events.jsonl"), "utf8");
    const snapshot = await fs.readFile(path.join(dir, "snapshot.json"), "utf8");
    const leadMessages = await fs.readFile(path.join(dir, "lead-messages.json"), "utf8");

    assert.equal(events.includes(rawToolInput), false);
    assert.equal(events.includes(rawToolOutput), false);
    assert.equal(snapshot.includes(rawToolInput), false);
    assert.equal(snapshot.includes(rawToolOutput), false);
    assert.equal(leadMessages.includes(rawToolInput), true);
    assert.equal(leadMessages.includes(rawToolOutput), true);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("SessionController projects denied permission decisions", async () => {
  let calls = 0;
  const provider = fakeProvider(() => {
    calls += 1;
    return calls === 1
      ? toolUseResponse("bash", { command: "echo blocked" })
      : textResponse("assistant reply");
  });
  const workspace = await tempWorkspace();
  try {
    const leadAgent = new Agent({
      id: "lead",
      workspaceRoot: workspace,
      toolRuntime: emptyRuntime(),
      provider,
      checkPermission: async () => ({ allowed: false, reason: "test denied" }),
    });
    const controller = await SessionController.createNew({
      workspaceRoot: workspace,
      leadAgent,
      sessionId: "session_permission_denied",
      now: "2026-01-01T00:00:00.000Z",
    });

    await controller.handleUserMessage("run denied tool");

    assert.equal(controller.getSnapshot().permissionDecisions[0]?.allowed, false);
    assert.equal(controller.getSnapshot().permissionDecisions[0]?.reason, "test denied");
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("SessionController redacts permission reasons in session files", async () => {
  const secret = "permission_token=abc123";
  let calls = 0;
  const provider = fakeProvider(() => {
    calls += 1;
    return calls === 1
      ? toolUseResponse("bash", { command: "echo blocked" })
      : textResponse("assistant reply");
  });
  const workspace = await tempWorkspace();
  try {
    const leadAgent = new Agent({
      id: "lead",
      workspaceRoot: workspace,
      toolRuntime: emptyRuntime(),
      provider,
      checkPermission: async (context) => {
        context.emitPermissionRequested?.(`approval requires ${secret}`);
        return { allowed: false, requested: true, reason: `test denied ${secret}` };
      },
    });
    const controller = await SessionController.createNew({
      workspaceRoot: workspace,
      leadAgent,
      sessionId: "session_permission_redacted",
      now: "2026-01-01T00:00:00.000Z",
    });

    await controller.handleUserMessage("run denied tool");

    const dir = sessionPath(workspace, "session_permission_redacted");
    const events = await fs.readFile(path.join(dir, "events.jsonl"), "utf8");
    const snapshot = await fs.readFile(path.join(dir, "snapshot.json"), "utf8");

    assert.equal(events.includes(secret), false);
    assert.equal(snapshot.includes(secret), false);
    assert.equal(events.includes("[redacted]"), true);
    assert.equal(snapshot.includes("[redacted]"), true);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("SessionController does not re-append events after a partial flush failure", async () => {
  const provider = fakeProvider(() => textResponse("assistant reply"));
  const workspace = await tempWorkspace();
  try {
    const store = new FlakyFlushStore(workspace);
    const leadAgent = new Agent({
      id: "lead",
      workspaceRoot: workspace,
      toolRuntime: emptyRuntime(),
      provider,
    });
    const controller = await SessionController.createNew({
      workspaceRoot: workspace,
      leadAgent,
      store,
      sessionId: "session_partial_flush",
      now: "2026-01-01T00:00:00.000Z",
    });

    await assert.rejects(() => controller.handleUserMessage("hello"), /transient save failure/);
    await controller.flush();

    assert.equal(store.appendedEventIds.length, 1);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("SessionController emits normalized session_started events for TUI listeners", async () => {
  const workspace = await tempWorkspace();
  try {
    const events: SessionViewEvent[] = [];
    const controller = await SessionController.createNew({
      workspaceRoot: workspace,
      sessionId: "session_view_started",
      now: "2026-01-01T00:00:00.000Z",
      onSessionEvent: (event, snapshot) => {
        events.push(event);
        assert.equal(snapshot.session?.id, "session_view_started");
      },
    });

    assert.equal(events[0]?.type, "session_started");
    if (events[0]?.type !== "session_started") {
      assert.fail("expected a session_started view event");
    }
    assert.equal(events[0].mode, "created");
    assert.equal(events[0].session.id, "session_view_started");

    await controller.close();
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("SessionController subscribers receive normalized conversation and tool events", async () => {
  const workspace = await tempWorkspace();
  let calls = 0;
  const provider = fakeProvider(() => {
    calls += 1;
    return calls === 1
      ? toolUseResponse("raw_output", { value: "input" })
      : textResponse("assistant reply");
  });
  try {
    const controller = await SessionController.createNew({
      workspaceRoot: workspace,
      sessionId: "session_view_tool",
      provider,
    });
    controller.appContext.toolRuntime.registerTool({
      name: "raw_output",
      definition: {
        name: "raw_output",
        description: "Return output for session view event tests.",
        parameters: { type: "object", properties: {} },
      },
      handler: () => "tool output",
      source: { type: "builtin" },
    });
    const events: SessionViewEvent[] = [];
    let throwingListenerCalls = 0;
    const removeThrowingListener = controller.subscribe(() => {
      throwingListenerCalls += 1;
      throw new Error("listener failed");
    });
    const unsubscribe = controller.subscribe((event) => events.push(event));

    await controller.handleUserMessage("hello");

    assert.deepEqual(
      events.map((event) => event.type),
      [
        "user_message_added",
        "tool_started",
        "tool_finished",
        "assistant_message_added",
        "session_titled",
      ],
    );
    const toolStarted = events.find((event) => event.type === "tool_started");
    const toolFinished = events.find((event) => event.type === "tool_finished");
    if (toolStarted?.type !== "tool_started") {
      assert.fail("expected a tool_started view event");
    }
    if (toolFinished?.type !== "tool_finished") {
      assert.fail("expected a tool_finished view event");
    }
    assert.equal(toolStarted.toolCall.toolName, "raw_output");
    assert.equal(toolFinished.toolCall.status, "completed");
    assert.ok(throwingListenerCalls > 0);

    unsubscribe();
    removeThrowingListener();
    controller.recordReportWritten({
      id: "report_after_unsubscribe",
      title: "After unsubscribe",
      path: ".coil/sessions/session_view_tool/report.md",
      createdAt: "2026-01-01T00:00:00.000Z",
    });
    assert.equal(events.length, 5);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("SessionController normalizes permission lifecycle events for TUI listeners", async () => {
  const workspace = await tempWorkspace();
  let calls = 0;
  const provider = fakeProvider(() => {
    calls += 1;
    return calls === 1
      ? toolUseResponse("bash", { command: "echo blocked" })
      : textResponse("assistant reply");
  });
  try {
    const events: SessionViewEvent[] = [];
    const controller = await SessionController.createNew({
      workspaceRoot: workspace,
      sessionId: "session_view_permission",
      provider,
      onSessionEvent: (event) => events.push(event),
      checkPermission: async (context) => {
        context.emitPermissionRequested?.("needs approval");
        return { allowed: false, requested: true, reason: "denied by test" };
      },
    });

    await controller.handleUserMessage("run command");

    const requested = events.find((event) => event.type === "permission_requested");
    const resolved = events.find((event) => event.type === "permission_resolved");
    if (requested?.type !== "permission_requested") {
      assert.fail("expected a permission_requested view event");
    }
    if (resolved?.type !== "permission_resolved") {
      assert.fail("expected a permission_resolved view event");
    }
    assert.equal(requested.permission.toolName, "bash");
    assert.equal(requested.permission.reason, "needs approval");
    assert.equal(resolved.decision.allowed, false);
    assert.equal(resolved.decision.reason, "denied by test");
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});
