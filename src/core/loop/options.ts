import type { AssistantMessage, StopReason } from "@earendil-works/pi-ai";

export type AgentLoopStopReason = StopReason | "max_turns" | "timeout";

export type AgentLoopResult = {
  stopReason: AgentLoopStopReason;
  content: AssistantMessage["content"];
};

export const DEFAULT_MAIN_AGENT_MAX_TURNS = 200;
export const DEFAULT_SUB_AGENT_MAX_TURNS = 90;
export const DEFAULT_SUB_AGENT_TIMEOUT_MS = 30 * 60 * 1000;
