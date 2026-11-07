import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { formatStartupError } from "../src/core/config/startupError.js";

test("core imports without model configuration or UI and validates on first provider use", async () => {
  const workspace = await mkdtemp(path.join(tmpdir(), "coil-lazy-config-"));
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    DOTENV_CONFIG_PATH: path.join(workspace, "missing.env"),
  };
  delete env.MODEL_ID;
  delete env.ANTHROPIC_MODEL;
  delete env.FALLBACK_MODEL_ID;
  delete env.COIL_LLM_PROVIDER;
  const core = new URL("../src/core/index.ts", import.meta.url).href;
  try {
    await promisify(execFile)(
      process.execPath,
      [
        "--import",
        "tsx",
        "--input-type=module",
        "--eval",
        `
          import assert from "node:assert/strict";
          import { registerHooks } from "node:module";
          registerHooks({
            resolve(specifier, context, next) {
              assert.doesNotMatch(specifier, /^(?:react|ink)(?:$|[-/])|[/]tui[/]/);
              return next(specifier, context);
            },
          });
          const { createDefaultProvider, createAppContext } = await import(${JSON.stringify(core)});
          const app = createAppContext(${JSON.stringify(workspace)});
          try {
            assert.throws(createDefaultProvider, {
              message: "MODEL_ID (or ANTHROPIC_MODEL) is required",
            });
          } finally {
            await app.agentRuntime.close();
            await app.closeToolProviders();
          }
        `,
      ],
      { env, timeout: 10_000 },
    );
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

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
