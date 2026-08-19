import type Anthropic from "@anthropic-ai/sdk";

export type AgentLoopStopReason =
  Anthropic.Messages.Message["stop_reason"] | "max_turns" | "timeout" | "error";

export type AgentLoopResult = {
  stopReason: AgentLoopStopReason;
  content: Anthropic.Messages.Message["content"];
};

export const DEFAULT_MAIN_AGENT_MAX_TURNS = 200;
export const DEFAULT_SUB_AGENT_MAX_TURNS = 90;
export const DEFAULT_SUB_AGENT_TIMEOUT_MS = 30 * 60 * 1000;
