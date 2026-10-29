import { AsyncLocalStorage } from "node:async_hooks";
import type { Message, Tool } from "@earendil-works/pi-ai";
import type { HookBus } from "../hooks/hookBus.js";
import { DEFAULT_MAIN_AGENT_MAX_TURNS } from "../loop/options.js";
import type { CheckPermissionFn } from "../permission/types.js";
import type { Provider } from "../providers/types.js";
import type { ToolRuntime } from "../tools/runtime.js";

export interface AgentConfig {
  id?: string | undefined;
  name?: string | undefined;
  role?: string | undefined;
  maxTurns?: number | undefined;
  timeoutMs?: number | undefined;
  system?: string | undefined;
  workspaceRoot?: string | undefined;
  allowedTools?: readonly string[] | undefined;
  toolRuntime: ToolRuntime;
  /** LLM provider the loop calls. Optional; the loop falls back to the default pi-ai provider. */
  provider?: Provider | undefined;
  hooks?: HookBus | undefined;
  checkPermission?: CheckPermissionFn | undefined;
  messages?: Message[] | undefined;
}

export type AgentForkOptions = Omit<AgentConfig, "toolRuntime">;

/** Agent identity, policy, tool scope, and model context. */
export class Agent {
  readonly id?: string | undefined;
  readonly name?: string | undefined;
  readonly role?: string | undefined;
  readonly maxTurns: number = DEFAULT_MAIN_AGENT_MAX_TURNS;
  readonly timeoutMs?: number | undefined;
  readonly system: string;
  readonly workspaceRoot: string;
  readonly allowedTools?: readonly string[] | undefined;
  readonly toolRuntime: ToolRuntime;
  readonly provider?: Provider | undefined;
  readonly hooks?: HookBus | undefined;
  readonly checkPermission?: CheckPermissionFn | undefined;

  /** Mutated by AgentRuntime's underlying loop. */
  readonly messages: Message[];

  constructor(opts: AgentConfig) {
    this.id = opts.id;
    this.name = opts.name;
    this.role = opts.role;
    if (opts.maxTurns !== undefined) this.maxTurns = opts.maxTurns;
    this.timeoutMs = opts.timeoutMs;
    this.system =
      opts.system ??
      `You are a coding agent at ${opts.workspaceRoot ?? process.cwd()}. Use tools to solve tasks.`;
    this.workspaceRoot = opts.workspaceRoot ?? process.cwd();
    this.allowedTools = opts.allowedTools;
    this.toolRuntime = opts.toolRuntime;
    this.provider = opts.provider;
    this.hooks = opts.hooks;
    this.checkPermission = opts.checkPermission;
    this.messages = opts.messages ?? [];
  }

  getToolDefinitions(): Tool[] {
    return this.toolRuntime.getToolDefinitions(this.allowedTools);
  }

  /** Child agents share runtime access but start with isolated prompt and messages. */
  fork(overrides: AgentForkOptions = {}): Agent {
    return new Agent({
      toolRuntime: this.toolRuntime,
      provider: overrides.provider ?? this.provider,
      workspaceRoot: overrides.workspaceRoot ?? this.workspaceRoot,
      hooks: overrides.hooks,
      checkPermission: overrides.checkPermission ?? this.checkPermission,
      id: overrides.id,
      name: overrides.name,
      role: overrides.role,
      system: overrides.system,
      maxTurns: overrides.maxTurns,
      timeoutMs: overrides.timeoutMs,
      allowedTools: overrides.allowedTools,
      messages: overrides.messages,
    });
  }
}

/** Bound by the loop so tools can find the agent that invoked them. */
export const currentAgent = new AsyncLocalStorage<Agent>();
