import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { StdioMcpClient } from "../src/core/tools/mcp/stdioClient.js";
import { createMcpHandler } from "../src/core/tools/mcp/handler.js";
import { createAppContext } from "../src/core/app/context.js";
import { Agent } from "../src/core/agent/agent.js";
import { createAgentRun } from "../src/core/agent/run.js";
import { fakeProvider, toolCallMessage, toolCall } from "./helpers/pi.js";

test(
  "cancelling a real shared MCP call reports unknown without closing another call's connection",
  { timeout: 10_000 },
  async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "coil-mcp-cancel-"));
    const marker = path.join(dir, "entered");
    const client = new StdioMcpClient({
      name: "fixture",
      command: process.execPath,
      args: [
        "--import",
        "tsx",
        fileURLToPath(new URL("./fixtures/cancellation-mcp-server.ts", import.meta.url)),
        marker,
      ],
    });
    const app = createAppContext(dir);
    const source = { type: "mcp" as const, serverName: "fixture", originalName: "wait" };
    app.toolRuntime.registerTool({
      name: "remote",
      definition: {
        name: "remote",
        description: "fixture",
        parameters: { type: "object", properties: {} },
      },
      source,
      handler: createMcpHandler(client, source),
    });
    const agent = new Agent({
      toolRuntime: app.toolRuntime,
      provider: fakeProvider(() => toolCallMessage([toolCall("remote", {}, "mcp-call")])),
    });
    const run = createAgentRun({
      agentId: "lead",
      agentKind: "lead",
      trigger: { type: "user_message" },
    });
    let pid: number | undefined;
    try {
      const running = app.agentRuntime.run(agent, run);
      const deadline = Date.now() + 3_000;
      while (Date.now() < deadline) {
        try {
          pid = Number(await readFile(marker, "utf8"));
          break;
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        }
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      assert.ok(pid, "MCP request reached the real server");
      const cancelled = await app.agentRuntime.cancelRun(run.id, "user", Date.now());
      await running;
      assert.equal(cancelled.cleanup?.status, "unconfirmed");
      const messages = structuredClone(agent.messages);
      assert.match(JSON.stringify(await client.callTool("echo", {})), /echo complete/);
      await client.callTool("release", {});
      await app.agentRuntime.whenSettled(run.id);
      assert.deepEqual(agent.messages, messages);
      assert.equal(run.status, "interrupted");
      const closed = client.close();
      assert.equal(client.close(), closed);
      await closed;
      assert.throws(() => process.kill(pid!, 0), { code: "ESRCH" });
      await assert.rejects(client.callTool("echo", {}), /closed/);
    } finally {
      await client.close();
      await rm(dir, { recursive: true, force: true });
    }
  },
);
