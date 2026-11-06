import { readFile, writeFile } from "node:fs/promises";
import { fileToolFailure } from "../errors.js";

import { builtinTool, type RegisteredTool, type ToolExecutionResult } from "../types.js";
import { safePath } from "./safePath.js";

async function runEditFile(
  pathArg: string,
  oldText: string,
  newText: string,
  workspaceRoot: string,
): Promise<ToolExecutionResult> {
  try {
    const filePath = await safePath(pathArg, workspaceRoot);
    const content = await readFile(filePath, "utf8");
    if (!content.includes(oldText)) {
      return { status: "error", output: "Text not found in the target file." };
    }
    await writeFile(filePath, content.replace(oldText, newText), "utf8");
    return { status: "completed", output: `Edited ${pathArg}` };
  } catch (e) {
    return fileToolFailure(e);
  }
}

export function createEditFileTool(deps: { workspaceRoot: string }): RegisteredTool {
  return builtinTool(
    {
      name: "edit_file",
      description: "Replace exact text in file.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string" },
          old_text: { type: "string" },
          new_text: { type: "string" },
        },
        required: ["path", "old_text", "new_text"],
      },
    },
    (input) =>
      runEditFile(
        input.path as string,
        input.old_text as string,
        input.new_text as string,
        deps.workspaceRoot,
      ),
  );
}
