import type { StartSubagent } from "./types.js";
export type { StartSubagent, SubagentStartOptions } from "./types.js";
import type { RegisteredTool } from "../types.js";
import { createSubagentTool } from "./subagentTool.js";

export function createSubagentTools(deps: { startSubagent: StartSubagent }): RegisteredTool[] {
  return [createSubagentTool(deps)];
}
