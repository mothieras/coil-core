import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { SessionController } from "../src/core/session/controller.js";
import { SessionStore } from "../src/core/session/store/sessionStore.js";
import { StdioMcpClient } from "../src/core/tools/mcp/stdioClient.js";
import { createMcpHandler } from "../src/core/tools/mcp/handler.js";
import { fakeProvider, textMessage, toolCall, toolCallMessage } from "./helpers/pi.js";

async function readReady(file: string): Promise<string> {
  const deadline = Date.now() + 3_000;
  while (true) {
    try {
      return await fs.readFile(file, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT" || Date.now() >= deadline) throw error;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }
}

for (const mode of ["confirmed", "failures", "timeout"] as const) {
  const release = mode !== "timeout";
  test(`combined close ${mode}`, { timeout: 12_000 }, async () => {
    const workspaceRoot = await fs.mkdtemp(path.join(tmpdir(), "coil-combined-close-"));
    const marker = path.join(workspaceRoot, "mcp-entered");
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
    const source = { type: "mcp" as const, serverName: "fixture", originalName: "wait" };
    const permission = Promise.withResolvers<void>();
    const completed = Promise.withResolvers<void>();
    let permissionStopped = false;
    let leadCalls = 0;
    let closes = 0;
    const store = new SessionStore(workspaceRoot);
    const finalRuns: string[] = [];
    const controller = await SessionController.createNew({
      workspaceRoot,
      store,
      title: "Combined close",
      provider: fakeProvider((request) => {
        if (request.system?.startsWith("You are a subagent"))
          return toolCallMessage([
            toolCall("bash", { command: "printf forbidden > must-not-exist" }, "child-shell"),
          ]);
        if (++leadCalls === 1)
          return toolCallMessage([
            toolCall("subagent", { prompt: "wait for permission" }, "spawn"),
            toolCall(
              "background_run",
              { command: "sleep 60 & echo $$ $! > shell-pids; wait" },
              "shell",
            ),
            toolCall("background_run", { command: "printf completed" }, "quick"),
          ]);
        return leadCalls === 2
          ? toolCallMessage([toolCall("remote", {}, "remote")])
          : textMessage("unexpected wake");
      }),
      checkPermission: (context) => {
        if (context.agentKind !== "subagent") return Promise.resolve({ allowed: true });
        context.emitPermissionRequested?.("Waiting for test approval");
        permission.resolve();
        return new Promise((_resolve, reject) => {
          const stop = () => {
            permissionStopped = true;
            reject(context.signal?.reason);
          };
          if (context.signal?.aborted) stop();
          else context.signal?.addEventListener("abort", stop, { once: true });
        });
      },
      toolProviderResults: [
        {
          tools: [
            {
              name: "remote",
              definition: {
                name: "remote",
                description: "wait",
                parameters: { type: "object", properties: {} },
              },
              source,
              handler: createMcpHandler(client, source),
            },
          ],
          diagnostics: [],
          close: async () => {
            closes++;
            await client.close();
            if (mode === "failures") throw new Error("provider-close-failure");
          },
        },
      ],
      onSessionEvent: (event) => {
        if (event.type === "background_finished" && event.command.status === "completed")
          completed.resolve();
        if (
          event.type === "run_changed" &&
          ["completed", "interrupted", "failed"].includes(event.run.status)
        )
          finalRuns.push(event.run.id);
      },
    });
    let running: Promise<unknown> | undefined;
    try {
      running = controller.handleUserMessage("start all work");
      await Promise.all([permission.promise, completed.promise, readReady(marker)]);
      const pids = (await readReady(path.join(workspaceRoot, "shell-pids")))
        .trim()
        .split(/\s+/)
        .map(Number);
      for (const pid of pids) assert.equal(process.kill(pid, 0), true);
      const mcpPid = Number(await readReady(marker));
      const wake = controller.handleAutoWake("async_work_finished");
      if (mode !== "confirmed")
        store.saveSnapshot = async () => {
          throw new Error("close-save-failure");
        };
      const closing = controller.close();
      assert.equal(controller.close(), closing);
      await assert.rejects(controller.handleUserMessage("late"), /closing/);
      if (release) {
        await client.callTool("release", {});
      }
      if (mode === "confirmed") await closing;
      else {
        await assert.rejects(closing, (error: unknown) => {
          assert.ok(error instanceof AggregateError);
          const errors = error.errors.map(String).join("\n");
          assert.match(errors, mode === "timeout" ? /unconfirmed/ : /provider-close-failure/);
          assert.match(errors, /close-save-failure/);
          return true;
        });
      }
      await client.close();
      await running;
      assert.equal(await wake, undefined);
      assert.equal(permissionStopped, true);
      assert.equal(closes, 1);
      assert.equal(leadCalls, 2);
      assert.equal(controller.hasPendingAsyncWork(), false);
      assert.equal(await controller.handleAutoWake("async_work_finished"), undefined);
      for (const pid of [...pids, mcpPid])
        assert.throws(() => process.kill(pid, 0), { code: "ESRCH" });
      await assert.rejects(fs.access(path.join(workspaceRoot, "must-not-exist")), {
        code: "ENOENT",
      });
      const snapshot = controller.getSnapshot();
      assert.equal(snapshot.session?.status, "closed");
      assert.equal(snapshot.agentRuns.length, 2);
      assert.equal(new Set(finalRuns).size, 2);
      assert.equal(finalRuns.length, 2);
      const lead = snapshot.agentRuns.find((run) => run.agentKind === "lead")!;
      assert.equal(lead.cleanup?.status, release ? "confirmed" : "unconfirmed");
      const messages = structuredClone(controller.leadAgentState.messages);
      await controller.appContext.agentRuntime.whenSettled(lead.id);
      assert.deepEqual(controller.leadAgentState.messages, messages);
      assert.ok(
        controller.appContext.inbox.getResults().some((result) => result.status === "completed"),
      );
      assert.deepEqual(controller.appContext.inbox.drainNotifications(), []);
    } finally {
      await client.close();
      await controller.close().catch(() => {});
      await running;
      await fs.rm(workspaceRoot, { recursive: true, force: true });
    }
  });
}
