import type { Agent } from "./agent.js";
import { agentLoop } from "../loop/loop.js";
import type { AgentLoopResult } from "../loop/loop.js";
import { describeFinalResponse } from "../loop/response.js";
import type { AgentRun } from "./run.js";
import { completeAgentRun, failAgentRun, startAgentRun } from "./run.js";
import {
  createRuntimeLifecycleEvent,
  noopRuntimeLifecycleSink,
  runtimeLifecycleBase,
  runtimeRunContextFromAgentRun,
  safeEmitRuntimeLifecycle,
  type AgentRunFinishedEvent,
  type AgentRunStartedEvent,
  type RuntimeLifecycleSink,
} from "./lifecycle.js";
import { summarizeLifecycleText } from "./lifecycleSummary.js";

export type AgentRuntimeRunResult = {
  run: AgentRun;
  result: AgentLoopResult;
};

export class AgentRuntime {
  constructor(private readonly lifecycle: RuntimeLifecycleSink = noopRuntimeLifecycleSink) {}

  async run(agent: Agent, run: AgentRun): Promise<AgentRuntimeRunResult> {
    startAgentRun(run);
    const runContext = runtimeRunContextFromAgentRun(run);
    safeEmitRuntimeLifecycle(
      this.lifecycle,
      createRuntimeLifecycleEvent<AgentRunStartedEvent>({
        ...runtimeLifecycleBase(runContext),
        type: "agent_run_started",
        trigger: run.trigger,
      }),
    );
    try {
      const result = await agentLoop(agent, {
        lifecycle: this.lifecycle,
        runContext,
      });
      completeAgentRun(run, {
        stopReason: result.stopReason,
        resultSummary: describeFinalResponse(result.content, result.stopReason),
        messageCount: agent.messages.length,
      });
      this.emitRunFinished(run, runContext);
      return { run, result };
    } catch (error) {
      failAgentRun(run, error);
      this.emitRunFinished(run, runContext);
      throw error;
    }
  }

  private emitRunFinished(
    run: AgentRun,
    runContext: ReturnType<typeof runtimeRunContextFromAgentRun>,
  ): void {
    if (run.status === "created" || run.status === "running") return;
    const event = createRuntimeLifecycleEvent<AgentRunFinishedEvent>({
      ...runtimeLifecycleBase(runContext),
      type: "agent_run_finished",
      status: run.status,
      ...(run.stopReason !== undefined ? { stopReason: run.stopReason } : {}),
      ...(run.resultSummary !== undefined
        ? { resultSummary: summarizeLifecycleText(run.resultSummary) }
        : {}),
      ...(run.error !== undefined ? { error: summarizeLifecycleText(run.error) } : {}),
      ...(run.messageCount !== undefined ? { messageCount: run.messageCount } : {}),
      ...(run.toolCallCount !== undefined ? { toolCallCount: run.toolCallCount } : {}),
    });
    safeEmitRuntimeLifecycle(this.lifecycle, event);
  }
}
