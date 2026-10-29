import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { SessionStore, sessionPath } from "../src/core/session/store/sessionStore.js";
import { importLegacyAnthropicMessages } from "../src/core/session/store/legacyMessages.js";
import { SessionController } from "../src/core/session/controller.js";
import { createSessionRecord } from "../src/core/session/types.js";
import { createEmptySessionSnapshot } from "../src/core/session/projection/projection.js";
import { fakeProvider, textMessage } from "./helpers/pi.js";

const LEGACY_MESSAGES = [
  { role: "user", content: "hello" },
  {
    role: "assistant",
    content: [
      { type: "text", text: "reading" },
      { type: "tool_use", id: "toolu_legacy", name: "read_file", input: { path: "a.txt" } },
    ],
  },
  {
    role: "user",
    content: [{ type: "tool_result", tool_use_id: "toolu_legacy", content: "file body" }],
  },
  {
    role: "user",
    content: [
      { type: "tool_result", tool_use_id: "toolu_missing", content: "oops", is_error: true },
    ],
  },
  { role: "assistant", content: [{ type: "text", text: "done" }] },
];

async function tempWorkspace(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), "coil-legacy-messages-"));
}

test("importLegacyAnthropicMessages rewrites user, assistant, and tool result blocks", () => {
  const messages = importLegacyAnthropicMessages(LEGACY_MESSAGES);

  assert.deepEqual(
    messages.map((message) => message.role),
    ["user", "assistant", "toolResult", "toolResult", "assistant"],
  );

  const first = messages[0];
  assert.ok(first && first.role === "user");
  assert.equal(first.content, "hello");
  assert.equal(typeof first.timestamp, "number");

  const assistant = messages[1];
  assert.ok(assistant && assistant.role === "assistant");
  assert.equal(assistant.stopReason, "toolUse");
  const toolCallBlock = assistant.content.find((block) => block.type === "toolCall");
  assert.ok(toolCallBlock && toolCallBlock.type === "toolCall");
  assert.equal(toolCallBlock.id, "toolu_legacy");
  assert.equal(toolCallBlock.name, "read_file");

  const result = messages[2];
  assert.ok(result && result.role === "toolResult");
  assert.equal(result.toolCallId, "toolu_legacy");
  assert.equal(result.toolName, "read_file");
  assert.equal(result.isError, false);
  assert.match(JSON.stringify(result.content), /file body/);

  const unknown = messages[3];
  assert.ok(unknown && unknown.role === "toolResult");
  assert.equal(unknown.toolName, "unknown");
  assert.equal(unknown.isError, true);
});

test("importLegacyAnthropicMessages passes pi-ai messages through unchanged", () => {
  const existing = [textMessage("already migrated")];
  assert.deepEqual(importLegacyAnthropicMessages(existing), existing);
});

test("SessionStore loads a legacy lead-messages.json as pi-ai messages", async () => {
  const workspace = await tempWorkspace();
  try {
    const store = new SessionStore(workspace);
    const session = createSessionRecord({ workspaceRoot: workspace, id: "s_legacy_lead" });
    await store.create(session);
    await fs.mkdir(sessionPath(workspace, session.id), { recursive: true });
    await fs.writeFile(
      path.join(sessionPath(workspace, session.id), "lead-messages.json"),
      `${JSON.stringify(LEGACY_MESSAGES, null, 2)}\n`,
      "utf8",
    );

    const messages = await store.loadLeadAgentMessages(session.id);

    assert.deepEqual(
      messages.map((message) => message.role),
      ["user", "assistant", "toolResult", "toolResult", "assistant"],
    );
    const assistant = messages[1];
    assert.ok(assistant && assistant.role === "assistant");
    assert.equal(assistant.api, "anthropic-messages");
    assert.ok(assistant.content.some((block) => block.type === "toolCall"));
  } finally {
    await fs.rm(workspace, { recursive: true, force: true });
  }
});

test("SessionController.resume continues a session persisted in the legacy format", async () => {
  const workspace = await tempWorkspace();
  try {
    const store = new SessionStore(workspace);
    const session = createSessionRecord({ workspaceRoot: workspace, id: "s_legacy_resume" });
    await store.create(session);
    await store.saveSnapshot(session.id, createEmptySessionSnapshot());
    await fs.mkdir(sessionPath(workspace, session.id), { recursive: true });
    await fs.writeFile(
      path.join(sessionPath(workspace, session.id), "lead-messages.json"),
      `${JSON.stringify(LEGACY_MESSAGES, null, 2)}\n`,
      "utf8",
    );

    const controller = await SessionController.resume({
      sessionId: session.id,
      workspaceRoot: workspace,
      store,
      provider: fakeProvider(() => textMessage("resumed reply")),
    });

    assert.deepEqual(
      controller.leadAgentState.messages.map((message) => message.role),
      ["user", "assistant", "toolResult", "toolResult", "assistant"],
    );

    await controller.handleUserMessage("continue");
    assert.equal(controller.getSnapshot().conversationMessages.at(-1)?.content, "resumed reply");
  } finally {
    await fs.rm(workspace, { recursive: true, force: true });
  }
});
