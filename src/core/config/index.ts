import Anthropic from "@anthropic-ai/sdk";
import "dotenv/config";

let cachedClient: Anthropic | undefined;

export function getClient(): Anthropic {
  if (cachedClient !== undefined) return cachedClient;
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error("ANTHROPIC_API_KEY is required");
  const baseURL = process.env.ANTHROPIC_BASE_URL;
  cachedClient = new Anthropic({
    apiKey,
    ...(baseURL ? { baseURL } : {}),
  });
  return cachedClient;
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
