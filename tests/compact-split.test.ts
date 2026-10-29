import test from "node:test";
import assert from "node:assert/strict";
import type { AssistantMessage, Message, ToolResultMessage } from "@earendil-works/pi-ai";
import { splitMessagesForAutoCompact } from "../src/core/context/compact.js";
import { assistantMessage, textMessage, toolCall, userMessage } from "./helpers/pi.js";

const toolUse = (id: string): AssistantMessage =>
  assistantMessage([toolCall("read_file", {}, id)], "toolUse");

const bigToolUse = (id: string): AssistantMessage =>
  assistantMessage([toolCall("read_file", { path: "x".repeat(40_000) }, id)], "toolUse");

const toolResult = (id: string, text: string): ToolResultMessage => ({
  role: "toolResult",
  toolCallId: id,
  toolName: "read_file",
  content: [{ type: "text", text }],
  isError: false,
  timestamp: Date.now(),
});

function startsWithToolResult(msg: Message | undefined): boolean {
  return msg?.role === "toolResult";
}

test("split never starts the recent slice with an orphaned tool_result", () => {
  // The big tool_use ("a") breaks the size loop, so the natural cut lands on
  // its tool_result at index 2. The boundary guard must back up past that
  // leading tool_result to include its tool_use; otherwise the recent slice
  // would carry a tool_result whose tool_use was summarized away (an orphan).
  const messages: Message[] = [
    userMessage("kick off"), // index 0 — summarized
    bigToolUse("a"), // index 1 — large; loop breaks here
    toolResult("a", "result a"), // index 2 — naive cut lands here (a tool_result)
    toolUse("b"), // index 3
    toolResult("b", "result b"), // index 4
  ];

  const { oldMessages, recentMessages } = splitMessagesForAutoCompact(messages, 4_000);

  assert.equal(startsWithToolResult(recentMessages[0]), false);
  assert.deepEqual(recentMessages[0], messages[1]); // pulled back to the tool_use for "a"
  assert.deepEqual(oldMessages, messages.slice(0, 1));
  assert.deepEqual(recentMessages, messages.slice(1));

  // No messages are lost or duplicated across the split.
  assert.deepEqual([...oldMessages, ...recentMessages], messages);

  // Every tool_result kept raw has its matching tool_use also kept raw.
  const recentToolUseIds = new Set(
    recentMessages.flatMap((message) =>
      message.role === "assistant"
        ? message.content.filter((block) => block.type === "toolCall").map((block) => block.id)
        : [],
    ),
  );
  for (const message of recentMessages) {
    if (message.role !== "toolResult") continue;
    assert.ok(
      recentToolUseIds.has(message.toolCallId),
      `tool_result ${message.toolCallId} kept without its tool_use`,
    );
  }
});

test("split keeps everything recent when nothing exceeds the limit", () => {
  const messages: Message[] = [userMessage("hi"), textMessage("hello")];

  const { oldMessages, recentMessages } = splitMessagesForAutoCompact(messages, 100_000);

  assert.deepEqual(oldMessages, []);
  assert.deepEqual(recentMessages, messages);
});
