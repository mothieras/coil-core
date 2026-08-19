import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type Anthropic from "@anthropic-ai/sdk";
import { getClient, getModel } from "../src/core/config/index.js";
const client = getClient();
import {
  decideRecovery,
  extractRetryAfterMs,
  initialRecoveryState,
  MAX_RETRIES,
  retryDelay,
} from "../src/core/loop/recovery.js";
import { agentLoop } from "../src/core/loop/loop.js";
import { Agent } from "../src/core/agent/agent.js";
import type { ToolDefinition } from "../src/core/tools/types.js";

function textResponse(
  text: string,
  stopReason: Anthropic.Messages.Message["stop_reason"],
): Anthropic.Messages.Message {
  return {
    id: "msg_test",
    type: "message",
    role: "assistant",
    model: "test-model",
    content: [{ type: "text", text, citations: null }],
    stop_reason: stopReason,
    stop_sequence: null,
    usage: { input_tokens: 1, output_tokens: 1 },
  } as unknown as Anthropic.Messages.Message;
}

const emptyRuntime = {
  getToolDefinitions: () => [],
  invokeTool: async () => "",
};

function toolDefinition(name: string): ToolDefinition {
  return {
    name,
    description: `${name} test tool`,
    input_schema: {
      type: "object",
      properties: {},
    },
  };
}

test("retryDelay returns millisecond delays", () => {
  const originalRandom = Math.random;
  Math.random = () => 0;
  try {
    assert.equal(retryDelay(0), 500);
    assert.equal(retryDelay(1), 1000);
  } finally {
    Math.random = originalRandom;
  }
});

test("extractRetryAfterMs parses retry headers as milliseconds", () => {
  assert.equal(
    extractRetryAfterMs({
      headers: new Headers({ "retry-after-ms": "2500" }),
    }),
    2500,
  );
  assert.equal(
    extractRetryAfterMs({
      headers: new Headers({ "retry-after": "30" }),
    }),
    30_000,
  );
  assert.equal(
    extractRetryAfterMs(
      {
        headers: new Headers({
          "retry-after": "Wed, 27 May 2026 12:00:30 GMT",
        }),
      },
      Date.parse("Wed, 27 May 2026 12:00:00 GMT"),
    ),
    30_000,
  );
  assert.equal(
    extractRetryAfterMs({
      headers: new Headers({ "retry-after": "0" }),
    }),
    0,
  );
});

test("decideRecovery respects Retry-After on rate limits", () => {
  const action = decideRecovery(
    {
      kind: "error",
      error: {
        status: 429,
        message: "rate limited",
        headers: new Headers({ "retry-after": "30" }),
      },
    },
    initialRecoveryState(),
  );

  assert.equal(action.type, "backoff_and_retry");
  assert.equal(action.delayMs, 30_000);
});

test("decideRecovery does not treat generic prompt or numeric messages as recoverable", () => {
  assert.equal(
    decideRecovery(
      {
        kind: "error",
        error: { status: 400, message: "invalid prompt role" },
      },
      initialRecoveryState(),
    ).type,
    "abort",
  );
  assert.equal(
    decideRecovery(
      {
        kind: "error",
        error: { message: "processed 529 records" },
      },
      initialRecoveryState(),
    ).type,
    "abort",
  );
  assert.equal(
    decideRecovery(
      {
        kind: "error",
        error: { message: "not overloaded" },
      },
      initialRecoveryState(),
    ).type,
    "abort",
  );
});

test("decideRecovery retries transient network errors before aborting", () => {
  const action = decideRecovery(
    { kind: "error", error: { code: "ECONNRESET", message: "socket hang up" } },
    initialRecoveryState(),
  );

  assert.equal(action.type, "backoff_and_retry");
  assert.equal(action.nextState.retryAttempt, 1);
});

test("decideRecovery aborts transient network errors after retry budget", () => {
  const action = decideRecovery(
    { kind: "error", error: { code: "ETIMEDOUT", message: "timeout" } },
    { ...initialRecoveryState(), retryAttempt: MAX_RETRIES },
  );

  assert.equal(action.type, "abort");
  assert.match(action.message, /Max retries/);
});

test("decideRecovery switches model after three consecutive overloads", () => {
  const action = decideRecovery(
    { kind: "error", error: { status: 529, message: "overloaded" } },
    { ...initialRecoveryState(), consecutive529: 2 },
    { fallbackModel: "fallback-model" },
  );

  assert.equal(action.type, "backoff_and_retry");
  assert.equal(action.nextModel, "fallback-model");
});

test("agentLoop resets max_tokens after successful recovery", async () => {
  const originalCreate = client.messages.create;
  const requestedMaxTokens: number[] = [];
  const responses = [
    textResponse("partial", "max_tokens"),
    textResponse("done after retry", "end_turn"),
    textResponse("fresh turn", "end_turn"),
  ];
  let stopHookCalls = 0;

  client.messages.create = (async (params: Anthropic.Messages.MessageCreateParams) => {
    requestedMaxTokens.push(params.max_tokens);
    const response = responses.shift();
    if (!response) throw new Error("unexpected extra model call");
    return response;
  }) as typeof client.messages.create;

  try {
    const result = await agentLoop(
      new Agent({
        toolRuntime: emptyRuntime as never,
        hooks: {
          emitEffect() {},
          triggerControl(event: string) {
            if (event !== "Stop") return null;
            stopHookCalls += 1;
            return stopHookCalls === 1 ? "continue once" : null;
          },
        } as never,
        messages: [{ role: "user", content: "hello" }],
      }),
    );

    assert.equal(result.stopReason, "end_turn");
    assert.deepEqual(requestedMaxTokens, [8000, 64000, 8000]);
  } finally {
    client.messages.create = originalCreate;
  }
});

test("agentLoop retries transient network errors without consuming turns", async () => {
  const originalCreate = client.messages.create;
  const requestedMaxTokens: number[] = [];

  client.messages.create = (async (params: Anthropic.Messages.MessageCreateParams) => {
    requestedMaxTokens.push(params.max_tokens);
    if (requestedMaxTokens.length === 1) {
      throw {
        code: "ECONNRESET",
        message: "socket hang up",
        headers: new Headers({ "retry-after-ms": "1" }),
      };
    }
    return textResponse("network recovered", "end_turn");
  }) as typeof client.messages.create;

  try {
    const result = await agentLoop(
      new Agent({
        toolRuntime: emptyRuntime as never,
        maxTurns: 1,
        messages: [{ role: "user", content: "hello" }],
      }),
    );

    assert.equal(result.stopReason, "end_turn");
    assert.deepEqual(requestedMaxTokens, [8000, 8000]);
  } finally {
    client.messages.create = originalCreate;
  }
});

test("agentLoop uses fallback model after three consecutive overloads", async () => {
  const originalCreate = client.messages.create;
  const originalFallbackModel = process.env.FALLBACK_MODEL_ID;
  const requestedModels: unknown[] = [];
  process.env.FALLBACK_MODEL_ID = "fallback-model";

  client.messages.create = (async (params: Anthropic.Messages.MessageCreateParams) => {
    requestedModels.push(params.model);
    if (requestedModels.length <= 3) {
      throw {
        status: 529,
        message: "overloaded",
        headers: new Headers({ "retry-after-ms": "1" }),
      };
    }
    return textResponse("fallback ok", "end_turn");
  }) as typeof client.messages.create;

  try {
    const result = await agentLoop(
      new Agent({
        toolRuntime: emptyRuntime as never,
        messages: [{ role: "user", content: "hello" }],
      }),
    );

    assert.equal(result.stopReason, "end_turn");
    assert.deepEqual(requestedModels, [getModel(), getModel(), getModel(), "fallback-model"]);
  } finally {
    client.messages.create = originalCreate;
    if (originalFallbackModel === undefined) {
      delete process.env.FALLBACK_MODEL_ID;
    } else {
      process.env.FALLBACK_MODEL_ID = originalFallbackModel;
    }
  }
});

test("agentLoop returns an error result when reactive compaction fails", async () => {
  const originalCreate = client.messages.create;
  const workspace = await mkdtemp(path.join(tmpdir(), "agent-compact-"));
  let calls = 0;

  client.messages.create = (async () => {
    calls += 1;
    if (calls === 1) {
      throw {
        status: 400,
        message: "prompt is too long",
        headers: new Headers(),
      };
    }
    throw {
      code: "ECONNRESET",
      message: "summary call reset",
      headers: new Headers(),
    };
  }) as unknown as typeof client.messages.create;

  try {
    const result = await agentLoop(
      new Agent({
        toolRuntime: emptyRuntime as never,
        workspaceRoot: workspace,
        messages: [{ role: "user", content: "hello" }],
      }),
    );

    assert.equal(result.stopReason, "error");
    assert.match(
      result.content.find((block) => block.type === "text")?.text ?? "",
      /Compaction failed/,
    );
  } finally {
    client.messages.create = originalCreate;
    await rm(workspace, { recursive: true, force: true });
  }
});

test("agentLoop uses the runtime's tool definitions when the agent sets no allowedTools", async () => {
  const originalCreate = client.messages.create;
  const fallbackTool = toolDefinition("fallback_tool");
  let observedTools: Anthropic.Messages.MessageCreateParams["tools"];

  client.messages.create = (async (params: Anthropic.Messages.MessageCreateParams) => {
    observedTools = params.tools;
    return textResponse("done", "end_turn");
  }) as typeof client.messages.create;

  const runtime = {
    getToolDefinitions: () => [fallbackTool],
    invokeTool: async () => "",
  };

  try {
    const result = await agentLoop(
      new Agent({
        toolRuntime: runtime as never,
        messages: [{ role: "user", content: "hello" }],
      }),
    );

    assert.equal(result.stopReason, "end_turn");
    assert.deepEqual(observedTools!, [fallbackTool]);
  } finally {
    client.messages.create = originalCreate;
  }
});

test("agentLoop rejects unknown allowed tools instead of silently filtering", async () => {
  const fallbackTool = toolDefinition("fallback_tool");
  const runtime = {
    getToolDefinitions: (allowedTools?: readonly string[]) => {
      if (allowedTools) {
        const missing = allowedTools.filter((n) => n !== "fallback_tool");
        if (missing.length > 0) throw new Error(`Unknown allowed tool(s): ${missing.join(", ")}`);
      }
      return [fallbackTool];
    },
    invokeTool: async () => "",
  };

  await assert.rejects(
    () =>
      agentLoop(
        new Agent({
          toolRuntime: runtime as never,
          allowedTools: ["fallback_tool", "missing_tool"],
          messages: [{ role: "user", content: "hello" }],
        }),
      ),
    /Unknown allowed tool\(s\): missing_tool/,
  );
});

test("agentLoop returns thrown tool errors as tool_result content", async () => {
  const originalCreate = client.messages.create;
  const userMessages: Anthropic.Messages.MessageParam[] = [];
  let calls = 0;

  client.messages.create = (async (params: Anthropic.Messages.MessageCreateParams) => {
    calls += 1;
    userMessages.push(...params.messages.filter((msg) => msg.role === "user"));
    if (calls === 1) {
      return {
        ...textResponse("", "tool_use"),
        content: [
          {
            type: "tool_use",
            id: "toolu_test",
            name: "explode",
            input: {},
          },
        ],
      };
    }
    return textResponse("handled tool error", "end_turn");
  }) as typeof client.messages.create;

  const toolRuntime = {
    getToolDefinitions: () => [],
    invokeTool: async () => {
      throw new Error("tool blew up");
    },
  };

  try {
    const result = await agentLoop(
      new Agent({
        toolRuntime: toolRuntime as never,
        messages: [{ role: "user", content: "hello" }],
      }),
    );

    assert.equal(result.stopReason, "end_turn");
    const toolResultMessage = userMessages.find(
      (msg) =>
        Array.isArray(msg.content) && msg.content.some((block) => block.type === "tool_result"),
    );
    assert.ok(toolResultMessage);
    assert.match(JSON.stringify(toolResultMessage), /Error: tool blew up/);
  } finally {
    client.messages.create = originalCreate;
  }
});

test("decideRecovery aborts instead of continuing truncated tool_use output", () => {
  const response = {
    ...textResponse("", "max_tokens"),
    content: [
      {
        type: "tool_use",
        id: "toolu_partial",
        name: "bash",
        input: {},
      },
    ],
  } as Anthropic.Messages.Message;

  const action = decideRecovery(
    { kind: "success", response },
    { ...initialRecoveryState(), hasEscalated: true },
  );

  assert.equal(action.type, "abort");
  assert.match(action.message, /truncated.*tool_use/i);
});
