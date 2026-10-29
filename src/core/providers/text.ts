import type { Usage } from "@earendil-works/pi-ai";
import { createDefaultProvider } from "./pi.js";
import type { Provider } from "./types.js";

export type TextGenerator = (
  prompt: string,
  options?: { maxTokens?: number | undefined },
) => Promise<{ text: string; usage: Usage }>;

/** Single-turn text call shared by compaction, auto-title, and /ping. */
export function textGenerator(provider: Provider = createDefaultProvider()): TextGenerator {
  return async (prompt, options) => {
    const message = await provider.generate(
      provider.model,
      {
        messages: [{ role: "user", content: prompt, timestamp: Date.now() }],
        tools: [],
      },
      options?.maxTokens !== undefined ? { maxTokens: options.maxTokens } : {},
    );
    const text = message.content
      .filter((block) => block.type === "text")
      .map((block) => block.text)
      .join("\n\n");
    return { text, usage: message.usage };
  };
}
