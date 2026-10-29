import type { Message } from "@earendil-works/pi-ai";
import { Agent } from "../agent/agent.js";
import type { AppContext } from "../app/context.js";
import { buildSystemPrompt, type PromptContext } from "../context/assembler.js";
import type { CheckPermissionFn } from "../permission/types.js";
import type { Provider } from "../providers/index.js";

export function createLeadAgent(options: {
  workspaceRoot: string;
  app: AppContext;
  leadAgent?: Agent | undefined;
  checkPermission?: CheckPermissionFn | undefined;
  provider?: Provider | undefined;
  messages?: Message[] | undefined;
}): Agent {
  if (options.leadAgent) {
    return bindLeadAgentToApp(
      options.leadAgent,
      options.app,
      options.messages,
      options.checkPermission,
      options.provider,
    );
  }
  return new Agent({
    id: "lead",
    system: buildSystemPrompt(buildPromptContext(options.app)),
    workspaceRoot: options.workspaceRoot,
    toolRuntime: options.app.toolRuntime,
    hooks: options.app.hooks,
    checkPermission: options.checkPermission,
    provider: options.provider,
    messages: options.messages,
  });
}

export function bindLeadAgentToApp(
  agent: Agent,
  app: AppContext,
  messages?: Message[] | undefined,
  checkPermission?: CheckPermissionFn | undefined,
  provider?: Provider | undefined,
): Agent {
  return new Agent({
    id: agent.id,
    name: agent.name,
    role: agent.role,
    maxTurns: agent.maxTurns,
    timeoutMs: agent.timeoutMs,
    system: agent.system,
    workspaceRoot: agent.workspaceRoot,
    allowedTools: agent.allowedTools,
    toolRuntime: app.toolRuntime,
    hooks: app.hooks,
    checkPermission: checkPermission ?? agent.checkPermission,
    provider: provider ?? agent.provider,
    messages: messages ?? agent.messages,
  });
}

function buildPromptContext(app: AppContext): PromptContext {
  return {
    workspace: app.workspaceRoot,
    memories: app.memoryManager.buildIndex(),
    skills: app.skillLoader.getDescriptions(),
  };
}
