import fs from "node:fs/promises";
import { mcpConfigPath } from "../../state/paths.js";

export type McpServerConfig = {
  name: string;
  command: string;
  args: string[];
  env?: Record<string, string> | undefined;
};

type RawMcpConfig = {
  servers?: Record<string, { command?: unknown; args?: unknown; env?: unknown }> | undefined;
};

export async function loadMcpConfig(workspaceRoot: string): Promise<McpServerConfig[]> {
  const configPath = mcpConfigPath(workspaceRoot);
  let raw: string;
  try {
    raw = await fs.readFile(configPath, "utf8");
  } catch (error) {
    if ((error as { code?: unknown }).code === "ENOENT") return [];
    throw error;
  }

  const parsed = JSON.parse(raw) as RawMcpConfig;
  return Object.entries(parsed.servers ?? {}).map(([name, server]) => {
    if (typeof server.command !== "string" || server.command.trim() === "") {
      throw new Error(`MCP server '${name}' must define a command.`);
    }
    const args = Array.isArray(server.args) ? server.args.map((value) => String(value)) : [];
    const env = parseEnv(server.env);
    return env === undefined
      ? { name, command: server.command, args }
      : { name, command: server.command, args, env };
  });
}

function parseEnv(value: unknown): Record<string, string> | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("MCP server env must be an object.");
  }
  const env: Record<string, string> = {};
  for (const [key, item] of Object.entries(value)) env[key] = String(item);
  return env;
}
