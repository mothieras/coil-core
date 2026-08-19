import path from "node:path";
import { HookBus } from "../hooks/hookBus.js";
import { MemoryManager } from "../services/memory/memoryManager.js";
import type { CheckPermissionFn } from "../permission/types.js";
import { SkillLoader } from "../services/skill/skillLoader.js";
import { BackgroundManager } from "../tools/background/backgroundManager.js";
import { loadBuiltinTools } from "../tools/builtins.js";
import { TaskManager, type TaskRecord } from "../tools/task/taskManager.js";
import { ToolRegistry } from "../tools/registry.js";
import { ToolRuntime } from "../tools/runtime.js";
import { validateToolProfiles } from "../tools/profiles.js";
import type { ToolProviderLoadResult } from "../tools/types.js";
import type { AgentRuntime } from "../agent/runtime.js";
import { SubAgentRunner } from "../tools/subagent/subagentRunner.js";
import { memoryStatePath, taskStatePath } from "../state/paths.js";
import { AsyncWorkInbox } from "../async/asyncWorkInbox.js";

export interface AppContext {
  workspaceRoot: string;
  hooks: HookBus;
  skillLoader: SkillLoader;
  memoryManager: MemoryManager;
  toolRegistry: ToolRegistry;
  toolRuntime: ToolRuntime;
  subAgentRunner: SubAgentRunner;
  inbox: AsyncWorkInbox;
  closeToolProviders(): Promise<void>;
}

export type CreateAppContextOptions = {
  checkPermission?: CheckPermissionFn;
  toolProviderResults?: ToolProviderLoadResult[];
  taskStateDir?: string | undefined;
  onTaskChanged?: ((task: TaskRecord) => void) | undefined;
  agentRuntime?: AgentRuntime | undefined;
};

export function createAppContext(
  workspaceRoot: string,
  options: CreateAppContextOptions = {},
): AppContext {
  const skillLoader = new SkillLoader(path.join(workspaceRoot, "skills"));
  const hooks = new HookBus();
  const memoryManager = new MemoryManager(memoryStatePath(workspaceRoot));
  const taskManager = new TaskManager(
    options.taskStateDir ?? taskStatePath(workspaceRoot),
    options.onTaskChanged ? { onTaskChanged: options.onTaskChanged } : {},
  );
  const inbox = new AsyncWorkInbox();
  const backgroundManager = new BackgroundManager(workspaceRoot, inbox);
  const toolRegistry = new ToolRegistry();
  const toolRuntime = new ToolRuntime({
    taskManager,
    backgroundManager,
    registry: toolRegistry,
  });
  const subAgentRunner = new SubAgentRunner(undefined, options.agentRuntime, inbox);
  const builtinTools = loadBuiltinTools({
    workspaceRoot,
    taskManager,
    backgroundManager,
    subAgentRunner,
    ...(options.checkPermission ? { checkPermission: options.checkPermission } : {}),
  });
  const providerResults = options.toolProviderResults ?? [];
  const closedToolProviderIndexes = new Set<number>();
  toolRegistry.registerMany(builtinTools.tools);
  toolRegistry.recordDiagnostics(builtinTools.diagnostics);
  for (const providerResult of providerResults) {
    toolRegistry.registerMany(providerResult.tools);
    toolRegistry.recordDiagnostics(providerResult.diagnostics);
  }
  validateToolProfiles(toolRegistry);
  return {
    workspaceRoot,
    hooks,
    skillLoader,
    memoryManager,
    toolRegistry,
    toolRuntime,
    subAgentRunner,
    inbox,
    async closeToolProviders() {
      let firstError: unknown;
      for (const [index, providerResult] of providerResults.entries()) {
        if (closedToolProviderIndexes.has(index)) continue;
        if (providerResult.close === undefined) {
          closedToolProviderIndexes.add(index);
          continue;
        }
        try {
          await providerResult.close();
          closedToolProviderIndexes.add(index);
        } catch (error) {
          firstError ??= error;
        }
      }
      if (firstError !== undefined) throw firstError;
    },
  };
}
