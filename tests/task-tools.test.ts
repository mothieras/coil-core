import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { TaskManager } from "../src/core/tools/task/taskManager.js";
import { createTaskTools } from "../src/core/tools/task/index.js";
import { ToolRegistry } from "../src/core/tools/registry.js";
import { ToolRuntime } from "../src/core/tools/runtime.js";
import { BackgroundManager } from "../src/core/tools/background/backgroundManager.js";

test("applyMany creates, updates and returns the resulting list", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "coil-tasks-"));
  try {
    const manager = new TaskManager(dir);
    const first = manager.applyMany([
      { subject: "write tests" },
      { subject: "implement", status: "in_progress" },
    ]);
    assert.match(first, /\[ \] #1: write tests/);
    assert.match(first, /\[>\] #2: implement/);
    const second = manager.applyMany([{ id: 1, status: "completed", subject: "write unit tests" }]);
    assert.match(second, /\[x\] #1: write unit tests/);
    assert.throws(() => manager.applyMany([{ status: "pending" }]), /subject/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("update_tasks tool validates input and applies the list", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "coil-tasks-"));
  try {
    const manager = new TaskManager(dir);
    const tools = createTaskTools({ taskManager: manager });
    assert.equal(tools.length, 1);
    const tool = tools[0]!;
    assert.equal(tool.name, "update_tasks");
    const registry = new ToolRegistry();
    registry.registerMany(tools);
    const runtime = new ToolRuntime({
      registry,
      taskManager: manager,
      backgroundManager: new BackgroundManager(dir),
    });
    for (const input of [
      {},
      { tasks: [] },
      { tasks: [{ subject: "must not write" }, {}] },
      { tasks: [{ subject: "demo", status: "wrong" }] },
    ]) {
      const bad = await runtime.invokeTool("update_tasks", input);
      assert.equal(bad.status, "invalid_input");
      assert.equal(manager.listAll(), "No tasks.");
    }
    const ok = await runtime.invokeTool("update_tasks", { tasks: [{ subject: "demo" }] });
    assert.equal(ok.status, "completed");
    assert.match(ok.output, /#1: demo/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
