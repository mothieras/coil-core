import type { ProviderDiagnostic, RegisteredTool, ToolDefinition, ToolSource } from "./types.js";
import type { ToolHandler } from "./input.js";
import { selectAllowedToolDefinitions } from "./profiles.js";

export class ToolRegistry {
  private readonly tools = new Map<string, RegisteredTool>();
  private readonly providerDiagnostics: ProviderDiagnostic[] = [];

  register(tool: RegisteredTool): void {
    if (tool.name !== tool.definition.name) {
      throw new Error(
        `RegisteredTool name '${tool.name}' must match definition name '${tool.definition.name}'.`,
      );
    }
    if (this.tools.has(tool.name)) {
      throw new Error(`Duplicate tool registration: ${tool.name}`);
    }
    this.tools.set(tool.name, tool);
  }

  registerMany(tools: RegisteredTool[]): void {
    for (const tool of tools) {
      this.register(tool);
    }
  }

  recordDiagnostic(diagnostic: ProviderDiagnostic): void {
    this.providerDiagnostics.push(diagnostic);
  }

  recordDiagnostics(diagnostics: ProviderDiagnostic[]): void {
    for (const diagnostic of diagnostics) {
      this.recordDiagnostic(diagnostic);
    }
  }

  hasTool(name: string): boolean {
    return this.tools.has(name);
  }

  getDefinitions(allowedTools?: readonly string[]): ToolDefinition[] {
    const definitions = Array.from(this.tools.values(), (tool) => tool.definition);
    return selectAllowedToolDefinitions(definitions, allowedTools);
  }

  getHandler(name: string): ToolHandler | undefined {
    return this.tools.get(name)?.handler;
  }

  getSource(name: string): ToolSource | undefined {
    return this.tools.get(name)?.source;
  }

  diagnostics(): readonly ProviderDiagnostic[] {
    return this.providerDiagnostics;
  }

  explainUnavailable(name: string): ProviderDiagnostic | undefined {
    return this.providerDiagnostics.find(
      (diagnostic) =>
        diagnostic.status === "unavailable" &&
        diagnostic.namespacePrefix !== undefined &&
        name.startsWith(diagnostic.namespacePrefix),
    );
  }
}
