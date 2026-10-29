import test from "node:test";
import assert from "node:assert/strict";
import { clearModelCache, createPiAiProvider, resolveModel } from "../src/core/providers/index.js";
import { ProviderRequestError, httpStatusFromMessage } from "../src/core/providers/errors.js";
import { decideRecovery, initialRecoveryState } from "../src/core/loop/recovery.js";
import { getModelsCollection } from "../src/core/providers/catalog.js";
import { assistantMessage, testModel, textMessage, userMessage } from "./helpers/pi.js";

async function withEnv<T>(
  vars: Record<string, string | undefined>,
  run: () => T | Promise<T>,
): Promise<T> {
  const saved = new Map<string, string | undefined>();
  for (const [key, value] of Object.entries(vars)) {
    saved.set(key, process.env[key]);
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  clearModelCache();
  try {
    return await run();
  } finally {
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    clearModelCache();
  }
}

test("resolveModel returns the catalog entry for a known model", async () => {
  const catalog = getModelsCollection().getModels("anthropic")[0];
  assert.ok(catalog);

  await withEnv({ ANTHROPIC_BASE_URL: undefined }, () => {
    const resolved = resolveModel(catalog.id, "anthropic");
    assert.equal(resolved.id, catalog.id);
    assert.equal(resolved.api, catalog.api);
    assert.equal(resolved.contextWindow, catalog.contextWindow);
  });
});

test("resolveModel builds a custom anthropic model for gateway model ids", async () => {
  await withEnv({ ANTHROPIC_BASE_URL: undefined }, () => {
    const resolved = resolveModel("glm-5", "anthropic");
    assert.equal(resolved.id, "glm-5");
    assert.equal(resolved.api, "anthropic-messages");
    assert.equal(resolved.provider, "anthropic");
    assert.equal(resolved.baseUrl, "https://api.anthropic.com");
    assert.equal(resolved.maxTokens, 64_000);
  });
});

test("resolveModel applies ANTHROPIC_BASE_URL to catalog and gateway models", async () => {
  const catalog = getModelsCollection().getModels("anthropic")[0];
  assert.ok(catalog);

  await withEnv({ ANTHROPIC_BASE_URL: "https://gateway.example/anthropic" }, () => {
    assert.equal(
      resolveModel(catalog.id, "anthropic").baseUrl,
      "https://gateway.example/anthropic",
    );
    assert.equal(
      resolveModel("MiniMax-M2.5", "anthropic").baseUrl,
      "https://gateway.example/anthropic",
    );
  });
});

test("resolveModel ignores ANTHROPIC_BASE_URL for non-anthropic providers", async () => {
  const catalog = getModelsCollection().getModels("openai")[0];
  if (!catalog) return;

  await withEnv({ ANTHROPIC_BASE_URL: "https://gateway.example/anthropic" }, () => {
    assert.equal(resolveModel(catalog.id, "openai").baseUrl, catalog.baseUrl);
  });
});

test("resolveModel rejects unknown models for non-anthropic providers", () => {
  assert.throws(
    () => resolveModel("not-a-model", "openai"),
    /Unknown model 'not-a-model' for provider 'openai'/,
  );
});

test("createPiAiProvider forwards context, maxTokens, timeout and disables SDK retries", async () => {
  await withEnv({ MODEL_ID: "test-model", FALLBACK_MODEL_ID: undefined }, async () => {
    let observed:
      { context: { systemPrompt?: string }; options: Record<string, unknown> } | undefined;

    const provider = createPiAiProvider({
      resolveModel: () => testModel(),
      complete: async (_model, context, options) => {
        observed = {
          context: context as { systemPrompt?: string },
          options: options as Record<string, unknown>,
        };
        return textMessage("done");
      },
    });

    const result = await provider.generate(
      provider.model,
      { system: "be brief", messages: [userMessage("hi")], tools: [] },
      { maxTokens: 1234, timeoutMs: 5000 },
    );

    assert.equal(result.stopReason, "stop");
    assert.ok(observed);
    assert.equal(observed.context.systemPrompt, "be brief");
    assert.equal(observed.options.maxTokens, 1234);
    assert.equal(observed.options.timeoutMs, 5000);
    assert.equal(observed.options.maxRetries, 0);
    assert.equal(typeof observed.options.onResponse, "function");
  });
});

test("createPiAiProvider turns error messages into ProviderRequestError with status and headers", async () => {
  await withEnv({ MODEL_ID: "test-model", FALLBACK_MODEL_ID: undefined }, async () => {
    const provider = createPiAiProvider({
      resolveModel: () => testModel(),
      complete: async (model, _context, options) => {
        options?.onResponse?.({ status: 429, headers: { "retry-after": "5" } }, model);
        return assistantMessage([], "error");
      },
    });

    let caught: unknown;
    try {
      await provider.generate(provider.model, { messages: [userMessage("hi")], tools: [] });
      assert.fail("expected a provider error");
    } catch (error) {
      caught = error;
    }

    assert.ok(caught instanceof ProviderRequestError);
    assert.equal(caught.status, 429);
    assert.equal(caught.headers?.get("Retry-After"), "5");

    const action = decideRecovery(
      { kind: "error", error: caught },
      { ...initialRecoveryState(), retryAttempt: 0 },
    );
    assert.equal(action.type, "backoff_and_retry");
    assert.equal(action.delayMs, 5000);
  });
});

test("httpStatusFromMessage parses pi-ai HTTP error prefixes", () => {
  assert.equal(httpStatusFromMessage('429 {"error":"rate limited"}'), 429);
  assert.equal(httpStatusFromMessage("529 overloaded"), 529);
  assert.equal(httpStatusFromMessage("model overloaded"), undefined);
  assert.equal(httpStatusFromMessage(undefined), undefined);
});

test("createPiAiProvider captures status and headers from a real pi-ai HTTP error", async () => {
  await withEnv(
    {
      MODEL_ID: "test-model",
      FALLBACK_MODEL_ID: undefined,
      ANTHROPIC_API_KEY: "test-key",
      ANTHROPIC_BASE_URL: undefined,
    },
    async () => {
      const provider = createPiAiProvider({
        resolveModel: () => testModel(),
        fetch: async () =>
          new Response(
            JSON.stringify({
              type: "error",
              error: { type: "rate_limit_error", message: "rate limited" },
            }),
            {
              status: 429,
              headers: { "content-type": "application/json", "retry-after": "7" },
            },
          ),
      });

      let caught: unknown;
      try {
        await provider.generate(provider.model, {
          messages: [userMessage("hi")],
          tools: [],
        });
        assert.fail("expected a provider error");
      } catch (error) {
        caught = error;
      }

      assert.ok(caught instanceof ProviderRequestError);
      assert.equal(caught.status, 429);
      assert.equal(caught.headers?.get("retry-after"), "7");
      assert.match(caught.message, /rate limited/);

      const action = decideRecovery({ kind: "error", error: caught }, initialRecoveryState());
      assert.equal(action.type, "backoff_and_retry");
      assert.equal(action.delayMs, 7000);
    },
  );
});

test("createPiAiProvider surfaces truncated output as stopReason length", async () => {
  await withEnv({ MODEL_ID: "test-model", FALLBACK_MODEL_ID: undefined }, async () => {
    const provider = createPiAiProvider({
      resolveModel: () => testModel(),
      complete: async () => textMessage("partial", "length"),
    });

    const result = await provider.generate(provider.model, {
      messages: [userMessage("hi")],
      tools: [],
    });

    assert.equal(result.stopReason, "length");
  });
});
