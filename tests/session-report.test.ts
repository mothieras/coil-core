import test from "node:test";
import assert from "node:assert/strict";
import { buildSessionReport } from "../src/core/session/report.js";
import { createEmptySessionSnapshot } from "../src/core/session/projection/projection.js";
import type { SessionSnapshot } from "../src/core/session/types.js";

function snapshotWith(overrides: Partial<SessionSnapshot>): SessionSnapshot {
  return { ...createEmptySessionSnapshot(), ...overrides };
}

test("report distinguishes timeout, unknown cleanup and legacy missing cleanup", () => {
  const base = {
    sessionId: "s",
    agentId: "lead",
    agentKind: "lead" as const,
    trigger: { type: "user_message" as const },
  };
  const report = buildSessionReport(
    snapshotWith({
      agentRuns: [
        {
          ...base,
          id: "cancelled",
          status: "interrupted",
          stopReason: "timeout",
          cleanup: { status: "unconfirmed", resources: ["tool:t1"], errors: ["cleanup failed"] },
        },
        { ...base, id: "old", status: "completed" },
      ],
    }),
    { title: "Report", createdAt: "now" },
  );
  assert.match(report, /interrupted; reason: timeout; cleanup: unconfirmed/);
  assert.match(report, /Stop unconfirmed: tool:t1/);
  assert.match(report, /Cleanup error: cleanup failed/);
  assert.match(report, /Run old: completed; reason: not recorded; cleanup: not recorded/);
});

test("buildSessionReport summarizes MCP servers and MCP tool calls", () => {
  const report = buildSessionReport(
    snapshotWith({
      mcpServers: [
        { name: "everything", status: "connected", toolCount: 13, updatedAt: "t" },
        { name: "broken", status: "failed", reason: "spawn npx ENOENT", updatedAt: "t" },
      ],
      toolCalls: [
        {
          id: "t1",
          sessionId: "s",
          runId: "r",
          agentId: "lead",
          agentKind: "lead",
          toolName: "mcp__everything__echo",
          status: "completed",
          resultSummary: "output (15 chars, 1 line)",
          startedAt: "t",
        },
        {
          id: "t2",
          sessionId: "s",
          runId: "r",
          agentId: "lead",
          agentKind: "lead",
          toolName: "read_file",
          status: "completed",
          startedAt: "t",
        },
      ],
    }),
    { title: "Session report", createdAt: "2026-07-06T00:00:00.000Z" },
  );

  assert.match(report, /## MCP/);
  assert.match(report, /- everything: connected, 13 tools/);
  assert.match(report, /- broken: failed \(spawn npx ENOENT\)/);
  assert.match(report, /- MCP tool calls: 1/);
});

test("buildSessionReport reports absence of MCP servers", () => {
  const report = buildSessionReport(snapshotWith({}), {
    title: "Session report",
    createdAt: "2026-07-06T00:00:00.000Z",
  });
  assert.match(report, /## MCP/);
  assert.match(report, /- No MCP servers configured\./);
});
