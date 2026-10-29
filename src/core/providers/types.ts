import type { Api, AssistantMessage, Message, Model, Tool } from "@earendil-works/pi-ai";

/** Request payload the loop hands to a provider. */
export type ProviderRequest = {
  system?: string | undefined;
  messages: Message[];
  tools: Tool[];
};

export type ProviderCallOptions = {
  maxTokens?: number | undefined;
  timeoutMs?: number | undefined;
};

/**
 * LLM provider interface. The loop only calls `generate`; `model` describes the
 * default target and `fallbackModel` the recovery target. `generate` takes the
 * model explicitly so recovery can switch models mid-run.
 */
export interface Provider {
  readonly model: Model<Api>;
  readonly fallbackModel?: Model<Api> | undefined;
  generate(
    model: Model<Api>,
    request: ProviderRequest,
    options?: ProviderCallOptions,
  ): Promise<AssistantMessage>;
}
