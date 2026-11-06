import type { ToolInvocationContext } from "../input.js";

export type SubagentStartOptions = {
  name?: string | undefined;
  role?: string | undefined;
  maxTurns?: number | undefined;
  timeoutMs?: number | undefined;
  taskId?: string | undefined;
  allowedTools?: readonly string[] | undefined;
};
export type StartSubagent = (
  prompt: string,
  options: SubagentStartOptions,
  context?: ToolInvocationContext,
) => string;
