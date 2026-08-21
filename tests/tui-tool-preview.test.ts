import test from "node:test";
import assert from "node:assert/strict";
import { formatToolPreview, formatToolTarget } from "../src/tui/toolPreview.js";

test("edit_file previews old/new lines as a diff", () => {
  const lines = formatToolPreview("edit_file", {
    filepath: "src/a.ts",
    old_text: "const a = 1;\nconst b = 2;",
    new_text: "const a = 1;\nconst b = 3;",
  });
  assert.deepEqual(lines, ["  const a = 1;", "- const b = 2;", "+ const b = 3;"]);
});

test("edit_file preview caps long sides with a more-lines tail", () => {
  const old = Array.from({ length: 12 }, (_, i) => `old ${i}`).join("\n");
  const lines = formatToolPreview("edit_file", { old_text: old, new_text: "x" });
  assert.ok(lines);
  // 8 content lines + 1 "… (+4 more)" tail on the old side, then the new side.
  assert.equal(lines!.filter((line: string) => line.startsWith("- ")).length, 9);
  assert.ok(lines!.some((line: string) => /… \(\+4 more\)/.test(line)));
  assert.deepEqual(lines!.at(-1), "+ x");
});

test("write_file previews the first content lines as additions", () => {
  const lines = formatToolPreview("write_file", {
    filepath: "notes.md",
    content: "line 1\nline 2",
  });
  assert.deepEqual(lines, ["+ line 1", "+ line 2"]);
});

test("bash previews the command; unknown tools have no preview", () => {
  assert.deepEqual(formatToolPreview("bash", { command: "rm -rf build" }), ["$ rm -rf build"]);
  assert.equal(formatToolPreview("subagent", { prompt: "x" }), null);
  assert.equal(formatToolPreview("edit_file", {}), null);
});

test("permission targets expose file, command, and subagent context", () => {
  assert.equal(formatToolTarget("edit_file", { path: "src/a.ts" }), "src/a.ts");
  assert.equal(formatToolTarget("write_file", { filepath: "src/b.ts" }), "src/b.ts");
  assert.equal(formatToolTarget("bash", { command: "pnpm test" }), "pnpm test");
  assert.equal(formatToolTarget("subagent", { task: "review TUI" }), "review TUI");
});
