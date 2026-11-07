import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Agent } from "../src/core/agent/agent.js";
import { createAgentRun } from "../src/core/agent/run.js";
import { createAppContext } from "../src/core/app/context.js";
import { fakeProvider, textMessage, toolCall, toolCallMessage } from "./helpers/pi.js";

test(
  "completed parents keep async processes; cancellation isolates run ownership and close stops the remainder",
  { timeout: 10_000 },
  async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "coil-owned-"));
    const app = createAppContext(dir);
    const pids: number[] = [];
    try {
      const start = async (id: string) => {
        let calls = 0;
        const agent = new Agent({
          id,
          workspaceRoot: dir,
          toolRuntime: app.toolRuntime,
          provider: fakeProvider(() =>
            ++calls === 1
              ? toolCallMessage([
                  toolCall("background_run", { command: `sleep 60 & echo $$ $! > ${id}; wait` }),
                ])
              : textMessage("parent completed"),
          ),
        });
        const run = createAgentRun({
          agentId: id,
          agentKind: "lead",
          sessionId: "session",
          trigger: { type: "user_message" },
        });
        await app.agentRuntime.run(agent, run);
        const deadline = Date.now() + 3_000;
        while (Date.now() < deadline) {
          try {
            const values = (await readFile(path.join(dir, id), "utf8"))
              .trim()
              .split(/\s+/)
              .map(Number);
            if (values.length === 2 && values.every(Boolean)) {
              pids.push(...values);
              return { run, pids: values };
            }
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
          }
          await new Promise((resolve) => setTimeout(resolve, 10));
        }
        throw new Error("Background fixture did not become ready");
      };
      const first = await start("first");
      const second = await start("second");
      const before = structuredClone(first.run);
      for (const pid of pids) assert.equal(process.kill(pid, 0), true);
      const cancelled = await app.agentRuntime.cancelRun(first.run.id);
      assert.equal(cancelled.status, "descendants_only");
      assert.equal(cancelled.cleanup?.status, "confirmed");
      for (const pid of first.pids) assert.throws(() => process.kill(pid, 0), { code: "ESRCH" });
      for (const pid of second.pids) assert.equal(process.kill(pid, 0), true);
      assert.deepEqual(first.run, before);
      await app.agentRuntime.close();
      for (const pid of second.pids) assert.throws(() => process.kill(pid, 0), { code: "ESRCH" });
      assert.deepEqual(app.inbox.drainNotifications(), []);
    } finally {
      await app.agentRuntime.close();
      await app.toolRuntime.cancelBackgroundTasks();
      await rm(dir, { recursive: true, force: true });
    }
  },
);

test(
  "cancelling one parent stops only its active child; runtime close stops the other",
  { timeout: 10_000 },
  async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "coil-owned-children-"));
    const app = createAppContext(dir);
    const entered = [Promise.withResolvers<void>(), Promise.withResolvers<void>()];
    const stopped = new Set<number>();
    const runs = [];
    try {
      for (const index of [0, 1]) {
        let turns = 0;
        const agent = new Agent({
          id: `parent-${index}`,
          workspaceRoot: dir,
          toolRuntime: app.toolRuntime,
          provider: fakeProvider((request, call) => {
            if (!request.system?.startsWith("You are a subagent"))
              return ++turns === 1
                ? toolCallMessage([toolCall("subagent", { prompt: `child ${index}` })])
                : textMessage("parent done");
            entered[index]!.resolve();
            return new Promise((resolve) => {
              call.options?.signal?.addEventListener(
                "abort",
                () => {
                  stopped.add(index);
                  resolve(textMessage("stopped"));
                },
                { once: true },
              );
            });
          }),
        });
        const run = createAgentRun({
          agentId: agent.id!,
          agentKind: "lead",
          sessionId: "owned",
          trigger: { type: "user_message" },
        });
        runs.push(run);
        await app.agentRuntime.run(agent, run);
        await entered[index]!.promise;
        assert.equal(run.status, "completed");
      }
      assert.deepEqual([...stopped], []);
      const original = structuredClone(runs[0]);
      assert.equal((await app.agentRuntime.cancelRun(runs[0]!.id)).status, "descendants_only");
      assert.deepEqual([...stopped], [0]);
      assert.equal(app.subAgentRunner.hasRunning(), true);
      assert.deepEqual(runs[0], original);
      await app.agentRuntime.close();
      await app.subAgentRunner.cancelAll();
      assert.deepEqual([...stopped], [0, 1]);
      assert.equal(app.subAgentRunner.hasRunning(), false);
      assert.deepEqual(app.inbox.drainNotifications(), []);
    } finally {
      await app.agentRuntime.close();
      await app.subAgentRunner.cancelAll();
      await rm(dir, { recursive: true, force: true });
    }
  },
);
