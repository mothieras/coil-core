#!/usr/bin/env tsx
/**
 * Register a custom tool with the core tool registry. No API key needed —
 * this only demonstrates the registration + definition surface.
 *
 *   tsx examples/custom-tool.ts
 */
import { builtinTool, ToolRegistry, type ToolDefinition } from "../src/core/index.js";

const echoDefinition: ToolDefinition = {
  name: "echo",
  description: "Echoes back the provided text.",
  parameters: {
    type: "object",
    properties: {
      text: { type: "string", description: "Text to echo back." },
    },
    required: ["text"],
  },
};

const echoTool = builtinTool(echoDefinition, (input) => `echo: ${String(input.text)}`);

const registry = new ToolRegistry();
registry.register(echoTool);

console.log("Registered tool definitions:");
console.log(JSON.stringify(registry.getDefinitions(), null, 2));
