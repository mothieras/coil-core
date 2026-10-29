import type {
  Api,
  AssistantMessage,
  Context,
  FetchFunction,
  Model,
  ProviderResponse,
  ProviderStreamOptions,
} from "@earendil-works/pi-ai";
import { getFallbackModel, getModel } from "../config/index.js";
import { getModelsCollection } from "./catalog.js";
import { ProviderRequestError, headerGetter, httpStatusFromMessage } from "./errors.js";
import { resolveModel } from "./model.js";
import type { Provider, ProviderCallOptions, ProviderRequest } from "./types.js";

export type PiAiComplete = (
  model: Model<Api>,
  context: Context,
  options?: ProviderStreamOptions,
) => Promise<AssistantMessage>;

export type PiAiProviderDeps = {
  complete?: PiAiComplete | undefined;
  resolveModel?: ((modelId: string) => Model<Api>) | undefined;
  fetch?: FetchFunction | undefined;
};

function supportsFetchCapture(api: Api): boolean {
  return api === "anthropic-messages" || api.startsWith("openai");
}

/**
 * pi-ai backed provider. pi-ai reports request failures inside the assistant
 * message, so `generate` rethrows them as ProviderRequestError carrying the
 * HTTP status/headers; the loop's recovery classifiers depend on that shape.
 * `onResponse` is not called for non-2xx responses, hence the fetch wrapper.
 */
export function createPiAiProvider(deps: PiAiProviderDeps = {}): Provider {
  const resolve = deps.resolveModel ?? resolveModel;
  const model = resolve(getModel());
  const fallbackId = getFallbackModel();
  const baseFetch = deps.fetch ?? globalThis.fetch;

  return {
    model,
    ...(fallbackId !== undefined ? { fallbackModel: resolve(fallbackId) } : {}),
    async generate(
      activeModel: Model<Api>,
      request: ProviderRequest,
      options?: ProviderCallOptions,
    ): Promise<AssistantMessage> {
      const context: Context = {
        messages: request.messages,
        tools: request.tools,
        ...(request.system !== undefined ? { systemPrompt: request.system } : {}),
      };
      let captured: ProviderResponse | undefined;
      const captureFetch: FetchFunction = async (input, init) => {
        const response = await baseFetch(input, init);
        captured = {
          status: response.status,
          headers: Object.fromEntries(response.headers.entries()),
        };
        return response;
      };
      const callOptions: ProviderStreamOptions = {
        maxRetries: 0,
        ...(options?.maxTokens !== undefined ? { maxTokens: options.maxTokens } : {}),
        ...(options?.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
        ...(supportsFetchCapture(activeModel.api) ? { fetch: captureFetch } : {}),
        onResponse: (response: ProviderResponse) => {
          captured = response;
        },
      };

      const message =
        deps.complete !== undefined
          ? await deps.complete(activeModel, context, callOptions)
          : await getModelsCollection().complete(activeModel, context, callOptions);

      if (message.stopReason === "error" || message.stopReason === "aborted") {
        const status = captured?.status ?? httpStatusFromMessage(message.errorMessage);
        throw new ProviderRequestError(
          message.errorMessage ?? `Provider request ended with ${message.stopReason}`,
          {
            ...(status !== undefined ? { status } : {}),
            ...(captured !== undefined ? { headers: headerGetter(captured.headers) } : {}),
          },
        );
      }
      return message;
    },
  };
}

export function createDefaultProvider(): Provider {
  return createPiAiProvider();
}
