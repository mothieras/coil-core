import type { Provider, ProviderRequest } from "coil-core";

type Reply = Pick<Awaited<ReturnType<Provider["generate"]>>, "content" | "stopReason">;

/** 演示共用的本地 provider，不读取模型配置或发起网络请求。 */
export function createScriptedProvider(reply: (request: ProviderRequest) => Reply): Provider {
  const model: Provider["model"] = {
    id: "scripted",
    name: "Local demo",
    api: "anthropic-messages",
    provider: "anthropic",
    baseUrl: "http://127.0.0.1",
    reasoning: false,
    input: ["text"],
    contextWindow: 200_000,
    maxTokens: 1024,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  };
  return {
    model,
    async generate(_model, request) {
      return {
        role: "assistant",
        api: model.api,
        provider: model.provider,
        model: model.id,
        timestamp: Date.now(),
        usage: {
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 0,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
        ...reply(request),
      };
    },
  };
}
