import { optionalArrayOfStrings, optionalInteger, requireNonEmptyString } from "../input.js";
import type { SubAgentRunOptions, SubAgentRunner } from "./subagentRunner.js";
import type { CheckPermissionFn } from "../../permission/types.js";
import { builtinTool, type RegisteredTool } from "../types.js";
import { currentAgent } from "../../agent/agent.js";

export function createSubagentTool(deps: {
  subAgentRunner: SubAgentRunner;
  checkPermission?: CheckPermissionFn;
}): RegisteredTool {
  return builtinTool(
    {
      name: "subagent",
      description:
        "Spawn an async subagent and return a sub_id immediately. Results arrive automatically as <subagent-results> messages — keep working, or end your turn and the host will re-wake you when results land. Defaults to 90 turns and 30 minutes.",
      parameters: {
        type: "object",
        properties: {
          prompt: { type: "string", description: "The task for the subagent to complete." },
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
      const prompt = requireNonEmptyString(input, "prompt", "subagent tool");
      if ("error" in prompt) return prompt.error;

      const parent = currentAgent.getStore();
      if (!parent) {
        return "Error: subagent can only be spawned from within an agent loop.";
      }

      const options: SubAgentRunOptions = {};
      if (context?.sessionId !== undefined) options.sessionId = context.sessionId;
      if (context?.runId !== undefined) options.parentRunId = context.runId;
      if (context?.toolCallId !== undefined) options.parentToolCallId = context.toolCallId;
      const name = requireNonEmptyString(input, "name", "subagent tool");
      if (!("error" in name)) options.name = name.value;
      const role = requireNonEmptyString(input, "role", "subagent tool");
      if (!("error" in role)) options.role = role.value;
      const taskId = requireNonEmptyString(input, "task_id", "subagent tool");
      if (!("error" in taskId)) options.taskId = taskId.value;
      const maxTurns = optionalInteger(input, "max_turns");
      if (maxTurns !== undefined) options.maxTurns = maxTurns;
      const timeoutMs = optionalInteger(input, "timeout_ms");
      if (timeoutMs !== undefined) options.timeoutMs = timeoutMs;
      const allowedTools = optionalArrayOfStrings(input, "allowed_tools");
      if (allowedTools !== undefined) options.allowedTools = allowedTools;
      if (deps.checkPermission) options.checkPermission = deps.checkPermission;

      return deps.subAgentRunner.run(parent, prompt.value, options);
    },
  );
}
