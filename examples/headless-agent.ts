#!/usr/bin/env tsx
/**
 * Minimal headless embedding: read one prompt from argv, run a single agent
 * loop turn against the default Anthropic provider, and print the result.
 *
 * Requires ANTHROPIC_API_KEY + MODEL_ID in the environment (see .env.example).
 *
 *   pnpm build
 *   tsx examples/headless-agent.ts "explain this repo's entry point"
 */
import { Agent, agentLoop, createAnthropicProvider, createAppContext } from "../src/core/index.js";

async function main(): Promise<void> {
  const prompt = process.argv[2];
  if (!prompt) {
    console.error('usage: tsx examples/headless-agent.ts "your prompt"');
    process.exit(1);
  }

  const app = createAppContext(process.cwd(), {});
  const agent = new Agent({
    id: "headless",
    system: "You are a concise coding agent. Use tools when useful, then answer.",
    workspaceRoot: process.cwd(),
    toolRuntime: app.toolRuntime,
    provider: createAnthropicProvider(),
    hooks: app.hooks,
    messages: [{ role: "user", content: prompt }],
  });

  try {
    const result = await agentLoop(agent, {});
    const text = Array.isArray(result.content)
      ? result.content
          .map((block) => (block.type === "text" ? block.text : `[${block.type}]`))
          .join("\n")
      : String(result.content);
    console.log(text);
  } finally {
    await app.closeToolProviders();
  }
}

void main();
