#!/usr/bin/env tsx
/** 无凭据演示：pnpm build && pnpm exec tsx examples/recover-session.ts */
import assert from "node:assert/strict";
import { fork } from "node:child_process";
import { once } from "node:events";
import { appendFile, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { builtinTool, SessionController } from "coil-core";
import { createScriptedProvider } from "./scripted-provider.js";

const sessionId = "recovery-demo";
const definition = {
  name: "append_marker",
  description: "Append one marker in this demo workspace.",
  parameters: { type: "object", properties: {}, additionalProperties: false },
};

async function worker(workspaceRoot: string): Promise<void> {
  const controller = await SessionController.createNew({
    workspaceRoot,
    sessionId,
    title: "Local recovery demo",
    provider: createScriptedProvider(() => ({
      content: [{ type: "toolCall", id: "marker", name: definition.name, arguments: {} }],
      stopReason: "toolUse",
    })),
  });
  controller.appContext.toolRuntime.registerTool(
    builtinTool(definition, async () => {
      // 进入 handler 前，controller 已确认工具意图；此处故意不返回结果。
      await appendFile(path.join(workspaceRoot, "effects"), "executed\n");
      process.send!("effect written");
      await new Promise((_, reject) => {
        setTimeout(() => reject(new Error("Demo worker was not terminated")), 10_000);
      });
      throw new Error("Unreachable");
    }),
  );
  try {
    await controller.handleUserMessage("Append one demo marker.");
    throw new Error("Demo worker finished before the interruption");
  } finally {
    await controller.close();
  }
}

async function interruptAfterEffect(workspaceRoot: string): Promise<void> {
  const child = fork(fileURLToPath(import.meta.url), ["--worker", workspaceRoot], {
    execArgv: ["--import", "tsx"],
    stdio: ["ignore", "inherit", "inherit", "ipc"],
  });
  const exited = once(child, "exit");
  const ready = new AbortController();
  const timer = setTimeout(() => ready.abort(), 10_000);
  try {
    const [message] = await Promise.race([
      once(child, "message", { signal: ready.signal }),
      exited.then(() => {
        throw new Error("Demo worker exited before writing the marker");
      }),
    ]);
    assert.equal(message, "effect written");
    console.log("副作用已发生，正在结果保存前终止演示进程。");
  } finally {
    clearTimeout(timer);
    ready.abort();
    child.kill("SIGKILL");
    const [code, signal] = await exited;
    assert.deepEqual([code, signal], [null, "SIGKILL"]);
  }
}

async function main(): Promise<void> {
  const workspaceRoot = await mkdtemp(path.join(tmpdir(), "coil-recovery-demo-"));
  try {
    await interruptAfterEffect(workspaceRoot);
    let requests = 0;
    let replays = 0;
    const provider = createScriptedProvider(() => {
      requests++;
      return {
        content: [{ type: "text", text: "已按新消息继续，没有重跑工具。" }],
        stopReason: "stop",
      };
    });
    const options = { workspaceRoot, sessionId, provider };
    const controller = await SessionController.resume(options);
    try {
      controller.appContext.toolRuntime.registerTool(
        builtinTool(definition, async () => {
          replays++;
          await appendFile(path.join(workspaceRoot, "effects"), "replayed\n");
          return { status: "completed", output: "This must not be replayed." };
        }),
      );
      const pending = controller.getSnapshot().recovery?.pending ?? [];
      assert.equal(pending.length, 1);
      const operation = pending[0]!;
      assert.equal(operation.kind, "tool");
      assert.equal(operation.name, definition.name);
      console.log("恢复发现结果未知，继续执行和自动唤醒均被阻止。");
      await assert.rejects(controller.handleUserMessage("Continue."), /outcome unknown/);
      await assert.rejects(controller.handleAutoWake("async_work_finished"), /outcome unknown/);
      assert.equal(requests, 0);
      assert.equal(replays, 0);

      // 核实这个已知的本地副作用；真实宿主应让用户检查对应外部系统后作决定。
      assert.equal(await readFile(path.join(workspaceRoot, "effects"), "utf8"), "executed\n");
      await controller.resolveRecovery(operation.id, "verified");
      assert.equal(requests, 0, "Recording verification must not resume execution");
      console.log("已读取本地文件核实副作用，并保存 verified 决定。");
      const turn = await controller.handleUserMessage(
        "The marker exists; continue without repeating it.",
      );
      assert.equal(turn.run.stopReason, "stop");
      assert.equal(requests, 1);
      assert.equal(replays, 0);
      assert.equal(await readFile(path.join(workspaceRoot, "effects"), "utf8"), "executed\n");
    } finally {
      await controller.close();
    }
    const reopened = await SessionController.resume(options);
    try {
      assert.deepEqual(reopened.getSnapshot().recovery?.pending, []);
      assert.equal(requests, 1);
      console.log("再次打开后核实决定仍有效，副作用只发生一次。");
    } finally {
      await reopened.close();
    }
  } finally {
    await rm(workspaceRoot, { recursive: true, force: true });
  }
}

if (process.argv[2] === "--worker") {
  await worker(process.argv[3]!);
} else {
  await main();
}
