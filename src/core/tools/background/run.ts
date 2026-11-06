import type { BackgroundManager } from "./backgroundManager.js";
import { builtinTool, type RegisteredTool } from "../types.js";

export function createBackgroundRunTool(deps: {
  backgroundManager: BackgroundManager;
}): RegisteredTool {
  return builtinTool(
    {
      name: "background_run",
      description:
        "Run a shell command in the background. Returns task_id immediately; results arrive automatically as <background-results> messages.",
      parameters: {
        type: "object",
        properties: {
          command: { type: "string", pattern: "\\S", description: "The shell command to run." },
        },
        required: ["command"],
      },
    },
    (input, context) => ({
      status: "completed",
      output: deps.backgroundManager.run(input.command as string, context),
    }),
  );
}
