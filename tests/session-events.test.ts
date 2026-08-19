import test from "node:test";
import assert from "node:assert/strict";
import {
  taskChangedEvent,
  subagentProjection,
  subagentStartedEvent,
  mcpServerEvents,
} from "../src/core/session/sessionEvents.js";

test("taskChangedEvent maps a TaskRecord to a task_changed event", () => {
  const event = taskChangedEvent("s1", {
    id: 7,
    subject: "Do thing",
    status: "in_progress",
  } as never);
  assert.equal(event.type, "task_changed");
  assert.equal(event.sessionId, "s1");
  assert.equal(event.task.id, "7");
  assert.equal(event.task.title, "Do thing");
  assert.equal(event.task.status, "in_progress");
});

test("subagentProjection only includes defined optional fields", () => {
  const projection = subagentProjection("s1", {
    id: "ab12",
    status: "running",
    promptSummary: "research X",
  } as never);
  assert.deepEqual(projection, {
    id: "ab12",
    sessionId: "s1",
    status: "running",
    promptSummary: "research X",
  });
});

test("subagentStartedEvent wraps the projection", () => {
  const event = subagentStartedEvent("s1", {
    id: "ab12",
    status: "running",
    promptSummary: "research X",
  } as never);
  assert.equal(event.type, "subagent_started");
  assert.equal(event.subagent.id, "ab12");
});

test("mcpServerEvents emits connected for available and failed for unavailable", () => {
  const events = mcpServerEvents(
    "s1",
    [
      { providerName: "demo", sourceType: "mcp", status: "available", reason: "", toolCount: 3 },
      { providerName: "broken", sourceType: "mcp", status: "unavailable", reason: "boom" },
      { providerName: "builtin", sourceType: "builtin", status: "available", reason: "" },
    ],
    "2026-06-25T00:00:00.000Z",
  );
  assert.deepEqual(
    events.map((e) => e.type),
    ["mcp_server_connected", "mcp_server_failed"],
  );
});
