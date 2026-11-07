#!/usr/bin/env tsx
/** 无凭据演示：pnpm build && pnpm exec tsx examples/cancel-run.ts */
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Agent, createAgentRun, createAppContext } from "coil-core";
import { createScriptedProvider } from "./scripted-provider.js";

const workspace = await mkdtemp(path.join(tmpdir(), "coil-cancel-demo-"));
const app = createAppContext(workspace);
const command = `node -e 'require("node:fs").writeFileSync("ready", String(process.pid)); setInterval(() => {}, 1000)'`;
let requests = 0;
const provider = createScriptedProvider(() => {
  requests++;
  return {
    content: [{ type: "toolCall", id: "demo-shell", name: "bash", arguments: { command } }],
    stopReason: "toolUse",
  };
});
const agent = new Agent({
  id: "demo",
  toolRuntime: app.toolRuntime,
  workspaceRoot: workspace,
  provider,
});
const run = createAgentRun({
  agentId: "demo",
  agentKind: "lead",
  trigger: { type: "user_message" },
});
const running = app.agentRuntime.run(agent, run);
// Observe errors immediately, including failures before the readiness marker.
let failure: unknown;
void running.catch((error) => {
  failure = error;
});
try {
  let pid: number | undefined;
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline && !pid) {
    if (failure) throw failure;
    try {
      pid = Number(await readFile(path.join(workspace, "ready"), "utf8"));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    if (!pid) await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.ok(pid, "The managed process must report readiness");
  console.log("受控进程已就绪，正在取消运行。");
  const cancellation = await app.agentRuntime.cancelRun(run.id);
  const { result } = await running;
  console.log(
    `run=${run.status}, reason=${run.stopReason}, cleanup=${cancellation.cleanup?.status}`,
  );
  assert.equal(cancellation.cleanup?.status, "confirmed");
  assert.equal(run.status, "interrupted");
  assert.equal(result.stopReason, "aborted");
  assert.equal(requests, 1, "Cancellation must not dispatch another model request");
  assert.throws(() => process.kill(pid, 0), { code: "ESRCH" });
  assert.equal(await readFile(path.join(workspace, "ready"), "utf8"), String(pid));
  console.log("已确认进程退出。取消不会回滚已经发生的副作用。");
} finally {
  await app.agentRuntime.close();
  await app.closeToolProviders();
  await rm(workspace, { recursive: true, force: true });
}
