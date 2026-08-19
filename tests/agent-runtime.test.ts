import test from "node:test";
import assert from "node:assert/strict";
import type Anthropic from "@anthropic-ai/sdk";
import { getClient } from "../src/core/config/index.js";
const client = getClient();
import { Agent } from "../src/core/agent/agent.js";
import { AgentRuntime } from "../src/core/agent/runtime.js";
import { createAgentRun } from "../src/core/agent/run.js";
import { createRuntimeLifecycleCollector } from "../src/core/agent/lifecycle.js";
import { HookBus } from "../src/core/hooks/hookBus.js";

function textResponse(text: string): Anthropic.Messages.Message {
  return {
    id: "msg_runtime_test",
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
    id: "msg_runtime_tool_test",
    type: "message",
    role: "assistant",
    model: "test-model",
    content: [{ type: "tool_use", id: "toolu_runtime", name, input }],
    stop_reason: "tool_use",
    stop_sequence: null,
    usage: { input_tokens: 1, output_tokens: 1 },
  } as unknown as Anthropic.Messages.Message;
}

function emptyRuntime() {
  return {
    getToolDefinitions: () => [],
    invokeTool: async () => "",
  } as never;
}

test("AgentRuntime marks an AgentRun completed", async () => {
  const original = client.messages.create;
  client.messages.create = (async () =>
    textResponse("done")) as unknown as typeof client.messages.create;
  try {
    const agent = new Agent({ id: "lead", toolRuntime: emptyRuntime() });
    agent.messages.push({ role: "user", content: "hello" });
    const run = createAgentRun({
      id: "run_test",
      agentId: "lead",
      agentKind: "lead",
      trigger: { type: "user_message" },
      now: "2026-01-01T00:00:00.000Z",
    });

    const out = await new AgentRuntime().run(agent, run);

    assert.equal(out.run, run);
    assert.equal(run.status, "completed");
    assert.equal(run.stopReason, "end_turn");
    assert.equal(run.resultSummary, "done");
    assert.equal(run.messageCount, 2);
    assert.ok(run.startedAt);
    assert.ok(run.finishedAt);
  } finally {
    client.messages.create = original;
  }
});

test("AgentRuntime emits run lifecycle events", async () => {
  const original = client.messages.create;
  client.messages.create = (async () =>
    textResponse("done")) as unknown as typeof client.messages.create;
  try {
    const collector = createRuntimeLifecycleCollector();
    const agent = new Agent({ id: "lead", toolRuntime: emptyRuntime() });
    agent.messages.push({ role: "user", content: "hello" });
    const run = createAgentRun({
      id: "run_lifecycle",
      sessionId: "session_1",
      agentId: "lead",
      agentKind: "lead",
      trigger: { type: "user_message" },
    });

    await new AgentRuntime(collector).run(agent, run);

    assert.deepEqual(
      collector.events.map((event) => event.type),
      ["agent_run_started", "assistant_message_added", "agent_run_finished"],
    );
    assert.equal(collector.events[0]?.runId, "run_lifecycle");
    assert.equal(collector.events[0]?.sessionId, "session_1");
    const finished = collector.events[2];
    assert.equal(finished?.type, "agent_run_finished");
    if (finished?.type === "agent_run_finished") {
      assert.equal(finished.status, "completed");
      assert.equal(finished.resultSummary, "done");
      assert.equal(finished.messageCount, 2);
    }
  } finally {
    client.messages.create = original;
  }
});

test("agent loop lifecycle records assistant and completed tool events in order", async () => {
  const original = client.messages.create;
  let calls = 0;
  client.messages.create = (async () => {
    calls += 1;
    return calls === 1
      ? toolUseResponse("test_tool", { path: "file.txt" })
      : textResponse("all done");
  }) as unknown as typeof client.messages.create;
  try {
    const collector = createRuntimeLifecycleCollector();
    let invoked = false;
    const runtime = {
      getToolDefinitions: () => [
        {
          name: "test_tool",
          description: "test tool",
          input_schema: { type: "object" as const, properties: {} },
        },
      ],
      getToolSource: () => ({ type: "builtin" as const }),
      invokeTool: async () => {
        invoked = true;
        return "tool output";
      },
    } as never;
    const agent = new Agent({ id: "lead", toolRuntime: runtime });
    agent.messages.push({ role: "user", content: "use tool" });
    const run = createAgentRun({
      id: "run_tool_lifecycle",
      agentId: "lead",
      agentKind: "lead",
      trigger: { type: "user_message" },
    });

    await new AgentRuntime(collector).run(agent, run);

    assert.equal(invoked, true);
    assert.deepEqual(
      collector.events.map((event) => event.type),
      [
        "agent_run_started",
        "assistant_message_added",
        "tool_started",
        "tool_finished",
        "assistant_message_added",
        "agent_run_finished",
      ],
    );
    const toolStarted = collector.events[2];
    assert.equal(toolStarted?.type, "tool_started");
    if (toolStarted?.type === "tool_started") {
      assert.equal(toolStarted.toolCallId, "toolu_runtime");
      assert.equal(toolStarted.toolName, "test_tool");
      assert.deepEqual(toolStarted.source, { type: "builtin" });
      assert.match(toolStarted.inputSummary ?? "", /file.txt/);
    }
    const toolFinished = collector.events[3];
    assert.equal(toolFinished?.type, "tool_finished");
    if (toolFinished?.type === "tool_finished") {
      assert.equal(toolFinished.status, "completed");
      assert.equal(toolFinished.resultSummary, "output (11 chars, 1 line)");
      assert.equal(typeof toolFinished.durationMs, "number");
    }
  } finally {
    client.messages.create = original;
  }
});

test("agent loop emits permission requested and resolved when user approval is required", async () => {
  const original = client.messages.create;
  let calls = 0;
  client.messages.create = (async () => {
    calls += 1;
    return calls === 1 ? toolUseResponse("bash", { command: "rm temp.txt" }) : textResponse("done");
  }) as unknown as typeof client.messages.create;
  try {
    const collector = createRuntimeLifecycleCollector();
    const runtime = {
      getToolDefinitions: () => [
        {
          name: "bash",
          description: "bash",
          input_schema: { type: "object" as const, properties: {} },
        },
      ],
      getToolSource: () => ({ type: "builtin" as const }),
      invokeTool: async () => "ok",
    } as never;
    const agent = new Agent({
      id: "lead",
      toolRuntime: runtime,
      checkPermission: async (context) => {
        context.emitPermissionRequested?.("Potentially destructive command");
        return {
          allowed: true,
          requested: true,
          reason: "Potentially destructive command",
        };
      },
    });
    agent.messages.push({ role: "user", content: "run command" });
    const run = createAgentRun({
      id: "run_perm",
      sessionId: "s1",
      agentId: "lead",
      agentKind: "lead",
      trigger: { type: "user_message" },
    });

    await new AgentRuntime(collector).run(agent, run);

    const permissionEvents = collector.events.filter((event) =>
      event.type.startsWith("permission_"),
    );
    assert.deepEqual(
      permissionEvents.map((event) => event.type),
      ["permission_requested", "permission_resolved"],
    );
    const requested = permissionEvents[0];
    assert.equal(requested?.type, "permission_requested");
    if (requested?.type === "permission_requested") {
      assert.equal(requested.runId, "run_perm");
      assert.equal(requested.sessionId, "s1");
      assert.equal(requested.toolCallId, "toolu_runtime");
      assert.equal(requested.toolName, "bash");
      assert.equal(requested.reason, "Potentially destructive command");
      assert.match(requested.inputSummary ?? "", /rm temp\.txt/);
    }
    const resolved = permissionEvents[1];
    assert.equal(resolved?.type, "permission_resolved");
    if (resolved?.type === "permission_resolved") {
      assert.equal(resolved.allowed, true);
      assert.equal(requested?.type, "permission_requested");
      if (requested?.type === "permission_requested") {
        assert.equal(resolved.permissionId, requested.permissionId);
      }
    }
  } finally {
    client.messages.create = original;
  }
});

test("agent loop emits permission resolved without requested for hard denies", async () => {
  const original = client.messages.create;
  let calls = 0;
  client.messages.create = (async () => {
    calls += 1;
    return calls === 1 ? toolUseResponse("bash", { command: "sudo reboot" }) : textResponse("done");
  }) as unknown as typeof client.messages.create;
  try {
    const collector = createRuntimeLifecycleCollector();
    const runtime = {
      getToolDefinitions: () => [
        {
          name: "bash",
          description: "bash",
          input_schema: { type: "object" as const, properties: {} },
        },
      ],
      getToolSource: () => ({ type: "builtin" as const }),
      invokeTool: async () => "should not run",
    } as never;
    const agent = new Agent({
      id: "lead",
      toolRuntime: runtime,
      checkPermission: async () => ({
        allowed: false,
        reason: "Blocked: 'sudo' is on the deny list",
      }),
    });
    agent.messages.push({ role: "user", content: "run command" });
    const run = createAgentRun({
      id: "run_deny",
      sessionId: "s1",
      agentId: "lead",
      agentKind: "lead",
      trigger: { type: "user_message" },
    });

    await new AgentRuntime(collector).run(agent, run);

    const permissionEvents = collector.events.filter((event) =>
      event.type.startsWith("permission_"),
    );
    assert.deepEqual(
      permissionEvents.map((event) => event.type),
      ["permission_resolved"],
    );
    const resolved = permissionEvents[0];
    assert.equal(resolved?.type, "permission_resolved");
    if (resolved?.type === "permission_resolved") {
      assert.equal(resolved.allowed, false);
      assert.match(resolved.reason ?? "", /sudo/);
    }
  } finally {
    client.messages.create = original;
  }
});

test("agent loop lifecycle records legacy PreToolUse blocks", async () => {
  const original = client.messages.create;
  let calls = 0;
  client.messages.create = (async () => {
    calls += 1;
    return calls === 1 ? toolUseResponse("blocked_tool", {}) : textResponse("after block");
  }) as unknown as typeof client.messages.create;
  try {
    const collector = createRuntimeLifecycleCollector();
    const hooks = new HookBus();
    hooks.register("PreToolUse", () => "blocked by policy");
    let invoked = false;
    const runtime = {
      getToolDefinitions: () => [
        {
          name: "blocked_tool",
          description: "blocked tool",
          input_schema: { type: "object" as const, properties: {} },
        },
      ],
      getToolSource: () => ({ type: "builtin" as const }),
      invokeTool: async () => {
        invoked = true;
        return "should not run";
      },
    } as never;
    const agent = new Agent({ id: "lead", toolRuntime: runtime, hooks });
    agent.messages.push({ role: "user", content: "use tool" });
    const run = createAgentRun({
      id: "run_block_lifecycle",
      agentId: "lead",
      agentKind: "lead",
      trigger: { type: "user_message" },
    });

    await new AgentRuntime(collector).run(agent, run);

    assert.equal(invoked, false);
    const toolFinished = collector.events.find((event) => event.type === "tool_finished");
    assert.equal(toolFinished?.type, "tool_finished");
    if (toolFinished?.type === "tool_finished") {
      assert.equal(toolFinished.status, "blocked");
      assert.equal(toolFinished.resultSummary, "blocked by policy");
    }
  } finally {
    client.messages.create = original;
  }
});

test("agent loop lifecycle redacts tool input and avoids raw tool output", async () => {
  const original = client.messages.create;
  let calls = 0;
  client.messages.create = (async () => {
    calls += 1;
    return calls === 1
      ? toolUseResponse("write_file", {
          path: "secret.txt",
          content: "do not persist this raw file content",
          api_key: "sk-ant-testsecret",
        })
      : textResponse("done");
  }) as unknown as typeof client.messages.create;
  try {
    const collector = createRuntimeLifecycleCollector();
    const runtime = {
      getToolDefinitions: () => [
        {
          name: "write_file",
          description: "write file",
          input_schema: { type: "object" as const, properties: {} },
        },
      ],
      getToolSource: () => ({ type: "builtin" as const }),
      invokeTool: async () => "Wrote secret material to disk",
    } as never;
    const agent = new Agent({ id: "lead", toolRuntime: runtime });
    agent.messages.push({ role: "user", content: "write secret" });
    const run = createAgentRun({
      id: "run_redact_lifecycle",
      agentId: "lead",
      agentKind: "lead",
      trigger: { type: "user_message" },
    });

    await new AgentRuntime(collector).run(agent, run);

    const toolStarted = collector.events.find((event) => event.type === "tool_started");
    assert.equal(toolStarted?.type, "tool_started");
    if (toolStarted?.type === "tool_started") {
      assert.match(toolStarted.inputSummary ?? "", /secret\.txt/);
      assert.match(toolStarted.inputSummary ?? "", /\[content omitted:/);
      assert.match(toolStarted.inputSummary ?? "", /\[redacted\]/);
      assert.doesNotMatch(toolStarted.inputSummary ?? "", /do not persist/);
      assert.doesNotMatch(toolStarted.inputSummary ?? "", /sk-ant-testsecret/);
    }
    const toolFinished = collector.events.find((event) => event.type === "tool_finished");
    assert.equal(toolFinished?.type, "tool_finished");
    if (toolFinished?.type === "tool_finished") {
      assert.equal(toolFinished.status, "completed");
      assert.doesNotMatch(toolFinished.resultSummary ?? "", /Wrote secret/);
    }
  } finally {
    client.messages.create = original;
  }
});

test("agent loop lifecycle closes tool events when PreToolUse throws", async () => {
  const original = client.messages.create;
  client.messages.create = (async () =>
    toolUseResponse("blocked_tool", {})) as unknown as typeof client.messages.create;
  try {
    const collector = createRuntimeLifecycleCollector();
    const hooks = new HookBus();
    hooks.register("PreToolUse", () => {
      throw new Error("policy secret=abc123");
    });
    const runtime = {
      getToolDefinitions: () => [
        {
          name: "blocked_tool",
          description: "blocked tool",
          input_schema: { type: "object" as const, properties: {} },
        },
      ],
      getToolSource: () => ({ type: "builtin" as const }),
      invokeTool: async () => "should not run",
    } as never;
    const agent = new Agent({ id: "lead", toolRuntime: runtime, hooks });
    agent.messages.push({ role: "user", content: "use tool" });
    const run = createAgentRun({
      id: "run_hook_throw_lifecycle",
      agentId: "lead",
      agentKind: "lead",
      trigger: { type: "user_message" },
    });

    await assert.rejects(() => new AgentRuntime(collector).run(agent, run), /policy/);

    assert.deepEqual(
      collector.events
        .filter((event) => event.type === "tool_started" || event.type === "tool_finished")
        .map((event) => event.type),
      ["tool_started", "tool_finished"],
    );
    const toolFinished = collector.events.find((event) => event.type === "tool_finished");
    assert.equal(toolFinished?.type, "tool_finished");
    if (toolFinished?.type === "tool_finished") {
      assert.equal(toolFinished.status, "error");
      assert.match(toolFinished.error ?? "", /\[redacted\]/);
      assert.doesNotMatch(toolFinished.error ?? "", /abc123/);
    }
  } finally {
    client.messages.create = original;
  }
});

test("agent loop lifecycle closes tool events when permission checker rejects", async () => {
  const original = client.messages.create;
  client.messages.create = (async () =>
    toolUseResponse("test_tool", {})) as unknown as typeof client.messages.create;
  try {
    const collector = createRuntimeLifecycleCollector();
    const runtime = {
      getToolDefinitions: () => [
        {
          name: "test_tool",
          description: "test tool",
          input_schema: { type: "object" as const, properties: {} },
        },
      ],
      getToolSource: () => ({ type: "builtin" as const }),
      invokeTool: async () => "should not run",
    } as never;
    const agent = new Agent({
      id: "lead",
      toolRuntime: runtime,
      checkPermission: async () => {
        throw new Error("permission token=abc123 failed");
      },
    });
    agent.messages.push({ role: "user", content: "use tool" });
    const run = createAgentRun({
      id: "run_permission_throw_lifecycle",
      agentId: "lead",
      agentKind: "lead",
      trigger: { type: "user_message" },
    });

    await assert.rejects(() => new AgentRuntime(collector).run(agent, run), /permission/);

    const toolFinished = collector.events.find((event) => event.type === "tool_finished");
    assert.equal(toolFinished?.type, "tool_finished");
    if (toolFinished?.type === "tool_finished") {
      assert.equal(toolFinished.status, "error");
      assert.match(toolFinished.error ?? "", /\[redacted\]/);
      assert.doesNotMatch(toolFinished.error ?? "", /abc123/);
    }
  } finally {
    client.messages.create = original;
  }
});

test("agent loop lifecycle marks direct tool invocation errors as error", async () => {
  const original = client.messages.create;
  let calls = 0;
  client.messages.create = (async () => {
    calls += 1;
    return calls === 1 ? toolUseResponse("test_tool", {}) : textResponse("handled error");
  }) as unknown as typeof client.messages.create;
  try {
    const collector = createRuntimeLifecycleCollector();
    const runtime = {
      getToolDefinitions: () => [
        {
          name: "test_tool",
          description: "test tool",
          input_schema: { type: "object" as const, properties: {} },
        },
      ],
      getToolSource: () => ({ type: "builtin" as const }),
      invokeTool: async () => {
        throw new Error("boom token=abc123");
      },
    } as never;
    const agent = new Agent({ id: "lead", toolRuntime: runtime });
    agent.messages.push({ role: "user", content: "use tool" });
    const run = createAgentRun({
      id: "run_tool_error_lifecycle",
      agentId: "lead",
      agentKind: "lead",
      trigger: { type: "user_message" },
    });

    await new AgentRuntime(collector).run(agent, run);

    const toolFinished = collector.events.find((event) => event.type === "tool_finished");
    assert.equal(toolFinished?.type, "tool_finished");
    if (toolFinished?.type === "tool_finished") {
      assert.equal(toolFinished.status, "error");
      assert.match(toolFinished.resultSummary ?? "", /^error output \(/);
      assert.match(toolFinished.error ?? "", /\[redacted\]/);
      assert.doesNotMatch(toolFinished.error ?? "", /abc123/);
    }
  } finally {
    client.messages.create = original;
  }
});

test("AgentRuntime marks an AgentRun failed when the loop throws", async () => {
  const agent = new Agent({
    id: "lead",
    toolRuntime: {
      getToolDefinitions: () => {
        throw new Error("boom");
      },
      invokeTool: async () => "",
    } as never,
  });
  const run = createAgentRun({
    id: "run_fail",
    agentId: "lead",
    agentKind: "lead",
    trigger: { type: "user_message" },
  });

  await assert.rejects(() => new AgentRuntime().run(agent, run), /boom/);

  assert.equal(run.status, "failed");
  assert.match(run.error ?? "", /Error: boom/);
  assert.ok(run.startedAt);
  assert.ok(run.finishedAt);
});
