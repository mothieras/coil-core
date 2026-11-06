import { ToolRuntime } from "../../src/core/tools/runtime.js";
import { ToolRegistry } from "../../src/core/tools/registry.js";
import type { ToolExecutionResult } from "../../src/core/tools/types.js";
import type { ToolInput, ToolInvocationContext } from "../../src/core/tools/input.js";

/** Script only the handler; retain real runtime gating, cancellation and error propagation. */
export function testToolInvoker(
  handler: (
    name: string,
    input: ToolInput,
    context?: ToolInvocationContext,
  ) => Promise<ToolExecutionResult>,
): ToolRuntime["invokeTool"] {
  return async (name, input, context) => {
    const registry = new ToolRegistry();
    registry.register({
      name,
      definition: { name, description: "fixture", parameters: { type: "object", properties: {} } },
      source: { type: "builtin" },
      handler: (value, ctx) => handler(name, value, ctx),
    });
    const runtime = new ToolRuntime({
      registry,
      taskManager: {} as never,
      backgroundManager: {} as never,
    });
    return runtime.invokeTool(name, input, context);
  };
}
