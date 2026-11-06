import { startManagedProcess } from "./process.js";
import { requireNonEmptyString } from "../input.js";
import { isDangerousCommand } from "./shellSafety.js";
import { builtinTool, type RegisteredTool } from "../types.js";

async function runBash(
  command: string,
  workspaceRoot: string,
  signal?: AbortSignal,
): Promise<string> {
  if (isDangerousCommand(command)) {
    return "Error: Dangerous command blocked";
  }

  const result = await startManagedProcess(command, workspaceRoot, { signal, timeoutMs: 120_000 })
    .done;
  return result.code === 0
    ? result.output
    : `Error: Command exited ${result.code ?? result.signal}\n${result.output}`;
}

export function createBashTool(deps: { workspaceRoot: string }): RegisteredTool {
  return builtinTool(
    {
      name: "bash",
      description: "Run a shell command.",
      parameters: {
        type: "object",
        properties: {
          command: { type: "string" },
        },
        required: ["command"],
      },
    },
    (input, context) => {
      const command = requireNonEmptyString(input, "command", "bash tool");
      if ("error" in command) return command.error;
      return runBash(command.value, deps.workspaceRoot, context?.signal);
    },
  );
}
