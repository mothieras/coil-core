import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { ToolRuntime } from "../src/core/tools/runtime.js";
import { ToolRegistry } from "../src/core/tools/registry.js";
import { TaskManager } from "../src/core/tools/task/taskManager.js";
import { BackgroundManager } from "../src/core/tools/background/backgroundManager.js";
import { builtinTool } from "../src/core/tools/types.js";
import { ToolExecutionError, ToolInvocationError } from "../src/core/tools/errors.js";
import { createBashTool } from "../src/core/tools/file/bash.js";
import { createBackgroundRunTool } from "../src/core/tools/background/run.js";

async function fixture(t: { after(fn: () => Promise<void>): void }) {
  const dir = await mkdtemp(path.join(tmpdir(), "tool-contract-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const registry = new ToolRegistry();
  const runtime = new ToolRuntime({
    registry,
    taskManager: new TaskManager(dir),
    backgroundManager: new BackgroundManager(dir),
  });
  return { dir, registry, runtime };
}

test("built-in dangerous commands are typed rejections without starting background work", async (t) => {
  const { dir, registry, runtime } = await fixture(t);
  const background = new BackgroundManager(dir);
  registry.register(createBashTool({ workspaceRoot: dir }));
  registry.register(createBackgroundRunTool({ backgroundManager: background }));
  for (const name of ["bash", "background_run"]) {
    const result = await runtime.invokeTool(name, { command: "rm -rf /" });
    assert.equal(result.status, "blocked");
  }
  assert.equal(background.hasRunning(), false);
});

test("permission cannot mutate validated arguments and abort-before-dispatch stays side-effect free", async (t) => {
  const { registry, runtime } = await fixture(t);
  let received: unknown;
  registry.register(
    builtinTool(
      {
        name: "immutable",
        description: "test",
        parameters: {
          type: "object",
          properties: { value: { type: "integer" } },
          required: ["value"],
        },
      },
      (input) => {
        received = input.value;
        return { status: "completed", output: String(input.value) };
      },
    ),
  );
  const input = { value: 1 };
  await runtime.invokeTool("immutable", input, {
    toolName: "immutable",
    beforeInvoke: async (value) => {
      input.value = 2;
      value.value = 3;
    },
  });
  assert.equal(received, 1);
  received = undefined;
  const cancel = new AbortController();
  await assert.rejects(
    runtime.invokeTool(
      "immutable",
      { value: 1 },
      {
        toolName: "immutable",
        signal: cancel.signal,
        beforeInvoke: async () => {
          cancel.abort();
        },
      },
    ),
    /Execution stopped/,
  );
  assert.equal(received, undefined);
});

test("runtime validates strictly before permission and dispatch without leaking argument values", async (t) => {
  const { registry, runtime } = await fixture(t);
  const order: string[] = [];
  registry.register(
    builtinTool(
      {
        name: "strict",
        description: "test",
        parameters: {
          type: "object",
          properties: {
            count: { type: "integer", minimum: 1 },
            items: { type: "array", items: { type: "string" } },
          },
          required: ["count"],
          additionalProperties: false,
        },
      },
      () => {
        order.push("handler");
        return { status: "completed", output: "Error: ordinary file content" };
      },
    ),
  );
  const context = {
    toolName: "strict",
    beforeInvoke: async () => {
      order.push("permission");
    },
    onDispatch: () => {
      order.push("dispatch");
    },
  };
  for (const input of [
    null,
    [],
    { count: "2" },
    { count: 0 },
    { count: 1, items: [1] },
    { count: 1, password: "secret-value" },
  ]) {
    const result = await runtime.invokeTool("strict", input, context);
    assert.equal(result.status, "invalid_input");
    assert.doesNotMatch(result.output, /secret-value/);
    assert.deepEqual(order, []);
  }
  const result = await runtime.invokeTool("strict", { count: 2 }, context);
  assert.deepEqual(result, { status: "completed", output: "Error: ordinary file content" });
  assert.deepEqual(order, ["permission", "dispatch", "handler"]);
  order.length = 0;
  assert.equal(
    (
      await runtime.invokeTool(
        "strict",
        { count: 2 },
        {
          ...context,
          beforeInvoke: async () => ({ status: "permission_denied" as const, output: "no" }),
        },
      )
    ).status,
    "permission_denied",
  );
  assert.deepEqual(order, []);
  assert.equal((await runtime.invokeTool("missing", {})).status, "unavailable");
});

test("runtime distinguishes recoverable errors from fatal failures and preserves private cause and identity", async (t) => {
  const { registry, runtime } = await fixture(t);
  const cause = new Error("password=private-value");
  for (const [name, error] of [
    ["recoverable", new ToolExecutionError("Try another path", { cause })],
    ["fatal", cause],
  ] as const) {
    registry.register(
      builtinTool(
        { name, description: name, parameters: { type: "object", properties: {} } },
        () => {
          throw error;
        },
      ),
    );
  }
  assert.deepEqual(await runtime.invokeTool("recoverable", {}), {
    status: "error",
    output: "Try another path",
  });
  await assert.rejects(
    runtime.invokeTool("fatal", {}, { toolName: "fatal", toolCallId: "call-1", runId: "run-1" }),
    (error) => {
      assert.ok(error instanceof ToolInvocationError);
      assert.equal(error.cause, cause);
      assert.equal(error.toolCallId, "call-1");
      assert.equal(error.runId, "run-1");
      assert.doesNotMatch(error.message, /private-value/);
      return true;
    },
  );
});

test(
  "shell output cannot hide nonzero exit or turn Error-prefixed success into failure",
  { timeout: 10000 },
  async (t) => {
    const { registry, runtime, dir } = await fixture(t);
    registry.register(createBashTool({ workspaceRoot: dir }));
    const failed = await runtime.invokeTool("bash", { command: "printf 'some output'; exit 7" });
    assert.equal(failed.status, "error");
    assert.match(failed.output, /7/);
    assert.match(failed.output, /some output/);
    assert.deepEqual(await runtime.invokeTool("bash", { command: "printf 'Error: just text'" }), {
      status: "completed",
      output: "Error: just text",
    });
  },
);
