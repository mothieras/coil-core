import type { ToolProviderLoadResult } from "../types.js";
import { loadMcpConfig } from "./config.js";
import { loadMcpTools } from "./provider.js";
import { StdioMcpClient } from "./stdioClient.js";

export async function loadConfiguredMcpTools(
  workspaceRoot: string,
): Promise<ToolProviderLoadResult[]> {
  const servers = await loadMcpConfig(workspaceRoot);
  const results: ToolProviderLoadResult[] = [];
  for (const server of servers) {
    const client = new StdioMcpClient(server);
    const result = await loadMcpTools({
      serverName: server.name,
      client,
    });
    results.push({
      ...result,
      close: () => client.close(),
    });
  }
  return results;
}
