import test from "node:test";
import assert from "node:assert/strict";
import { renderMarkdown } from "../src/tui/markdown.js";

test("renderMarkdown keeps content and strips trailing blank lines", () => {
  const out = renderMarkdown("**bold** and `code`\n\n- item one\n- item two");
  assert.match(out, /bold/);
  assert.match(out, /code/);
  assert.match(out, /item one/);
  assert.doesNotMatch(out, /\n$/);
});

test("renderMarkdown is total: empty input and renderer failures fall back", () => {
  assert.equal(renderMarkdown(""), "");
  // Non-string input must not throw — it falls back to the input.
  const bad = renderMarkdown(123 as unknown as string);
  assert.equal(bad, 123 as unknown as string);
});
