import type { ProviderDiagnostic, RegisteredTool, ToolDefinition, ToolSource } from "./types.js";
import type { ToolHandler } from "./input.js";
import { Compile } from "typebox/compile";
import { selectAllowedToolDefinitions } from "./profiles.js";

export class ToolRegistry {
  private readonly tools = new Map<string, RegisteredTool>();
  private readonly providerDiagnostics: ProviderDiagnostic[] = [];
  private readonly validators = new Map<string, ReturnType<typeof Compile>>();

  register(tool: RegisteredTool): void {
    if (tool.name !== tool.definition.name) {
      throw new Error(
        `RegisteredTool name '${tool.name}' must match definition name '${tool.definition.name}'.`,
      );
    }
    if (this.tools.has(tool.name)) {
      throw new Error(`Duplicate tool registration: ${tool.name}`);
    }
    const validator = Compile(tool.definition.parameters);
    this.tools.set(tool.name, tool);
    this.validators.set(tool.name, validator);
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

  /** Schema diagnostics never include input values or schema literals. */
  validateInput(name: string, input: unknown): string | undefined {
    const validator = this.validators.get(name);
    if (!validator) throw new Error("Missing registered tool validator.");
    if (typeof input !== "object" || input === null || Array.isArray(input))
      return "root: expected an object.";
    if (validator.Check(input)) return undefined;
    return validator
      .Errors(input)
      .map((error) => {
        const params = error.params as { requiredProperties?: string[]; type?: string };
        const rule =
          error.keyword === "required"
            ? `required properties: ${params.requiredProperties?.join(", ")}`
            : error.keyword === "type"
              ? `expected ${params.type}`
              : `must satisfy ${error.keyword}`;
        return `${error.instancePath || "root"}: ${rule}.`;
      })
      .join("\n");
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
