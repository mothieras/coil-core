import crypto from "node:crypto";
import type {
  Api,
  AssistantMessage,
  Model,
  ToolCall,
  ToolResultMessage,
  UserMessage,
} from "@earendil-works/pi-ai";
import {
  awaitWithDeadline,
  isDeadlineError,
  remainingMs,
  throwIfDeadlineExpired,
} from "./deadline.js";
import {
  DEFAULT_MAIN_AGENT_MAX_TURNS,
  DEFAULT_SUB_AGENT_MAX_TURNS,
  DEFAULT_SUB_AGENT_TIMEOUT_MS,
} from "./options.js";
import type { AgentLoopResult, AgentLoopStopReason } from "./options.js";
import type { ToolResultsReadyPayload } from "../hooks/hookBus.js";
import { createDefaultProvider, textGenerator } from "../providers/index.js";
import type { ProviderCallOptions } from "../providers/index.js";
import {
  autoCompactIfNeeded,
  forceCompact,
  microCompact,
  trackerFromUsage,
} from "../context/compact.js";
import type { ContextSizeTracker } from "../context/compact.js";
import { Agent, currentAgent } from "../agent/agent.js";
import {
  createRuntimeLifecycleEvent,
  runtimeLifecycleBase,
  safeEmitRuntimeLifecycle,
  type AssistantMessageAddedEvent,
  type PermissionRequestedEvent,
  type PermissionResolvedEvent,
  type RuntimeLifecycleSink,
  type RuntimeRunContext,
  type ToolFinishedEvent,
  type ToolStartedEvent,
} from "../agent/lifecycle.js";
import {
  isToolErrorOutput,
  summarizeLifecycleError,
  summarizeLifecycleText,
  summarizeToolInput,
  summarizeToolResult,
} from "../agent/lifecycleSummary.js";
import type { ToolSource } from "../tools/types.js";
import {
  decideRecovery,
  initialRecoveryState,
  CONTINUATION_PROMPT,
  DEFAULT_MAX_TOKENS,
} from "./recovery.js";
import type { LLMOutcome } from "./recovery.js";
import type { PermissionCheckContext } from "../permission/types.js";

export { DEFAULT_MAIN_AGENT_MAX_TURNS, DEFAULT_SUB_AGENT_MAX_TURNS, DEFAULT_SUB_AGENT_TIMEOUT_MS };
export type { AgentLoopResult, AgentLoopStopReason };

export type AgentLoopOptions = {
  lifecycle?: RuntimeLifecycleSink | undefined;
  runContext?: RuntimeRunContext | undefined;
};

function stopContent(text: string): AssistantMessage["content"] {
  return [{ type: "text", text }];
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function formatRuntimeError(error: unknown): string {
  if (error instanceof Error) return `${error.name}: ${error.message}`;
  if (typeof error === "object" && error !== null) {
    const e = error as { code?: unknown; message?: unknown };
    const code = typeof e.code === "string" ? `${e.code}: ` : "";
    const message = typeof e.message === "string" ? e.message : JSON.stringify(error);
    return `${code}${message}`;
  }
  return String(error);
}

function summarizeAssistantContent(content: AssistantMessage["content"]): string {
  const parts = content.map((block) => {
    if (block.type === "text") return summarizeLifecycleText(block.text);
    if (block.type === "toolCall") return `[toolCall:${block.name}]`;
    return "[thinking]";
  });
  return summarizeLifecycleText(parts.join("\n"));
}

function getToolSource(agent: Agent, name: string): ToolSource | undefined {
  const runtime = agent.toolRuntime as Agent["toolRuntime"] & {
    getToolSource?: (toolName: string) => ToolSource | undefined;
  };
  return runtime.getToolSource?.(name);
}

function emitAssistantMessageAdded(
  options: AgentLoopOptions,
  messageIndex: number,
  response: AssistantMessage,
): void {
  if (!options.runContext) return;
  safeEmitRuntimeLifecycle(
    options.lifecycle,
    createRuntimeLifecycleEvent<AssistantMessageAddedEvent>({
      ...runtimeLifecycleBase(options.runContext),
      type: "assistant_message_added",
      messageIndex,
      contentSummary: summarizeAssistantContent(response.content),
      blockCount: response.content.length,
      stopReason: response.stopReason,
      usage: {
        inputTokens: response.usage.input,
        outputTokens: response.usage.output,
      },
    }),
  );
}

function emitToolStarted(
  options: AgentLoopOptions,
  block: ToolCall,
  source: ToolSource | undefined,
): void {
  if (!options.runContext) return;
  safeEmitRuntimeLifecycle(
    options.lifecycle,
    createRuntimeLifecycleEvent<ToolStartedEvent>({
      ...runtimeLifecycleBase(options.runContext),
      type: "tool_started",
      toolCallId: block.id,
      toolName: block.name,
      ...(source !== undefined ? { source } : {}),
      inputSummary: summarizeToolInput(block.name, block.arguments),
    }),
  );
}

function emitToolFinished(
  options: AgentLoopOptions,
  block: ToolCall,
  source: ToolSource | undefined,
  fields: Pick<ToolFinishedEvent, "status"> &
    Partial<Pick<ToolFinishedEvent, "resultSummary" | "error" | "durationMs">>,
): void {
  if (!options.runContext) return;
  safeEmitRuntimeLifecycle(
    options.lifecycle,
    createRuntimeLifecycleEvent<ToolFinishedEvent>({
      ...runtimeLifecycleBase(options.runContext),
      type: "tool_finished",
      toolCallId: block.id,
      toolName: block.name,
      ...(source !== undefined ? { source } : {}),
      status: fields.status,
      ...(fields.resultSummary !== undefined ? { resultSummary: fields.resultSummary } : {}),
      ...(fields.error !== undefined ? { error: fields.error } : {}),
      ...(fields.durationMs !== undefined ? { durationMs: fields.durationMs } : {}),
    }),
  );
}

type ToolUseExecutionResult =
  { kind: "result"; result: ToolResultMessage } | { kind: "timeout"; result: AgentLoopResult };

type ToolUseExecutionOptions = {
  agent: Agent;
  block: ToolCall;
  deadlineAt: number | undefined;
  loopOptions: AgentLoopOptions;
  timedOut: () => AgentLoopResult;
};

function toolResult(block: ToolCall, content: string, isError: boolean): ToolResultMessage {
  return {
    role: "toolResult",
    toolCallId: block.id,
    toolName: block.name,
    content: [{ type: "text", text: content }],
    isError,
    timestamp: Date.now(),
  };
}

async function executeToolUseBlock(
  options: ToolUseExecutionOptions,
): Promise<ToolUseExecutionResult> {
  const { agent, block, deadlineAt, loopOptions, timedOut } = options;
  const hooks = agent.hooks;
  const checkPermission = agent.checkPermission;
  const toolRuntime = agent.toolRuntime;
  const source = getToolSource(agent, block.name);
  const toolStartedAt = Date.now();
  let finished = false;
  const durationMs = () => Date.now() - toolStartedAt;
  const finish = (
    fields: Pick<ToolFinishedEvent, "status"> &
      Partial<Pick<ToolFinishedEvent, "resultSummary" | "error">>,
  ) => {
    if (finished) return;
    finished = true;
    emitToolFinished(loopOptions, block, source, {
      ...fields,
      durationMs: durationMs(),
    });
  };

  emitToolStarted(loopOptions, block, source);

  try {
    const allowedTools = agent.allowedTools;
    if (allowedTools !== undefined && !allowedTools.includes(block.name)) {
      const notAllowed = `Error: Tool '${block.name}' is not allowed for this agent.`;
      finish({
        status: "blocked",
        resultSummary: summarizeLifecycleText(notAllowed),
      });
      return { kind: "result", result: toolResult(block, notAllowed, true) };
    }

    // Tool execution gating: PreToolUse hooks run first (can block entirely,
    // skipping permission), then the optional permission pipeline (deny list →
    // rule matching → user approval). A PreToolUse hook that blocks bypasses
    // permission — useful for administrative blocks, not user prompts.
    const blocked = hooks?.triggerControl("PreToolUse", block);
    if (blocked) {
      finish({
        status: "blocked",
        resultSummary: summarizeLifecycleText(blocked),
      });
      return { kind: "result", result: toolResult(block, blocked, true) };
    }

    if (checkPermission) {
      const permissionId = crypto.randomUUID();
      const input = block.arguments as Record<string, unknown>;
      const inputSummary = summarizeToolInput(block.name, block.arguments);
      const runContext = loopOptions.runContext ?? {
        runId: "untracked",
        agentId: agent.id ?? "lead",
        agentKind: "lead" as const,
      };
      const emitPermissionRequested = (reason: string) => {
        if (!loopOptions.runContext) return;
        safeEmitRuntimeLifecycle(
          loopOptions.lifecycle,
          createRuntimeLifecycleEvent<PermissionRequestedEvent>({
            ...runtimeLifecycleBase(loopOptions.runContext),
            type: "permission_requested",
            permissionId,
            toolCallId: block.id,
            toolName: block.name,
            ...(source !== undefined ? { source } : {}),
            reason: summarizeLifecycleText(reason),
            inputSummary,
          }),
        );
      };
      const permissionContext: PermissionCheckContext = {
        permissionId,
        toolName: block.name,
        input,
        runId: runContext.runId,
        agentId: runContext.agentId,
        agentKind: runContext.agentKind,
        toolCallId: block.id,
        ...(runContext.sessionId !== undefined ? { sessionId: runContext.sessionId } : {}),
        ...(source !== undefined ? { source } : {}),
        inputSummary,
        emitPermissionRequested,
      };
      const permResult = await awaitWithDeadline(checkPermission(permissionContext), deadlineAt);
      if (loopOptions.runContext && (!permResult.allowed || permResult.requested)) {
        safeEmitRuntimeLifecycle(
          loopOptions.lifecycle,
          createRuntimeLifecycleEvent<PermissionResolvedEvent>({
            ...runtimeLifecycleBase(loopOptions.runContext),
            type: "permission_resolved",
            permissionId,
            toolCallId: block.id,
            toolName: block.name,
            ...(source !== undefined ? { source } : {}),
            allowed: permResult.allowed,
            ...(permResult.reason !== undefined
              ? { reason: summarizeLifecycleText(permResult.reason) }
              : {}),
          }),
        );
      }
      if (!permResult.allowed) {
        const deniedResult = `Permission denied: ${
          permResult.reason ?? "blocked by permission check"
        }`;
        finish({
          status: "permission_denied",
          resultSummary: summarizeLifecycleText(deniedResult),
        });
        return { kind: "result", result: toolResult(block, deniedResult, true) };
      }
    }

    let output: string;
    let invokeError: string | undefined;
    try {
      output = await awaitWithDeadline(
        toolRuntime.invokeTool(block.name, block.arguments, {
          toolCallId: block.id,
          toolName: block.name,
          ...(loopOptions.runContext !== undefined
            ? {
                runId: loopOptions.runContext.runId,
                sessionId: loopOptions.runContext.sessionId,
                agentId: loopOptions.runContext.agentId,
                agentKind: loopOptions.runContext.agentKind,
              }
            : {}),
          ...(source !== undefined ? { source } : {}),
        }),
        deadlineAt,
      );
    } catch (error) {
      if (isDeadlineError(error, deadlineAt)) throw error;
      invokeError = summarizeLifecycleError(error);
      output = `Error: ${formatRuntimeError(error)}`;
    }

    hooks?.emitEffect("PostToolUse", block, output);
    const isError = invokeError !== undefined || isToolErrorOutput(output);
    finish({
      status: isError ? "error" : "completed",
      resultSummary: summarizeToolResult(output),
      ...(isError ? { error: invokeError ?? summarizeLifecycleText(output) } : {}),
    });
    return { kind: "result", result: toolResult(block, output, isError) };
  } catch (error) {
    finish({
      status: "error",
      error: summarizeLifecycleError(error),
    });
    if (isDeadlineError(error, deadlineAt)) {
      return { kind: "timeout", result: timedOut() };
    }
    throw error;
  }
}

function requireSuccessOutcome(
  outcome: LLMOutcome,
  actionType: string,
): AssistantMessage | { error: string } {
  if (outcome.kind === "success") return outcome.response;
  return {
    error: `Internal recovery error: action '${actionType}' requires a successful model response.`,
  };
}

export async function agentLoop(
  agent: Agent,
  options: AgentLoopOptions = {},
): Promise<AgentLoopResult> {
  // Bind the agent to the async context for the whole run so tools dispatched
  // inside the loop (e.g. `subagent`) can fork the agent that invoked them.
  return currentAgent.run(agent, () => agentLoopInner(agent, options));
}

async function agentLoopInner(agent: Agent, options: AgentLoopOptions): Promise<AgentLoopResult> {
  const messages = agent.messages;
  const timeoutMs = agent.timeoutMs;
  const provider = agent.provider ?? createDefaultProvider();
  const deadlineAt = timeoutMs !== undefined ? Date.now() + timeoutMs : undefined;
  const workspaceRoot = agent.workspaceRoot;
  const generateText = textGenerator(provider);

  const tools = agent.getToolDefinitions();
  const system = agent.system;
  const hooks = agent.hooks;
  const maxTurns = agent.maxTurns;

  const timedOut = () => ({
    stopReason: "timeout" as const,
    content: stopContent(`Stopped: reached timeout (${timeoutMs}ms).`),
  });
  let turns = 0;
  let recoveryState = initialRecoveryState();
  let maxTokens = DEFAULT_MAX_TOKENS;
  let activeModel: Model<Api> = provider.model;
  // Real context size from the last response's usage; undefined until the
  // first response lands and after any compaction rewrites the buffer.
  let usageTracker: ContextSizeTracker | undefined;

  try {
    hooks?.emitEffect("LoopStart", messages);

    while (true) {
      if (turns >= maxTurns) {
        return {
          stopReason: "max_turns",
          content: stopContent(`Stopped: reached max turns (${maxTurns}).`),
        };
      }
      throwIfDeadlineExpired(deadlineAt);

      if (microCompact(messages, usageTracker)) usageTracker = undefined;
      const autoCompacted = await awaitWithDeadline(
        autoCompactIfNeeded(messages, workspaceRoot, usageTracker, generateText),
        deadlineAt,
      );
      if (autoCompacted) usageTracker = undefined;

      // Fires before every model call (every loop turn), not only on genuine
      // user input — semantically a "pre LLM call" hook, despite the legacy name history.
      hooks?.emitEffect("PreLLMCall", messages);

      // ── LLM call — outcome capture for recovery decision ──
      let outcome: LLMOutcome;
      try {
        const callOptions: ProviderCallOptions = { maxTokens };
        const timeout = remainingMs(deadlineAt);
        if (timeout !== undefined) callOptions.timeoutMs = timeout;
        const response = await awaitWithDeadline(
          provider.generate(activeModel, { system, messages, tools }, callOptions),
          deadlineAt,
        );
        outcome = { kind: "success", response };
      } catch (error) {
        if (isDeadlineError(error, deadlineAt)) return timedOut();
        outcome = { kind: "error", error };
      }

      const fallbackModel = provider.fallbackModel;
      const action = decideRecovery(
        outcome,
        recoveryState,
        fallbackModel !== undefined ? { fallbackModel } : {},
      );

      switch (action.type) {
        case "none": {
          const response = requireSuccessOutcome(outcome, action.type);
          if ("error" in response) {
            return {
              stopReason: "error",
              content: stopContent(response.error),
            };
          }
          recoveryState = initialRecoveryState();
          maxTokens = DEFAULT_MAX_TOKENS;
          break;
        }
        case "retry": {
          maxTokens = Math.min(action.maxTokens, activeModel.maxTokens);
          recoveryState = action.nextState;
          continue;
        }
        case "continue_with_prompt": {
          const resp = requireSuccessOutcome(outcome, action.type);
          if ("error" in resp) {
            return {
              stopReason: "error",
              content: stopContent(resp.error),
            };
          }
          messages.push(resp);
          usageTracker = trackerFromUsage(resp.usage, messages.length);
          emitAssistantMessageAdded(options, messages.length - 1, resp);
          messages.push({ role: "user", content: CONTINUATION_PROMPT, timestamp: Date.now() });
          recoveryState = action.nextState;
          continue;
        }
        case "compact_and_retry": {
          try {
            await awaitWithDeadline(
              forceCompact(messages, workspaceRoot, "context overflow recovery", generateText),
              deadlineAt,
            );
            usageTracker = undefined;
          } catch (error) {
            if (isDeadlineError(error, deadlineAt)) return timedOut();
            return {
              stopReason: "error",
              content: stopContent(`Compaction failed: ${formatRuntimeError(error)}`),
            };
          }
          recoveryState = action.nextState;
          continue;
        }
        case "backoff_and_retry": {
          if (action.nextModel !== undefined) activeModel = action.nextModel;
          await awaitWithDeadline(sleep(action.delayMs), deadlineAt);
          recoveryState = action.nextState;
          continue;
        }
        case "abort": {
          return {
            stopReason: "error",
            content: stopContent(action.message),
          };
        }
      }

      // Normal path — proceed with successful response
      const response = requireSuccessOutcome(outcome, "normal_path");
      if ("error" in response) {
        return {
          stopReason: "error",
          content: stopContent(response.error),
        };
      }
      turns += 1;

      messages.push(response);
      usageTracker = trackerFromUsage(response.usage, messages.length);
      emitAssistantMessageAdded(options, messages.length - 1, response);
      if (response.stopReason === "pending" || response.stopReason === "deferred") {
        return {
          stopReason: "error",
          content: stopContent(`Provider returned an incomplete response: ${response.stopReason}.`),
        };
      }
      if (response.stopReason !== "toolUse") {
        const forceContinue = hooks?.triggerControl("Stop", messages);
        if (forceContinue) {
          messages.push({ role: "user", content: forceContinue, timestamp: Date.now() });
          continue;
        }
        return { stopReason: response.stopReason, content: response.content };
      }

      const results: ToolResultMessage[] = [];
      for (const block of response.content) {
        if (block.type !== "toolCall") continue;
        throwIfDeadlineExpired(deadlineAt);
        const execution = await executeToolUseBlock({
          agent,
          block,
          deadlineAt,
          loopOptions: options,
          timedOut,
        });
        if (execution.kind === "timeout") return execution.result;
        results.push(execution.result);
      }

      const followups: UserMessage[] = [];
      const payload: ToolResultsReadyPayload = { results, followups };
      hooks?.emitEffect("ToolResultsReady", payload);
      messages.push(...payload.results, ...payload.followups);
    }
  } catch (error) {
    if (isDeadlineError(error, deadlineAt)) return timedOut();
    throw error;
  }
}
