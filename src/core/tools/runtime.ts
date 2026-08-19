import type { BackgroundManager } from "./background/backgroundManager.js";
import type { TaskManager } from "./task/taskManager.js";
import type { ToolInput, ToolInvocationContext } from "./input.js";
import {
  formatToolExecutionError,
  formatUnavailableTool,
  formatUnsupportedTool,
} from "./errors.js";
import type { ToolRegistry } from "./registry.js";
import type { RegisteredTool, ToolDefinition, ToolSource } from "./types.js";

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

  interruptRunningBackgroundTasks(): void {
    this.bg.interruptRunning();
  }

  async invokeTool(name: string, input: unknown, context?: ToolInvocationContext): Promise<string> {
    const handler = this.registry.getHandler(name);
    if (!handler) {
      const diagnostic = this.registry.explainUnavailable(name);
      if (diagnostic) return formatUnavailableTool(name, diagnostic);
      return formatUnsupportedTool(name);
    }

    const normalizedInput = typeof input === "object" && input !== null ? (input as ToolInput) : {};

    try {
      return await handler(normalizedInput, context);
    } catch (error) {
      return formatToolExecutionError(error);
    }
  }
}
