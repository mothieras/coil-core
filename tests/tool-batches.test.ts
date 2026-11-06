import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Agent } from "../src/core/agent/agent.js";
import { AgentRuntime } from "../src/core/agent/runtime.js";
import { createAgentRun } from "../src/core/agent/run.js";
import { agentLoop } from "../src/core/loop/loop.js";
import { createRuntimeLifecycleCollector } from "../src/core/agent/lifecycle.js";
import { ExecutionStoppedError } from "../src/core/loop/cancellation.js";
import { ToolRuntime } from "../src/core/tools/runtime.js";
import { ToolRegistry } from "../src/core/tools/registry.js";
import { ToolInvocationError } from "../src/core/tools/errors.js";
import { builtinTool, type ToolExecutionResult } from "../src/core/tools/types.js";
import { TaskManager } from "../src/core/tools/task/taskManager.js";
import { createUpdateTasksTool } from "../src/core/tools/task/updateTasks.js";
import { BackgroundManager } from "../src/core/tools/background/backgroundManager.js";
import { HookBus } from "../src/core/hooks/hookBus.js";
import { SessionController } from "../src/core/session/controller.js";
import { buildSessionReport } from "../src/core/session/report.js";
import { fakeProvider, toolCall, toolCallMessage, textMessage } from "./helpers/pi.js";

async function fixture(t: { after(fn: () => Promise<void>): void }) {
  const dir = await mkdtemp(path.join(tmpdir(), "tool-batch-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const registry = new ToolRegistry();
  const manager = new TaskManager(path.join(dir, "tasks"));
  const runtime = new ToolRuntime({
    registry,
    taskManager: manager,
    backgroundManager: new BackgroundManager(dir),
  });
  return { dir, registry, runtime, manager };
}
const runRecord = () =>
  createAgentRun({ agentId: "lead", agentKind: "lead", trigger: { type: "user_message" } });

test("real runtime gates a mixed batch and gives the next model complete correlated results", async (t) => {
  const { registry, runtime } = await fixture(t);
  const order: string[] = [];
  const post: string[] = [];
  const hooks = new HookBus();
  hooks.register("PostToolUse", (call) => {
    post.push(call.name);
  });
  hooks.register("PreToolUse", (call) => {
    order.push(`hook:${call.name}`);
    return call.name === "admin" ? "administratively blocked" : null;
  });
  for (const name of ["ok", "failure", "invalid", "deny", "admin", "scope"]) {
    registry.register(
      builtinTool(
        {
          name,
          description: name,
          parameters: { type: "object", properties: { n: { type: "integer" } }, required: ["n"] },
        },
        () => {
          order.push(`handler:${name}`);
          return name === "failure"
            ? { status: "error", output: "no prefix here" }
            : { status: "completed", output: "Error: this is normal output" };
        },
      ),
    );
  }
  const names = ["ok", "deny", "failure", "invalid", "admin", "scope", "missing"];
  let calls = 0;
  const collector = createRuntimeLifecycleCollector();
  const agent = new Agent({
    toolRuntime: runtime,
    hooks,
    allowedTools: names.filter((name) => name !== "scope" && name !== "missing"),
    checkPermission: async (context) => {
      order.push(`permission:${context.toolName}`);
      return { allowed: context.toolName !== "deny" };
    },
    provider: fakeProvider((request) => {
      if (++calls === 1)
        return toolCallMessage(
          names.map((name) => toolCall(name, { n: name === "invalid" ? "1" : 1 }, name)),
        );
      const results = request.messages.filter((m) => m.role === "toolResult");
      assert.deepEqual(
        results.map((r) => r.toolCallId),
        names,
      );
      assert.deepEqual(
        results.map((r) => r.isError),
        [false, true, true, true, true, true, true],
      );
      assert.deepEqual(
        results.map((r) => r.details),
        [
          { status: "completed", dispatched: true },
          { status: "permission_denied", dispatched: false },
          { status: "error", dispatched: true },
          { status: "invalid_input", dispatched: false },
          { status: "blocked", dispatched: false },
          { status: "blocked", dispatched: false },
          { status: "blocked", dispatched: false },
        ],
      );
      return textMessage("done");
    }),
  });
  await new AgentRuntime(collector).run(agent, runRecord());
  assert.deepEqual(order, [
    "hook:ok",
    "permission:ok",
    "handler:ok",
    "hook:deny",
    "permission:deny",
    "hook:failure",
    "permission:failure",
    "handler:failure",
    "hook:invalid",
    "hook:admin",
  ]);
  assert.equal(calls, 2);
  assert.deepEqual(post, ["ok", "failure"]);
  const finished = collector.events.filter((e) => e.type === "tool_finished");
  assert.deepEqual(
    finished.map((e) => e.toolCallId),
    names,
  );
  assert.deepEqual(
    finished.map((e) => e.dispatched),
    [true, false, true, false, false, false, false],
  );
});

test("fatal storage failure stops the batch, preserves cause and pairs messages for a later turn", async (t) => {
  const { registry, runtime, dir, manager } = await fixture(t);
  const tasksDir = path.join(dir, "tasks");
  // Actual I/O failure, not a mock throwing a generic error.
  await rm(tasksDir, { recursive: true });
  await writeFile(tasksDir, "not a directory");
  registry.register(createUpdateTasksTool({ taskManager: manager }));
  let sideEffects = 0;
  registry.register(
    builtinTool(
      { name: "after", description: "side effect", parameters: { type: "object", properties: {} } },
      () => {
        sideEffects++;
        return { status: "completed", output: "wrong" };
      },
    ),
  );
  let calls = 0;
  const agent = new Agent({
    toolRuntime: runtime,
    provider: fakeProvider((request) => {
      if (++calls === 1)
        return toolCallMessage([
          toolCall("update_tasks", { tasks: [{ subject: "save" }] }, "save"),
          toolCall("after", {}, "after"),
        ]);
      const results = request.messages.filter((m) => m.role === "toolResult");
      assert.deepEqual(
        results.map((r) => r.details),
        [
          { status: "error", dispatched: true },
          { status: "not_executed", dispatched: false },
        ],
      );
      return textMessage("continued without replay");
    }),
  });
  const collector = createRuntimeLifecycleCollector();
  const runner = new AgentRuntime(collector);
  const run = runRecord();
  await assert.rejects(runner.run(agent, run), (error) => {
    assert.ok(error instanceof ToolInvocationError);
    assert.equal((error.cause as NodeJS.ErrnoException).code, "ENOTDIR");
    assert.equal(error.toolCallId, "save");
    assert.equal(error.runId, run.id);
    return true;
  });
  assert.equal(run.status, "failed");
  assert.equal(calls, 1);
  assert.equal(sideEffects, 0);
  assert.deepEqual(
    collector.events
      .filter((e) => e.type === "tool_finished")
      .map((e) => [e.toolCallId, e.status, e.dispatched]),
    [
      ["save", "error", true],
      ["after", "not_executed", false],
    ],
  );
  await runner.whenSettled(run.id);
  await runner.run(agent, runRecord());
  assert.equal(sideEffects, 0);
  assert.equal(calls, 2);
});

test("parser failures and invalid task batches do not reach permission or write storage", async (t) => {
  const { registry, runtime, dir, manager } = await fixture(t);
  registry.register(createUpdateTasksTool({ taskManager: manager }));
  let checks = 0;
  const context = {
    toolName: "update_tasks",
    beforeInvoke: async () => {
      checks++;
    },
  };
  assert.equal(
    (
      await runtime.invokeTool(
        "update_tasks",
        { tasks: [{ subject: "must not write" }, { subject: 42 }] },
        context,
      )
    ).status,
    "invalid_input",
  );
  assert.equal(
    (
      await runtime.invokeTool(
        "update_tasks",
        { tasks: [{ subject: "valid-looking partial" }] },
        { ...context, argumentsError: "password=secret raw data" },
      )
    ).status,
    "invalid_input",
  );
  assert.equal(checks, 0);
  assert.deepEqual(await readdir(path.join(dir, "tasks")), []);
});

for (const status of ["cancelled", "timeout", "unconfirmed"] as const) {
  test(`structured ${status} stops dispatch through both runtime and direct loop`, async (t) => {
    const { registry, runtime } = await fixture(t);
    registry.register(
      builtinTool(
        { name: "stop", description: "control", parameters: { type: "object", properties: {} } },
        (): ToolExecutionResult => ({ status, output: "control" }),
      ),
    );
    let invoked = 0;
    registry.register(
      builtinTool(
        {
          name: "later",
          description: "must not run",
          parameters: { type: "object", properties: {} },
        },
        () => {
          invoked++;
          return { status: "completed", output: "wrong" };
        },
      ),
    );
    await assert.rejects(runtime.invokeTool("stop", {}), ExecutionStoppedError);
    for (const direct of [false, true]) {
      const agent = new Agent({
        toolRuntime: runtime,
        provider: fakeProvider(() =>
          toolCallMessage([toolCall("stop", {}, "one"), toolCall("later", {}, "two")]),
        ),
      });
      const run = runRecord();
      const result = direct
        ? await agentLoop(agent)
        : (await new AgentRuntime().run(agent, run)).result;
      assert.equal(result.stopReason, status === "timeout" ? "timeout" : "aborted");
      assert.equal(result.cleanup?.status, status === "unconfirmed" ? "unconfirmed" : "confirmed");
      const results = agent.messages.filter((m) => m.role === "toolResult");
      assert.equal(results.length, 2);
      assert.equal((results[0]?.details as { status: string }).status, status);
      assert.deepEqual(results[1]?.details, { status: "not_executed", dispatched: false });
    }
    assert.equal(invoked, 0);
  });
}

test("session projections and report retain validation, availability and dispatch facts", async (t) => {
  const { dir } = await fixture(t);
  let calls = 0;
  const controller = await SessionController.createNew({
    workspaceRoot: dir,
    title: "contract",
    provider: fakeProvider(() =>
      ++calls === 1
        ? toolCallMessage([
            toolCall("read_file", {}, "invalid"),
            toolCall("unknown", {}, "missing"),
          ])
        : textMessage("done"),
    ),
  });
  try {
    await controller.handleUserMessage("test");
    const snapshot = controller.getSnapshot();
    assert.deepEqual(
      snapshot.toolCalls.map((c) => [c.id, c.status, c.dispatched]),
      [
        ["invalid", "invalid_input", false],
        ["missing", "unavailable", false],
      ],
    );
    const report = buildSessionReport(snapshot, { title: "test", createdAt: "now" });
    assert.match(report, /invalid_input; dispatched: false/);
    assert.match(report, /unavailable; dispatched: false/);
  } finally {
    await controller.close();
  }
});
