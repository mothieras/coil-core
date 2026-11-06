import type { AgentKind } from "../agent/run.js";
import type { ToolSource, ToolExecutionResult } from "./types.js";

export type ToolInput = Record<string, unknown>;
export type ToolInvocationContext = {
  signal?: AbortSignal | undefined;
  /** Model parser failure; never expose its raw contents in diagnostics. */
  argumentsError?: string | undefined;
  /** Host gate after validation, before dispatch. Direct runtime callers are trusted hosts. */
  beforeInvoke?: ((input: ToolInput) => Promise<ToolExecutionResult | void>) | undefined;
  onDispatch?: (() => void) | undefined;
  toolCallId?: string | undefined;
  toolName: string;
  runId?: string | undefined;
  sessionId?: string | undefined;
  agentId?: string | undefined;
  agentKind?: AgentKind | undefined;
  source?: ToolSource | undefined;
};
export type ToolHandler = (
  input: ToolInput,
  context?: ToolInvocationContext,
) => Promise<ToolExecutionResult> | ToolExecutionResult;
