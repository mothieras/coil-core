import type { SubagentStartOptions, StartSubagent } from "./types.js";
import { builtinTool, type RegisteredTool } from "../types.js";

export function createSubagentTool(deps: { startSubagent: StartSubagent }): RegisteredTool {
  return builtinTool(
    {
      name: "subagent",
      description:
        "Spawn an async subagent and return a sub_id immediately. Results arrive automatically as <subagent-results> messages — keep working, or end your turn and the host will re-wake you when results land. Defaults to 90 turns and 30 minutes.",
      parameters: {
        type: "object",
        properties: {
          prompt: {
            type: "string",
            pattern: "\\S",
            description: "The task for the subagent to complete.",
          },
          name: { type: "string", description: "Optional display identity for the subagent." },
          role: { type: "string", description: "Optional role description for the subagent." },
          max_turns: {
            type: "integer",
            minimum: 1,
            description: "Optional maximum agent-loop turns for this subagent. Defaults to 90.",
          },
          timeout_ms: {
            type: "integer",
            minimum: 1,
            description: "Optional maximum runtime in milliseconds. Defaults to 1800000.",
          },
          task_id: {
            type: "string",
            description:
              "Optional task id this subagent works on; echoed back when the result returns so you can correlate it.",
          },
          allowed_tools: {
            type: "array",
            items: { type: "string" },
            description:
              "Optional subset of the subagent tool profile (bash, read_file, write_file, edit_file) to grant this child. Omit for the full profile; tools outside it are ignored.",
          },
        },
        required: ["prompt"],
      },
    },
    (input, context) => {
      const options: SubagentStartOptions = {
        name: input.name as string | undefined,
        role: input.role as string | undefined,
        taskId: input.task_id as string | undefined,
        maxTurns: input.max_turns as number | undefined,
        timeoutMs: input.timeout_ms as number | undefined,
        allowedTools: input.allowed_tools as string[] | undefined,
      };
      return {
        status: "completed",
        output: deps.startSubagent(input.prompt as string, options, context),
      };
    },
  );
}
