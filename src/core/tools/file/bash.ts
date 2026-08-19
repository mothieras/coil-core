import { exec } from "node:child_process";
import { requireNonEmptyString } from "../input.js";
import { isDangerousCommand } from "./shellSafety.js";
import { builtinTool, type RegisteredTool } from "../types.js";

type ExecErrorWithOutput = Error & {
  code?: number | string;
  stdout?: string;
  stderr?: string;
};

function execAsync(
  command: string,
  cwd: string,
  timeoutMs: number,
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    exec(
      command,
      { cwd, timeout: timeoutMs, maxBuffer: 10 * 1024 * 1024 },
      (error, stdout, stderr) => {
        if (error) {
          const err = error as unknown as ExecErrorWithOutput;
          err.stdout = stdout;
          err.stderr = stderr;
          reject(err);
          return;
        }
        resolve({ stdout, stderr });
      },
    );
  });
}

async function runBash(command: string, workspaceRoot: string): Promise<string> {
  if (isDangerousCommand(command)) {
    return "Error: Dangerous command blocked";
  }

  try {
    const r = await execAsync(command, workspaceRoot, 120_000);
    const out = (r.stdout + r.stderr).trim();
    return out ? out.slice(-50000) : "(no output)";
  } catch (e) {
    const err = e as ExecErrorWithOutput;
    const out = `${err.stdout ?? ""}${err.stderr ?? ""}`.trim();
    if (out) return out.slice(-50000);
    if (err.code === "ETIMEDOUT") return "Error: Timeout (120s)";
    return `Error: ${err.message}`;
  }
}

export function createBashTool(deps: { workspaceRoot: string }): RegisteredTool {
  return builtinTool(
    {
      name: "bash",
      description: "Run a shell command.",
      input_schema: {
        type: "object",
        properties: {
          command: { type: "string" },
        },
        required: ["command"],
      },
    },
    (input) => {
      const command = requireNonEmptyString(input, "command", "bash tool");
      if ("error" in command) return command.error;
      return runBash(command.value, deps.workspaceRoot);
    },
  );
}
