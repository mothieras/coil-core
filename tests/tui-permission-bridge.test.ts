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

  bridge.resolve(true);
  assert.equal(await decision, true);
  assert.equal(bridge.current(), null, "pending cleared after resolve");
});

test("resolve with no pending request is a no-op", () => {
  const bridge = createPermissionBridge();
  assert.doesNotThrow(() => bridge.resolve(false));
});

test("queues concurrent requests and resolves each in arrival order", async () => {
  const bridge = createPermissionBridge();

  const first = bridge.request("bash", { command: "rm -rf a" }, "destructive A");
  const second = bridge.request("bash", { command: "rm -rf b" }, "destructive B");

  // The first request is shown while the second waits behind it.
  assert.equal(bridge.current()?.reason, "destructive A");

  // Resolving the head advances to the next queued request and resolves its promise.
  bridge.resolve(true);
  assert.equal(await first, true);
  assert.equal(bridge.current()?.reason, "destructive B");

  bridge.resolve(false);
  assert.equal(await second, false);
  assert.equal(bridge.current(), null, "pending cleared once the queue drains");
});
