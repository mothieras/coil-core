import type { ToolDefinition } from "../types.js";

export type McpToolSchema = {
  name: string;
  description?: string;
  inputSchema?: ToolDefinition["parameters"];
};

export type McpTextContent = {
  type: "text";
  text: string;
};

export type McpJsonContent = {
  type: "json";
  json: unknown;
};

export type McpResourceContent = {
  type: "resource";
  uri: string;
  text?: string;
};

export type McpImageContent = {
  type: "image";
  mimeType?: string;
};

export type McpToolResultContent =
  McpTextContent | McpJsonContent | McpResourceContent | McpImageContent;

export type McpToolResult = {
  isError?: boolean;
  content: McpToolResultContent[];
};

export interface McpClient {
  listTools(): Promise<McpToolSchema[]>;
  callTool(name: string, input: unknown): Promise<McpToolResult>;
}
