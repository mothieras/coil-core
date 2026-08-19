import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { buildSystemPrompt } from "../src/core/context/assembler.js";
import { createAppContext } from "../src/core/app/context.js";

const estimateTokens = (text: string): number => Math.ceil(text.length / 4);

test("base system prompt stays under the token budget", () => {
  const prompt = buildSystemPrompt({
    workspace: "/home/user/project",
    skills:
      "  - demo-skill (/home/user/project/skills/demo-skill/SKILL.md): a sample skill\n  - other (/home/user/project/skills/other/SKILL.md): another skill",
    memories: "- [pref](pref.md)[user] — prefers pnpm\n- [ctx](ctx.md)[project] — monorepo layout",
  });
  const estimate = estimateTokens(prompt);
  assert.ok(estimate <= 1200, `prompt is ~${estimate} tokens (budget 1200)`);
});

test("builtin tool set is exactly the seven slim tools", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "coil-budget-"));
  try {
    const app = createAppContext(dir);
    const names = app.toolRegistry
      .getDefinitions()
      .map((definition) => definition.name)
      .sort();
    assert.deepEqual(names, [
      "background_run",
      "bash",
      "edit_file",
      "read_file",
      "subagent",
      "update_tasks",
      "write_file",
    ]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
