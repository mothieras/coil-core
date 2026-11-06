import { readFile } from "node:fs/promises";
import { fileToolFailure } from "../errors.js";

import { builtinTool, type RegisteredTool, type ToolExecutionResult } from "../types.js";
import { safePath } from "./safePath.js";

const MAX_OUTPUT_CHARS = 50_000;

async function runReadFile(
  pathArg: string,
  workspaceRoot: string,
  limit?: number,
): Promise<ToolExecutionResult> {
  try {
    const text = await readFile(await safePath(pathArg, workspaceRoot), "utf8");
    let lines = text.split(/\r?\n/);

    if (typeof limit === "number" && limit > 0 && limit < lines.length) {
      lines = lines.slice(0, limit).concat(`... (${lines.length - limit} more lines)`);
    }

    return { status: "completed", output: lines.join("\n").slice(0, MAX_OUTPUT_CHARS) };
  } catch (e) {
    return fileToolFailure(e);
  }
}

export function createReadFileTool(deps: { workspaceRoot: string }): RegisteredTool {
  return builtinTool(
    {
      name: "read_file",
      description: "Read file contents.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string" },
          limit: { type: "integer" },
        },
        required: ["path"],
      },
    },
    (input) =>
      runReadFile(input.path as string, deps.workspaceRoot, input.limit as number | undefined),
  );
}
