// tests/subagent-runner.test.ts
import test from "node:test";
import assert from "node:assert/strict";
import type Anthropic from "@anthropic-ai/sdk";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { getClient } from "../src/core/config/index.js";
const client = getClient();
import { Agent, currentAgent } from "../src/core/agent/agent.js";
import { SubAgentRunner } from "../src/core/tools/subagent/subagentRunner.js";
import type { SubagentRecord } from "../src/core/tools/subagent/subagentRunner.js";
import type { ToolRuntime } from "../src/core/tools/runtime.js";
import { createAppContext } from "../src/core/app/context.js";
import { AsyncWorkInbox } from "../src/core/async/asyncWorkInbox.js";

function textResponse(text: string): Anthropic.Messages.Message {
  return {
    id: "msg_test",
    type: "message",
    role: "assistant",
    model: "test-model",
    content: [{ type: "text", text, citations: null }],
    stop_reason: "end_turn",
    stop_sequence: null,
    usage: { input_tokens: 1, output_tokens: 1 },
  } as unknown as Anthropic.Messages.Message;
}

function toolUseResponse(name: string, input: Record<string, unknown>): Anthropic.Messages.Message {
  return {
    id: "msg_test",
    type: "message",
    role: "assistant",
    model: "test-model",
    content: [{ type: "tool_use", id: "tu_1", name, input } as Anthropic.Messages.ToolUseBlock],
    stop_reason: "tool_use",
    stop_sequence: null,
    usage: { input_tokens: 1, output_tokens: 1 },
  } as unknown as Anthropic.Messages.Message;
}

// Subagents fork the parent and inherit its toolRuntime; the stub runtime must
// expose definitions for each SUB_AGENT_ALLOWED_TOOLS or selection will throw.
const SUB_TOOL_NAMES = ["bash", "read_file", "write_file", "edit_file"];
function okRuntime(): ToolRuntime {
  const tools = SUB_TOOL_NAMES.map((name) => ({
    name,
    description: `${name} test tool`,
    input_schema: { type: "object" as const, properties: {} },
  }));
  return { getToolDefinitions: () => tools, invokeTool: async () => "" } as never;
}

function parentAgent(runtime: ToolRuntime): Agent {
  return new Agent({ toolRuntime: runtime, workspaceRoot: "/tmp/ws" });
}

async function waitUntilSettled(runner: SubAgentRunner, timeoutMs = 2000) {
  const start = Date.now();
  while (runner.hasRunning() && Date.now() - start < timeoutMs) {
    await new Promise((resolve) => setImmediate(resolve));
  }
}

test("run() returns a sub_id message and registers a running subagent", async () => {
  const original = client.messages.create;
  client.messages.create = (async () =>
    textResponse("done")) as unknown as typeof client.messages.create;
  try {
    const runner = new SubAgentRunner();
    const out = runner.run(parentAgent(okRuntime()), "do X");
    assert.match(out, /Subagent \w+ started: do X/);
    assert.equal(runner.hasRunning(), true);
    await waitUntilSettled(runner);
    assert.equal(runner.hasRunning(), false);
  } finally {
    client.messages.create = original;
  }
});

test("SubAgentRunner emits started and finished records with child run context", async () => {
  const original = client.messages.create;
  client.messages.create = (async () =>
    textResponse("sub done")) as unknown as typeof client.messages.create;
  try {
    const inbox = new AsyncWorkInbox();
    const started: string[] = [];
    const finished: string[] = [];
    inbox.subscribe((n) => {
      const record = n.record as SubagentRecord;
      if (n.status === "running")
        started.push(
          `${record.id}:${record.status}:${record.parentRunId}:${record.parentToolCallId}`,
        );
      else finished.push(`${record.id}:${record.status}:${record.resultSummary}`);
    });
    const runner = new SubAgentRunner(4, undefined, inbox);

    const out = runner.run(parentAgent(okRuntime()), "review docs", {
      sessionId: "s1",
      parentRunId: "run_parent",
      parentToolCallId: "tool_parent",
    });
    const subId = out.match(/Subagent (\w+) started/)![1];

    await waitUntilSettled(runner);

    assert.deepEqual(started, [`${subId}:running:run_parent:tool_parent`]);
    assert.deepEqual(finished, [`${subId}:completed:sub done`]);
  } finally {
    client.messages.create = original;
  }
});

test("interruptRunning marks running subagents interrupted and emits records", async () => {
  const neverRuntime = {
    run: async () => await new Promise<never>(() => {}),
  } as unknown as ConstructorParameters<typeof SubAgentRunner>[1];
  const inbox = new AsyncWorkInbox();
  const finished: string[] = [];
  inbox.subscribe((n) => {
    if (n.status !== "running") finished.push(`${(n.record as SubagentRecord).id}:${n.status}`);
  });
  const runner = new SubAgentRunner(4, neverRuntime, inbox);

  const out = runner.run(parentAgent(okRuntime()), "slow task", {
    sessionId: "s1",
    parentRunId: "run_parent",
    parentToolCallId: "tool_parent",
  });
  const subId = out.match(/Subagent (\w+) started/)![1];
  assert.equal(runner.hasRunning(), true);

  const records = runner.interruptRunning();

  assert.equal(runner.hasRunning(), false);
  assert.equal(records.length, 1);
  assert.equal(records[0]?.id, subId);
  assert.equal(records[0]?.status, "interrupted");
  assert.equal(records[0]?.parentRunId, "run_parent");
  assert.equal(records[0]?.parentToolCallId, "tool_parent");
  assert.deepEqual(finished, [`${subId}:interrupted`]);

  const notifs = inbox.drainNotifications();
  assert.equal(notifs[0]?.status, "interrupted");
});

test("completed subagent reports full untruncated result, then drains once", async () => {
  const original = client.messages.create;
  const big = "R".repeat(1200);
  client.messages.create = (async () =>
    textResponse(big)) as unknown as typeof client.messages.create;
  try {
    const inbox = new AsyncWorkInbox();
    const runner = new SubAgentRunner(undefined, undefined, inbox);
    const out = runner.run(parentAgent(okRuntime()), "do Y");
    const subId = out.match(/Subagent (\w+) started/)![1];
    await waitUntilSettled(runner);

    const notifs = inbox.drainNotifications();
    assert.equal(notifs.length, 1);
    assert.equal(notifs[0]?.id, subId);
    assert.equal(notifs[0]?.status, "completed");
    assert.equal(notifs[0]?.result.length, big.length); // NOT truncated

    assert.deepEqual(inbox.drainNotifications(), []); // drained once
  } finally {
    client.messages.create = original;
  }
});

test("each subagent runs under its own identity, never 'lead' (observed via tool dispatch)", async () => {
  const original = client.messages.create;
  // A silent sub-agent has no hooks, so the tool runtime is the observation
  // point: turn 1 calls a tool (dispatched under the sub's identity), turn 2 ends.
  let calls = 0;
  client.messages.create = (async () => {
    calls += 1;
    return calls === 1 ? toolUseResponse("bash", {}) : textResponse("done");
  }) as unknown as typeof client.messages.create;

  let observed: string | undefined;
  const runtime = {
    getToolDefinitions: () =>
      SUB_TOOL_NAMES.map((name) => ({
        name,
        description: `${name} test tool`,
        input_schema: { type: "object" as const, properties: {} },
      })),
    invokeTool: async () => {
      observed = currentAgent.getStore()?.id;
      return "";
    },
  } as never;

  try {
    const runner = new SubAgentRunner();
    const out = runner.run(parentAgent(runtime), "do Z");
    const subId = out.match(/Subagent (\w+) started/)![1];
    await waitUntilSettled(runner);
    assert.ok(observed);
    assert.notEqual(observed, "lead");
    assert.equal(observed, subId);
  } finally {
    client.messages.create = original;
  }
});

test("a rejecting subagent settles as error and never crashes the process", async () => {
  const explodingRuntime = {
    getToolDefinitions: () => {
      throw new Error("boom");
    },
    invokeTool: async () => "",
  } as never;
  const inbox = new AsyncWorkInbox();
  const runner = new SubAgentRunner(undefined, undefined, inbox);
  const out = runner.run(parentAgent(explodingRuntime), "do W");
  const subId = out.match(/Subagent (\w+) started/)![1];
  await waitUntilSettled(runner);

  const notifs = inbox.drainNotifications();
  assert.equal(notifs.length, 1);
  assert.equal(notifs[0]?.id, subId);
  assert.equal(notifs[0]?.status, "error");
  assert.match(notifs[0]?.result ?? "", /Error: boom/);
});

test("run() refuses to exceed the concurrency cap", async () => {
  const original = client.messages.create;
  client.messages.create = (async () =>
    textResponse("done")) as unknown as typeof client.messages.create;
  try {
    const runner = new SubAgentRunner(1);
    const parent = parentAgent(okRuntime());
    const first = runner.run(parent, "a");
    const second = runner.run(parent, "b");
    assert.match(first, /started/);
    assert.match(second, /Error: too many running subagents/);
    await waitUntilSettled(runner);
  } finally {
    client.messages.create = original;
  }
});

test("hasRunning() reflects in-flight subagents", async () => {
  const original = client.messages.create;
  client.messages.create = (async () =>
    textResponse("done")) as unknown as typeof client.messages.create;
  try {
    const runner = new SubAgentRunner();
    assert.equal(runner.hasRunning(), false);
    runner.run(parentAgent(okRuntime()), "alpha");
    assert.equal(runner.hasRunning(), true);
    await waitUntilSettled(runner);
    assert.equal(runner.hasRunning(), false);
  } finally {
    client.messages.create = original;
  }
});

test("createAppContext exposes an idle SubAgentRunner", async () => {
  const workspace = await mkdtemp(path.join(tmpdir(), "subrunner-"));
  try {
    const app = createAppContext(workspace);
    assert.ok(app.subAgentRunner instanceof SubAgentRunner);
    assert.equal(app.subAgentRunner.hasRunning(), false);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});
