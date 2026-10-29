import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { formatError } from "../errors.js";
import { requireString } from "../input.js";
import { builtinTool, type RegisteredTool } from "../types.js";
import { safePath } from "./safePath.js";

async function runWriteFile(
  pathArg: string,
  content: string,
  workspaceRoot: string,
): Promise<string> {
  try {
    const filePath = await safePath(pathArg, workspaceRoot);
    const parentDir = path.dirname(filePath);
    await mkdir(parentDir, { recursive: true });
    await writeFile(filePath, content, "utf8");
    return `Wrote ${content.length} bytes to ${pathArg}`;
  } catch (e) {
    return formatError(e);
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
    (input) => {
      const filepath = requireString(input, "path");
      if (filepath === null) return "Error: Missing required 'path' for write_file tool.";
      const content = requireString(input, "content");
      if (content === null) return "Error: Missing required 'content' for write_file tool.";
      return runWriteFile(filepath, content, deps.workspaceRoot);
    },
  );
}
