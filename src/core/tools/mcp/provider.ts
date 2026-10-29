import type { RegisteredTool, ToolDefinition, ToolProviderLoadResult } from "../types.js";
import { createMcpHandler } from "./handler.js";
import { mcpNamespacePrefix, mcpToolName } from "./names.js";
import type { McpClient, McpToolSchema } from "./types.js";

export type LoadMcpToolsOptions = {
  serverName: string;
  client: McpClient;
};

export async function loadMcpTools(options: LoadMcpToolsOptions): Promise<ToolProviderLoadResult> {
  try {
    const schemas = await options.client.listTools();
    return {
      tools: schemas.map((schema) => createMcpRegisteredTool(options, schema)),
      diagnostics: [
        {
          providerName: options.serverName,
          sourceType: "mcp",
          namespacePrefix: mcpNamespacePrefix(options.serverName),
          status: "available",
          reason: `${schemas.length} tool(s) loaded.`,
          toolCount: schemas.length,
        },
      ],
    };
  } catch (error) {
    return {
      tools: [],
      diagnostics: [
        {
          providerName: options.serverName,
          sourceType: "mcp",
          namespacePrefix: mcpNamespacePrefix(options.serverName),
          status: "unavailable",
          reason: formatMcpError(error),
        },
      ],
    };
  }
}

function createMcpRegisteredTool(
  options: LoadMcpToolsOptions,
  schema: McpToolSchema,
): RegisteredTool {
  const source = {
    type: "mcp" as const,
    serverName: options.serverName,
    originalName: schema.name,
  };
  const definition: ToolDefinition = {
    name: mcpToolName(options.serverName, schema.name),
    description: schema.description ?? `MCP tool '${schema.name}' from ${options.serverName}.`,
    parameters: schema.inputSchema ?? {
      type: "object",
      properties: {},
    },
  };
  return {
    name: definition.name,
    definition,
    source,
    handler: createMcpHandler(options.client, source),
  };
}

function formatMcpError(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === "object" && error !== null) {
    const maybeMessage = (error as { message?: unknown }).message;
    if (typeof maybeMessage === "string") return maybeMessage;
  }
  return String(error);
}
