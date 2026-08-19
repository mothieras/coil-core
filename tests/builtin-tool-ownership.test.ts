import { access, readFile, readdir } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

const toolsRoot = path.join(process.cwd(), "src", "core", "tools");

test("builtins aggregates per-tool factories instead of a central handler file", async () => {
  const builtinsSource = await readFile(path.join(toolsRoot, "builtins.ts"), "utf8");

  assert.doesNotMatch(builtinsSource, /toolHandlers\.js/);
  assert.match(builtinsSource, /\.\/file\/index\.js/);

  const expectedFactoryFiles = [
    "file/bash.ts",
    "file/read.ts",
    "file/write.ts",
    "file/edit.ts",
    "task/updateTasks.ts",
    "background/run.ts",
    "subagent/subagentTool.ts",
  ];

  const toolFiles = await readdir(toolsRoot, { recursive: true });
  assert.deepEqual(
    expectedFactoryFiles.filter((file) => toolFiles.includes(file)),
    expectedFactoryFiles,
  );

  await assert.rejects(access(path.join(toolsRoot, "builtin")));
  await assert.rejects(access(path.join(toolsRoot, "toolHandlers.ts")));
});
