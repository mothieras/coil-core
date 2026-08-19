import type Anthropic from "@anthropic-ai/sdk";
import { Agent } from "../agent/agent.js";
import type { AppContext } from "../app/context.js";
import { buildSystemPrompt, type PromptContext } from "../context/assembler.js";
import type { CheckPermissionFn } from "../permission/types.js";

export function createLeadAgent(options: {
  workspaceRoot: string;
  app: AppContext;
  leadAgent?: Agent | undefined;
  checkPermission?: CheckPermissionFn | undefined;
  messages?: Anthropic.Messages.MessageParam[] | undefined;
}): Agent {
  if (options.leadAgent) {
    return bindLeadAgentToApp(
      options.leadAgent,
      options.app,
      options.messages,
      options.checkPermission,
    );
  }
  return new Agent({
    id: "lead",
    system: buildSystemPrompt(buildPromptContext(options.app)),
    workspaceRoot: options.workspaceRoot,
    toolRuntime: options.app.toolRuntime,
    hooks: options.app.hooks,
    checkPermission: options.checkPermission,
    messages: options.messages,
  });
}

export function bindLeadAgentToApp(
  agent: Agent,
  app: AppContext,
  messages?: Anthropic.Messages.MessageParam[] | undefined,
  checkPermission?: CheckPermissionFn | undefined,
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
