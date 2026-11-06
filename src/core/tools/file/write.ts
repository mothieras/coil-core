import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileToolFailure } from "../errors.js";

import { builtinTool, type RegisteredTool, type ToolExecutionResult } from "../types.js";
import { safePath } from "./safePath.js";

async function runWriteFile(
  pathArg: string,
  content: string,
  workspaceRoot: string,
): Promise<ToolExecutionResult> {
  try {
    const filePath = await safePath(pathArg, workspaceRoot);
    const parentDir = path.dirname(filePath);
    await mkdir(parentDir, { recursive: true });
    await writeFile(filePath, content, "utf8");
    return { status: "completed", output: `Wrote ${content.length} bytes to ${pathArg}` };
  } catch (e) {
    return fileToolFailure(e);
  }
}

export function createWriteFileTool(deps: { workspaceRoot: string }): RegisteredTool {
  return builtinTool(
    {
      name: "write_file",
      description: "Write content to file.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string" },
          content: { type: "string" },
        },
        required: ["path", "content"],
      },
    },
    (input) => runWriteFile(input.path as string, input.content as string, deps.workspaceRoot),
  );
}
