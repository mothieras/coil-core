import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { StdioMcpClient } from "../src/core/tools/mcp/stdioClient.js";
import { createRuntimeLifecycleCollector } from "../src/core/agent/lifecycle.js";
import { AgentRuntime } from "../src/core/agent/runtime.js";
import { createMcpHandler } from "../src/core/tools/mcp/handler.js";
import { createAppContext } from "../src/core/app/context.js";
import { Agent } from "../src/core/agent/agent.js";
import { createAgentRun } from "../src/core/agent/run.js";
import { fakeProvider, textMessage, toolCallMessage, toolCall } from "./helpers/pi.js";

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

test(
  "real MCP request timeout remains unconfirmed, stops the batch and leaves the shared connection usable",
  { timeout: 15_000 },
  async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "coil-mcp-timeout-"));
    const client = new StdioMcpClient({
      name: "fixture",
      command: process.execPath,
      args: [
        "--import",
        "tsx",
        fileURLToPath(new URL("./fixtures/cancellation-mcp-server.ts", import.meta.url)),
        path.join(dir, "entered"),
      ],
    });
    const app = createAppContext(dir);
    app.toolRuntime.registerTool({
      name: "remote",
      definition: {
        name: "remote",
        description: "wait",
        parameters: { type: "object", properties: {} },
      },
      source: { type: "mcp", serverName: "fixture", originalName: "wait" },
      handler: createMcpHandler(client, {
        type: "mcp",
        serverName: "fixture",
        originalName: "wait",
      }),
    });
    const events = createRuntimeLifecycleCollector();
    const runner = new AgentRuntime(events);
    const agent = new Agent({
      toolRuntime: app.toolRuntime,
      provider: fakeProvider(() =>
        toolCallMessage([
          toolCall("remote", {}, "wait"),
          toolCall("write_file", { path: "must-not-exist", content: "bad" }, "later"),
        ]),
      ),
    });
    const run = createAgentRun({
      agentId: "lead",
      agentKind: "lead",
      trigger: { type: "user_message" },
    });
    try {
      await runner.run(agent, run);
      assert.equal(run.stopReason, "timeout");
      assert.equal(run.cleanup?.status, "unconfirmed");
      assert.deepEqual(
        events.events
          .filter((e) => e.type === "tool_finished")
          .map((e) => [e.status, e.dispatched, e.stopReason]),
        [
          ["unconfirmed", true, "timeout"],
          ["not_executed", false, undefined],
        ],
      );
      await assert.rejects(readFile(path.join(dir, "must-not-exist")), { code: "ENOENT" });
      assert.match(JSON.stringify(await client.callTool("echo", {})), /echo complete/);
      // Timeout is not a remote cancellation; explicitly release the fixture's pending operation.
      await client.callTool("release", {});
    } finally {
      await client.close();
      await rm(dir, { recursive: true, force: true });
    }
  },
);

test(
  "two runs share an MCP connection and cancelling one leaves the other request active",
  { timeout: 10_000 },
  async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "coil-mcp-isolation-"));
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
    const running: Promise<unknown>[] = [];
    try {
      const runs = [];
      for (const suffix of ["", "2"]) {
        const source = {
          type: "mcp" as const,
          serverName: "fixture",
          originalName: `wait${suffix}`,
        };
        const name = `remote${suffix}`;
        app.toolRuntime.registerTool({
          name,
          definition: {
            name,
            description: "fixture",
            parameters: { type: "object", properties: {} },
          },
          source,
          handler: createMcpHandler(client, source),
        });
        let calls = 0;
        const agent = new Agent({
          id: `lead${suffix}`,
          toolRuntime: app.toolRuntime,
          provider: fakeProvider(() =>
            ++calls === 1 ? toolCallMessage([toolCall(name)]) : textMessage("done"),
          ),
        });
        const run = createAgentRun({
          agentId: agent.id!,
          agentKind: "lead",
          sessionId: "shared",
          trigger: { type: "user_message" },
        });
        runs.push(run);
        running.push(app.agentRuntime.run(agent, run));
      }
      for (const suffix of ["", "2"]) {
        const deadline = Date.now() + 3_000;
        while (true) {
          try {
            await readFile(`${marker}${suffix}`);
            break;
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "ENOENT" || Date.now() >= deadline)
              throw error;
            await new Promise((resolve) => setTimeout(resolve, 10));
          }
        }
      }
      const cancelled = await app.agentRuntime.cancelRun(runs[0]!.id, "user", Date.now());
      assert.equal(cancelled.cleanup?.status, "unconfirmed");
      assert.equal(runs[1]!.status, "running");
      assert.match(JSON.stringify(await client.callTool("echo", {})), /echo complete/);
      await client.callTool("release2", {});
      await running[1];
      assert.equal(runs[1]!.status, "completed");
      await client.callTool("release", {});
      await app.agentRuntime.whenSettled(runs[0]!.id);
      assert.equal(runs[0]!.status, "interrupted");
    } finally {
      await client.close();
      await Promise.allSettled(running);
      await app.agentRuntime.close();
      await rm(dir, { recursive: true, force: true });
    }
  },
);
