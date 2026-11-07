#!/usr/bin/env tsx
/**
 * 通过构建产物运行一个 headless 轮次；--scripted 使用临时目录，无需凭据。
 *
 * 默认使用 .env 中的模型与 provider 凭据（参见 .env.example）。
 *
 *   pnpm build
 *   pnpm exec tsx examples/headless-agent.ts --scripted "hello"
 *   pnpm exec tsx examples/headless-agent.ts "explain this repo's entry point"
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Agent, agentLoop, createDefaultProvider, createAppContext } from "coil-core";
import { createScriptedProvider } from "./scripted-provider.js";

async function main(): Promise<void> {
  const scripted = process.argv[2] === "--scripted";
  const prompt = process.argv[scripted ? 3 : 2];
  if (!prompt) {
    throw new Error('usage: pnpm exec tsx examples/headless-agent.ts [--scripted] "your prompt"');
  }

  const workspaceRoot = scripted
    ? await mkdtemp(path.join(tmpdir(), "coil-headless-demo-"))
    : process.cwd();
  try {
    const app = createAppContext(workspaceRoot);
    try {
      const agent = new Agent({
        id: "headless",
        system: "You are a concise coding agent. Use tools when useful, then answer.",
        workspaceRoot,
        toolRuntime: app.toolRuntime,
        provider: scripted
          ? createScriptedProvider(() => ({
              content: [{ type: "text", text: `本地演示已收到：${prompt}` }],
              stopReason: "stop",
            }))
          : createDefaultProvider(),
        hooks: app.hooks,
        messages: [{ role: "user", content: prompt, timestamp: Date.now() }],
      });
      const result = await agentLoop(agent, {});
      if (result.stopReason !== "stop") throw new Error(`Run ended: ${result.stopReason}`);
      console.log(
        result.content
          .map((block) => (block.type === "text" ? block.text : `[${block.type}]`))
          .join("\n"),
      );
    } finally {
      await app.agentRuntime.close();
      await app.closeToolProviders();
    }
  } finally {
    if (scripted) await rm(workspaceRoot, { recursive: true, force: true });
  }
}

void main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
