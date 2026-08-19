import test from "node:test";
import assert from "node:assert/strict";
import { applyTuiCommandResult } from "../src/tui/commands.js";
import { createTuiState } from "../src/tui/state.js";

test("notice command appends an info log line and continues", () => {
  const out = applyTuiCommandResult(
    createTuiState(),
    { action: "notice", title: "Tasks", body: "No tasks in this session." },
    "c1",
  );
  assert.equal(out.action, "continue");
  assert.equal(out.state.log.at(-1)?.kind, "info");
  assert.equal(out.state.log.at(-1)?.title, "Tasks");
  assert.equal(out.state.log.at(-1)?.detail, "No tasks in this session.");
});

test("exit command logs and requests exit", () => {
  const out = applyTuiCommandResult(
    createTuiState(),
    { action: "exit", title: "Exiting", body: "Saving session state." },
    "c2",
  );
  assert.equal(out.action, "exit");
  assert.equal(out.state.log.at(-1)?.title, "Exiting");
});

test("compact and report results append info lines", () => {
  let out = applyTuiCommandResult(
    createTuiState(),
    { action: "compact", compacted: true, message: "Context compacted." },
    "c3",
  );
  assert.equal(out.state.log.at(-1)?.title, "Compact");
  assert.equal(out.state.log.at(-1)?.detail, "Context compacted.");
  out = applyTuiCommandResult(
    out.state,
    {
      action: "report",
      message: "Report written: /tmp/report.md",
      report: {
        id: "r1",
        sessionId: "s1",
        title: "Session report",
        path: "/tmp/report.md",
        createdAt: "2026-01-01T00:00:00.000Z",
      },
    },
    "c4",
  );
  assert.equal(out.state.log.at(-1)?.title, "Report");
  assert.equal(out.state.log.at(-1)?.detail, "Report written: /tmp/report.md");
});
