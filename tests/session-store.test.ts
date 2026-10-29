import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { Message } from "@earendil-works/pi-ai";
import { SessionStore, sessionPath } from "../src/core/session/store/sessionStore.js";
import {
  applySessionEvents,
  createEmptySessionSnapshot,
} from "../src/core/session/projection/projection.js";
import {
  createConversationMessage,
  createSessionEvent,
  createSessionRecord,
  type SessionCreatedEvent,
} from "../src/core/session/types.js";
import { textMessage, userMessage } from "./helpers/pi.js";

async function tempWorkspace(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), "coil-session-store-"));
}

test("SessionStore creates session record and state files", async () => {
  const workspace = await tempWorkspace();
  const store = new SessionStore(workspace);
  const session = createSessionRecord({
    id: "session_store",
    workspaceRoot: workspace,
    now: "2026-01-01T00:00:00.000Z",
  });
  const message = createConversationMessage({
    id: "message_1",
    sessionId: session.id,
    role: "user",
    content: "hello",
    source: "user_input",
    now: "2026-01-01T00:00:01.000Z",
  });
  const snapshot = {
    ...createEmptySessionSnapshot(),
    session,
    conversationMessages: [message],
    leadAgentMessages: [{ role: "user" as const, contentSummary: "hello" }],
  };
  const leadMessages = [userMessage("hello")];

  await store.create(session);
  await store.saveConversation(session.id, [message]);
  await store.saveLeadMessages(session.id, leadMessages);
  await store.saveSnapshot(session.id, snapshot);

  const dir = sessionPath(workspace, session.id);
  assert.deepEqual(JSON.parse(await fs.readFile(path.join(dir, "session.json"), "utf8")), session);
  assert.deepEqual(JSON.parse(await fs.readFile(path.join(dir, "conversation.json"), "utf8")), [
    message,
  ]);
  assert.deepEqual(
    JSON.parse(await fs.readFile(path.join(dir, "lead-messages.json"), "utf8")),
    leadMessages,
  );
  assert.deepEqual(await store.loadSnapshot(session.id), snapshot);
});

test("SessionStore writes report artifacts under the session directory", async () => {
  const workspace = await tempWorkspace();
  try {
    const store = new SessionStore(workspace);
    const session = createSessionRecord({
      id: "session_report_store",
      workspaceRoot: workspace,
    });
    await store.create(session);

    const reportPath = await store.writeReport(session.id, "report.md", "# Report\n");

    assert.equal(reportPath, path.join(sessionPath(workspace, session.id), "report.md"));
    assert.equal(await fs.readFile(reportPath, "utf8"), "# Report\n");
  } finally {
    await fs.rm(workspace, { recursive: true, force: true });
  }
});

test("SessionStore loads persisted session state for resume", async () => {
  const workspace = await tempWorkspace();
  try {
    const store = new SessionStore(workspace);
    const session = createSessionRecord({ workspaceRoot: workspace, id: "s_resume" });
    const leadMessages: Message[] = [userMessage("hello"), textMessage("hi")];
    const snapshot = applySessionEvents(createEmptySessionSnapshot(), [
      createSessionEvent<SessionCreatedEvent>({
        type: "session_created",
        sessionId: session.id,
        session,
      }),
    ]);

    await store.create(session);
    await store.saveLeadMessages(session.id, leadMessages);
    await store.saveSnapshot(session.id, snapshot);

    assert.deepEqual(await store.loadSession("s_resume"), session);
    assert.deepEqual(await store.loadLeadAgentMessages("s_resume"), leadMessages);
    assert.deepEqual(await store.loadSnapshot("s_resume"), snapshot);
  } finally {
    await fs.rm(workspace, { recursive: true, force: true });
  }
});

test("SessionStore loads legacy snapshots without MCP server projections", async () => {
  const workspace = await tempWorkspace();
  try {
    const store = new SessionStore(workspace);
    const session = createSessionRecord({ workspaceRoot: workspace, id: "s_legacy" });
    const { mcpServers: _mcpServers, ...legacySnapshot } = createEmptySessionSnapshot();
    await store.create(session);
    await store.saveLeadMessages(session.id, []);
    await fs.writeFile(
      path.join(sessionPath(workspace, session.id), "snapshot.json"),
      `${JSON.stringify(legacySnapshot, null, 2)}\n`,
      "utf8",
    );

    assert.deepEqual((await store.loadSnapshot(session.id)).mcpServers, []);
  } finally {
    await fs.rm(workspace, { recursive: true, force: true });
  }
});

test("SessionStore exposes session-scoped tasks path", async () => {
  const workspace = await tempWorkspace();
  try {
    const store = new SessionStore(workspace);
    assert.equal(store.sessionTasksPath("s1"), path.join(sessionPath(workspace, "s1"), "tasks"));
  } finally {
    await fs.rm(workspace, { recursive: true, force: true });
  }
});

test("a failed write preserves the previous JSON file (atomic write)", async () => {
  const workspace = await tempWorkspace();
  try {
    const store = new SessionStore(workspace);
    const session = createSessionRecord({ id: "s_atomic", workspaceRoot: workspace });
    await store.create(session);
    const good = { ...createEmptySessionSnapshot(), session };
    await store.saveSnapshot(session.id, good);

    // Force the atomic rename to fail; the existing snapshot must survive intact
    // rather than being truncated by a partial overwrite.
    const originalRename = fs.rename;
    (fs as { rename: typeof fs.rename }).rename = (async () => {
      throw new Error("simulated rename failure");
    }) as typeof fs.rename;
    try {
      await assert.rejects(
        store.saveSnapshot(session.id, {
          ...good,
          session: { ...session, title: "corrupted" },
        }),
        /simulated rename failure/,
      );
    } finally {
      (fs as { rename: typeof fs.rename }).rename = originalRename;
    }

    assert.deepEqual(await store.loadSnapshot(session.id), good);
  } finally {
    await fs.rm(workspace, { recursive: true, force: true });
  }
});

test("SessionStore appends events as jsonl", async () => {
  const workspace = await tempWorkspace();
  const store = new SessionStore(workspace);
  const session = createSessionRecord({ id: "session_events", workspaceRoot: workspace });
  const first = createSessionEvent<SessionCreatedEvent>({
    id: "event_1",
    timestamp: "2026-01-01T00:00:00.000Z",
    type: "session_created",
    sessionId: session.id,
    session,
  });
  const second = createSessionEvent<SessionCreatedEvent>({
    id: "event_2",
    timestamp: "2026-01-01T00:00:01.000Z",
    type: "session_created",
    sessionId: session.id,
    session,
  });

  await store.create(session);
  await store.appendEvents(session.id, [first]);
  await store.appendEvents(session.id, [second]);

  const eventsPath = path.join(sessionPath(workspace, session.id), "events.jsonl");
  const lines = (await fs.readFile(eventsPath, "utf8")).trim().split("\n");
  assert.deepEqual(
    lines.map((line) => JSON.parse(line)),
    [first, second],
  );
});
