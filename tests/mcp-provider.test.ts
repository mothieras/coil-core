import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { createAppContext } from "../src/core/app/context.js";
import { BackgroundManager } from "../src/core/tools/background/backgroundManager.js";
import { MockMcpClient } from "../src/core/tools/mcp/mockClient.js";
import { loadConfiguredMcpTools } from "../src/core/tools/mcp/loader.js";
import { loadMcpTools } from "../src/core/tools/mcp/provider.js";
import { StdioMcpClient } from "../src/core/tools/mcp/stdioClient.js";
import { TaskManager } from "../src/core/tools/task/taskManager.js";
import { ToolRegistry } from "../src/core/tools/registry.js";
import { ToolRuntime } from "../src/core/tools/runtime.js";
import { taskStatePath } from "../src/core/state/paths.js";

test("MCP provider converts listed tools into namespaced RegisteredTool entries", async () => {
  const client = new MockMcpClient({
    tools: [
      {
        name: "search_issues",
        description: "Search GitHub issues.",
        inputSchema: {
          type: "object",
          properties: {
            query: { type: "string" },
          },
          required: ["query"],
        },
      },
    ],
  });

  const result = await loadMcpTools({ serverName: "github", client });

  assert.deepEqual(result.diagnostics, [
    {
      providerName: "github",
      sourceType: "mcp",
      namespacePrefix: "mcp__github__",
      status: "available",
      reason: "1 tool(s) loaded.",
      toolCount: 1,
    },
  ]);
  assert.equal(result.tools.length, 1);
  assert.equal(result.tools[0]?.name, "mcp__github__search_issues");
  assert.equal(result.tools[0]?.definition.name, "mcp__github__search_issues");
  assert.equal(result.tools[0]?.definition.description, "Search GitHub issues.");
  assert.deepEqual(result.tools[0]?.definition.input_schema, {
    type: "object",
    properties: {
      query: { type: "string" },
    },
    required: ["query"],
  });
  assert.deepEqual(result.tools[0]?.source, {
    type: "mcp",
    serverName: "github",
    originalName: "search_issues",
  });
});

test("MCP registered tool invokes the client with the original MCP tool name", async () => {
  const workspace = await mkdtemp(path.join(tmpdir(), "mcp-provider-"));
  try {
    const client = new MockMcpClient({
      tools: [
        {
          name: "search_issues",
          description: "Search GitHub issues.",
          inputSchema: { type: "object", properties: {} },
        },
      ],
      handlers: {
        search_issues: async () => ({
          content: [
            { type: "text", text: "Found 2 issues." },
            { type: "json", json: { ids: [1, 2] } },
          ],
        }),
      },
    });
    const registry = new ToolRegistry();
    const mcp = await loadMcpTools({ serverName: "github", client });
    registry.registerMany(mcp.tools);
    registry.recordDiagnostics(mcp.diagnostics);
    const runtime = new ToolRuntime({
      taskManager: new TaskManager(taskStatePath(workspace)),
      backgroundManager: new BackgroundManager(workspace),
      registry,
    });

    const output = await runtime.invokeTool("mcp__github__search_issues", {
      query: "is:open",
    });

    assert.deepEqual(client.calls, [{ name: "search_issues", input: { query: "is:open" } }]);
    assert.equal(output, 'Found 2 issues.\n{\n  "ids": [\n    1,\n    2\n  ]\n}');
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("MCP tool results preserve isError as tool error output", async () => {
  const workspace = await mkdtemp(path.join(tmpdir(), "mcp-provider-"));
  try {
    const client = new MockMcpClient({
      tools: [
        {
          name: "fail",
          description: "Fail through MCP.",
          inputSchema: { type: "object", properties: {} },
        },
      ],
      handlers: {
        fail: async () => ({
          isError: true,
          content: [{ type: "text", text: "remote tool failed" }],
        }),
      },
    });
    const registry = new ToolRegistry();
    const mcp = await loadMcpTools({ serverName: "demo", client });
    registry.registerMany(mcp.tools);
    const runtime = new ToolRuntime({
      taskManager: new TaskManager(taskStatePath(workspace)),
      backgroundManager: new BackgroundManager(workspace),
      registry,
    });

    assert.equal(
      await runtime.invokeTool("mcp__demo__fail", {}),
      "Error: MCP tool returned error.\nremote tool failed",
    );
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("MCP provider records unavailable diagnostics when listTools fails", async () => {
  const client = new MockMcpClient({
    listError: new Error("failed to connect"),
  });

  const result = await loadMcpTools({ serverName: "github", client });

  assert.deepEqual(result.tools, []);
  assert.deepEqual(result.diagnostics, [
    {
      providerName: "github",
      sourceType: "mcp",
      namespacePrefix: "mcp__github__",
      status: "unavailable",
      reason: "failed to connect",
    },
  ]);
});

test("app context can register preloaded mock MCP provider results", async () => {
  const workspace = await mkdtemp(path.join(tmpdir(), "mcp-app-context-"));
  try {
    const client = new MockMcpClient({
      tools: [
        {
          name: "ping",
          description: "Ping the mock server.",
          inputSchema: { type: "object", properties: {} },
        },
      ],
      handlers: {
        ping: async () => ({ content: [{ type: "text", text: "pong" }] }),
      },
    });
    const mcp = await loadMcpTools({ serverName: "mock", client });

    const app = createAppContext(workspace, {
      toolProviderResults: [mcp],
    });

    assert.equal(await app.toolRuntime.invokeTool("mcp__mock__ping", {}), "pong");
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("app context closes every tool provider and retries failed closes", async () => {
  const workspace = await mkdtemp(path.join(tmpdir(), "mcp-app-context-"));
  const calls: string[] = [];
  let firstAttempts = 0;
  try {
    const app = createAppContext(workspace, {
      toolProviderResults: [
        {
          tools: [],
          diagnostics: [],
          close: () => {
            calls.push("first");
            firstAttempts += 1;
            if (firstAttempts === 1) throw new Error("first close failed");
          },
        },
        {
          tools: [],
          diagnostics: [],
          close: () => {
            calls.push("second");
          },
        },
      ],
    });

    await assert.rejects(app.closeToolProviders(), /first close failed/);
    assert.deepEqual(calls, ["first", "second"]);
    await app.closeToolProviders();
    assert.deepEqual(calls, ["first", "second", "first"]);
    await app.closeToolProviders();
    assert.deepEqual(calls, ["first", "second", "first"]);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("StdioMcpClient lists and calls tools over newline JSON-RPC", async () => {
  const workspace = await mkdtemp(path.join(tmpdir(), "mcp-stdio-"));
  let client: StdioMcpClient | undefined;
  try {
    const serverPath = await writeTestMcpServer(workspace);
    client = new StdioMcpClient({
      name: "demo",
      command: process.execPath,
      args: [serverPath],
    });

    assert.deepEqual(await client.listTools(), [
      {
        name: "ping",
        description: "Ping test server.",
        inputSchema: { type: "object", properties: {} },
      },
    ]);
    assert.deepEqual(await client.callTool("ping", { value: "ok" }), {
      content: [{ type: "text", text: "pong ok" }],
    });
  } finally {
    await client?.close();
    await rm(workspace, { recursive: true, force: true });
  }
});

test("StdioMcpClient rejects malformed JSON stdout without crashing", async () => {
  const workspace = await mkdtemp(path.join(tmpdir(), "mcp-stdio-"));
  let client: StdioMcpClient | undefined;
  try {
    const serverPath = path.join(workspace, "bad-server.mjs");
    await writeFile(
      serverPath,
      'process.stdout.write("not-json\\n");\nsetTimeout(() => {}, 1000);\n',
      "utf8",
    );
    client = new StdioMcpClient({
      name: "bad",
      command: process.execPath,
      args: [serverPath],
    });

    await assert.rejects(client.listTools(), /Invalid MCP JSON response/);
  } finally {
    await client?.close();
    await rm(workspace, { recursive: true, force: true });
  }
});

test("StdioMcpClient rejects non-object JSON stdout without crashing", async () => {
  const workspace = await mkdtemp(path.join(tmpdir(), "mcp-stdio-"));
  let client: StdioMcpClient | undefined;
  try {
    const serverPath = path.join(workspace, "bad-server.mjs");
    await writeFile(
      serverPath,
      'process.stdout.write("null\\n");\nsetTimeout(() => {}, 1000);\n',
      "utf8",
    );
    client = new StdioMcpClient({
      name: "bad",
      command: process.execPath,
      args: [serverPath],
    });

    await assert.rejects(client.listTools(), /Invalid MCP JSON response/);
  } finally {
    await client?.close();
    await rm(workspace, { recursive: true, force: true });
  }
});

test("StdioMcpClient rejects when the server exits before responding", async () => {
  const workspace = await mkdtemp(path.join(tmpdir(), "mcp-stdio-"));
  let client: StdioMcpClient | undefined;
  try {
    const serverPath = path.join(workspace, "exit-server.mjs");
    await writeFile(serverPath, "process.exit(7);\n", "utf8");
    client = new StdioMcpClient({
      name: "exit",
      command: process.execPath,
      args: [serverPath],
    });

    await assert.rejects(client.listTools(), /exited before responding/);
  } finally {
    await client?.close();
    await rm(workspace, { recursive: true, force: true });
  }
});

test("loadConfiguredMcpTools loads stdio servers from .coil/mcp.json", async () => {
  const workspace = await mkdtemp(path.join(tmpdir(), "mcp-loader-"));
  let result: Awaited<ReturnType<typeof loadConfiguredMcpTools>>[number] | undefined;
  try {
    const serverPath = await writeTestMcpServer(workspace);
    await mkdir(path.join(workspace, ".coil", "config"), { recursive: true });
    await writeFile(
      path.join(workspace, ".coil", "config", "mcp.json"),
      JSON.stringify({
        servers: {
          demo: { command: process.execPath, args: [serverPath] },
        },
      }),
      "utf8",
    );

    [result] = await loadConfiguredMcpTools(workspace);

    assert.equal(typeof result?.close, "function");
    assert.equal(result?.tools[0]?.name, "mcp__demo__ping");
    assert.deepEqual(result?.diagnostics, [
      {
        providerName: "demo",
        sourceType: "mcp",
        namespacePrefix: "mcp__demo__",
        status: "available",
        reason: "1 tool(s) loaded.",
        toolCount: 1,
      },
    ]);
  } finally {
    await result?.close?.();
    await rm(workspace, { recursive: true, force: true });
  }
});

async function writeTestMcpServer(workspace: string): Promise<string> {
  const serverPath = path.join(workspace, "server.mjs");
  await writeFile(
    serverPath,
    `import readline from "node:readline";
const rl = readline.createInterface({ input: process.stdin });
let initialized = false;
rl.on("line", (line) => {
  const request = JSON.parse(line);
  if (request.method === "initialize") {
    process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: request.id, result: { protocolVersion: "2024-11-05", capabilities: {}, serverInfo: { name: "test", version: "1.0.0" } } }) + "\\n");
    return;
  }
  if (request.method === "notifications/initialized") {
    initialized = true;
    return;
  }
  if (!initialized) {
    process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: request.id, error: { message: "initialize required" } }) + "\\n");
    return;
  }
  if (request.method === "tools/list") {
    process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: request.id, result: { tools: [{ name: "ping", description: "Ping test server.", inputSchema: { type: "object", properties: {} } }] } }) + "\\n");
    return;
  }
  if (request.method === "tools/call") {
    process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: request.id, result: { content: [{ type: "text", text: "pong " + request.params.arguments.value }] } }) + "\\n");
  }
});
`,
    "utf8",
  );
  return serverPath;
}
