import type { SubAgentRunner } from "./subagentRunner.js";
import type { CheckPermissionFn } from "../../permission/types.js";
import type { RegisteredTool } from "../types.js";
import { createSubagentTool } from "./subagentTool.js";

export function createSubagentTools(deps: {
  subAgentRunner: SubAgentRunner;
  checkPermission?: CheckPermissionFn;
}): RegisteredTool[] {
  return [createSubagentTool(deps)];
}
