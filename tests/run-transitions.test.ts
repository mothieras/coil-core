import test from "node:test";
import assert from "node:assert/strict";
import {
  createAgentRun,
  startAgentRun,
  completeAgentRun,
  failAgentRun,
  interruptAgentRun,
  requestAgentRunStop,
  finishAgentRunStop,
} from "../src/core/agent/run.js";

const makeRun = () =>
  createAgentRun({ agentId: "lead", agentKind: "lead", trigger: { type: "user_message" } });

test("the first accepted terminal decision wins, including repeated helpers", () => {
  for (const first of ["complete", "fail", "interrupt"] as const) {
    const run = makeRun();
    startAgentRun(run);
    if (first === "complete") completeAgentRun(run, { stopReason: "stop" });
    if (first === "fail") failAgentRun(run, new Error("original"));
    if (first === "interrupt") interruptAgentRun(run, "original");
    const expected = structuredClone(run);
    startAgentRun(run);
    completeAgentRun(run, { stopReason: "stop", resultSummary: "late" });
    failAgentRun(run, new Error("late"));
    interruptAgentRun(run, "late");
    assert.deepEqual(run, expected);
  }
});

test("accepted stop locks the reason before cleanup and late completion", () => {
  for (const reason of ["aborted", "timeout"] as const) {
    const run = makeRun();
    startAgentRun(run);
    assert.equal(requestAgentRunStop(run, reason, "user"), true);
    assert.equal(run.status, "stopping");
    assert.equal(
      requestAgentRunStop(run, reason === "timeout" ? "aborted" : "timeout", "session_close"),
      false,
    );
    completeAgentRun(run, { stopReason: "stop" });
    failAgentRun(run, new Error("late"));
    assert.equal(run.status, "stopping");
    finishAgentRunStop(run, { status: "confirmed", resources: [], errors: [] });
    assert.equal(run.status, "interrupted");
    assert.equal(run.stopReason, reason);
    assert.equal(run.stopSource, "user");
    assert.doesNotThrow(() => JSON.stringify(run));
  }
});

test("only normal stop is successful", () => {
  for (const reason of [
    "stop",
    "error",
    "length",
    "max_turns",
    "pending",
    "deferred",
    "toolUse",
    "aborted",
    "timeout",
  ]) {
    const run = makeRun();
    startAgentRun(run);
    completeAgentRun(run, { stopReason: reason });
    assert.equal(
      run.status,
      reason === "stop" ? "completed" : reason === "timeout" ? "interrupted" : "failed",
      reason,
    );
    if (["pending", "deferred", "toolUse", "aborted"].includes(reason))
      assert.equal(run.stopReason, "error");
  }
});
