import { PROMPT_SECTIONS } from "./sections.js";
import type { PromptContext } from "./types.js";

export type { PromptContext };

// 按稳定性排序：越不变的内容越靠前，充分利用前缀缓存
// Prompt budget: base prompt (sample skills/memory) ≤ 1200 estimated tokens
// (currently ~430) — enforced by tests/prompt-budget.test.ts.
const SECTION_ORDER = ["soul", "guidelines", "skills", "memory", "close"] as const;

export function buildSystemPrompt(context: PromptContext): string {
  const parts: string[] = [];

  for (const key of SECTION_ORDER) {
    const section = PROMPT_SECTIONS[key];
    if (!section) continue;
    const text = section(context);
    if (text !== null) {
      parts.push(text);
    }
  }

  return parts.join("\n\n");
}
