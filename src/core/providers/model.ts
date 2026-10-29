import type { Api, Model } from "@earendil-works/pi-ai";
import { getBaseUrl, getProviderId } from "../config/index.js";
import { getModelsCollection } from "./catalog.js";

const DEFAULT_CONTEXT_WINDOW = 200_000;
const DEFAULT_MAX_TOKENS = 64_000;

const cache = new Map<string, Model<Api>>();

/**
 * Resolves the configured model id against pi-ai's catalog. Gateway model ids
 * (Anthropic-compatible proxies) fall back to a custom anthropic-messages model
 * so `ANTHROPIC_BASE_URL` keeps working.
 */
export function resolveModel(modelId: string, providerId: string = getProviderId()): Model<Api> {
  const key = `${providerId}:${modelId}`;
  const hit = cache.get(key);
  if (hit !== undefined) return hit;

  const baseUrl = providerId === "anthropic" ? getBaseUrl() : undefined;
  const catalogModel = getModelsCollection().getModel(providerId, modelId);
  const resolved =
    catalogModel !== undefined
      ? withBaseUrl(catalogModel, baseUrl)
      : createGatewayModel(modelId, providerId, baseUrl);
  cache.set(key, resolved);
  return resolved;
}

export function clearModelCache(): void {
  cache.clear();
}

function withBaseUrl(model: Model<Api>, baseUrl: string | undefined): Model<Api> {
  return baseUrl === undefined ? model : { ...model, baseUrl };
}

function createGatewayModel(
  modelId: string,
  providerId: string,
  baseUrl: string | undefined,
): Model<Api> {
  if (providerId !== "anthropic") {
    throw new Error(
      `Unknown model '${modelId}' for provider '${providerId}'. Set MODEL_ID to a model in that provider's catalog.`,
    );
  }
  const model: Model<"anthropic-messages"> = {
    id: modelId,
    name: modelId,
    api: "anthropic-messages",
    provider: "anthropic",
    baseUrl: baseUrl ?? "https://api.anthropic.com",
    reasoning: false,
    input: ["text", "image"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: DEFAULT_CONTEXT_WINDOW,
    maxTokens: DEFAULT_MAX_TOKENS,
  };
  return model;
}
