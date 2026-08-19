import Anthropic from "@anthropic-ai/sdk";
import crypto from "node:crypto";
import {
  anthropicRequestTimeoutOptions,
  awaitWithDeadline,
  isDeadlineError,
  throwIfDeadlineExpired,
} from "./deadline.js";
import {
  DEFAULT_MAIN_AGENT_MAX_TURNS,
  DEFAULT_SUB_AGENT_MAX_TURNS,
  DEFAULT_SUB_AGENT_TIMEOUT_MS,
} from "./options.js";
import type { AgentLoopResult, AgentLoopStopReason } from "./options.js";
import type { ToolResultReadyBlock } from "../hooks/hookBus.js";
import { createAnthropicProvider } from "../providers/index.js";
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

function stopContent(text: string): Anthropic.Messages.Message["content"] {
  return [{ type: "text", text, citations: null }];
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

function summarizeAssistantContent(content: Anthropic.Messages.Message["content"]): string {
  const parts = content.map((block) => {
    if (block.type === "text") return summarizeLifecycleText(block.text);
    if (block.type === "tool_use") return `[tool_use:${block.name}]`;
    return `[${block.type}]`;
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
  response: Anthropic.Messages.Message,
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
      stopReason: response.stop_reason,
      ...(response.usage
        ? {
            usage: {
              inputTokens: response.usage.input_tokens ?? 0,
              outputTokens: response.usage.output_tokens ?? 0,
            },
          }
        : {}),
    }),
  );
}

function emitToolStarted(
  options: AgentLoopOptions,
  block: Anthropic.Messages.ToolUseBlock,
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
      inputSummary: summarizeToolInput(block.name, block.input),
    }),
  );
}

function emitToolFinished(
  options: AgentLoopOptions,
  block: Anthropic.Messages.ToolUseBlock,
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
  | { kind: "result"; result: Anthropic.Messages.ToolResultBlockParam }
  | { kind: "timeout"; result: AgentLoopResult };

type ToolUseExecutionOptions = {
  agent: Agent;
  block: Anthropic.Messages.ToolUseBlock;
  deadlineAt: number | undefined;
  loopOptions: AgentLoopOptions;
  timedOut: () => AgentLoopResult;
};

function toolResult(
  block: Anthropic.Messages.ToolUseBlock,
  content: string,
): Anthropic.Messages.ToolResultBlockParam {
  return {
    type: "tool_result",
    tool_use_id: block.id,
    content,
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
      return { kind: "result", result: toolResult(block, blocked) };
    }

    if (checkPermission) {
      const permissionId = crypto.randomUUID();
      const input = block.input as Record<string, unknown>;
      const inputSummary = summarizeToolInput(block.name, block.input);
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
        return { kind: "result", result: toolResult(block, deniedResult) };
      }
    }

    let output: string;
    let invokeError: string | undefined;
    try {
      output = await awaitWithDeadline(
        toolRuntime.invokeTool(block.name, block.input, {
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
    const status = invokeError || isToolErrorOutput(output) ? "error" : "completed";
    finish({
      status,
      resultSummary: summarizeToolResult(output),
      ...(status === "error" ? { error: invokeError ?? summarizeLifecycleText(output) } : {}),
    });
    return { kind: "result", result: toolResult(block, output) };
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
): Anthropic.Messages.Message | { error: string } {
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
  const provider = agent.provider ?? createAnthropicProvider();
  const deadlineAt = timeoutMs !== undefined ? Date.now() + timeoutMs : undefined;
  const workspaceRoot = agent.workspaceRoot;

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
  let activeModel = provider.model;
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
        autoCompactIfNeeded(messages, workspaceRoot, usageTracker),
        deadlineAt,
      );
      if (autoCompacted) usageTracker = undefined;

      // Fires before every model call (every loop turn), not only on genuine
      // user input — semantically a "pre LLM call" hook, despite the legacy name history.
      hooks?.emitEffect("PreLLMCall", messages);

      // ── LLM call — outcome capture for recovery decision ──
      let outcome: LLMOutcome;
      try {
        const response = await awaitWithDeadline(
          provider.messages.create(
            {
              model: activeModel as Anthropic.Model,
              system: system,
              tools: tools,
              messages,
              max_tokens: maxTokens,
              stream: false,
            },
            anthropicRequestTimeoutOptions(deadlineAt),
          ),
          deadlineAt,
        );
        outcome = { kind: "success", response };
      } catch (error) {
        if (isDeadlineError(error, deadlineAt)) return timedOut();
        outcome = { kind: "error", error };
      }

      const fallbackModel = provider.fallbackModel;
      const action = decideRecovery(outcome, recoveryState, fallbackModel ? { fallbackModel } : {});

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
          maxTokens = action.maxTokens;
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
          messages.push({ role: "assistant", content: resp.content });
          usageTracker = trackerFromUsage(resp.usage, messages.length);
          emitAssistantMessageAdded(options, messages.length - 1, resp);
          messages.push({ role: "user", content: CONTINUATION_PROMPT });
          recoveryState = action.nextState;
          continue;
        }
        case "compact_and_retry": {
          try {
            await awaitWithDeadline(
              forceCompact(messages, workspaceRoot, "context overflow recovery"),
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
          if (action.nextModel) activeModel = action.nextModel;
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

      messages.push({ role: "assistant", content: response.content });
      usageTracker = trackerFromUsage(response.usage, messages.length);
      emitAssistantMessageAdded(options, messages.length - 1, response);
      if (response.stop_reason !== "tool_use") {
        const forceContinue = hooks?.triggerControl("Stop", messages);
        if (forceContinue) {
          messages.push({ role: "user", content: forceContinue });
          continue;
        }
        return { stopReason: response.stop_reason, content: response.content };
      }

      const results: ToolResultReadyBlock[] = [];
      for (const block of response.content) {
        if (block.type !== "tool_use") continue;
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

      hooks?.emitEffect("ToolResultsReady", results);
      messages.push({ role: "user", content: results });
    }
  } catch (error) {
    if (isDeadlineError(error, deadlineAt)) return timedOut();
    throw error;
  }
}
