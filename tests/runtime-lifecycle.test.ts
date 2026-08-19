import test from "node:test";
import assert from "node:assert/strict";
import {
  createRuntimeLifecycleCollector,
  createRuntimeLifecycleEvent,
  noopRuntimeLifecycleSink,
  safeEmitRuntimeLifecycle,
  type AgentRunFinishedEvent,
  type AgentRunStartedEvent,
} from "../src/core/agent/lifecycle.js";

test("createRuntimeLifecycleEvent fills id and timestamp", () => {
  const event = createRuntimeLifecycleEvent<AgentRunStartedEvent>({
    type: "agent_run_started",
    runId: "run_1",
    agentId: "lead",
    agentKind: "lead",
    trigger: { type: "user_message" },
  });

  assert.equal(event.type, "agent_run_started");
  assert.equal(event.runId, "run_1");
  assert.equal(typeof event.id, "string");
  assert.ok(event.id.length > 0);
  assert.ok(!Number.isNaN(Date.parse(event.timestamp)));
});

test("createRuntimeLifecycleEvent preserves explicit id and timestamp", () => {
  const event = createRuntimeLifecycleEvent<AgentRunStartedEvent>({
    id: "event_1",
    timestamp: "2026-01-01T00:00:00.000Z",
    type: "agent_run_started",
    runId: "run_1",
    sessionId: "session_1",
    agentId: "lead",
    agentKind: "lead",
    trigger: { type: "user_message", messageId: "message_1" },
  });

  assert.equal(event.id, "event_1");
  assert.equal(event.timestamp, "2026-01-01T00:00:00.000Z");
  assert.equal(event.sessionId, "session_1");
  assert.deepEqual(event.trigger, {
    type: "user_message",
    messageId: "message_1",
  });
});

test("RuntimeLifecycleCollector synchronously queues events in order", () => {
  const collector = createRuntimeLifecycleCollector();
  const started = createRuntimeLifecycleEvent<AgentRunStartedEvent>({
    id: "event_started",
    timestamp: "2026-01-01T00:00:00.000Z",
    type: "agent_run_started",
    runId: "run_1",
    agentId: "lead",
    agentKind: "lead",
    trigger: { type: "user_message" },
  });
  const finished = createRuntimeLifecycleEvent<AgentRunFinishedEvent>({
    id: "event_finished",
    timestamp: "2026-01-01T00:00:01.000Z",
    type: "agent_run_finished",
    runId: "run_1",
    agentId: "lead",
    agentKind: "lead",
    status: "completed",
    stopReason: "end_turn",
    resultSummary: "done",
  });

  collector.emit(started);
  assert.deepEqual(collector.events, [started]);

  collector.emit(finished);
  assert.deepEqual(collector.events, [started, finished]);
  assert.deepEqual(collector.drain(), [started, finished]);
  assert.deepEqual(collector.events, []);
});

test("safeEmitRuntimeLifecycle treats observation as best effort", () => {
  const event = createRuntimeLifecycleEvent<AgentRunStartedEvent>({
    type: "agent_run_started",
    runId: "run_1",
    agentId: "lead",
    agentKind: "lead",
    trigger: { type: "user_message" },
  });

  assert.doesNotThrow(() => safeEmitRuntimeLifecycle(undefined, event));
  assert.doesNotThrow(() => noopRuntimeLifecycleSink.emit(event));
  assert.doesNotThrow(() =>
    safeEmitRuntimeLifecycle(
      {
        emit() {
          throw new Error("observer failed");
        },
      },
      event,
    ),
  );
});
