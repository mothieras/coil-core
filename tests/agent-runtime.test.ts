import test from "node:test";
import assert from "node:assert/strict";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { Agent } from "../src/core/agent/agent.js";
import { AgentRuntime } from "../src/core/agent/runtime.js";
import { createAgentRun } from "../src/core/agent/run.js";
import { createRuntimeLifecycleCollector } from "../src/core/agent/lifecycle.js";
import { HookBus } from "../src/core/hooks/hookBus.js";
import { fakeProvider, textMessage, toolCall, toolCallMessage, userMessage } from "./helpers/pi.js";

function textResponse(text: string): AssistantMessage {
  return textMessage(text);
}

function toolUseResponse(name: string, input: Record<string, unknown>): AssistantMessage {
  return toolCallMessage([toolCall(name, input, "toolu_runtime")]);
}

function emptyRuntime() {
  return {
    getToolDefinitions: () => [],
    invokeTool: async () => "",
  } as never;
}

test("AgentRuntime marks an AgentRun completed", async () => {
  const agent = new Agent({
    id: "lead",
    toolRuntime: emptyRuntime(),
    provider: fakeProvider(() => textResponse("done")),
  });
  agent.messages.push(userMessage("hello"));
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
  assert.equal(run.stopReason, "stop");
  assert.equal(run.resultSummary, "done");
  assert.equal(run.messageCount, 2);
  assert.ok(run.startedAt);
  assert.ok(run.finishedAt);
});

test("AgentRuntime emits run lifecycle events", async () => {
  const collector = createRuntimeLifecycleCollector();
  const agent = new Agent({
    id: "lead",
    toolRuntime: emptyRuntime(),
    provider: fakeProvider(() => textResponse("done")),
  });
  agent.messages.push(userMessage("hello"));
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
});

test("agent loop lifecycle records assistant and completed tool events in order", async () => {
  let calls = 0;
  const provider = fakeProvider(() => {
    calls += 1;
    return calls === 1
      ? toolUseResponse("test_tool", { path: "file.txt" })
      : textResponse("all done");
  });
  const collector = createRuntimeLifecycleCollector();
  let invoked = false;
  const runtime = {
    getToolDefinitions: () => [
      {
        name: "test_tool",
        description: "test tool",
        parameters: { type: "object" as const, properties: {} },
      },
    ],
    getToolSource: () => ({ type: "builtin" as const }),
    invokeTool: async () => {
      invoked = true;
      return "tool output";
    },
  } as never;
  const agent = new Agent({ id: "lead", toolRuntime: runtime, provider });
  agent.messages.push(userMessage("use tool"));
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
});

test("agent loop emits permission requested and resolved when user approval is required", async () => {
  let calls = 0;
  const provider = fakeProvider(() => {
    calls += 1;
    return calls === 1 ? toolUseResponse("bash", { command: "rm temp.txt" }) : textResponse("done");
  });
  const collector = createRuntimeLifecycleCollector();
  const runtime = {
    getToolDefinitions: () => [
      {
        name: "bash",
        description: "bash",
        parameters: { type: "object" as const, properties: {} },
      },
    ],
    getToolSource: () => ({ type: "builtin" as const }),
    invokeTool: async () => "ok",
  } as never;
  const agent = new Agent({
    id: "lead",
    toolRuntime: runtime,
    provider,
    checkPermission: async (context) => {
      context.emitPermissionRequested?.("Potentially destructive command");
      return {
        allowed: true,
        requested: true,
        reason: "Potentially destructive command",
      };
    },
  });
  agent.messages.push(userMessage("run command"));
  const run = createAgentRun({
    id: "run_perm",
    sessionId: "s1",
    agentId: "lead",
    agentKind: "lead",
    trigger: { type: "user_message" },
  });

  await new AgentRuntime(collector).run(agent, run);

  const permissionEvents = collector.events.filter((event) => event.type.startsWith("permission_"));
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
});

test("agent loop emits permission resolved without requested for hard denies", async () => {
  let calls = 0;
  const provider = fakeProvider(() => {
    calls += 1;
    return calls === 1 ? toolUseResponse("bash", { command: "sudo reboot" }) : textResponse("done");
  });
  const collector = createRuntimeLifecycleCollector();
  const runtime = {
    getToolDefinitions: () => [
      {
        name: "bash",
        description: "bash",
        parameters: { type: "object" as const, properties: {} },
      },
    ],
    getToolSource: () => ({ type: "builtin" as const }),
    invokeTool: async () => "should not run",
  } as never;
  const agent = new Agent({
    id: "lead",
    toolRuntime: runtime,
    provider,
    checkPermission: async () => ({
      allowed: false,
      reason: "Blocked: 'sudo' is on the deny list",
    }),
  });
  agent.messages.push(userMessage("run command"));
  const run = createAgentRun({
    id: "run_deny",
    sessionId: "s1",
    agentId: "lead",
    agentKind: "lead",
    trigger: { type: "user_message" },
  });

  await new AgentRuntime(collector).run(agent, run);

  const permissionEvents = collector.events.filter((event) => event.type.startsWith("permission_"));
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
});

test("agent loop lifecycle records legacy PreToolUse blocks", async () => {
  let calls = 0;
  const provider = fakeProvider(() => {
    calls += 1;
    return calls === 1 ? toolUseResponse("blocked_tool", {}) : textResponse("after block");
  });
  const collector = createRuntimeLifecycleCollector();
  const hooks = new HookBus();
  hooks.register("PreToolUse", () => "blocked by policy");
  let invoked = false;
  const runtime = {
    getToolDefinitions: () => [
      {
        name: "blocked_tool",
        description: "blocked tool",
        parameters: { type: "object" as const, properties: {} },
      },
    ],
    getToolSource: () => ({ type: "builtin" as const }),
    invokeTool: async () => {
      invoked = true;
      return "should not run";
    },
  } as never;
  const agent = new Agent({ id: "lead", toolRuntime: runtime, hooks, provider });
  agent.messages.push(userMessage("use tool"));
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
});

test("agent loop rejects tool calls outside allowedTools without throwing", async () => {
  let calls = 0;
  const provider = fakeProvider(() => {
    calls += 1;
    return calls === 1
      ? toolUseResponse("write_file", { path: "a.txt" })
      : textResponse("after whitelist rejection");
  });
  const collector = createRuntimeLifecycleCollector();
  const hooks = new HookBus();
  let hookRan = false;
  hooks.register("PreToolUse", () => {
    hookRan = true;
    return null;
  });
  let permissionChecked = false;
  let invoked = false;
  const runtime = {
    getToolDefinitions: () => [
      {
        name: "read_file",
        description: "read file",
        parameters: { type: "object" as const, properties: {} },
      },
    ],
    getToolSource: () => ({ type: "builtin" as const }),
    invokeTool: async () => {
      invoked = true;
      return "should not run";
    },
  } as never;
  const agent = new Agent({
    id: "lead",
    toolRuntime: runtime,
    hooks,
    provider,
    allowedTools: ["read_file"],
    checkPermission: async () => {
      permissionChecked = true;
      return { allowed: true };
    },
  });
  agent.messages.push(userMessage("write a file"));
  const run = createAgentRun({
    id: "run_allowed_tools",
    agentId: "lead",
    agentKind: "lead",
    trigger: { type: "user_message" },
  });

  await new AgentRuntime(collector).run(agent, run);

  assert.equal(invoked, false);
  assert.equal(hookRan, false);
  assert.equal(permissionChecked, false);
  assert.equal(run.stopReason, "stop");
  const toolFinished = collector.events.find((event) => event.type === "tool_finished");
  assert.equal(toolFinished?.type, "tool_finished");
  if (toolFinished?.type === "tool_finished") {
    assert.equal(toolFinished.status, "blocked");
    assert.match(toolFinished.resultSummary ?? "", /write_file/);
  }
  const toolResult = agent.messages.find((message) => message.role === "toolResult");
  assert.ok(toolResult && toolResult.role === "toolResult");
  assert.equal(toolResult.toolCallId, "toolu_runtime");
  assert.equal(toolResult.isError, true);
  assert.match(JSON.stringify(toolResult.content), /not allowed/);
});

test("agent loop lifecycle redacts tool input and avoids raw tool output", async () => {
  let calls = 0;
  const provider = fakeProvider(() => {
    calls += 1;
    return calls === 1
      ? toolUseResponse("write_file", {
          path: "secret.txt",
          content: "do not persist this raw file content",
          api_key: "sk-ant-testsecret",
        })
      : textResponse("done");
  });
  const collector = createRuntimeLifecycleCollector();
  const runtime = {
    getToolDefinitions: () => [
      {
        name: "write_file",
        description: "write file",
        parameters: { type: "object" as const, properties: {} },
      },
    ],
    getToolSource: () => ({ type: "builtin" as const }),
    invokeTool: async () => "Wrote secret material to disk",
  } as never;
  const agent = new Agent({ id: "lead", toolRuntime: runtime, provider });
  agent.messages.push(userMessage("write secret"));
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
});

test("agent loop lifecycle closes tool events when PreToolUse throws", async () => {
  const provider = fakeProvider(() => toolUseResponse("blocked_tool", {}));
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
        parameters: { type: "object" as const, properties: {} },
      },
    ],
    getToolSource: () => ({ type: "builtin" as const }),
    invokeTool: async () => "should not run",
  } as never;
  const agent = new Agent({ id: "lead", toolRuntime: runtime, hooks, provider });
  agent.messages.push(userMessage("use tool"));
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
});

test("agent loop lifecycle closes tool events when permission checker rejects", async () => {
  const provider = fakeProvider(() => toolUseResponse("test_tool", {}));
  const collector = createRuntimeLifecycleCollector();
  const runtime = {
    getToolDefinitions: () => [
      {
        name: "test_tool",
        description: "test tool",
        parameters: { type: "object" as const, properties: {} },
      },
    ],
    getToolSource: () => ({ type: "builtin" as const }),
    invokeTool: async () => "should not run",
  } as never;
  const agent = new Agent({
    id: "lead",
    toolRuntime: runtime,
    provider,
    checkPermission: async () => {
      throw new Error("permission token=abc123 failed");
    },
  });
  agent.messages.push(userMessage("use tool"));
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
});

test("agent loop lifecycle marks direct tool invocation errors as error", async () => {
  let calls = 0;
  const provider = fakeProvider(() => {
    calls += 1;
    return calls === 1 ? toolUseResponse("test_tool", {}) : textResponse("handled error");
  });
  const collector = createRuntimeLifecycleCollector();
  const runtime = {
    getToolDefinitions: () => [
      {
        name: "test_tool",
        description: "test tool",
        parameters: { type: "object" as const, properties: {} },
      },
    ],
    getToolSource: () => ({ type: "builtin" as const }),
    invokeTool: async () => {
      throw new Error("boom token=abc123");
    },
  } as never;
  const agent = new Agent({ id: "lead", toolRuntime: runtime, provider });
  agent.messages.push(userMessage("use tool"));
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
    provider: fakeProvider(() => textResponse("unused")),
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
