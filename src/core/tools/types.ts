import type { Tool } from "@earendil-works/pi-ai";
import type { ToolHandler } from "./input.js";

export type ToolDefinition = Tool;

export type ToolSource =
  { type: "builtin" } | { type: "mcp"; serverName: string; originalName: string };

export type RegisteredTool = {
  name: string;
  definition: ToolDefinition;
  handler: ToolHandler;
  source: ToolSource;
};

export type ProviderDiagnostic = {
  providerName: string;
  sourceType: "builtin" | "mcp";
  namespacePrefix?: string;
  status: "available" | "warning" | "unavailable";
  reason: string;
  toolCount?: number | undefined;
};

export type ToolProviderLoadResult = {
  tools: RegisteredTool[];
  diagnostics: ProviderDiagnostic[];
  close?: (() => Promise<void> | void) | undefined;
};

export function builtinTool(definition: ToolDefinition, handler: ToolHandler): RegisteredTool {
  return {
    name: definition.name,
    definition,
    handler,
    source: { type: "builtin" },
  };
}
