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
            minItems: 1,
            description: "The tasks to create or update.",
            items: {
              type: "object",
              anyOf: [{ required: ["id"] }, { required: ["subject"] }],
              properties: {
                id: {
                  type: "integer",
                  minimum: 1,
                  description: "Existing task id to update. Omit to create.",
                },
                subject: {
                  type: "string",
                  pattern: "\\S",
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
    (input) => ({
      status: "completed",
      output: deps.taskManager.applyMany(input.tasks as TaskItemInput[]),
    }),
  );
}
