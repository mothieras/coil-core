import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { Message, ToolResultMessage, Usage } from "@earendil-works/pi-ai";
import {
  autoCompactIfNeeded,
  contextTokens,
  microCompact,
  trackerFromUsage,
} from "../src/core/context/compact.js";
import type { TextGenerator } from "../src/core/providers/index.js";
import { agentLoop } from "../src/core/loop/loop.js";
import { Agent } from "../src/core/agent/agent.js";
import {
  ZERO_USAGE,
  assistantMessage,
  fakeProvider,
  textMessage,
  toolCall,
  usage,
  userMessage,
} from "./helpers/pi.js";

const makeUsage = (fields: Partial<Usage>): Usage => ({ ...ZERO_USAGE, ...fields });

const toolResult = (id: string, text: string): ToolResultMessage => ({
  role: "toolResult",
  toolCallId: id,
  toolName: "bash",
  content: [{ type: "text", text }],
  isError: false,
  timestamp: Date.now(),
});

function resultContents(messages: Message[]): string[] {
  const out: string[] = [];
  for (const message of messages) {
    if (message.role !== "toolResult") continue;
    out.push(
      message.content
        .filter((block) => block.type === "text")
        .map((block) => block.text)
        .join("\n"),
    );
  }
  return out;
}

test("trackerFromUsage sums input, output and both cache token fields", () => {
  const tracker = trackerFromUsage(
    makeUsage({ input: 100, output: 50, cacheWrite: 200, cacheRead: 1000 }),
    7,
  );

  assert.equal(tracker.baseTokens, 1350);
  assert.equal(tracker.coveredCount, 7);
});

test("trackerFromUsage treats absent cache fields as zero", () => {
  const tracker = trackerFromUsage(makeUsage({ input: 10, output: 5 }), 2);

  assert.equal(tracker.baseTokens, 15);
});

test("contextTokens adds the heuristic only for messages beyond coveredCount", () => {
  const messages: Message[] = [
    userMessage("a".repeat(4000)),
    textMessage("b".repeat(4000)),
    userMessage("tail"),
  ];

  const tokens = contextTokens(messages, { baseTokens: 10_000, coveredCount: 2 });

  const deltaEstimate = Math.ceil(JSON.stringify(messages.slice(2)).length / 4);
  assert.equal(tokens, 10_000 + deltaEstimate);
});

test("contextTokens falls back to the full heuristic when the tracker is stale", () => {
  const messages: Message[] = [userMessage("only"), textMessage("two")];

  const withStaleTracker = contextTokens(messages, {
    baseTokens: 1,
    coveredCount: 5,
  });
  const withoutTracker = contextTokens(messages);

  assert.equal(withStaleTracker, withoutTracker);
});

test("microCompact trusts small real usage over a large heuristic estimate", () => {
  // 10 fat tool results push the char/4 estimate far past the micro threshold,
  // but the tracker says the real context is tiny — nothing may be cleared.
  const messages: Message[] = Array.from({ length: 10 }, (_, i) =>
    toolResult(`t${i}`, "x".repeat(20_000)),
  );
  const before = resultContents(messages);

  const cleared = microCompact(messages, {
    baseTokens: 500,
    coveredCount: messages.length,
  });

  assert.equal(cleared, false);
  assert.deepEqual(resultContents(messages), before);
});

test("microCompact clears old results when real usage exceeds the threshold", () => {
  // Tiny heuristic estimate, but the tracker reports a large real context.
  const messages: Message[] = Array.from({ length: 10 }, (_, i) =>
    toolResult(`t${i}`, `result ${i} `.repeat(20)),
  );

  const cleared = microCompact(messages, {
    baseTokens: 40_000,
    coveredCount: messages.length,
  });

  assert.equal(cleared, true);
  const contents = resultContents(messages);
  assert.match(contents[0]!, /\[Previous tool result compacted\]/);
  assert.match(contents[1]!, /\[Previous tool result compacted\]/);
  assert.doesNotMatch(contents[2]!, /compacted/);
});

test("autoCompactIfNeeded skips the summary call when real usage is small", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "coil-compact-usage-"));
  const generate: TextGenerator = async () => {
    throw new Error("summary call must not happen");
  };

  const messages: Message[] = [userMessage("y".repeat(250_000))];

  try {
    const compacted = await autoCompactIfNeeded(
      messages,
      dir,
      { baseTokens: 1_000, coveredCount: 1 },
      generate,
    );

    assert.equal(compacted, false);
    assert.equal(messages.length, 1);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("autoCompactIfNeeded compacts when real usage exceeds the threshold", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "coil-compact-usage-"));
  const generate: TextGenerator = async () => ({
    text: "summary of it all",
    usage: ZERO_USAGE,
  });

  const messages: Message[] = [userMessage("short question"), textMessage("short answer")];

  try {
    const compacted = await autoCompactIfNeeded(
      messages,
      dir,
      { baseTokens: 60_000, coveredCount: 2 },
      generate,
    );

    assert.equal(compacted, true);
    const first = messages[0];
    assert.ok(first && first.role === "user" && typeof first.content === "string");
    assert.match(first.content, /\[Conversation compressed\]/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("agentLoop feeds real usage into the next compaction check", async () => {
  // History whose heuristic estimate crosses the auto threshold only after the
  // first response lands — but the response's usage says the real context is
  // tiny, so no summary call may be made before the second model call.
  const bigText = "h".repeat(190_000); // est ~47.5k alone, crosses 50k with response
  const responses = [
    assistantMessage(
      [{ type: "text", text: "t".repeat(20_000) }, toolCall("noop", {}, "tool_1")],
      "toolUse",
      usage(10, 20),
    ),
    textMessage("done", "stop", usage(12, 2)),
  ];
  const provider = fakeProvider(() => {
    const response = responses.shift();
    if (!response) throw new Error("unexpected extra model call");
    return response;
  });

  const agent = new Agent({
    toolRuntime: {
      getToolDefinitions: () => [],
      invokeTool: async () => "",
    } as never,
    hooks: {
      emitEffect() {},
      triggerControl() {
        return null;
      },
    } as never,
    provider,
    messages: [userMessage("kick off"), userMessage(bigText)],
  });

  const result = await agentLoop(agent);

  assert.equal(result.stopReason, "stop");
  assert.equal(provider.calls.length, 2);
  for (const call of provider.calls) {
    assert.doesNotMatch(JSON.stringify(call.request.messages), /Summarize this conversation/);
  }
  const first = agent.messages[0];
  assert.ok(first);
  assert.doesNotMatch(JSON.stringify(first), /\[Conversation compressed\]/);
});
