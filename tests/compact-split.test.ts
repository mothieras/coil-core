import test from "node:test";
import assert from "node:assert/strict";
import type Anthropic from "@anthropic-ai/sdk";
import { splitMessagesForAutoCompact } from "../src/core/context/compact.js";

type Msg = Anthropic.Messages.MessageParam;

const toolUse = (id: string): Msg => ({
  role: "assistant",
  content: [{ type: "tool_use", id, name: "read_file", input: {} }],
});

const bigToolUse = (id: string): Msg => ({
  role: "assistant",
  content: [{ type: "tool_use", id, name: "read_file", input: { path: "x".repeat(40_000) } }],
});

const toolResult = (id: string, text: string): Msg => ({
  role: "user",
  content: [{ type: "tool_result", tool_use_id: id, content: text }],
});

function startsWithToolResult(msg: Msg | undefined): boolean {
  return (
    msg?.role === "user" &&
    Array.isArray(msg.content) &&
    msg.content.some((block) => block.type === "tool_result")
  );
}

test("split never starts the recent slice with an orphaned tool_result", () => {
  // The big tool_use ("a") breaks the size loop, so the natural cut lands on
  // its tool_result at index 2. The boundary guard must back up past that
  // leading tool_result to include its tool_use; otherwise the recent slice
  // would carry a tool_result whose tool_use was summarized away (an orphan).
  const messages: Msg[] = [
    { role: "user", content: "kick off" }, // index 0 — summarized
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
    recentMessages.flatMap((m) =>
      Array.isArray(m.content)
        ? m.content.filter((b) => b.type === "tool_use").map((b) => (b as { id: string }).id)
        : [],
    ),
  );
  for (const m of recentMessages) {
    if (!Array.isArray(m.content)) continue;
    for (const block of m.content) {
      if (block.type === "tool_result") {
        assert.ok(
          recentToolUseIds.has(block.tool_use_id),
          `tool_result ${block.tool_use_id} kept without its tool_use`,
        );
      }
    }
  }
});

test("split keeps everything recent when nothing exceeds the limit", () => {
  const messages: Msg[] = [
    { role: "user", content: "hi" },
    { role: "assistant", content: "hello" },
  ];

  const { oldMessages, recentMessages } = splitMessagesForAutoCompact(messages, 100_000);

  assert.deepEqual(oldMessages, []);
  assert.deepEqual(recentMessages, messages);
});
