import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { loadMcpConfig } from "../src/core/tools/mcp/config.js";

test("loadMcpConfig reads .coil/mcp.json server definitions", async () => {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "coil-mcp-config-"));
  try {
    await fs.mkdir(path.join(workspace, ".coil", "config"), { recursive: true });
    await fs.writeFile(
      path.join(workspace, ".coil", "config", "mcp.json"),
      JSON.stringify({
        servers: {
          demo: { command: "node", args: ["server.js"], env: { DEMO: "1" } },
        },
      }),
      "utf8",
    );

    assert.deepEqual(await loadMcpConfig(workspace), [
      { name: "demo", command: "node", args: ["server.js"], env: { DEMO: "1" } },
    ]);
  } finally {
    await fs.rm(workspace, { recursive: true, force: true });
  }
});

test("loadMcpConfig returns an empty list when config is absent", async () => {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "coil-mcp-config-"));
  try {
    assert.deepEqual(await loadMcpConfig(workspace), []);
  } finally {
    await fs.rm(workspace, { recursive: true, force: true });
  }
});
