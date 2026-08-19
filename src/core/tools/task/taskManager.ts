import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";

export interface TaskRecord {
  id: number;
  subject: string;
  description: string;
  status: "pending" | "in_progress" | "completed";
  blockedBy: number[];
  owner: string;
}

export type TaskManagerOptions = {
  onTaskChanged?: ((task: TaskRecord) => void) | undefined;
};

export type TaskItemInput = {
  id?: number | undefined;
  subject?: string | undefined;
  status?: string | undefined;
  description?: string | undefined;
};

export class TaskManager {
  private readonly dir: string;
  private nextId: number;

  constructor(
    tasksDir: string,
    private readonly options: TaskManagerOptions = {},
  ) {
    this.dir = tasksDir;
    if (!existsSync(this.dir)) {
      mkdirSync(this.dir, { recursive: true });
      this.nextId = 1;
      return;
    }
    let maxId = 0;
    for (const f of readdirSync(this.dir)) {
      const match = f.match(/^task_(\d+)\.json$/);
      if (match) maxId = Math.max(maxId, parseInt(match[1]!, 10));
    }
    this.nextId = maxId + 1;
  }

  private load(taskId: number): TaskRecord {
    const filePath = path.join(this.dir, `task_${taskId}.json`);
    if (!existsSync(filePath)) {
      throw new Error(`Task ${taskId} not found`);
    }
    return JSON.parse(readFileSync(filePath, "utf8")) as TaskRecord;
  }

  private save(task: TaskRecord): void {
    const filePath = path.join(this.dir, `task_${task.id}.json`);
    writeFileSync(filePath, JSON.stringify(task, null, 2) + "\n", "utf8");
  }

  create(subject: string, description = ""): string {
    const task: TaskRecord = {
      id: this.nextId,
      subject,
      description,
      status: "pending",
      blockedBy: [],
      owner: "",
    };
    this.save(task);
    this.options.onTaskChanged?.(task);
    this.nextId += 1;
    return JSON.stringify(task, null, 2);
  }

  get(taskId: number): string {
    return JSON.stringify(this.load(taskId), null, 2);
  }

  update(taskId: number, status?: string, subject?: string, description?: string): string {
    const task = this.load(taskId);

    if (status) {
      if (!["pending", "in_progress", "completed"].includes(status)) {
        throw new Error(`Invalid status: ${status}`);
      }
      task.status = status as TaskRecord["status"];
      if (status === "completed") {
        this.clearDependency(taskId);
      }
    }

    if (subject !== undefined && subject.trim() !== "") {
      task.subject = subject;
    }
    if (description !== undefined) {
      task.description = description;
    }

    this.save(task);
    this.options.onTaskChanged?.(task);
    return JSON.stringify(task, null, 2);
  }

  /**
   * Whole-list apply: items without id are created, items with id are
   * updated. Returns the resulting list so the model always sees the
   * current state after a call.
   */
  applyMany(items: TaskItemInput[]): string {
    for (const item of items) {
      if (item.id === undefined) {
        if (!item.subject || item.subject.trim() === "") {
          throw new Error("Each new task needs a non-empty 'subject'");
        }
        const created = JSON.parse(this.create(item.subject, item.description ?? "")) as TaskRecord;
        if (item.status && item.status !== "pending") {
          this.update(created.id, item.status);
        }
      } else {
        this.update(item.id, item.status, item.subject, item.description);
      }
    }
    return this.listAll();
  }

  private clearDependency(completedId: number): void {
    let entries: string[];
    try {
      entries = readdirSync(this.dir);
    } catch {
      return;
    }
    for (const f of entries) {
      if (!f.startsWith("task_") || !f.endsWith(".json")) continue;
      const filePath = path.join(this.dir, f);
      const task = JSON.parse(readFileSync(filePath, "utf8")) as TaskRecord;
      if (task.blockedBy.includes(completedId)) {
        task.blockedBy = task.blockedBy.filter((id) => id !== completedId);
        this.save(task);
      }
    }
  }

  hasActive(): boolean {
    let entries: string[];
    try {
      entries = readdirSync(this.dir);
    } catch {
      return false;
    }
    for (const f of entries) {
      if (!f.startsWith("task_") || !f.endsWith(".json")) continue;
      const task = JSON.parse(readFileSync(path.join(this.dir, f), "utf8")) as TaskRecord;
      if (task.status === "pending" || task.status === "in_progress") {
        return true;
      }
    }
    return false;
  }

  listAll(): string {
    const tasks: TaskRecord[] = [];
    let entries: string[];
    try {
      entries = readdirSync(this.dir);
    } catch {
      return "No tasks.";
    }

    const files = entries
      .filter((f) => /^task_\d+\.json$/.test(f))
      .sort((a, b) => {
        const idA = parseInt(a.match(/task_(\d+)\.json$/)![1]!, 10);
        const idB = parseInt(b.match(/task_(\d+)\.json$/)![1]!, 10);
        return idA - idB;
      });

    for (const f of files) {
      tasks.push(JSON.parse(readFileSync(path.join(this.dir, f), "utf8")) as TaskRecord);
    }

    if (tasks.length === 0) return "No tasks.";

    const marker: Record<string, string> = {
      pending: "[ ]",
      in_progress: "[>]",
      completed: "[x]",
    };

    const lines = tasks.map((t) => {
      const m = marker[t.status] ?? "[?]";
      const blocked = t.blockedBy.length > 0 ? ` (blocked by: ${t.blockedBy.join(", ")})` : "";
      return `${m} #${t.id}: ${t.subject}${blocked}`;
    });

    const done = tasks.filter((t) => t.status === "completed").length;
    lines.push(`\n(${done}/${tasks.length} completed)`);
    return lines.join("\n");
  }

  clearIfAllCompleted(): boolean {
    let entries: string[];
    try {
      entries = readdirSync(this.dir);
    } catch {
      return false;
    }
    const taskFiles = entries.filter((f) => f.startsWith("task_") && f.endsWith(".json"));
    if (taskFiles.length === 0) return false;

    let allDone = true;
    for (const f of taskFiles) {
      const task = JSON.parse(readFileSync(path.join(this.dir, f), "utf8")) as TaskRecord;
      if (task.status !== "completed") {
        allDone = false;
        break;
      }
    }
    if (!allDone) return false;

    for (const f of taskFiles) {
      rmSync(path.join(this.dir, f));
    }
    return true;
  }
}
