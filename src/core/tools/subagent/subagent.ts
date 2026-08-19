import type { Agent } from "../../agent/agent.js";
import { DEFAULT_SUB_AGENT_MAX_TURNS, DEFAULT_SUB_AGENT_TIMEOUT_MS } from "../../loop/options.js";
import type { CheckPermissionFn } from "../../permission/types.js";
import { SUB_AGENT_ALLOWED_TOOLS } from "../profiles.js";

export type SubAgentOptions = {
  name?: string;
  role?: string;
  maxTurns?: number;
  timeoutMs?: number;
  checkPermission?: CheckPermissionFn;
  /** Optional narrowing of the subagent tool profile. Tools outside it are dropped. */
  allowedTools?: readonly string[];
};

function buildSubAgentSystemPrompt(workspaceRoot: string, options?: SubAgentOptions): string {
  const identity = options?.name ? ` named '${options.name}'` : "";
  const role = options?.role ? ` Your role is: ${options.role}.` : "";
  return `You are a subagent${identity} at ${workspaceRoot}.${role} Complete the assigned task and report back concisely.`;
}

/**
 * Fork a constrained sub-agent from `parent`: a fresh conversation seeded with
 * `prompt`, narrowed to the subagent tool profile, with shorter turn/timeout
 * budgets. toolRuntime/hooks/workspaceRoot/checkPermission are inherited from
 * the parent via {@link Agent.fork}; everything task-specific is isolated.
 */
export function forkSubAgent(
  parent: Agent,
  id: string,
  prompt: string,
  options?: SubAgentOptions,
): Agent {
  // A child may only narrow the subagent profile, never widen it: requested ∩
  // profile. This keeps child tool access ⊆ the profile (and since the profile
  // excludes `subagent`, a child can never spawn grandchildren).
  const requested = options?.allowedTools;
  const allowedTools = requested
    ? SUB_AGENT_ALLOWED_TOOLS.filter((tool) => requested.includes(tool))
    : SUB_AGENT_ALLOWED_TOOLS;

  return parent.fork({
    id,
    name: options?.name,
    role: options?.role,
    maxTurns: options?.maxTurns ?? DEFAULT_SUB_AGENT_MAX_TURNS,
    timeoutMs: options?.timeoutMs ?? DEFAULT_SUB_AGENT_TIMEOUT_MS,
    allowedTools,
    system: buildSubAgentSystemPrompt(parent.workspaceRoot, options),
    checkPermission: options?.checkPermission,
    messages: [{ role: "user", content: prompt }],
  });
}
