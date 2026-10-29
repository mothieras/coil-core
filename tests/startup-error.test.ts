import test from "node:test";
import assert from "node:assert/strict";
import { formatStartupError } from "../src/core/config/startupError.js";

test("missing env errors become a friendly setup message", () => {
  const forKey = formatStartupError(new Error("ANTHROPIC_API_KEY is required"));
  assert.ok(forKey);
  assert.match(forKey!, /ANTHROPIC_API_KEY/);
  assert.match(forKey!, /\.env/);
  assert.match(forKey!, /pnpm dev/);

  const forModel = formatStartupError(new Error("MODEL_ID (or ANTHROPIC_MODEL) is required"));
  assert.ok(forModel);
  assert.match(forModel!, /MODEL_ID/);

  const forProvider = formatStartupError(new Error("No API key for provider: anthropic"));
  assert.ok(forProvider);
  assert.match(forProvider!, /ANTHROPIC_API_KEY/);

  const forUnconfigured = formatStartupError(new Error("Provider is not configured: anthropic"));
  assert.ok(forUnconfigured);
  assert.match(forUnconfigured!, /ANTHROPIC_API_KEY/);
});

test("other errors are not rewritten", () => {
  assert.equal(formatStartupError(new Error("boom")), null);
  assert.equal(formatStartupError("not an error"), null);
});
