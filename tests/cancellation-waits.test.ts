import { testToolInvoker } from "./helpers/tools.js";
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { Agent } from "../src/core/agent/agent.js";
import { AgentRuntime } from "../src/core/agent/runtime.js";
import { createAgentRun } from "../src/core/agent/run.js";
import { createRuntimeLifecycleCollector } from "../src/core/agent/lifecycle.js";
import { ExecutionScope, ExecutionStoppedError } from "../src/core/loop/cancellation.js";
import { createPermissionBridge } from "../src/tui/permissionBridge.js";
import { fakeProvider, textMessage, userMessage } from "./helpers/pi.js";

const emptyRuntime = {
  getToolDefinitions: () => [],
  invokeTool: testToolInvoker(async () => ({ status: "completed", output: await "" })),
} as never;
const record = () =>
  createAgentRun({ agentId: "lead", agentKind: "lead", trigger: { type: "user_message" } });

test("nested waits preserve a consumer's stop uncertainty after the operation settles", async () => {
  const scope = new ExecutionScope();
  const operation = new Promise<never>((_resolve, reject) => {
    scope.signal.addEventListener(
      "abort",
      () => reject(new ExecutionStoppedError("aborted", "remote", "unconfirmed")),
      { once: true },
    );
  });
  const stopped = assert.rejects(scope.wait(scope.wait(operation, "remote"), "tool"));
  scope.controller.abort(new ExecutionStoppedError());
  await stopped;
  await scope.settled();
  const cleanup = await scope.cleanup(Date.now());
  assert.equal(cleanup.status, "unconfirmed");
  assert.deepEqual(cleanup.resources, []);
  assert.deepEqual(cleanup.errors, [
    "remote: ExecutionStoppedError: Execution stopped: aborted (remote); stop unconfirmed",
  ]);
});

test("cancelled backoff has no later model retries", async () => {
  const called = Promise.withResolvers<void>();
  let calls = 0;
  const agent = new Agent({
    toolRuntime: emptyRuntime,
    provider: fakeProvider(() => {
      calls++;
      called.resolve();
      throw Object.assign(new Error("rate limited"), { status: 429, headers: { get: () => "60" } });
    }),
  });
  const runtime = new AgentRuntime();
  const run = record();
  const pending = runtime.run(agent, run);
  await called.promise;
  // Let the response rejection enter the retry wait; no wall-clock sleep.
  await new Promise((resolve) => setImmediate(resolve));
  await runtime.cancelRun(run.id);
  await pending;
  assert.equal(calls, 1);
  assert.equal(run.cleanup?.status, "confirmed");
});

test(
  "deadline aborts its provider and remains timeout when user cancellation follows",
  { timeout: 2_000 },
  async () => {
    const aborted = Promise.withResolvers<void>();
    const collector = createRuntimeLifecycleCollector();
    const runtime = new AgentRuntime(collector);
    const agent = new Agent({
      timeoutMs: 10,
      toolRuntime: emptyRuntime,
      provider: fakeProvider(
        (_request, call) =>
          new Promise((_resolve, reject) => {
            call.options?.signal?.addEventListener(
              "abort",
              () => {
                aborted.resolve();
                reject(call.options?.signal?.reason);
              },
              { once: true },
            );
          }),
      ),
    });
    const run = record();
    const pending = runtime.run(agent, run);
    await aborted.promise;
    await runtime.cancelRun(run.id);
    await pending;
    assert.equal(run.status, "interrupted");
    assert.equal(run.stopReason, "timeout");
    assert.equal(run.stopSource, "deadline");
    assert.equal(run.cleanup?.status, "confirmed");
    assert.equal(collector.events.filter((event) => event.type === "agent_run_finished").length, 1);
  },
);

test("run compaction cancellation cannot overwrite the stopped conversation", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "coil-compact-cancel-"));
  const entered = Promise.withResolvers<void>();
  const response = Promise.withResolvers<ReturnType<typeof textMessage>>();
  const provider = fakeProvider((_request, call) => {
    assert.ok(call.options?.signal);
    entered.resolve();
    return response.promise;
  });
  const agent = new Agent({
    workspaceRoot: dir,
    toolRuntime: emptyRuntime,
    provider,
    messages: [userMessage("x".repeat(210_000))],
  });
  const before = structuredClone(agent.messages);
  const run = record();
  const runtime = new AgentRuntime();
  try {
    const pending = runtime.run(agent, run);
    await entered.promise;
    const stopped = runtime.cancelRun(run.id);
    response.resolve(textMessage("late summary"));
    await stopped;
    await pending;
    assert.deepEqual(agent.messages, before);
    assert.equal(provider.calls.length, 1);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("permission cancellation removes only its queued request and ignores a late allow", async () => {
  const bridge = createPermissionBridge();
  const abort = new AbortController();
  const first = bridge.request("bash", {}, "first", { signal: abort.signal });
  const firstId = bridge.current()!.id;
  const second = bridge.request("write_file", {}, "second");
  abort.abort();
  assert.equal(await first, false);
  assert.equal(bridge.current()?.toolName, "write_file");
  bridge.resolve(firstId, true);
  assert.equal(bridge.current()?.toolName, "write_file");
  bridge.resolve(bridge.current()!.id, true);
  assert.equal(await second, true);
  assert.equal(bridge.current(), null);
});
