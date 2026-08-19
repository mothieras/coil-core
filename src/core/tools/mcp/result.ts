import type { McpToolResult, McpToolResultContent } from "./types.js";

export function normalizeMcpResult(result: McpToolResult): string {
  const content = result.content.map(formatContent).join("\n");
  return result.isError ? `Error: MCP tool returned error.\n${content}` : content;
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
