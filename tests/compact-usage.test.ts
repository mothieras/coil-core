import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type Anthropic from "@anthropic-ai/sdk";
import { getClient } from "../src/core/config/index.js";
const client = getClient();
import {
  autoCompactIfNeeded,
  contextTokens,
  microCompact,
  trackerFromUsage,
} from "../src/core/context/compact.js";
import { agentLoop } from "../src/core/loop/loop.js";
import { Agent } from "../src/core/agent/agent.js";

type Msg = Anthropic.Messages.MessageParam;

const usage = (fields: Partial<Anthropic.Messages.Usage>): Anthropic.Messages.Usage =>
  ({
    input_tokens: 0,
    output_tokens: 0,
    cache_creation_input_tokens: null,
    cache_read_input_tokens: null,
    ...fields,
  }) as Anthropic.Messages.Usage;

const toolResult = (id: string, text: string): Msg => ({
  role: "user",
  content: [{ type: "tool_result", tool_use_id: id, content: text }],
});

function resultContents(messages: Msg[]): string[] {
  const out: string[] = [];
  for (const msg of messages) {
    if (msg.role !== "user" || !Array.isArray(msg.content)) continue;
    for (const block of msg.content) {
      if (block.type === "tool_result" && typeof block.content === "string") {
        out.push(block.content);
      }
    }
  }
  return out;
}

test("trackerFromUsage sums input, output and both cache token fields", () => {
  const tracker = trackerFromUsage(
    usage({
      input_tokens: 100,
      output_tokens: 50,
      cache_creation_input_tokens: 200,
      cache_read_input_tokens: 1000,
    }),
    7,
  );

  assert.equal(tracker.baseTokens, 1350);
  assert.equal(tracker.coveredCount, 7);
});

test("trackerFromUsage treats null cache fields as zero", () => {
  const tracker = trackerFromUsage(usage({ input_tokens: 10, output_tokens: 5 }), 2);

  assert.equal(tracker.baseTokens, 15);
});

test("contextTokens adds the heuristic only for messages beyond coveredCount", () => {
  const messages: Msg[] = [
    { role: "user", content: "a".repeat(4000) },
    { role: "assistant", content: "b".repeat(4000) },
    { role: "user", content: "tail" },
  ];

  const tokens = contextTokens(messages, { baseTokens: 10_000, coveredCount: 2 });

  const deltaEstimate = Math.ceil(JSON.stringify(messages.slice(2)).length / 4);
  assert.equal(tokens, 10_000 + deltaEstimate);
});

test("contextTokens falls back to the full heuristic when the tracker is stale", () => {
  const messages: Msg[] = [
    { role: "user", content: "only" },
    { role: "assistant", content: "two" },
  ];

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
  const messages: Msg[] = Array.from({ length: 10 }, (_, i) =>
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
  const messages: Msg[] = Array.from({ length: 10 }, (_, i) =>
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
  const originalCreate = client.messages.create;
  client.messages.create = (async (
    _params: Anthropic.Messages.MessageCreateParams,
  ): Promise<Anthropic.Messages.Message> => {
    throw new Error("summary call must not happen");
  }) as typeof client.messages.create;

  const messages: Msg[] = [{ role: "user", content: "y".repeat(250_000) }];

  try {
    const compacted = await autoCompactIfNeeded(messages, dir, {
      baseTokens: 1_000,
      coveredCount: 1,
    });

    assert.equal(compacted, false);
    assert.equal(messages.length, 1);
  } finally {
    client.messages.create = originalCreate;
    await rm(dir, { recursive: true, force: true });
  }
});

test("autoCompactIfNeeded compacts when real usage exceeds the threshold", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "coil-compact-usage-"));
  const originalCreate = client.messages.create;
  client.messages.create = (async (_params: Anthropic.Messages.MessageCreateParams) =>
    ({
      id: "msg_summary",
      type: "message",
      role: "assistant",
      model: "test-model",
      content: [{ type: "text", text: "summary of it all", citations: null }],
      stop_reason: "end_turn",
      stop_sequence: null,
      usage: { input_tokens: 1, output_tokens: 1 },
    }) as unknown as Anthropic.Messages.Message) as typeof client.messages.create;

  const messages: Msg[] = [
    { role: "user", content: "short question" },
    { role: "assistant", content: "short answer" },
  ];

  try {
    const compacted = await autoCompactIfNeeded(messages, dir, {
      baseTokens: 60_000,
      coveredCount: 2,
    });

    assert.equal(compacted, true);
    const first = messages[0];
    assert.ok(first && Array.isArray(first.content));
    const firstBlock = first.content[0];
    assert.ok(firstBlock && firstBlock.type === "text");
    assert.match(firstBlock.text, /\[Conversation compressed\]/);
  } finally {
    client.messages.create = originalCreate;
    await rm(dir, { recursive: true, force: true });
  }
});

test("agentLoop feeds real usage into the next compaction check", async () => {
  // History whose heuristic estimate crosses the auto threshold only after the
  // first response lands — but the response's usage says the real context is
  // tiny, so no summary call may be made before the second model call.
  const originalCreate = client.messages.create;
  const requests: Anthropic.Messages.MessageCreateParams[] = [];

  const bigText = "h".repeat(190_000); // est ~47.5k alone, crosses 50k with response
  const responses: Anthropic.Messages.Message[] = [
    {
      id: "msg_1",
      type: "message",
      role: "assistant",
      model: "test-model",
      content: [
        { type: "text", text: "t".repeat(20_000), citations: null },
        { type: "tool_use", id: "tool_1", name: "noop", input: {} },
      ],
      stop_reason: "tool_use",
      stop_sequence: null,
      usage: {
        input_tokens: 10,
        output_tokens: 20,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 0,
      },
    } as unknown as Anthropic.Messages.Message,
    {
      id: "msg_2",
      type: "message",
      role: "assistant",
      model: "test-model",
      content: [{ type: "text", text: "done", citations: null }],
      stop_reason: "end_turn",
      stop_sequence: null,
      usage: { input_tokens: 12, output_tokens: 2 },
    } as unknown as Anthropic.Messages.Message,
  ];

  client.messages.create = (async (params: Anthropic.Messages.MessageCreateParams) => {
    requests.push(params);
    const response = responses.shift();
    if (!response) throw new Error("unexpected extra model call");
    return response;
  }) as typeof client.messages.create;

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
    messages: [
      { role: "user", content: "kick off" },
      { role: "user", content: bigText },
    ],
  });

  try {
    const result = await agentLoop(agent);

    assert.equal(result.stopReason, "end_turn");
    assert.equal(requests.length, 2);
    for (const request of requests) {
      assert.doesNotMatch(JSON.stringify(request.messages), /Summarize this conversation/);
    }
    const first = agent.messages[0];
    assert.ok(first);
    assert.doesNotMatch(JSON.stringify(first), /\[Conversation compressed\]/);
  } finally {
    client.messages.create = originalCreate;
  }
});
