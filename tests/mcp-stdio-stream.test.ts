import test from "node:test";
import assert from "node:assert/strict";
import { JsonRpcStream } from "../src/core/tools/mcp/stdioClient.js";

type Captured = { value?: unknown; error?: Error };

function pending(stream: JsonRpcStream, id: number): Captured {
  const captured: Captured = {};
  stream.add(id, {
    resolve: (value) => {
      captured.value = value;
    },
    reject: (error) => {
      captured.error = error;
    },
  });
  return captured;
}

test("dispatches a response to its matching pending id", () => {
  const stream = new JsonRpcStream();
  const one = pending(stream, 1);

  stream.push(`${JSON.stringify({ jsonrpc: "2.0", id: 1, result: { ok: true } })}\n`);

  assert.deepEqual(one.value, { ok: true });
});

test("demultiplexes concurrent out-of-order responses to the correct ids", () => {
  const stream = new JsonRpcStream();
  const one = pending(stream, 1);
  const two = pending(stream, 2);

  // Server answers the second request first — the routing must not cross wires.
  stream.push(`${JSON.stringify({ jsonrpc: "2.0", id: 2, result: "second" })}\n`);
  stream.push(`${JSON.stringify({ jsonrpc: "2.0", id: 1, result: "first" })}\n`);

  assert.equal(one.value, "first");
  assert.equal(two.value, "second");
});

test("handles responses batched in one chunk and split across chunks", () => {
  const stream = new JsonRpcStream();
  const one = pending(stream, 1);
  const two = pending(stream, 2);

  const line1 = JSON.stringify({ jsonrpc: "2.0", id: 1, result: "a" });
  const line2 = JSON.stringify({ jsonrpc: "2.0", id: 2, result: "b" });

  // Two complete responses in a single chunk, plus a third response split apart.
  stream.push(`${line1}\n${line2.slice(0, 10)}`);
  assert.equal(one.value, "a");
  assert.equal(two.value, undefined, "partial line is not dispatched yet");

  stream.push(`${line2.slice(10)}\n`);
  assert.equal(two.value, "b");
});

test("rejects the matching pending on a JSON-RPC error response", () => {
  const stream = new JsonRpcStream();
  const one = pending(stream, 1);

  stream.push(`${JSON.stringify({ jsonrpc: "2.0", id: 1, error: { message: "boom" } })}\n`);

  assert.equal(one.error?.message, "boom");
});

test("ignores notifications and responses for unknown ids", () => {
  const stream = new JsonRpcStream();
  const one = pending(stream, 1);

  stream.push(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/progress" })}\n`);
  stream.push(`${JSON.stringify({ jsonrpc: "2.0", id: 99, result: "stray" })}\n`);

  assert.equal(one.value, undefined, "valid but unrelated traffic does not resolve a request");
  assert.equal(one.error, undefined, "valid but unrelated traffic is not a protocol error");
});

test("rejects every pending request on a framing error (non-JSON line)", () => {
  const stream = new JsonRpcStream();
  const one = pending(stream, 1);
  const two = pending(stream, 2);

  stream.push("not json at all\n");

  assert.match(one.error?.message ?? "", /Invalid MCP JSON response/);
  assert.match(two.error?.message ?? "", /Invalid MCP JSON response/);
});

test("rejectAll rejects every outstanding request", () => {
  const stream = new JsonRpcStream();
  const one = pending(stream, 1);
  const two = pending(stream, 2);

  stream.rejectAll(new Error("server exited"));

  assert.equal(one.error?.message, "server exited");
  assert.equal(two.error?.message, "server exited");
});
