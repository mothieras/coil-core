import type Anthropic from "@anthropic-ai/sdk";

/**
 * LLM provider interface. A provider owns the model identity and the
 * messages endpoint used by the agent loop. Embedders can implement this to
 * route the loop to a non-Anthropic backend without touching the loop itself.
 */
export interface Provider {
  /** Model id passed in `model` on every request. */
  readonly model: string;
  /** Optional fallback model used by recovery when the primary is unavailable. */
  readonly fallbackModel?: string | undefined;
  /** Anthropic-shaped messages endpoint. `create` is the only call the loop makes. */
  readonly messages: Pick<Anthropic.Messages, "create">;
}
