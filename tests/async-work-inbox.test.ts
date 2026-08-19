import test from "node:test";
import assert from "node:assert/strict";
import { AsyncWorkInbox } from "../src/core/async/asyncWorkInbox.js";

test("hasPending reflects registered-but-unsettled work across kinds", () => {
  const inbox = new AsyncWorkInbox();
  assert.equal(inbox.hasPending(), false);
  inbox.register({ id: "s1", kind: "subagent", status: "running", result: "", record: {} });
  inbox.register({ id: "b1", kind: "background", status: "running", result: "", record: {} });
  assert.equal(inbox.hasPending(), true);
  inbox.settle({ id: "s1", kind: "subagent", status: "completed", result: "ok", record: {} });
  assert.equal(inbox.hasPending(), true);
  inbox.settle({ id: "b1", kind: "background", status: "completed", result: "done", record: {} });
  assert.equal(inbox.hasPending(), false);
});

test("drainNotifications returns only settled items, once, then clears", () => {
  const inbox = new AsyncWorkInbox();
  inbox.register({ id: "s1", kind: "subagent", status: "running", result: "", record: {} });
  assert.deepEqual(inbox.drainNotifications(), []); // register does not enqueue
  inbox.settle({
    id: "s1",
    kind: "subagent",
    status: "completed",
    result: "ok",
    taskId: "t9",
    record: { id: "s1" },
  });
  const first = inbox.drainNotifications();
  assert.equal(first.length, 1);
  assert.equal(first[0]?.id, "s1");
  assert.equal(first[0]?.status, "completed");
  assert.equal(first[0]?.taskId, "t9");
  assert.deepEqual(inbox.drainNotifications(), []);
});

test("subscribe receives register and settle with the opaque record", () => {
  const inbox = new AsyncWorkInbox();
  const seen: Array<{ status: string; record: unknown }> = [];
  inbox.subscribe((n) => seen.push({ status: n.status, record: n.record }));
  inbox.register({
    id: "x",
    kind: "subagent",
    status: "running",
    result: "",
    record: { phase: "start" },
  });
  inbox.settle({
    id: "x",
    kind: "subagent",
    status: "completed",
    result: "r",
    record: { phase: "end" },
  });
  assert.deepEqual(seen, [
    { status: "running", record: { phase: "start" } },
    { status: "completed", record: { phase: "end" } },
  ]);
});

test("unsubscribe stops delivery; same id under different kinds is independent", () => {
  const inbox = new AsyncWorkInbox();
  let count = 0;
  const off = inbox.subscribe(() => {
    count += 1;
  });
  inbox.register({ id: "x", kind: "subagent", status: "running", result: "", record: {} });
  off();
  inbox.register({ id: "x", kind: "background", status: "running", result: "", record: {} });
  assert.equal(count, 1);
  inbox.settle({ id: "x", kind: "subagent", status: "completed", result: "a", record: {} });
  assert.equal(inbox.hasPending(), true); // background x still pending
});

test("a throwing subscriber does not break register/settle", () => {
  const inbox = new AsyncWorkInbox();
  inbox.subscribe(() => {
    throw new Error("listener boom");
  });
  assert.doesNotThrow(() =>
    inbox.register({ id: "s", kind: "subagent", status: "running", result: "", record: {} }),
  );
  assert.doesNotThrow(() =>
    inbox.settle({ id: "s", kind: "subagent", status: "completed", result: "ok", record: {} }),
  );
  assert.equal(inbox.drainNotifications().length, 1);
});
