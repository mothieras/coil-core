import type { CheckPermissionFn } from "../permission/types.js";
import type { BackgroundManager } from "./background/backgroundManager.js";
import { createBackgroundTools } from "./background/index.js";
import { createFileTools } from "./file/index.js";
import { createSubagentTools } from "./subagent/index.js";
import type { SubAgentRunner } from "./subagent/subagentRunner.js";
import { createTaskTools } from "./task/index.js";
import type { TaskManager } from "./task/taskManager.js";
import type { ToolProviderLoadResult } from "./types.js";

export type BuiltinServices = {
  workspaceRoot: string;
  taskManager: TaskManager;
  backgroundManager: BackgroundManager;
  subAgentRunner: SubAgentRunner;
  checkPermission?: CheckPermissionFn;
};

export function loadBuiltinTools(services: BuiltinServices): ToolProviderLoadResult {
  return {
    tools: [
      ...createFileTools({ workspaceRoot: services.workspaceRoot }),
      ...createTaskTools({ taskManager: services.taskManager }),
      ...createBackgroundTools({ backgroundManager: services.backgroundManager }),
      ...createSubagentTools({
        subAgentRunner: services.subAgentRunner,
        ...(services.checkPermission ? { checkPermission: services.checkPermission } : {}),
      }),
    ],
    diagnostics: [],
  };
}
