import { ExecutionStoppedError, throwIfAborted } from "../loop/cancellation.js";
import type { BackgroundManager } from "./background/backgroundManager.js";
import type { TaskManager } from "./task/taskManager.js";
import type { ToolInput, ToolInvocationContext } from "./input.js";
import { ToolExecutionError, ToolInvocationError, redactToolDiagnostic } from "./errors.js";
import type { ToolRegistry } from "./registry.js";
import type { RegisteredTool, ToolDefinition, ToolSource, ToolExecutionResult } from "./types.js";

export type { ToolHandler, ToolInput, ToolInvocationContext } from "./input.js";
export type { RegisteredTool, ToolDefinition } from "./types.js";

type ToolRuntimeDeps = {
  taskManager: TaskManager;
  backgroundManager: BackgroundManager;
  registry: ToolRegistry;
};

export class ToolRuntime {
  private readonly taskManager: TaskManager;
  private readonly bg: BackgroundManager;
  private readonly registry: ToolRegistry;

  constructor(deps: ToolRuntimeDeps) {
    this.taskManager = deps.taskManager;
    this.bg = deps.backgroundManager;
    this.registry = deps.registry;
  }

  registerTool(tool: RegisteredTool): void {
    this.registry.register(tool);
  }

  getToolDefinitions(allowedTools?: readonly string[]): ToolDefinition[] {
    return this.registry.getDefinitions(allowedTools);
  }

  getToolSource(name: string): ToolSource | undefined {
    return this.registry.getSource(name);
  }

  clearTasksIfAllDone(): boolean {
    return this.taskManager.clearIfAllCompleted();
  }

  hasActiveTasks(): boolean {
    return this.taskManager.hasActive();
  }

  taskSummary(): string | null {
    // For LLM injection — the injected list is the model's only task view.
    return this.taskManager.listAll();
  }

  taskStatusForUser(): string | null {
    // Compact list with [ ] markers for terminal display
    const list = this.taskManager.listAll();
    if (list === "No tasks.") return null;
    return list;
  }

  cancelBackgroundTasks(deadlineAt?: number) {
    return this.bg.cancelAll(deadlineAt);
  }

  async invokeTool(
    name: string,
    input: unknown,
    context?: ToolInvocationContext,
  ): Promise<ToolExecutionResult> {
    throwIfAborted(context?.signal);
    const handler = this.registry.getHandler(name);
    if (!handler) {
      const diagnostic = this.registry.explainUnavailable(name);
      return {
        status: "unavailable",
        output: diagnostic
          ? `Tool '${name}' is unavailable from provider '${diagnostic.providerName}'.`
          : `Unsupported tool '${name}'.`,
      };
    }

    try {
      const diagnostic =
        context?.argumentsError !== undefined
          ? "Tool arguments could not be parsed. Supply a valid JSON object."
          : this.registry.validateInput(name, input);
      if (diagnostic) return { status: "invalid_input", output: diagnostic };
      // Own the validated arguments across the asynchronous permission gate.
      const validated = structuredClone(input) as ToolInput;
      let result = await context?.beforeInvoke?.(structuredClone(validated));
      throwIfAborted(context?.signal);
      if (!result) {
        context?.onDispatch?.();
        result = await handler(validated, context);
        throwIfAborted(context?.signal);
      }
      if (
        result.status === "cancelled" ||
        result.status === "timeout" ||
        result.status === "unconfirmed"
      )
        throw new ExecutionStoppedError(
          result.stopReason ?? (result.status === "timeout" ? "timeout" : "aborted"),
          `tool:${context?.toolCallId ?? name}`,
          result.status === "unconfirmed" ? "unconfirmed" : "confirmed",
        );
      return result.status === "completed"
        ? result
        : { ...result, output: redactToolDiagnostic(result.output) };
    } catch (error) {
      if (error instanceof ExecutionStoppedError) throw error;
      throwIfAborted(context?.signal);
      if (error instanceof ToolExecutionError)
        return { status: error.status, output: error.message };
      if (error instanceof ToolInvocationError) throw error;
      throw new ToolInvocationError(name, context, error);
    }
  }
}
