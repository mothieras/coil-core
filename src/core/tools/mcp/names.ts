export function mcpNamespacePrefix(serverName: string): string {
  return `mcp__${serverName}__`;
}

export function mcpToolName(serverName: string, originalName: string): string {
  return `${mcpNamespacePrefix(serverName)}${originalName}`;
}
