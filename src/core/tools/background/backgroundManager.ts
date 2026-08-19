import { exec } from "node:child_process";
import crypto from "node:crypto";
import { isDangerousCommand } from "../file/shellSafety.js";
import { AsyncWorkInbox } from "../../async/asyncWorkInbox.js";

export type BackgroundStatus = "running" | "completed" | "timeout" | "error" | "interrupted";

export interface BackgroundCommandRecord {
  id: string;
  status: BackgroundStatus;
  commandSummary: string;
  resultSummary?: string | undefined;
  startedAt: string;
  finishedAt?: string | undefined;
}

interface BgTask {
  status: BackgroundStatus;
  result: string | null;
  command: string;
  startedAt: string;
  finishedAt?: string | undefined;
}

export class BackgroundManager {
  private tasks = new Map<string, BgTask>();

  constructor(
    private readonly workspaceRoot: string,
    private readonly inbox: AsyncWorkInbox = new AsyncWorkInbox(),
  ) {}

  run(command: string): string {
    if (isDangerousCommand(command)) {
      return "Error: Dangerous command blocked";
    }
    const taskId = crypto.randomUUID().slice(0, 8);
    this.tasks.set(taskId, {
      status: "running",
      result: null,
      command,
      startedAt: new Date().toISOString(),
    });
    this.inbox.register({
      id: taskId,
      kind: "background",
      status: "running",
      result: "",
      record: this.toRecord(taskId, this.tasks.get(taskId)!),
    });

    exec(command, { cwd: this.workspaceRoot, timeout: 300_000 }, (error, stdout, stderr) => {
      const task = this.tasks.get(taskId);
      if (!task || task.status !== "running") return;
      const output = (stdout + stderr).trim() || "(no output)";

      if (error) {
        if (error.killed && error.signal === "SIGTERM") {
          task.status = "timeout";
          task.result = "Error: Timeout (300s)";
        } else {
          task.status = "error";
          task.result = `Error: ${error.message}`;
        }
      } else {
        task.status = "completed";
        task.result = output;
      }
      task.finishedAt = new Date().toISOString();

      this.inbox.settle({
        id: taskId,
        kind: "background",
        status: task.status,
        result: (task.result || "(no output)").slice(0, 500),
        record: this.toRecord(taskId, task),
      });
    });

    return `Background task ${taskId} started: ${command.slice(0, 80)}`;
  }

  hasRunning(): boolean {
    for (const t of this.tasks.values()) {
      if (t.status === "running") return true;
    }
    return false;
  }

  interruptRunning(): BackgroundCommandRecord[] {
    const interrupted: BackgroundCommandRecord[] = [];
    for (const [taskId, task] of this.tasks) {
      if (task.status !== "running") continue;
      task.status = "interrupted";
      task.result = "Interrupted: session closed";
      task.finishedAt = new Date().toISOString();
      const record = this.toRecord(taskId, task);
      interrupted.push(record);
      this.inbox.settle({
        id: taskId,
        kind: "background",
        status: "interrupted",
        result: task.result ?? "Interrupted: session closed",
        record,
      });
    }
    return interrupted;
  }

  private toRecord(taskId: string, task: BgTask): BackgroundCommandRecord {
    const record: BackgroundCommandRecord = {
      id: taskId,
      status: task.status,
      commandSummary: task.command.slice(0, 80),
      startedAt: task.startedAt,
    };
    if (task.result !== null) {
      record.resultSummary = task.result.slice(0, 500);
    }
    if (task.finishedAt !== undefined) {
      record.finishedAt = task.finishedAt;
    }
    return record;
  }
}
