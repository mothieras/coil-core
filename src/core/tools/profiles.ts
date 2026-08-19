import type { ToolRegistry } from "./registry.js";
import type { ToolDefinition } from "./types.js";

export type ToolProfileName = "subagent";
export type ToolProfiles = Record<string, readonly string[]>;

export const TOOL_PROFILES = {
  subagent: ["bash", "read_file", "write_file", "edit_file"],
} as const satisfies Record<ToolProfileName, readonly string[]>;

export const SUB_AGENT_ALLOWED_TOOLS = TOOL_PROFILES.subagent;

export function selectAllowedToolDefinitions(
  definitions: readonly ToolDefinition[],
  allowedTools?: readonly string[],
): ToolDefinition[] {
  if (!allowedTools) return [...definitions];

  const definitionsByName = new Map(definitions.map((definition) => [definition.name, definition]));
  const missing = allowedTools.filter((name) => !definitionsByName.has(name));
  if (missing.length > 0) {
    throw new Error(`Unknown allowed tool(s): ${missing.join(", ")}`);
  }

  return allowedTools.map((name) => definitionsByName.get(name)!);
}

export function validateToolProfiles(
  registry: ToolRegistry,
  profiles: ToolProfiles = TOOL_PROFILES,
): void {
  for (const [profileName, allowedTools] of Object.entries(profiles)) {
    const missing = allowedTools.filter((name) => !registry.hasTool(name));
    if (missing.length > 0) {
      throw new Error(
        `Tool profile '${profileName}' references unknown tool(s): ${missing.join(", ")}`,
      );
    }
  }
}
