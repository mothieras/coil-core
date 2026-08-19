import test from "node:test";
import assert from "node:assert/strict";
import { ToolRegistry } from "../src/core/tools/registry.js";
import type { RegisteredTool, ToolDefinition } from "../src/core/tools/types.js";

function definition(name: string): ToolDefinition {
  return {
    name,
    description: `${name} description`,
    input_schema: {
      type: "object",
      properties: {},
    },
  };
}

function registeredTool(name: string): RegisteredTool {
  return {
    name,
    definition: definition(name),
    handler: () => `${name} handled`,
    source: { type: "builtin" },
  };
}

test("ToolRegistry returns definitions and handlers for registered tools", async () => {
  const registry = new ToolRegistry();
  const tool = registeredTool("read_file");

  registry.register(tool);

  assert.deepEqual(registry.getDefinitions(), [tool.definition]);
  assert.equal(await registry.getHandler("read_file")?.({}), "read_file handled");
});

test("ToolRegistry rejects mismatched registered tool names", () => {
  const registry = new ToolRegistry();
  const tool = registeredTool("read_file");

  assert.throws(
    () =>
      registry.register({
        ...tool,
        definition: definition("write_file"),
      }),
    /RegisteredTool name 'read_file' must match definition name 'write_file'/,
  );
});

test("ToolRegistry rejects duplicate tool names", () => {
  const registry = new ToolRegistry();
  registry.register(registeredTool("read_file"));

  assert.throws(
    () => registry.register(registeredTool("read_file")),
    /Duplicate tool registration: read_file/,
  );
});

test("ToolRegistry explains unavailable provider namespaces", () => {
  const registry = new ToolRegistry();
  registry.recordDiagnostic({
    providerName: "github",
    sourceType: "mcp",
    namespacePrefix: "mcp__github__",
    status: "unavailable",
    reason: "connection failed",
  });

  assert.deepEqual(registry.explainUnavailable("mcp__github__search"), {
    providerName: "github",
    sourceType: "mcp",
    namespacePrefix: "mcp__github__",
    status: "unavailable",
    reason: "connection failed",
  });
  assert.equal(registry.explainUnavailable("read_file"), undefined);
});
