import type { BackgroundManager } from "./backgroundManager.js";
import type { RegisteredTool } from "../types.js";
import { createBackgroundRunTool } from "./run.js";

export function createBackgroundTools(deps: {
  backgroundManager: BackgroundManager;
}): RegisteredTool[] {
  return [createBackgroundRunTool(deps)];
}
