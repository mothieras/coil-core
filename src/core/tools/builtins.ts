import type { BackgroundManager } from "./background/backgroundManager.js";
import { createBackgroundTools } from "./background/index.js";
import { createFileTools } from "./file/index.js";
import { createSubagentTools } from "./subagent/index.js";
import type { StartSubagent } from "./subagent/types.js";
import { createTaskTools } from "./task/index.js";
import type { TaskManager } from "./task/taskManager.js";
import type { ToolProviderLoadResult } from "./types.js";

export type BuiltinServices = {
  workspaceRoot: string;
  taskManager: TaskManager;
  backgroundManager: BackgroundManager;
  startSubagent: StartSubagent;
};

export function loadBuiltinTools(services: BuiltinServices): ToolProviderLoadResult {
  return {
    tools: [
      ...createFileTools({ workspaceRoot: services.workspaceRoot }),
      ...createTaskTools({ taskManager: services.taskManager }),
      ...createBackgroundTools({ backgroundManager: services.backgroundManager }),
      ...createSubagentTools({
        startSubagent: services.startSubagent,
      }),
    ],
    diagnostics: [],
  };
}
