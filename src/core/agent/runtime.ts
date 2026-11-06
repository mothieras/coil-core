import type { Agent } from "./agent.js";
import { assertAgentIdle, claimAgent, releaseAgent } from "./ownership.js";
import { agentLoop } from "../loop/loop.js";
import type { AgentLoopResult } from "../loop/loop.js";
import { describeFinalResponse } from "../loop/response.js";
import type { AgentRun, RunCleanupResult, RunStopSource } from "./run.js";
import {
  completeAgentRun,
  failAgentRun,
  startAgentRun,
  requestAgentRunStop,
  finishAgentRunStop,
} from "./run.js";
import {
  createRuntimeLifecycleEvent,
  noopRuntimeLifecycleSink,
  runtimeLifecycleBase,
  runtimeRunContextFromAgentRun,
  safeEmitRuntimeLifecycle,
  type AgentRunFinishedEvent,
  type AgentRunStartedEvent,
  type AgentRunStoppingEvent,
  type RuntimeLifecycleSink,
} from "./lifecycle.js";
import { summarizeLifecycleText } from "./lifecycleSummary.js";
import { CLEANUP_TIMEOUT_MS, ExecutionScope, ExecutionStoppedError } from "../loop/cancellation.js";

export type AgentRuntimeRunResult = { run: AgentRun; result: AgentLoopResult };
export type CancelRunResult = {
  status: "accepted" | "noop" | "descendants_only" | "unknown";
  runId: string;
  cleanup?: RunCleanupResult | undefined;
};

type RunControl = {
  run: AgentRun;
  scope: ExecutionScope;
  done: PromiseWithResolvers<void>;
  settled: boolean;
  deadlineAt?: number;
  cancelling?: Promise<CancelRunResult>;
};

export class AgentRuntime {
  private readonly controls = new Map<string, RunControl>();
  private readonly work = new Map<
    string,
    Set<{ done: Promise<unknown>; stop: (deadlineAt: number) => Promise<RunCleanupResult> }>
  >();

  registerWork(
    runId: string,
    work: { done: Promise<unknown>; stop: (deadlineAt: number) => Promise<RunCleanupResult> },
  ): void {
    const owned = this.work.get(runId) ?? new Set();
    this.work.set(runId, owned);
    owned.add(work);
    const remove = () => {
      owned.delete(work);
      if (!owned.size) this.work.delete(runId);
    };
    void work.done.then(remove, remove);
  }

  async whenSettled(runId: string): Promise<void> {
    const control = this.controls.get(runId);
    if (!control) return;
    await control.done.promise;
    await control.scope.settled();
  }

  private async stopDescendants(
    runId: string,
    source: RunStopSource,
    deadlineAt: number,
  ): Promise<RunCleanupResult> {
    const jobs: Promise<RunCleanupResult | undefined>[] = [];
    for (const control of this.controls.values()) {
      if (control.run.trigger.type === "subagent" && control.run.trigger.parentRunId === runId) {
        jobs.push(
          this.cancelRun(control.run.id, source, deadlineAt).then((result) => result.cleanup),
        );
      }
    }
    for (const work of this.work.get(runId) ?? []) jobs.push(work.stop(deadlineAt));
    const results = await Promise.allSettled(jobs);
    const cleanups = results.flatMap((result) =>
      result.status === "fulfilled" && result.value ? [result.value] : [],
    );
    const errors = results
      .flatMap((result) => (result.status === "rejected" ? [String(result.reason)] : []))
      .concat(cleanups.flatMap((result) => result.errors));
    return {
      status:
        errors.length || cleanups.some((result) => result.status === "unconfirmed")
          ? "unconfirmed"
          : "confirmed",
      errors,
      resources: cleanups.flatMap((result) => result.resources),
    };
  }

  private hasDescendants(runId: string): boolean {
    return (
      !!this.work.get(runId)?.size ||
      [...this.controls.values()].some(
        (control) =>
          control.run.trigger.type === "subagent" &&
          control.run.trigger.parentRunId === runId &&
          (!control.settled || this.hasDescendants(control.run.id)),
      )
    );
  }
  private closing = false;
  constructor(private readonly lifecycle: RuntimeLifecycleSink = noopRuntimeLifecycleSink) {}

  async close(deadlineAt = Date.now() + CLEANUP_TIMEOUT_MS): Promise<CancelRunResult[]> {
    this.closing = true;
    return Promise.all(
      [...this.controls.keys()].map((id) => this.cancelRun(id, "session_close", deadlineAt)),
    );
  }

  cancelRun(
    runId: string,
    source: RunStopSource = "user",
    deadlineAt = Date.now() + CLEANUP_TIMEOUT_MS,
  ): Promise<CancelRunResult> {
    const control = this.controls.get(runId);
    if (!control) return Promise.resolve({ status: "unknown", runId });
    if (
      control.run.status !== "running" &&
      control.run.status !== "created" &&
      control.run.status !== "stopping"
    ) {
      if (this.hasDescendants(runId)) {
        return this.stopDescendants(runId, source, deadlineAt).then((cleanup) => ({
          status: "descendants_only",
          runId,
          cleanup,
        }));
      }
      return Promise.resolve({ status: "noop", runId, cleanup: control.run.cleanup });
    }
    if (control.cancelling) return control.cancelling;
    this.requestStop(control, source === "deadline" ? "timeout" : "aborted", source, deadlineAt);
    control.cancelling = control.done.promise.then(() => ({
      status: "accepted",
      runId,
      cleanup: control.run.cleanup,
    }));
    return control.cancelling;
  }

  private requestStop(
    control: RunControl,
    reason: "aborted" | "timeout",
    source: RunStopSource,
    deadlineAt: number,
  ): void {
    if (!requestAgentRunStop(control.run, reason, source)) return;
    control.deadlineAt = deadlineAt;
    safeEmitRuntimeLifecycle(
      this.lifecycle,
      createRuntimeLifecycleEvent<AgentRunStoppingEvent>({
        ...runtimeLifecycleBase(runtimeRunContextFromAgentRun(control.run)),
        type: "agent_run_stopping",
        stopReason: reason,
        stopSource: source,
      }),
    );
    control.scope.controller.abort(new ExecutionStoppedError(reason));
  }

  assertCanRun(agent: Agent): void {
    if (this.closing) throw new Error("Runtime is closing");
    assertAgentIdle(agent);
  }

  async run(
    agent: Agent,
    run: AgentRun,
    options: { signal?: AbortSignal | undefined } = {},
  ): Promise<AgentRuntimeRunResult> {
    this.assertCanRun(agent);
    if (run.status !== "created" || this.controls.has(run.id))
      throw new Error("Run has already started");
    claimAgent(agent);
    const scope = new ExecutionScope();
    const control: RunControl = { run, scope, done: Promise.withResolvers<void>(), settled: false };
    this.controls.set(run.id, control);
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
    const abort = () => {
      void this.cancelRun(run.id, "signal");
    };
    options.signal?.addEventListener("abort", abort, { once: true });
    let timer: ReturnType<typeof setTimeout> | undefined;
    if (options.signal?.aborted) abort();
    if (agent.timeoutMs !== undefined) {
      timer = setTimeout(
        () => {
          void this.cancelRun(run.id, "deadline");
        },
        Math.max(0, agent.timeoutMs),
      );
    }
    try {
      let result: AgentLoopResult;
      try {
        result = await agentLoop(agent, {
          lifecycle: this.lifecycle,
          runContext,
          signal: scope.signal,
          scope,
        });
      } catch (error) {
        if (!scope.signal.aborted) {
          failAgentRun(run, error);
          throw error;
        }
        result = { stopReason: run.stopReason === "timeout" ? "timeout" : "aborted", content: [] };
      }
      if (
        (result.stopReason === "timeout" || result.stopReason === "aborted") &&
        !scope.signal.aborted
      ) {
        this.requestStop(
          control,
          result.stopReason,
          result.stopReason === "timeout" ? "deadline" : "user",
          Date.now() + CLEANUP_TIMEOUT_MS,
        );
      }
      if (scope.signal.aborted) {
        const deadline = control.deadlineAt ?? Date.now() + CLEANUP_TIMEOUT_MS;
        const [ownCleanup, childrenCleanup] = await Promise.all([
          scope.cleanup(deadline),
          this.stopDescendants(run.id, run.stopSource ?? "user", deadline),
        ]);
        const cleanup: RunCleanupResult = {
          status:
            ownCleanup.status === "unconfirmed" || childrenCleanup.status === "unconfirmed"
              ? "unconfirmed"
              : "confirmed",
          resources: [...ownCleanup.resources, ...childrenCleanup.resources],
          errors: [...ownCleanup.errors, ...childrenCleanup.errors],
        };
        finishAgentRunStop(run, cleanup);
        result = {
          stopReason: run.stopReason === "timeout" ? "timeout" : "aborted",
          content: [
            {
              type: "text",
              text:
                cleanup.status === "unconfirmed"
                  ? "Stopped waiting; execution stop unconfirmed."
                  : "Execution stopped.",
            },
          ],
        };
        result.cleanup = cleanup;
        run.resultSummary = describeFinalResponse(result.content, result.stopReason);
        run.messageCount = agent.messages.length;
      } else {
        completeAgentRun(run, {
          stopReason: result.stopReason,
          resultSummary: describeFinalResponse(result.content, result.stopReason),
          messageCount: agent.messages.length,
        });
        run.cleanup = { status: "not_needed", resources: [], errors: [] };
      }
      return { run, result };
    } finally {
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", abort);
      this.emitRunFinished(run, runContext);
      control.done.resolve();
      // An uncooperative consumer still owns this Agent until its actual completion.
      void scope.settled().then(() => {
        control.settled = true;
        releaseAgent(agent);
      });
    }
  }

  private emitRunFinished(
    run: AgentRun,
    runContext: ReturnType<typeof runtimeRunContextFromAgentRun>,
  ): void {
    if (run.status === "created" || run.status === "running" || run.status === "stopping") return;
    const event = createRuntimeLifecycleEvent<AgentRunFinishedEvent>({
      ...runtimeLifecycleBase(runContext),
      type: "agent_run_finished",
      status: run.status,
      stopReason: run.stopReason,
      stopSource: run.stopSource,
      cleanup:
        run.cleanup === undefined
          ? undefined
          : {
              ...run.cleanup,
              errors: run.cleanup.errors.map((error) => summarizeLifecycleText(error)),
            },
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
