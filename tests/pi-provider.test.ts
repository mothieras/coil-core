import test from "node:test";
import { createServer } from "node:http";
import { once } from "node:events";
import { ExecutionStoppedError } from "../src/core/loop/cancellation.js";
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

test("adapter aborts before dispatch and after an in-flight completion", async () => {
  await withEnv({ MODEL_ID: "test-model", FALLBACK_MODEL_ID: undefined }, async () => {
    const abort = new AbortController();
    let calls = 0;
    const response = Promise.withResolvers<ReturnType<typeof textMessage>>();
    const entered = Promise.withResolvers<void>();
    const provider = createPiAiProvider({
      resolveModel: () => testModel(),
      complete: async (_model, _context, options) => {
        calls++;
        assert.equal(options?.signal, abort.signal);
        entered.resolve();
        return response.promise;
      },
    });
    const request = { messages: [], tools: [] };
    const pending = provider.generate(provider.model, request, { signal: abort.signal });
    await entered.promise;
    abort.abort();
    response.resolve(textMessage("late"));
    await assert.rejects(pending, ExecutionStoppedError);
    await assert.rejects(
      provider.generate(provider.model, request, { signal: abort.signal }),
      ExecutionStoppedError,
    );
    assert.equal(calls, 1);
  });
});

test(
  "real pi-ai adapter cancellation closes a local HTTP request without retry",
  { timeout: 10_000 },
  async () => {
    const entered = Promise.withResolvers<void>();
    const disconnected = Promise.withResolvers<void>();
    let calls = 0;
    const server = createServer((_req, res) => {
      calls++;
      res.on("close", () => disconnected.resolve());
      entered.resolve();
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    try {
      const address = server.address();
      assert.ok(address && typeof address !== "string");
      await withEnv(
        {
          MODEL_ID: "local-test",
          FALLBACK_MODEL_ID: undefined,
          ANTHROPIC_API_KEY: "local-fixture-only",
        },
        async () => {
          const provider = createPiAiProvider({
            resolveModel: () => ({
              ...testModel(),
              api: "anthropic-messages",
              provider: "anthropic",
              baseUrl: `http://127.0.0.1:${address.port}`,
            }),
          });
          const abort = new AbortController();
          const pending = provider.generate(
            provider.model,
            { messages: [userMessage("hello")], tools: [] },
            { signal: abort.signal },
          );
          const rejected = assert.rejects(pending, ExecutionStoppedError);
          await entered.promise;
          abort.abort();
          await rejected;
          await disconnected.promise;
          assert.equal(calls, 1);
        },
      );
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    }
  },
);

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
