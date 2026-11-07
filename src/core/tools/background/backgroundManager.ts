import crypto from "node:crypto";
import { ToolExecutionError } from "../errors.js";
import { isDangerousCommand } from "../file/shellSafety.js";
import { startManagedProcess, type ManagedProcess } from "../file/process.js";
import { ExecutionStoppedError, throwIfAborted } from "../../loop/cancellation.js";
import { AsyncWorkInbox } from "../../async/asyncWorkInbox.js";
import type { ToolInvocationContext } from "../input.js";
import type { RunCleanupResult } from "../../agent/run.js";

export type BackgroundStatus = "running" | "completed" | "timeout" | "error" | "interrupted";
export interface BackgroundCommandRecord {
  id: string;
  status: BackgroundStatus;
  commandSummary: string;
  resultSummary?: string | undefined;
  startedAt: string;
  finishedAt?: string | undefined;
  runId?: string | undefined;
  sessionId?: string | undefined;
  parentToolCallId?: string | undefined;
}
interface BgTask {
  record: BackgroundCommandRecord;
  process: ManagedProcess;
  done: Promise<void>;
  active: boolean;
}
type OwnedWork = { done: Promise<unknown>; stop(deadlineAt: number): Promise<RunCleanupResult> };

export class BackgroundManager {
  private readonly tasks = new Map<string, BgTask>();
  constructor(
    private readonly workspaceRoot: string,
    private readonly inbox: AsyncWorkInbox = new AsyncWorkInbox(),
    private readonly ownWork?: (runId: string, work: OwnedWork) => void,
  ) {}

  run(command: string, context?: ToolInvocationContext): string {
    throwIfAborted(context?.signal);
    if (isDangerousCommand(command))
      throw new ToolExecutionError("Dangerous command blocked", { status: "blocked" });
    const id = crypto.randomUUID().slice(0, 8);
    const record: BackgroundCommandRecord = {
      id,
      status: "running",
      commandSummary: command.slice(0, 80),
      startedAt: new Date().toISOString(),
      runId: context?.runId,
      sessionId: context?.sessionId,
      parentToolCallId: context?.toolCallId,
    };
    // Explicit async work survives normal parent completion; only its owner stops it.
    const process = startManagedProcess(command, this.workspaceRoot, { timeoutMs: 300_000 });
    const task: BgTask = { record, process, done: Promise.resolve(), active: true };
    this.tasks.set(id, task);
    this.inbox.register({
      id,
      kind: "background",
      status: "running",
      result: "",
      record: { ...record },
      ownerRunId: record.runId,
    });
    task.done = process.done
      .then(
        (result) => {
          record.status = result.code === 0 ? "completed" : "error";
          record.resultSummary = result.output.slice(0, 500);
        },
        (error: unknown) => {
          record.status =
            error instanceof ExecutionStoppedError
              ? error.reason === "timeout"
                ? "timeout"
                : "interrupted"
              : "error";
          record.resultSummary = String(error);
        },
      )
      .then(() => {
        task.active = false;
        record.finishedAt = new Date().toISOString();
        this.inbox.settle({
          id,
          kind: "background",
          status: record.status,
          result: record.resultSummary ?? "",
          record: { ...record },
          ownerRunId: record.runId,
        });
      });
    if (context?.runId)
      this.ownWork?.(context.runId, {
        done: task.done,
        stop: (deadline) => this.stopTask(task, deadline),
      });
    return `Background task ${id} started: ${command.slice(0, 80)}`;
  }

  hasRunning(): boolean {
    return [...this.tasks.values()].some((task) => task.active);
  }

  async cancelAll(deadlineAt = Date.now() + 5_000): Promise<RunCleanupResult[]> {
    return Promise.all(
      [...this.tasks.values()]
        .filter((task) => task.active)
        .map((task) => this.stopTask(task, deadlineAt)),
    );
  }

  private async stopTask(task: BgTask, deadlineAt: number): Promise<RunCleanupResult> {
    this.inbox.suppress("background", task.record.id);
    return task.process.stop(deadlineAt);
  }
}
