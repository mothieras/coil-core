import { formatError } from "../errors.js";
import type { ToolInput } from "../input.js";
import type { TaskItemInput, TaskManager } from "./taskManager.js";
import { builtinTool, type RegisteredTool } from "../types.js";

export function createUpdateTasksTool(deps: { taskManager: TaskManager }): RegisteredTool {
  return builtinTool(
    {
      name: "update_tasks",
      description:
        "Create and update the session task list in one call. Items without id are created; items with id are updated. Returns the resulting list. Tasks persist as JSON files and survive context compression.",
      parameters: {
        type: "object",
        properties: {
          tasks: {
            type: "array",
            description: "The tasks to create or update.",
            items: {
              type: "object",
              properties: {
                id: {
                  type: "integer",
                  description: "Existing task id to update. Omit to create.",
                },
                subject: {
                  type: "string",
                  description: "Brief actionable title (required when creating).",
                },
                status: {
                  type: "string",
                  enum: ["pending", "in_progress", "completed"],
                },
                description: { type: "string" },
              },
            },
          },
        },
        required: ["tasks"],
      },
    },
    (input) => runUpdateTasks(input, deps.taskManager),
  );
}

function runUpdateTasks(input: ToolInput, taskManager: TaskManager): string {
  const tasks = (input as { tasks?: unknown }).tasks;
  if (!Array.isArray(tasks) || tasks.length === 0) {
    return "Error: 'tasks' must be a non-empty array for update_tasks.";
  }
  try {
    return taskManager.applyMany(tasks as TaskItemInput[]);
  } catch (error) {
    return formatError(error);
  }
}
