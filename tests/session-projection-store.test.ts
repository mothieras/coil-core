import test from "node:test";
import assert from "node:assert/strict";
import { SessionProjectionStore } from "../src/core/session/projection/projectionStore.js";
import { taskChangedEvent } from "../src/core/session/sessionEvents.js";
import type { SessionViewEvent } from "../src/core/session/viewEvents.js";

test("record folds the event into the snapshot and queues it for flush", () => {
  const store = new SessionProjectionStore();
  store.record(taskChangedEvent("s1", { id: 1, subject: "A", status: "pending" } as never));
  assert.equal(store.getSnapshot().tasks.length, 1);
  assert.equal(store.drainPending().length, 1);
  assert.equal(store.drainPending().length, 0); // drained
});

test("subscribers receive view events; a throwing subscriber is isolated", () => {
  const store = new SessionProjectionStore();
  const seen: SessionViewEvent[] = [];
  store.subscribe(() => {
    throw new Error("ui boom");
  });
  store.subscribe((event) => seen.push(event));
  assert.doesNotThrow(() =>
    store.record(taskChangedEvent("s1", { id: 1, subject: "A", status: "pending" } as never)),
  );
  assert.ok(seen.length >= 1);
});
