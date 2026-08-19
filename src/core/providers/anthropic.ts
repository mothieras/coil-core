import type { Provider } from "./types.js";
import { getClient, getFallbackModel, getModel } from "../config/index.js";

/**
 * The default Anthropic provider. Lazily resolves env on first use so that
 * importing the module never throws — embedders can swap providers without
 * needing ANTHROPIC_API_KEY set at import time.
 */
export function createAnthropicProvider(): Provider {
  const client = getClient();
  return {
    model: getModel(),
    fallbackModel: getFallbackModel(),
    messages: client.messages,
  };
}
