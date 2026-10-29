import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { AssistantMessage, StopReason } from "@earendil-works/pi-ai";
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
import {
  assistantMessage,
  fakeProvider,
  testModel,
  textMessage,
  toolCall,
  toolCallMessage,
  userMessage,
} from "./helpers/pi.js";

function textResponse(text: string, stopReason: StopReason): AssistantMessage {
  return textMessage(text, stopReason);
}

const emptyRuntime = {
  getToolDefinitions: () => [],
  invokeTool: async () => "",
};

function toolDefinition(name: string): ToolDefinition {
  return {
    name,
    description: `${name} test tool`,
    parameters: {
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

test("decideRecovery retries pi-ai transport messages without an error code", () => {
  const action = decideRecovery(
    { kind: "error", error: new Error("fetch failed") },
    initialRecoveryState(),
  );

  assert.equal(action.type, "backoff_and_retry");
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
  const fallback = testModel("fallback-model");
  const action = decideRecovery(
    { kind: "error", error: { status: 529, message: "overloaded" } },
    { ...initialRecoveryState(), consecutive529: 2 },
    { fallbackModel: fallback },
  );

  assert.equal(action.type, "backoff_and_retry");
  assert.equal(action.nextModel?.id, "fallback-model");
});

test("agentLoop resets max_tokens after successful recovery", async () => {
  const requestedMaxTokens: number[] = [];
  const responses = [
    textResponse("partial", "length"),
    textResponse("done after retry", "stop"),
    textResponse("fresh turn", "stop"),
  ];
  let stopHookCalls = 0;

  const provider = fakeProvider((_request, call) => {
    requestedMaxTokens.push(call.options?.maxTokens ?? -1);
    const response = responses.shift();
    if (!response) throw new Error("unexpected extra model call");
    return response;
  });

  const result = await agentLoop(
    new Agent({
      toolRuntime: emptyRuntime as never,
      provider,
      hooks: {
        emitEffect() {},
        triggerControl(event: string) {
          if (event !== "Stop") return null;
          stopHookCalls += 1;
          return stopHookCalls === 1 ? "continue once" : null;
        },
      } as never,
      messages: [userMessage("hello")],
    }),
  );

  assert.equal(result.stopReason, "stop");
  assert.deepEqual(requestedMaxTokens, [8000, 64000, 8000]);
});

test("agentLoop retries transient network errors without consuming turns", async () => {
  const requestedMaxTokens: number[] = [];

  const provider = fakeProvider((_request, call) => {
    requestedMaxTokens.push(call.options?.maxTokens ?? -1);
    if (requestedMaxTokens.length === 1) {
      throw {
        code: "ECONNRESET",
        message: "socket hang up",
        headers: new Headers({ "retry-after-ms": "1" }),
      };
    }
    return textResponse("network recovered", "stop");
  });

  const result = await agentLoop(
    new Agent({
      toolRuntime: emptyRuntime as never,
      provider,
      maxTurns: 1,
      messages: [userMessage("hello")],
    }),
  );

  assert.equal(result.stopReason, "stop");
  assert.deepEqual(requestedMaxTokens, [8000, 8000]);
});

test("agentLoop uses fallback model after three consecutive overloads", async () => {
  const fallback = testModel("fallback-model");

  const provider = fakeProvider(
    () => {
      if (provider.calls.length <= 3) {
        throw {
          status: 529,
          message: "overloaded",
          headers: new Headers({ "retry-after-ms": "1" }),
        };
      }
      return textResponse("fallback ok", "stop");
    },
    { fallbackModel: fallback },
  );

  const result = await agentLoop(
    new Agent({
      toolRuntime: emptyRuntime as never,
      provider,
      messages: [userMessage("hello")],
    }),
  );

  assert.equal(result.stopReason, "stop");
  assert.deepEqual(
    provider.calls.map((call) => call.model.id),
    ["test-model", "test-model", "test-model", "fallback-model"],
  );
});

test("agentLoop returns an error result when reactive compaction fails", async () => {
  const workspace = await mkdtemp(path.join(tmpdir(), "agent-compact-"));
  let calls = 0;

  const provider = fakeProvider(() => {
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
  });

  try {
    const result = await agentLoop(
      new Agent({
        toolRuntime: emptyRuntime as never,
        provider,
        workspaceRoot: workspace,
        messages: [userMessage("hello")],
      }),
    );

    assert.equal(result.stopReason, "error");
    assert.match(
      result.content.find((block) => block.type === "text")?.text ?? "",
      /Compaction failed/,
    );
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("agentLoop uses the runtime's tool definitions when the agent sets no allowedTools", async () => {
  const fallbackTool = toolDefinition("fallback_tool");
  let observedTools: unknown;

  const provider = fakeProvider((request) => {
    observedTools = request.tools;
    return textResponse("done", "stop");
  });

  const runtime = {
    getToolDefinitions: () => [fallbackTool],
    invokeTool: async () => "",
  };

  const result = await agentLoop(
    new Agent({
      toolRuntime: runtime as never,
      provider,
      messages: [userMessage("hello")],
    }),
  );

  assert.equal(result.stopReason, "stop");
  assert.deepEqual(observedTools, [fallbackTool]);
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
          provider: fakeProvider(() => textResponse("unused", "stop")),
          allowedTools: ["fallback_tool", "missing_tool"],
          messages: [userMessage("hello")],
        }),
      ),
    /Unknown allowed tool\(s\): missing_tool/,
  );
});

test("agentLoop returns thrown tool errors as toolResult content", async () => {
  const seenMessages: unknown[] = [];

  const provider = fakeProvider((request) => {
    seenMessages.push(request.messages);
    if (seenMessages.length === 1) {
      return toolCallMessage([toolCall("explode", {}, "toolu_test")]);
    }
    return textResponse("handled tool error", "stop");
  });

  const toolRuntime = {
    getToolDefinitions: () => [],
    invokeTool: async () => {
      throw new Error("tool blew up");
    },
  };

  const result = await agentLoop(
    new Agent({
      toolRuntime: toolRuntime as never,
      provider,
      messages: [userMessage("hello")],
    }),
  );

  assert.equal(result.stopReason, "stop");
  const lastMessages = seenMessages.at(-1) as Array<{ role: string }>;
  const toolResult = lastMessages.find((message) => message.role === "toolResult");
  assert.ok(toolResult);
  assert.match(JSON.stringify(toolResult), /Error: tool blew up/);
});

test("decideRecovery aborts instead of continuing truncated toolCall output", () => {
  const response = assistantMessage([toolCall("bash", {}, "toolu_partial")], "length");

  const action = decideRecovery(
    { kind: "success", response },
    { ...initialRecoveryState(), hasEscalated: true },
  );

  assert.equal(action.type, "abort");
  assert.match(action.message, /truncated.*toolCall/i);
});
