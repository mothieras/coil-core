import crypto from "node:crypto";
import {
  CLEANUP_TIMEOUT_MS,
  ExecutionScope,
  ExecutionStoppedError,
  throwIfAborted,
  cancellableDelay,
} from "./cancellation.js";
import type {
  Api,
  AssistantMessage,
  Model,
  ToolCall,
  ToolResultMessage,
  UserMessage,
} from "@earendil-works/pi-ai";
import { isDeadlineError, remainingMs, throwIfDeadlineExpired } from "./deadline.js";
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
import { claimAgent, releaseAgent } from "../agent/ownership.js";
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
  summarizeLifecycleText,
  summarizeToolInput,
  summarizeToolResult,
} from "../agent/lifecycleSummary.js";
import type { ToolSource, ToolExecutionResult } from "../tools/types.js";
import { ToolInvocationError, redactToolDiagnostic } from "../tools/errors.js";
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
  signal?: AbortSignal | undefined;
  /** Internal execution ownership, shared with AgentRuntime. */
  scope?: ExecutionScope | undefined;
};

function waitForOperation<T>(
  promise: Promise<T>,
  options: AgentLoopOptions,
  resource: string,
): Promise<T> {
  return options.scope!.wait(promise, resource);
}

function stopContent(text: string): AssistantMessage["content"] {
  return [{ type: "text", text }];
}

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
    Partial<
      Pick<
        ToolFinishedEvent,
        "resultSummary" | "error" | "durationMs" | "dispatched" | "stopReason"
      >
    >,
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
      dispatched: fields.dispatched,
      stopReason: fields.stopReason,
      ...(fields.resultSummary !== undefined ? { resultSummary: fields.resultSummary } : {}),
      ...(fields.error !== undefined ? { error: fields.error } : {}),
      ...(fields.durationMs !== undefined ? { durationMs: fields.durationMs } : {}),
    }),
  );
}

type ToolUseExecutionOptions = {
  agent: Agent;
  block: ToolCall;
  loopOptions: AgentLoopOptions;
  results: ToolResultMessage[];
};

function toolResult(
  block: ToolCall,
  result: ToolExecutionResult,
  dispatched: boolean,
): ToolResultMessage {
  return {
    role: "toolResult",
    toolCallId: block.id,
    toolName: block.name,
    content: [
      {
        type: "text",
        text: result.status === "completed" ? result.output : redactToolDiagnostic(result.output),
      },
    ],
    isError: result.status !== "completed",
    details: {
      status: result.status,
      dispatched,
      ...(result.stopReason ? { stopReason: result.stopReason } : {}),
    },
    timestamp: Date.now(),
  };
}

async function executeToolUseBlock(options: ToolUseExecutionOptions): Promise<void> {
  const { agent, block, loopOptions, results } = options;
  const hooks = agent.hooks;
  const checkPermission = agent.checkPermission;
  const toolRuntime = agent.toolRuntime;
  const source = getToolSource(agent, block.name);
  const startedAt = Date.now();
  let dispatched = false;
  const finish = (result: ToolExecutionResult) => {
    results.push(toolResult(block, result, dispatched));
    emitToolFinished(loopOptions, block, source, {
      status: result.status,
      dispatched,
      stopReason: result.stopReason,
      durationMs: Date.now() - startedAt,
      resultSummary: summarizeToolResult(result.output),
      ...(result.status !== "completed" ? { error: summarizeLifecycleText(result.output) } : {}),
    });
  };

  emitToolStarted(loopOptions, block, source);
  try {
    throwIfAborted(loopOptions.signal);
    if (agent.allowedTools !== undefined && !agent.allowedTools.includes(block.name)) {
      finish({ status: "blocked", output: `Tool '${block.name}' is not allowed for this agent.` });
      return;
    }
    const blocked = hooks?.triggerControl("PreToolUse", block);
    if (blocked) {
      finish({ status: "blocked", output: blocked });
      return;
    }
    const beforeInvoke = async (
      validated: Record<string, unknown>,
    ): Promise<ToolExecutionResult | void> => {
      if (checkPermission) {
        const permissionId = crypto.randomUUID();
        const input = validated;
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
          signal: loopOptions.signal,
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
        throwIfAborted(loopOptions.signal);
        const permResult = await waitForOperation(
          checkPermission(permissionContext),
          loopOptions,
          `permission:${block.id}`,
        );
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
          return { status: "permission_denied", output: deniedResult };
        }
      }
    };
    const result = await waitForOperation(
      toolRuntime.invokeTool(block.name, block.arguments, {
        toolCallId: block.id,
        toolName: block.name,
        signal: loopOptions.signal,
        argumentsError: block.argumentsError,
        beforeInvoke,
        onDispatch: () => {
          dispatched = true;
        },
        ...(loopOptions.runContext ?? {}),
        ...(source !== undefined ? { source } : {}),
      }),
      loopOptions,
      `tool:${block.id}`,
    );
    if (dispatched) hooks?.emitEffect("PostToolUse", block, result.output);
    finish(result);
  } catch (error) {
    if (error instanceof ExecutionStoppedError) {
      const status = !dispatched
        ? error.reason === "timeout"
          ? "timeout"
          : "cancelled"
        : error.confirmation === "unconfirmed"
          ? "unconfirmed"
          : error.reason === "timeout"
            ? "timeout"
            : "cancelled";
      finish({
        status,
        stopReason: error.reason,
        output: !dispatched
          ? "未执行：运行已停止。"
          : status === "unconfirmed"
            ? "结果未知：运行已停止等待，工具可能仍在执行。"
            : `工具已停止：${error.reason}。`,
      });
      throw error;
    }
    const fatal =
      error instanceof ToolInvocationError
        ? error
        : new ToolInvocationError(
            block.name,
            { toolName: block.name, toolCallId: block.id, runId: loopOptions.runContext?.runId },
            error,
          );
    finish({ status: "error", output: fatal.message });
    throw fatal;
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
  const ownsScope = options.scope === undefined;
  const scope = options.scope ?? new ExecutionScope();
  const abort = () => scope.controller.abort(new ExecutionStoppedError());
  if (ownsScope) {
    claimAgent(agent);
    options.signal?.addEventListener("abort", abort, { once: true });
    if (options.signal?.aborted) abort();
  }
  const timer =
    !ownsScope || agent.timeoutMs === undefined
      ? undefined
      : setTimeout(
          () => scope.controller.abort(new ExecutionStoppedError("timeout")),
          Math.max(0, agent.timeoutMs),
        );
  try {
    const result = await currentAgent.run(agent, () =>
      agentLoopInner(agent, { ...options, signal: scope.signal, scope }),
    );
    if (
      ownsScope &&
      !scope.signal.aborted &&
      (result.stopReason === "aborted" || result.stopReason === "timeout")
    )
      scope.controller.abort(new ExecutionStoppedError(result.stopReason));
    if (ownsScope && scope.signal.aborted) {
      result.stopReason =
        scope.signal.reason instanceof ExecutionStoppedError
          ? scope.signal.reason.reason
          : "aborted";
      result.cleanup = await scope.cleanup(Date.now() + CLEANUP_TIMEOUT_MS);
    }
    return result;
  } finally {
    clearTimeout(timer);
    if (ownsScope) {
      options.signal?.removeEventListener("abort", abort);
      void scope.settled().then(() => releaseAgent(agent));
    }
  }
}

async function agentLoopInner(agent: Agent, options: AgentLoopOptions): Promise<AgentLoopResult> {
  if (options.signal?.aborted) {
    const reason =
      options.signal.reason instanceof ExecutionStoppedError
        ? options.signal.reason.reason
        : "aborted";
    return { stopReason: reason, content: stopContent(`Execution stopped: ${reason}`) };
  }
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
      throwIfAborted(options.signal);
      if (turns >= maxTurns) {
        return {
          stopReason: "max_turns",
          content: stopContent(`Stopped: reached max turns (${maxTurns}).`),
        };
      }
      throwIfDeadlineExpired(deadlineAt);

      if (microCompact(messages, usageTracker)) usageTracker = undefined;
      const autoCompacted = await waitForOperation(
        autoCompactIfNeeded(messages, workspaceRoot, usageTracker, generateText, options.signal),
        options,
        "compaction",
      );
      if (autoCompacted) usageTracker = undefined;

      // Fires before every model call (every loop turn), not only on genuine
      // user input — semantically a "pre LLM call" hook, despite the legacy name history.
      hooks?.emitEffect("PreLLMCall", messages);

      // ── LLM call — outcome capture for recovery decision ──
      let outcome: LLMOutcome;
      try {
        throwIfAborted(options.signal);
        const callOptions: ProviderCallOptions = { maxTokens, signal: options.signal };
        const timeout = remainingMs(deadlineAt);
        if (timeout !== undefined) callOptions.timeoutMs = timeout;
        const response = await waitForOperation(
          provider.generate(activeModel, { system, messages, tools }, callOptions),
          options,
          "provider",
        );
        outcome = { kind: "success", response };
      } catch (error) {
        if (error instanceof ExecutionStoppedError) throw error;
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
            await waitForOperation(
              forceCompact(
                messages,
                workspaceRoot,
                "context overflow recovery",
                generateText,
                options.signal,
              ),
              options,
              "compaction",
            );
            usageTracker = undefined;
          } catch (error) {
            if (error instanceof ExecutionStoppedError) throw error;
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
          await cancellableDelay(action.delayMs, options.signal);
          recoveryState = action.nextState;
          continue;
        }
        case "abort": {
          return {
            stopReason:
              outcome.kind === "success" && outcome.response.stopReason === "length"
                ? "length"
                : "error",
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
      const calls = response.content.filter(
        (block): block is ToolCall => block.type === "toolCall",
      );
      if (!calls.length)
        return {
          stopReason: "error",
          content: stopContent("Provider returned toolUse without tool calls."),
        };
      try {
        for (const block of calls) {
          throwIfAborted(options.signal);
          throwIfDeadlineExpired(deadlineAt);
          await executeToolUseBlock({ agent, block, loopOptions: options, results });
        }
      } catch (error) {
        for (const block of calls.slice(results.length)) {
          const result: ToolExecutionResult = {
            status: "not_executed",
            output: "未执行：本批次已停止。",
          };
          const source = getToolSource(agent, block.name);
          emitToolStarted(options, block, source);
          emitToolFinished(options, block, source, {
            status: result.status,
            dispatched: false,
            error: result.output,
            durationMs: 0,
          });
          results.push(toolResult(block, result, false));
        }
        messages.push(...results);
        throw error;
      }

      const followups: UserMessage[] = [];
      const payload: ToolResultsReadyPayload = { results, followups };
      hooks?.emitEffect("ToolResultsReady", payload);
      messages.push(...payload.results, ...payload.followups);
    }
  } catch (error) {
    if (error instanceof ExecutionStoppedError)
      return { stopReason: error.reason, content: stopContent(error.message) };
    if (isDeadlineError(error, deadlineAt)) return timedOut();
    throw error;
  }
}
