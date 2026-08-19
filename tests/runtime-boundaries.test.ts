import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { HookBus } from "../src/core/hooks/hookBus.js";
import type Anthropic from "@anthropic-ai/sdk";
import { getClient } from "../src/core/config/index.js";
const client = getClient();
import { createAppContext } from "../src/core/app/context.js";
import { pushTaggedUserMessage } from "../src/core/hooks/messageInjection.js";
import { registerRuntimeHooks } from "../src/core/hooks/runtimeHooks.js";
import { forkSubAgent } from "../src/core/tools/subagent/subagent.js";
import { SubAgentRunner } from "../src/core/tools/subagent/subagentRunner.js";
import { Agent, currentAgent } from "../src/core/agent/agent.js";
import { hasPendingAsyncWork } from "../src/core/app/pendingWork.js";
import { PROMPT_SECTIONS } from "../src/core/context/sections.js";
import { BackgroundManager } from "../src/core/tools/background/backgroundManager.js";
import type { BackgroundCommandRecord } from "../src/core/tools/background/backgroundManager.js";
import { requireNonEmptyString } from "../src/core/tools/input.js";
import { ToolRegistry } from "../src/core/tools/registry.js";
import { ToolRuntime } from "../src/core/tools/runtime.js";
import { TaskManager } from "../src/core/tools/task/taskManager.js";
import { loadBuiltinTools } from "../src/core/tools/builtins.js";
import { validateToolProfiles } from "../src/core/tools/profiles.js";
import type { RegisteredTool } from "../src/core/tools/types.js";
import { taskStatePath } from "../src/core/state/paths.js";
import { AsyncWorkInbox } from "../src/core/async/asyncWorkInbox.js";

function toolDefinition(name: string) {
  return {
    name,
    description: `${name} test tool`,
    input_schema: {
      type: "object" as const,
      properties: {},
    },
  };
}

function textResponse(
  text: string,
  stopReason: Anthropic.Messages.Message["stop_reason"] = "end_turn",
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

function createRuntime(workspaceRoot: string): ToolRuntime {
  const registry = new ToolRegistry();
  const taskManager = new TaskManager(taskStatePath(workspaceRoot));
  const backgroundManager = new BackgroundManager(workspaceRoot);
  const runtime = new ToolRuntime({ taskManager, backgroundManager, registry });
  const subAgentRunner = new SubAgentRunner();
  const builtin = loadBuiltinTools({
    workspaceRoot,
    taskManager,
    backgroundManager,
    subAgentRunner,
  });
  registry.registerMany(builtin.tools);
  registry.recordDiagnostics(builtin.diagnostics);

  return runtime;
}

test("BackgroundManager emits started and finished lifecycle records", async () => {
  const workspace = await mkdtemp(path.join(tmpdir(), "background-"));
  try {
    const inbox = new AsyncWorkInbox();
    const started: string[] = [];
    const finished: string[] = [];
    inbox.subscribe((n) => {
      const record = n.record as BackgroundCommandRecord;
      if (n.status === "running")
        started.push(`${record.id}:${record.status}:${record.commandSummary}`);
      else finished.push(`${record.id}:${record.status}:${record.resultSummary}`);
    });
    const manager = new BackgroundManager(workspace, inbox);

    const output = manager.run("node -e \"console.log('bg-ok')\"");
    assert.match(output, /Background task \w+ started/);
    assert.equal(started.length, 1);
    assert.match(started[0] ?? "", /running:node -e/);

    while (manager.hasRunning()) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }

    assert.equal(finished.length, 1);
    assert.match(finished[0] ?? "", /completed:bg-ok/);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

function testTool(name: string, handler: RegisteredTool["handler"]): RegisteredTool {
  return {
    name,
    definition: {
      name,
      description: `${name} test tool`,
      input_schema: {
        type: "object",
        properties: {},
      },
    },
    handler,
    source: { type: "builtin" },
  };
}

test("loadBuiltinTools returns complete RegisteredTool entries", async () => {
  const workspace = await mkdtemp(path.join(tmpdir(), "agent-runtime-"));
  try {
    const taskManager = new TaskManager(taskStatePath(workspace));
    const backgroundManager = new BackgroundManager(workspace);
    const subAgentRunner = new SubAgentRunner();
    const builtin = loadBuiltinTools({
      workspaceRoot: workspace,
      taskManager,
      backgroundManager,
      subAgentRunner,
    });

    assert.deepEqual(builtin.diagnostics, []);
    assert.deepEqual(
      builtin.tools.map((tool) => tool.name),
      [
        "bash",
        "read_file",
        "write_file",
        "edit_file",
        "update_tasks",
        "background_run",
        "subagent",
      ],
    );
    assert.equal(new Set(builtin.tools.map((tool) => tool.name)).size, builtin.tools.length);
    for (const tool of builtin.tools) {
      assert.equal(tool.name, tool.definition.name);
      assert.deepEqual(tool.source, { type: "builtin" });
      assert.equal(typeof tool.handler, "function");
    }
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("tool profile validation reports unknown allowed tools", () => {
  const registry = new ToolRegistry();
  registry.register(testTool("read_file", () => "ok"));

  assert.throws(
    () =>
      validateToolProfiles(registry, {
        reviewer: ["read_file", "missing_tool"],
      }),
    /Tool profile 'reviewer' references unknown tool\(s\): missing_tool/,
  );
});

test("registry.getDefinitions fails fast on an unknown allowed tool", () => {
  const registry = new ToolRegistry();
  registry.register(testTool("read_file", () => "ok"));

  assert.throws(
    () => registry.getDefinitions(["read_file", "nope"]),
    /Unknown allowed tool\(s\): nope/,
  );
});

test("subagent tool errors when invoked outside an agent loop", async () => {
  const workspace = await mkdtemp(path.join(tmpdir(), "agent-runtime-"));
  try {
    const app = createAppContext(workspace);
    // No surrounding currentAgent.run → no parent in the async context.
    const out = await app.toolRuntime.invokeTool("subagent", { prompt: "x" });
    assert.match(String(out), /within an agent loop/);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("createAppContext can scope task files to a supplied directory", async () => {
  const workspace = await mkdtemp(path.join(tmpdir(), "agent-runtime-"));
  try {
    const tasksDir = path.join(workspace, ".coil", "sessions", "s1", "tasks");
    const changed: string[] = [];
    const app = createAppContext(workspace, {
      taskStateDir: tasksDir,
      onTaskChanged: (task) => changed.push(task.subject),
    });

    await app.toolRuntime.invokeTool("update_tasks", { tasks: [{ subject: "Scoped task" }] });

    assert.equal(
      JSON.parse(await readFile(path.join(tasksDir, "task_1.json"), "utf8")).subject,
      "Scoped task",
    );
    assert.deepEqual(changed, ["Scoped task"]);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("HookBus instances do not share registered callbacks", () => {
  const first = new HookBus();
  const second = new HookBus();

  first.register("Stop", () => "first");

  assert.equal(first.triggerControl("Stop", []), "first");
  assert.equal(second.triggerControl("Stop", []), null);
});

test("effect hooks run every callback even when one returns text", () => {
  const hooks = new HookBus();
  const calls: string[] = [];

  hooks.register("PreLLMCall", () => {
    calls.push("first");
    return "ignored";
  });
  hooks.register("PreLLMCall", () => {
    calls.push("second");
  });

  hooks.emitEffect("PreLLMCall", []);

  assert.deepEqual(calls, ["first", "second"]);
});

test("PreToolUse returns the first block reason", () => {
  const hooks = new HookBus();
  const calls: string[] = [];

  hooks.register("PreToolUse", () => {
    calls.push("first");
    return "blocked";
  });
  hooks.register("PreToolUse", () => {
    calls.push("second");
    return "also blocked";
  });

  assert.equal(
    hooks.triggerControl("PreToolUse", {
      type: "tool_use",
      id: "toolu_test",
      name: "bash",
      input: {},
    } as Anthropic.Messages.ToolUseBlock),
    "blocked",
  );
  assert.deepEqual(calls, ["first"]);
});

test("Stop returns the first continue reason", () => {
  const hooks = new HookBus();
  const calls: string[] = [];

  hooks.register("Stop", () => {
    calls.push("first");
    return "continue";
  });
  hooks.register("Stop", () => {
    calls.push("second");
    return "continue again";
  });

  assert.equal(hooks.triggerControl("Stop", []), "continue");
  assert.deepEqual(calls, ["first"]);
});

test("ToolResultsReady appends results through mutation", () => {
  const hooks = new HookBus();
  const results = [{ type: "tool_result" as const, tool_use_id: "toolu_test", content: "ok" }];

  hooks.register("ToolResultsReady", (readyResults) => {
    readyResults.push({ type: "text", text: "extra" });
    return "ignored";
  });

  hooks.emitEffect("ToolResultsReady", results);

  assert.deepEqual(results, [
    { type: "tool_result", tool_use_id: "toolu_test", content: "ok" },
    { type: "text", text: "extra" },
  ]);
});

test("ToolRuntime resolves file tools against its workspace root", async () => {
  const workspace = await mkdtemp(path.join(tmpdir(), "agent-runtime-"));
  const previousCwd = process.cwd();

  try {
    process.chdir(tmpdir());
    const runtime = createRuntime(workspace);

    const output = await runtime.invokeTool("write_file", {
      path: "nested/example.txt",
      content: "workspace-root",
    });

    assert.match(output, /Wrote 14 bytes/);
    assert.equal(
      await readFile(path.join(workspace, "nested/example.txt"), "utf8"),
      "workspace-root",
    );
  } finally {
    process.chdir(previousCwd);
    await rm(workspace, { recursive: true, force: true });
  }
});

test("ToolRuntime returns handler exceptions as error strings", async () => {
  const registry = new ToolRegistry();
  const runtime = new ToolRuntime({
    taskManager: new TaskManager(taskStatePath(process.cwd())),
    backgroundManager: new BackgroundManager(process.cwd()),
    registry,
  });

  runtime.registerTool(
    testTool("explode", () => {
      throw new Error("boom");
    }),
  );
  runtime.registerTool(
    testTool("reject", async () => {
      throw new Error("async boom");
    }),
  );

  assert.match(await runtime.invokeTool("explode", {}), /Error: boom/);
  assert.match(await runtime.invokeTool("reject", {}), /Error: async boom/);
});

test("ToolRuntime passes invocation context to handlers", async () => {
  const registry = new ToolRegistry();
  let observedToolCallId: string | undefined;
  registry.register({
    name: "context_tool",
    definition: {
      name: "context_tool",
      description: "context",
      input_schema: { type: "object", properties: {} },
    },
    source: { type: "builtin" },
    handler: (_input, context) => {
      observedToolCallId = context?.toolCallId;
      return "ok";
    },
  });
  const runtime = new ToolRuntime({
    taskManager: new TaskManager(taskStatePath(process.cwd())),
    backgroundManager: new BackgroundManager(process.cwd()),
    registry,
  });

  await runtime.invokeTool(
    "context_tool",
    {},
    { toolCallId: "tool_ctx", toolName: "context_tool" },
  );

  assert.equal(observedToolCallId, "tool_ctx");
});

test("ToolRuntime exposes registered tool source metadata", () => {
  const registry = new ToolRegistry();
  const runtime = new ToolRuntime({
    taskManager: new TaskManager(taskStatePath(process.cwd())),
    backgroundManager: new BackgroundManager(process.cwd()),
    registry,
  });

  runtime.registerTool(testTool("source_test", () => "ok"));

  assert.deepEqual(runtime.getToolSource("source_test"), { type: "builtin" });
  assert.equal(runtime.getToolSource("missing_tool"), undefined);
});

test("ToolRuntime returns unsupported for unknown tools", async () => {
  const runtime = createRuntime(process.cwd());

  assert.equal(
    await runtime.invokeTool("missing_tool", {}),
    "Error: Unsupported tool 'missing_tool'.",
  );
});

test("ToolRuntime returns unavailable for failed provider namespaces", async () => {
  const registry = new ToolRegistry();
  registry.recordDiagnostic({
    providerName: "github",
    sourceType: "mcp",
    namespacePrefix: "mcp__github__",
    status: "unavailable",
    reason: "connection failed",
  });
  const runtime = new ToolRuntime({
    taskManager: new TaskManager(taskStatePath(process.cwd())),
    backgroundManager: new BackgroundManager(process.cwd()),
    registry,
  });

  assert.equal(
    await runtime.invokeTool("mcp__github__search", {}),
    "Error: Tool 'mcp__github__search' is unavailable from provider 'github': connection failed.",
  );
});

test("default orchestration exposes subagent but not teammate or polling tools", async () => {
  const workspace = await mkdtemp(path.join(tmpdir(), "agent-runtime-"));
  try {
    const app = createAppContext(workspace);

    const toolNames = app.toolRegistry.getDefinitions().map((tool) => tool.name);

    assert.ok(toolNames.includes("subagent"));
    assert.ok(!toolNames.includes("check_subagent"));
    assert.ok(!toolNames.includes("teammate"));
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("subagent schema accepts optional role, name, task_id, and allowed_tools", async () => {
  const workspace = await mkdtemp(path.join(tmpdir(), "agent-runtime-"));
  try {
    const app = createAppContext(workspace);
    const subagent = app.toolRegistry.getDefinitions().find((tool) => tool.name === "subagent");

    assert.ok(subagent);
    assert.deepEqual(Object.keys(subagent.input_schema.properties ?? {}).sort(), [
      "allowed_tools",
      "max_turns",
      "name",
      "prompt",
      "role",
      "task_id",
      "timeout_ms",
    ]);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("subagent tool returns a sub_id immediately while the run continues", async () => {
  const original = client.messages.create;
  client.messages.create = (async () =>
    textResponse("subagent done")) as unknown as typeof client.messages.create;
  const workspace = await mkdtemp(path.join(tmpdir(), "agent-runtime-"));
  try {
    const app = createAppContext(workspace);
    const lead = new Agent({
      toolRuntime: app.toolRuntime,
      hooks: app.hooks,
      workspaceRoot: workspace,
    });

    const out = await currentAgent.run(lead, () =>
      app.toolRuntime.invokeTool("subagent", { prompt: "research X" }),
    );
    assert.match(out, /Subagent \w+ started/);
    assert.equal(app.subAgentRunner.hasRunning(), true);

    while (app.subAgentRunner.hasRunning()) {
      await new Promise((resolve) => setImmediate(resolve));
    }
  } finally {
    client.messages.create = original;
    await rm(workspace, { recursive: true, force: true });
  }
});

test("forkSubAgent puts role/name/workspace into the child's system prompt", () => {
  const tools = ["bash", "read_file", "write_file", "edit_file"].map(toolDefinition);
  const runtime = {
    getToolDefinitions: () => tools,
    invokeTool: async () => "",
  };
  const parent = new Agent({
    toolRuntime: runtime as never,
    workspaceRoot: "/tmp/workspace",
  });

  const child = forkSubAgent(parent, "rev-1", "review docs", {
    name: "reviewer",
    role: "code reviewer",
  });

  assert.match(child.system, /reviewer/);
  assert.match(child.system, /code reviewer/);
  assert.match(child.system, /\/tmp\/workspace/);
  assert.deepEqual(child.messages, [{ role: "user", content: "review docs" }]);
});

test("forkSubAgent narrows allowedTools to the profile and never widens it", () => {
  const tools = ["bash", "read_file", "write_file", "edit_file"].map(toolDefinition);
  const runtime = {
    getToolDefinitions: () => tools,
    invokeTool: async () => "",
  };
  const parent = new Agent({ toolRuntime: runtime as never, workspaceRoot: "/tmp/ws" });

  // narrowing: requested ∩ profile
  assert.deepEqual(
    forkSubAgent(parent, "r1", "read", { allowedTools: ["read_file"] }).allowedTools,
    ["read_file"],
  );
  // widening is impossible: tools outside the profile (e.g. `subagent`) are dropped
  assert.deepEqual(
    forkSubAgent(parent, "r2", "escalate", { allowedTools: ["bash", "subagent"] }).allowedTools,
    ["bash"],
  );
  // omitted -> the full profile
  assert.deepEqual(forkSubAgent(parent, "r3", "work").allowedTools, [
    "bash",
    "read_file",
    "write_file",
    "edit_file",
  ]);
});

test("default prompt guides parallel subagent delegation", () => {
  const guidelines = PROMPT_SECTIONS.guidelines?.({
    workspace: "/tmp/workspace",
    memories: "",
    skills: "",
  });

  assert.match(guidelines ?? "", /subagent/);
  assert.match(guidelines ?? "", /<subagent-results>/);
  assert.match(guidelines ?? "", /in_progress/);
  assert.doesNotMatch(guidelines ?? "", /check_subagent|check_background/);
  assert.doesNotMatch(guidelines ?? "", /Use teammate/);
});

test("the executing agent and its id are available via the currentAgent ALS", () => {
  const result = currentAgent.run(
    new Agent({ id: "reviewer", toolRuntime: {} as never }),
    () => currentAgent.getStore()?.id,
  );

  assert.equal(result, "reviewer");
});

test("requireNonEmptyString returns tool-scoped errors for missing text", () => {
  assert.deepEqual(requireNonEmptyString({}, "prompt", "task tool"), {
    error: "Error: Missing required 'prompt' for task tool.",
  });
  assert.deepEqual(requireNonEmptyString({ prompt: "  " }, "prompt", "task tool"), {
    error: "Error: Missing required 'prompt' for task tool.",
  });
  assert.deepEqual(requireNonEmptyString({ prompt: 42 }, "prompt", "task tool"), {
    value: "42",
  });
});

test("pushTaggedUserMessage appends xml-like user blocks consistently", () => {
  const messages: Anthropic.Messages.MessageParam[] = [];

  pushTaggedUserMessage(messages, "task-status", "one\ntwo");
  pushTaggedUserMessage(messages, "inbox", '{"text":"hi"}', "inline");

  assert.deepEqual(messages, [
    { role: "user", content: "<task-status>\none\ntwo\n</task-status>" },
    { role: "user", content: '<inbox>{"text":"hi"}</inbox>' },
  ]);
});

test("subagent results inject in lead context only, not in subagent context", async () => {
  const original = client.messages.create;
  client.messages.create = (async () =>
    textResponse("sub result payload")) as unknown as typeof client.messages.create;
  const workspace = await mkdtemp(path.join(tmpdir(), "agent-runtime-"));
  try {
    const app = createAppContext(workspace);
    registerRuntimeHooks(app);

    const lead = new Agent({
      id: "lead",
      toolRuntime: app.toolRuntime,
      hooks: app.hooks,
      workspaceRoot: workspace,
    });
    app.subAgentRunner.run(lead, "do thing");
    while (app.subAgentRunner.hasRunning()) {
      await new Promise((resolve) => setImmediate(resolve));
    }

    // Non-lead context must NOT drain the lead's subagent results.
    const subMessages: Anthropic.Messages.MessageParam[] = [];
    const worker = new Agent({
      id: "worker-1",
      toolRuntime: app.toolRuntime,
      workspaceRoot: workspace,
    });
    currentAgent.run(worker, () => app.hooks.emitEffect("PreLLMCall", subMessages));
    assert.doesNotMatch(JSON.stringify(subMessages), /subagent-results/);

    // Lead context drains and injects the (still-present) result.
    const leadMessages: Anthropic.Messages.MessageParam[] = [];
    currentAgent.run(lead, () => app.hooks.emitEffect("PreLLMCall", leadMessages));
    const leadText = JSON.stringify(leadMessages);
    assert.match(leadText, /subagent-results/);
    assert.match(leadText, /sub result payload/);
  } finally {
    client.messages.create = original;
    await rm(workspace, { recursive: true, force: true });
  }
});

test("hasPendingAsyncWork reflects running subagents", async () => {
  const original = client.messages.create;
  client.messages.create = (async () =>
    textResponse("done")) as unknown as typeof client.messages.create;
  const workspace = await mkdtemp(path.join(tmpdir(), "agent-runtime-"));
  try {
    const app = createAppContext(workspace);

    assert.equal(hasPendingAsyncWork(app), false);
    const lead = new Agent({
      id: "lead",
      toolRuntime: app.toolRuntime,
      hooks: app.hooks,
      workspaceRoot: workspace,
    });
    app.subAgentRunner.run(lead, "work");
    assert.equal(hasPendingAsyncWork(app), true);

    while (app.subAgentRunner.hasRunning()) {
      await new Promise((resolve) => setImmediate(resolve));
    }
    assert.equal(hasPendingAsyncWork(app), false);
  } finally {
    client.messages.create = original;
    await rm(workspace, { recursive: true, force: true });
  }
});

test("hasPendingAsyncWork reflects running background tasks", async () => {
  const workspace = await mkdtemp(path.join(tmpdir(), "agent-runtime-"));
  try {
    const app = createAppContext(workspace);

    assert.equal(hasPendingAsyncWork(app), false);
    await app.toolRuntime.invokeTool("background_run", {
      command: 'node -e "setTimeout(() => {}, 50)"',
    });
    assert.equal(hasPendingAsyncWork(app), true);

    while (app.inbox.hasPending()) {
      await new Promise((resolve) => setImmediate(resolve));
    }
    assert.equal(hasPendingAsyncWork(app), false);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});
