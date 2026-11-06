import { testToolInvoker } from "./helpers/tools.js";
import test from "node:test";
import assert from "node:assert/strict";
import { Agent } from "../src/core/agent/agent.js";
import { AgentRuntime } from "../src/core/agent/runtime.js";
import { createAgentRun } from "../src/core/agent/run.js";
import { ExecutionStoppedError } from "../src/core/loop/cancellation.js";
import { fakeProvider, textMessage, toolCallMessage, toolCall } from "./helpers/pi.js";

const runRecord = () =>
  createAgentRun({ agentId: "lead", agentKind: "lead", trigger: { type: "user_message" } });

test("cancel a tool batch: retain prior results, skip later tools and continue with paired messages", async () => {
  const entered = Promise.withResolvers<void>();
  const result = Promise.withResolvers<string>();
  let invocations = 0;
  let modelCalls = 0;
  const agent = new Agent({
    toolRuntime: {
      getToolDefinitions: () => [],
      invokeTool: testToolInvoker(async (name: string) => {
        invocations++;
        if (name === "prepared") return { status: "completed", output: await "kept result" };
        entered.resolve();
        return { status: "completed", output: await result.promise };
      }),
    } as never,
    provider: fakeProvider(() =>
      ++modelCalls === 1
        ? toolCallMessage([
            toolCall("prepared", {}, "kept"),
            toolCall("first", {}, "one"),
            toolCall("second", {}, "two"),
          ])
        : textMessage("continued"),
    ),
  });
  const runtime = new AgentRuntime();
  const run = runRecord();
  const pending = runtime.run(agent, run);
  await entered.promise;
  const cancelled = runtime.cancelRun(run.id);
  result.resolve("late success");
  await pending;
  await cancelled;
  assert.equal(invocations, 2);
  assert.equal(modelCalls, 1);
  const results = agent.messages.filter((message) => message.role === "toolResult");
  assert.deepEqual(
    results.map((message) => message.toolCallId),
    ["kept", "one", "two"],
  );
  assert.equal(results[0]?.isError, false);
  assert.match(JSON.stringify(results[0]), /kept result/);
  assert.ok(results.slice(1).every((message) => message.isError));
  assert.match(JSON.stringify(results[1]), /结果未知/);
  assert.match(JSON.stringify(results[2]), /未执行/);
  await runtime.run(agent, runRecord());
  assert.equal(modelCalls, 2);
});

test("permission cancellation rejects a late allow without dispatch", async () => {
  const entered = Promise.withResolvers<void>();
  const allowed = Promise.withResolvers<{ allowed: boolean }>();
  let invoked = 0;
  const agent = new Agent({
    toolRuntime: {
      getToolDefinitions: () => [],
      invokeTool: testToolInvoker(async () => {
        invoked++;
        return { status: "completed", output: await "bad" };
      }),
    } as never,
    provider: fakeProvider(() => toolCallMessage([toolCall("bash", {}, "permission")])),
    checkPermission: async () => {
      entered.resolve();
      return allowed.promise;
    },
  });
  const runtime = new AgentRuntime();
  const run = runRecord();
  const pending = runtime.run(agent, run);
  await entered.promise;
  const cancelled = runtime.cancelRun(run.id);
  allowed.resolve({ allowed: true });
  await pending;
  await cancelled;
  assert.equal(invoked, 0);
});

test(
  "uncooperative handler remains unconfirmed and holds Agent ownership until actual settlement",
  { timeout: 10_000 },
  async () => {
    const entered = Promise.withResolvers<void>();
    const result = Promise.withResolvers<string>();
    const runtime = new AgentRuntime();
    const agent = new Agent({
      toolRuntime: {
        getToolDefinitions: () => [],
        invokeTool: testToolInvoker(async () => {
          entered.resolve();
          return { status: "completed", output: await result.promise };
        }),
      } as never,
      provider: fakeProvider(() => toolCallMessage([toolCall("remote", {}, "remote")])),
    });
    const run = runRecord();
    const pending = runtime.run(agent, run);
    await entered.promise;
    await runtime.cancelRun(run.id, "user", Date.now());
    await pending;
    assert.equal(run.cleanup?.status, "unconfirmed");
    assert.deepEqual(run.cleanup?.resources, ["tool:remote"]);
    await assert.rejects(runtime.run(agent, runRecord()), /active run/);
    const messages = structuredClone(agent.messages);
    result.resolve("late");
    await result.promise;
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(agent.messages, messages);
    assert.equal(run.status, "interrupted");
  },
);

test("cooperative handler receives the signal and cancellation is a control outcome", async () => {
  const entered = Promise.withResolvers<void>();
  const agent = new Agent({
    toolRuntime: {
      getToolDefinitions: () => [],
      invokeTool: testToolInvoker(async (_name, _input, context) => {
        entered.resolve();
        return {
          status: "completed",
          output: await new Promise<string>((_resolve, reject) =>
            context!.signal!.addEventListener("abort", () => reject(new ExecutionStoppedError()), {
              once: true,
            }),
          ),
        };
      }),
    } as never,
    provider: fakeProvider(() => toolCallMessage([toolCall("wait", {}, "wait")])),
  });
  const runtime = new AgentRuntime();
  const run = runRecord();
  const pending = runtime.run(agent, run);
  await entered.promise;
  await runtime.cancelRun(run.id);
  await pending;
  assert.equal(run.cleanup?.status, "confirmed");
});
