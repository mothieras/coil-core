import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { StdioMcpClient } from "../src/core/tools/mcp/stdioClient.js";

const fixture = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "fixtures",
  "echo-mcp-server.mjs",
);

test("demultiplexes concurrent tool calls sharing one stdio process", async () => {
  const client = new StdioMcpClient({
    name: "echo",
    command: process.execPath,
    args: [fixture],
  });

  try {
    // Both calls share one StdioMcpClient (and one child process). The server
    // replies out of order, so a correct demux must route each result by id.
    const [a, b] = await Promise.all([
      client.callTool("echo", { tag: "A" }),
      client.callTool("echo", { tag: "B" }),
    ]);

    assert.deepEqual((a as { echo?: unknown }).echo, { tag: "A" });
    assert.deepEqual((b as { echo?: unknown }).echo, { tag: "B" });
  } finally {
    await client.close();
  }
});
