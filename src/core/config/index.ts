import "dotenv/config";

/** pi-ai provider id. Defaults to Anthropic; other built-in providers work via the catalog. */
export function getProviderId(): string {
  const provider = process.env.COIL_LLM_PROVIDER?.trim();
  return provider && provider.length > 0 ? provider : "anthropic";
}

/** Anthropic-compatible gateway endpoint. Applied to the resolved model's baseUrl. */
export function getBaseUrl(): string | undefined {
  const baseUrl = process.env.ANTHROPIC_BASE_URL?.trim();
  return baseUrl && baseUrl.length > 0 ? baseUrl : undefined;
}

export function getModel(): string {
  const model = process.env.MODEL_ID ?? process.env.ANTHROPIC_MODEL;
  if (!model) throw new Error("MODEL_ID (or ANTHROPIC_MODEL) is required");
  return model;
}

export function getFallbackModel(): string | undefined {
  const fallback = process.env.FALLBACK_MODEL_ID?.trim();
  return fallback ? fallback : undefined;
}
