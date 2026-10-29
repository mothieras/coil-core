import { readFile, writeFile } from "node:fs/promises";
import { formatError } from "../errors.js";
import { requireString } from "../input.js";
import { builtinTool, type RegisteredTool } from "../types.js";
import { safePath } from "./safePath.js";

async function runEditFile(
  pathArg: string,
  oldText: string,
  newText: string,
  workspaceRoot: string,
): Promise<string> {
  try {
    const filePath = await safePath(pathArg, workspaceRoot);
    const content = await readFile(filePath, "utf8");
    if (!content.includes(oldText)) {
      return `Error: Text not found in ${pathArg}`;
    }
    await writeFile(filePath, content.replace(oldText, newText), "utf8");
    return `Edited ${pathArg}`;
  } catch (e) {
    return formatError(e);
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
    (input) => {
      const filepath = requireString(input, "path");
      if (filepath === null) return "Error: Missing required 'path' for edit_file tool.";
      const oldText = requireString(input, "old_text");
      if (oldText === null) return "Error: Missing required 'old_text' for edit_file tool.";
      const newText = requireString(input, "new_text");
      if (newText === null) return "Error: Missing required 'new_text' for edit_file tool.";
      return runEditFile(filepath, oldText, newText, deps.workspaceRoot);
    },
  );
}
