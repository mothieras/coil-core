import type { RegisteredTool } from "../types.js";
import { createBashTool } from "./bash.js";
import { createEditFileTool } from "./edit.js";
import { createReadFileTool } from "./read.js";
import { createWriteFileTool } from "./write.js";

export function createFileTools(deps: { workspaceRoot: string }): RegisteredTool[] {
  return [
    createBashTool(deps),
    createReadFileTool(deps),
    createWriteFileTool(deps),
    createEditFileTool(deps),
  ];
}
