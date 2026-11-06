import type { McpToolResult, McpToolResultContent } from "./types.js";

import type { ToolExecutionResult } from "../types.js";

export function normalizeMcpResult(result: McpToolResult): ToolExecutionResult {
  const content = result.content.map(formatContent).join("\n");
  return { status: result.isError ? "error" : "completed", output: content };
}

function formatContent(content: McpToolResultContent): string {
  switch (content.type) {
    case "text":
      return content.text;
    case "json":
      return JSON.stringify(content.json, null, 2);
    case "resource":
      return content.text
        ? `[resource: ${content.uri}]\n${content.text}`
        : `[resource: ${content.uri}]`;
    case "image":
      return `[image${content.mimeType ? `: ${content.mimeType}` : ""}]`;
  }
}
