import type { TaskManager } from "./taskManager.js";
import type { RegisteredTool } from "../types.js";
import { createUpdateTasksTool } from "./updateTasks.js";

export function createTaskTools(deps: { taskManager: TaskManager }): RegisteredTool[] {
  return [createUpdateTasksTool(deps)];
}
