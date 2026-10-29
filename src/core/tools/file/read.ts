import { readFile } from "node:fs/promises";
import { formatError } from "../errors.js";
import { optionalInteger, requireString } from "../input.js";
import { builtinTool, type RegisteredTool } from "../types.js";
import { safePath } from "./safePath.js";

const MAX_OUTPUT_CHARS = 50_000;

async function runReadFile(
  pathArg: string,
  workspaceRoot: string,
  limit?: number,
): Promise<string> {
  try {
    const text = await readFile(await safePath(pathArg, workspaceRoot), "utf8");
    let lines = text.split(/\r?\n/);

    if (typeof limit === "number" && limit > 0 && limit < lines.length) {
      lines = lines.slice(0, limit).concat(`... (${lines.length - limit} more lines)`);
    }

    return lines.join("\n").slice(0, MAX_OUTPUT_CHARS);
  } catch (e) {
    return formatError(e);
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
    (input) => {
      const filepath = requireString(input, "path");
      if (filepath === null) return "Error: Missing required 'path' for read_file tool.";
      return runReadFile(filepath, deps.workspaceRoot, optionalInteger(input, "limit"));
    },
  );
}
