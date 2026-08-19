import type { Agent } from "../agent/agent.js";
import type { AppContext } from "../app/context.js";
import { hasPendingAsyncWork } from "../app/pendingWork.js";
import { AgentRuntime } from "../agent/runtime.js";
import { createAgentRun, type AgentRun } from "../agent/run.js";
import { describeFinalResponse, type AgentLoopResult } from "../loop/index.js";
import { createConversationMessage, type ConversationMessage } from "./types.js";
import { SessionProjectionStore } from "./projection/projectionStore.js";
import { conversationMessageEvent } from "./sessionEvents.js";

export type SessionUserTurnResult = {
  run: AgentRun;
  result: AgentLoopResult;
  userMessage: ConversationMessage;
  assistantMessage: ConversationMessage;
};

export type SessionAutoWakeResult = {
  run: AgentRun;
  result: AgentLoopResult;
  assistantMessage: ConversationMessage;
};

export type SessionTurnResult = SessionUserTurnResult;

type SessionRunnerDeps = {
  sessionId: string;
  leadAgent: Agent;
  agentRuntime: AgentRuntime;
  store: SessionProjectionStore;
  app: AppContext;
};

export class SessionRunner {
  private readonly sessionId: string;
  private readonly leadAgent: Agent;
  private readonly agentRuntime: AgentRuntime;
  private readonly store: SessionProjectionStore;
  private readonly app: AppContext;

  constructor(deps: SessionRunnerDeps) {
    this.sessionId = deps.sessionId;
    this.leadAgent = deps.leadAgent;
    this.agentRuntime = deps.agentRuntime;
    this.store = deps.store;
    this.app = deps.app;
  }

  async runUserTurn(text: string): Promise<SessionUserTurnResult> {
    const userMessage = createConversationMessage({
      sessionId: this.sessionId,
      role: "user",
      content: text,
      source: "user_input",
    });
    this.store.record(conversationMessageEvent(userMessage));
    this.leadAgent.messages.push({ role: "user", content: text });

    const run = createAgentRun({
      sessionId: this.sessionId,
      agentId: this.leadAgent.id ?? "lead",
      agentKind: "lead",
      trigger: { type: "user_message", messageId: userMessage.id },
    });

    const { result } = await this.agentRuntime.run(this.leadAgent, run);
    const content = run.resultSummary ?? describeFinalResponse(result.content, result.stopReason);
    const assistantMessage = createConversationMessage({
      sessionId: this.sessionId,
      role: "assistant",
      content,
      source: "agent_result",
    });
    this.store.record(conversationMessageEvent(assistantMessage));
    return { run, result, userMessage, assistantMessage };
  }

  async runAutoWake(
    reason: "async_work_finished" | "background_finished" | "subagent_finished",
  ): Promise<SessionAutoWakeResult> {
    const run = createAgentRun({
      sessionId: this.sessionId,
      agentId: this.leadAgent.id ?? "lead",
      agentKind: "lead",
      trigger: { type: "auto_wake", reason },
    });

    const { result } = await this.agentRuntime.run(this.leadAgent, run);
    const assistantMessage = createConversationMessage({
      sessionId: this.sessionId,
      role: "assistant",
      content: run.resultSummary ?? describeFinalResponse(result.content, result.stopReason),
      source: "agent_result",
    });
    this.store.record(conversationMessageEvent(assistantMessage));
    return { run, result, assistantMessage };
  }

  hasPendingAsyncWork(): boolean {
    return hasPendingAsyncWork(this.app);
  }
}
