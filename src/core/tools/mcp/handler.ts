import type { ToolHandler } from "../input.js";
import type { ToolSource } from "../types.js";
import { normalizeMcpResult } from "./result.js";
import type { McpClient } from "./types.js";

export function createMcpHandler(
  client: McpClient,
  source: Extract<ToolSource, { type: "mcp" }>,
): ToolHandler {
  return async (input) => {
    const result = await client.callTool(source.originalName, input);
    return normalizeMcpResult(result);
  };
}
