import test from "node:test";
import assert from "node:assert/strict";
import { createPermissionBridge } from "../src/tui/permissionBridge.js";

test("request exposes current pending and resolves the returned promise", async () => {
  const bridge = createPermissionBridge();
  let notified = 0;
  bridge.subscribe(() => {
    notified += 1;
  });

  const decision = bridge.request("bash", { command: "ls" }, "Potentially destructive");
  assert.equal(bridge.current()?.toolName, "bash");
  assert.equal(bridge.current()?.reason, "Potentially destructive");
  assert.ok(notified >= 1, "subscribers notified on request");

  bridge.resolve(bridge.current()!.id, true);
  assert.equal(await decision, true);
  assert.equal(bridge.current(), null, "pending cleared after resolve");
  assert.doesNotThrow(() => bridge.resolve("missing", false));
});

test("queues concurrent requests and resolves each in arrival order", async () => {
  const bridge = createPermissionBridge();

  const first = bridge.request("bash", { command: "rm -rf a" }, "destructive A");
  const second = bridge.request("bash", { command: "rm -rf b" }, "destructive B");

  // The first request is shown while the second waits behind it.
  assert.equal(bridge.current()?.reason, "destructive A");
  assert.equal(bridge.current()?.queueSize, 2);

  // Resolving the head advances to the next queued request and resolves its promise.
  const firstId = bridge.current()!.id;
  bridge.resolve(firstId, true);
  assert.equal(await first, true);
  assert.equal(bridge.current()?.reason, "destructive B");
  assert.equal(bridge.current()?.queueSize, 1);

  // A repeated key event from the stale first prompt cannot decide the next one.
  bridge.resolve(firstId, false);
  assert.equal(bridge.current()?.reason, "destructive B");

  bridge.resolve(bridge.current()!.id, false);
  assert.equal(await second, false);
  assert.equal(bridge.current(), null, "pending cleared once the queue drains");
});
