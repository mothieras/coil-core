import crypto from "node:crypto";
import type { Agent } from "../../agent/agent.js";
import { AgentRuntime } from "../../agent/runtime.js";
import { createAgentRun, interruptAgentRun, type AgentRun } from "../../agent/run.js";
import { forkSubAgent } from "./subagent.js";
import type { SubAgentOptions } from "./subagent.js";
import type { CheckPermissionFn } from "../../permission/types.js";
import { AsyncWorkInbox } from "../../async/asyncWorkInbox.js";

export type SubagentStatus = "running" | "completed" | "error" | "interrupted";

interface SubTask {
  status: SubagentStatus;
  result: string | null;
  prompt: string;
  /** The live child agent instance — its messages are the subagent's conversation. */
  agent: Agent;
  run: AgentRun;
  taskId?: string | undefined;
}

export interface SubagentRecord {
  id: string;
  sessionId?: string | undefined;
  status: SubagentStatus;
  promptSummary: string;
  resultSummary?: string | undefined;
  taskId?: string | undefined;
  runId?: string | undefined;
  parentRunId?: string | undefined;
  parentToolCallId?: string | undefined;
  messageCount?: number | undefined;
  startedAt?: string | undefined;
  finishedAt?: string | undefined;
}

export type SubAgentRunOptions = {
  name?: string | undefined;
  role?: string | undefined;
  maxTurns?: number | undefined;
  timeoutMs?: number | undefined;
  taskId?: string | undefined;
  checkPermission?: CheckPermissionFn | undefined;
  allowedTools?: readonly string[] | undefined;
  sessionId?: string | undefined;
  parentRunId?: string | undefined;
  parentToolCallId?: string | undefined;
};

const DEFAULT_MAX_CONCURRENT = 3;

export class SubAgentRunner {
  private subs = new Map<string, SubTask>();

  constructor(
    private readonly maxConcurrent: number = DEFAULT_MAX_CONCURRENT,
    private readonly agentRuntime = new AgentRuntime(),
    private readonly inbox: AsyncWorkInbox = new AsyncWorkInbox(),
  ) {}

  run(parent: Agent, prompt: string, options: SubAgentRunOptions = {}): string {
    if (this.runningCount() >= this.maxConcurrent) {
      return `Error: too many running subagents (max ${this.maxConcurrent}). Wait for one to finish.`;
    }

    const subId = crypto.randomUUID().slice(0, 8);

    const forkOptions: SubAgentOptions = {};
    if (options.name) forkOptions.name = options.name;
    if (options.role) forkOptions.role = options.role;
    if (options.maxTurns !== undefined) forkOptions.maxTurns = options.maxTurns;
    if (options.timeoutMs !== undefined) forkOptions.timeoutMs = options.timeoutMs;
    if (options.checkPermission) forkOptions.checkPermission = options.checkPermission;
    if (options.allowedTools) forkOptions.allowedTools = options.allowedTools;

    const child = forkSubAgent(parent, subId, prompt, forkOptions);
    const run = createAgentRun({
      ...(options.sessionId !== undefined ? { sessionId: options.sessionId } : {}),
      agentId: child.id ?? subId,
      agentKind: "subagent",
      trigger: {
        type: "subagent",
        parentAgentId: parent.id ?? "lead",
        ...(options.parentRunId !== undefined ? { parentRunId: options.parentRunId } : {}),
        ...(options.parentToolCallId !== undefined
          ? { parentToolCallId: options.parentToolCallId }
          : {}),
      },
    });

    const entry: SubTask = { status: "running", result: null, prompt, agent: child, run };
    if (options.taskId) entry.taskId = options.taskId;
    this.subs.set(subId, entry);
    this.inbox.register({
      id: subId,
      kind: "subagent",
      status: "running",
      result: "",
      record: this.recordFor(subId, entry),
      ...(entry.taskId !== undefined ? { taskId: entry.taskId } : {}),
    });

    // No identity wrapper needed: AgentRuntime binds `currentAgent` via agentLoop,
    // and child.id === subId, so per-agent hook state keys correctly.
    void this.agentRuntime
      .run(child, run)
      .then(({ run: completedRun }) =>
        this.settle(subId, "completed", completedRun.resultSummary ?? ""),
      )
      .catch((error) =>
        this.settle(
          subId,
          "error",
          `Error: ${error instanceof Error ? error.message : String(error)}`,
        ),
      );

    return `Subagent ${subId} started: ${prompt.slice(0, 80)}`;
  }

  hasRunning(): boolean {
    return this.runningCount() > 0;
  }

  interruptRunning(reason = "Interrupted by session close"): SubagentRecord[] {
    const records: SubagentRecord[] = [];
    for (const [subId, task] of this.subs) {
      if (task.status !== "running") continue;
      interruptAgentRun(task.run, reason);
      task.status = "interrupted";
      task.result = reason;
      const record = this.recordFor(subId, task);
      records.push(record);
      this.inbox.settle({
        id: subId,
        kind: "subagent",
        status: "interrupted",
        result: reason,
        record,
        ...(task.taskId !== undefined ? { taskId: task.taskId } : {}),
      });
    }
    return records;
  }

  private runningCount(): number {
    let n = 0;
    for (const t of this.subs.values()) if (t.status === "running") n += 1;
    return n;
  }

  private settle(subId: string, status: SubagentStatus, result: string): void {
    const t = this.subs.get(subId);
    if (!t) return;
    if (t.status !== "running") return;
    t.status = status;
    t.result = result;
    this.inbox.settle({
      id: subId,
      kind: "subagent",
      status,
      result: result || "(no output)",
      record: this.recordFor(subId, t),
      ...(t.taskId !== undefined ? { taskId: t.taskId } : {}),
    });
  }

  private recordFor(subId: string, task: SubTask): SubagentRecord {
    const record: SubagentRecord = {
      id: subId,
      status: task.status,
      promptSummary: task.prompt.slice(0, 80),
      runId: task.run.id,
    };
    if (task.run.sessionId !== undefined) record.sessionId = task.run.sessionId;
    if (task.result !== null) record.resultSummary = task.result;
    if (task.taskId !== undefined) record.taskId = task.taskId;
    if (task.run.trigger.type === "subagent") {
      if (task.run.trigger.parentRunId !== undefined) {
        record.parentRunId = task.run.trigger.parentRunId;
      }
      if (task.run.trigger.parentToolCallId !== undefined) {
        record.parentToolCallId = task.run.trigger.parentToolCallId;
      }
    }
    if (task.run.messageCount !== undefined) record.messageCount = task.run.messageCount;
    record.startedAt = task.run.startedAt ?? task.run.createdAt;
    if (task.run.finishedAt !== undefined) record.finishedAt = task.run.finishedAt;
    return record;
  }
}
