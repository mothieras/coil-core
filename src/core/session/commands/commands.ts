import crypto from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { getClient, getModel } from "../../config/index.js";
import type { Agent } from "../../agent/agent.js";
import {
  createRuntimeLifecycleEvent,
  type CompactFinishedEvent,
  type CompactStartedEvent,
  type RuntimeLifecycleEvent,
} from "../../agent/lifecycle.js";
import { forceCompactWithResult } from "../../context/compact.js";
import type { SessionCommandResult, SessionCompactResult } from "./actions.js";
import type { SessionProjectionStore } from "../projection/projectionStore.js";
import { buildSessionReport } from "../report.js";
import { reportWrittenEvent } from "../sessionEvents.js";
import type { SessionStore } from "../store/sessionStore.js";
import type { ReportProjection } from "../types.js";

type SessionCommandsDeps = {
  sessionId: string;
  leadAgent: Agent;
  store: SessionProjectionStore;
  sessionStore: SessionStore;
  workspaceRoot: string;
  isBusy: () => boolean;
  emit: (event: RuntimeLifecycleEvent) => void;
};

export class SessionCommands {
  private readonly sessionId: string;
  private readonly leadAgent: Agent;
  private readonly store: SessionProjectionStore;
  private readonly sessionStore: SessionStore;
  private readonly workspaceRoot: string;
  private readonly isBusy: () => boolean;
  private readonly emit: (event: RuntimeLifecycleEvent) => void;

  constructor(deps: SessionCommandsDeps) {
    this.sessionId = deps.sessionId;
    this.leadAgent = deps.leadAgent;
    this.store = deps.store;
    this.sessionStore = deps.sessionStore;
    this.workspaceRoot = deps.workspaceRoot;
    this.isBusy = deps.isBusy;
    this.emit = deps.emit;
  }

  async handle(command: string): Promise<SessionCommandResult> {
    const trimmed = command.slice(1).trim();
    const [name = ""] = trimmed.split(/\s+/, 1);
    const args = trimmed.slice(name.length).trim();
    switch (name) {
      case "exit":
        return {
          action: "exit",
          title: "Exiting",
          body: "Saving session state.",
        };
      case "help":
        return {
          action: "notice",
          title: "Help",
          body: "/help /status /tasks /subagents /ping /compact /report /exit",
        };
      case "status":
        return {
          action: "notice",
          title: "Status",
          body: this.statusSummary(),
          focus: "status",
        };
      case "tasks":
        return {
          action: "notice",
          title: "Tasks",
          body: this.taskSummary(),
          focus: "tasks",
        };
      case "subagents":
        return {
          action: "notice",
          title: "Subagents",
          body: this.subagentSummary(),
          focus: "subagents",
        };
      case "compact":
        return this.compact("manual slash command");
      case "ping":
        return this.ping();
      case "report": {
        const report = await this.writeReport({ title: "Session report" });
        return {
          action: "report",
          report,
          message: `Report written: ${report.path}`,
        };
      }
      default: {
        const template = await this.loadCommandTemplate(name);
        if (template !== null) {
          return { action: "message", text: interpolateTemplate(template, args) };
        }
        return {
          action: "notice",
          title: "Unknown command",
          body: `No command named /${name}. Try /help.`,
        };
      }
    }
  }

  /** Custom commands are markdown templates at .coil/commands/<name>.md. */
  private async loadCommandTemplate(name: string): Promise<string | null> {
    if (!/^[a-z0-9][a-z0-9-]*$/.test(name)) return null;
    const file = path.join(this.workspaceRoot, ".coil", "commands", `${name}.md`);
    try {
      return await readFile(file, "utf8");
    } catch {
      return null;
    }
  }

  async compact(reason = "manual slash command"): Promise<SessionCompactResult> {
    // Compaction splices leadAgent.messages in place; doing that while a turn is
    // iterating/appending to the same array can orphan tool_use/tool_result
    // pairs. Refuse rather than corrupt the conversation.
    if (this.isBusy()) {
      return {
        action: "compact",
        compacted: false,
        message: "Cannot compact while a turn is running.",
      };
    }
    const beforeMessageCount = this.leadAgent.messages.length;
    const compactId = crypto.randomUUID();
    this.emit(
      createRuntimeLifecycleEvent<CompactStartedEvent>({
        type: "compact_started",
        runId: "session-action",
        sessionId: this.sessionId,
        agentId: this.leadAgent.id ?? "lead",
        agentKind: "lead",
        compactId,
        reason,
        strategy: "manual",
        beforeMessageCount,
      }),
    );

    try {
      const compactResult = await forceCompactWithResult(
        this.leadAgent.messages,
        this.workspaceRoot,
        reason,
      );
      const compacted = compactResult.compacted;
      this.emit(
        createRuntimeLifecycleEvent<CompactFinishedEvent>({
          type: "compact_finished",
          runId: "session-action",
          sessionId: this.sessionId,
          agentId: this.leadAgent.id ?? "lead",
          agentKind: "lead",
          compactId,
          reason,
          strategy: "manual",
          status: compacted ? "completed" : "skipped",
          beforeMessageCount,
          afterMessageCount: this.leadAgent.messages.length,
          ...(compactResult.transcriptPath !== undefined
            ? { transcriptPath: compactResult.transcriptPath }
            : {}),
        }),
      );
      return {
        action: "compact",
        compacted,
        message: compacted ? "Context compacted." : "Nothing to compact.",
      };
    } catch (error) {
      this.emit(
        createRuntimeLifecycleEvent<CompactFinishedEvent>({
          type: "compact_finished",
          runId: "session-action",
          sessionId: this.sessionId,
          agentId: this.leadAgent.id ?? "lead",
          agentKind: "lead",
          compactId,
          reason,
          strategy: "manual",
          status: "failed",
          beforeMessageCount,
          afterMessageCount: this.leadAgent.messages.length,
          error: error instanceof Error ? error.message : String(error),
        }),
      );
      throw error;
    }
  }

  async ping(): Promise<SessionCommandResult> {
    try {
      const start = Date.now();
      const response = await getClient().messages.create({
        model: getModel()!,
        max_tokens: 1,
        messages: [{ role: "user", content: "ping" }],
      });
      const elapsed = Date.now() - start;
      const usage = response.usage
        ? `in=${response.usage.input_tokens ?? 0} out=${response.usage.output_tokens ?? 0}`
        : "no usage";
      return {
        action: "notice",
        title: "Ping OK",
        body: `${elapsed}ms model=${getModel()} ${usage}`,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return {
        action: "notice",
        title: "Ping Failed",
        body: `model=${getModel()} error=${message}`,
      };
    }
  }

  recordReportWritten(options: {
    id?: string | undefined;
    title: string;
    path: string;
    createdAt?: string | undefined;
  }): ReportProjection {
    const createdAt = options.createdAt ?? new Date().toISOString();
    const report: ReportProjection = {
      id: options.id ?? crypto.randomUUID(),
      sessionId: this.sessionId,
      title: options.title,
      path: options.path,
      createdAt,
    };
    this.store.record(reportWrittenEvent(this.sessionId, report));
    return report;
  }

  async writeReport(options: { title?: string | undefined } = {}): Promise<ReportProjection> {
    const createdAt = new Date().toISOString();
    const title = options.title ?? "Session report";
    const content = buildSessionReport(this.store.getSnapshot(), { title, createdAt });
    const reportPath = await this.sessionStore.writeReport(this.sessionId, "report.md", content);
    return this.recordReportWritten({ title, path: reportPath, createdAt });
  }

  private statusSummary(): string {
    const snapshot = this.store.getSnapshot();
    return [
      `session=${snapshot.session?.id ?? "none"}`,
      `status=${snapshot.session?.status ?? "none"}`,
      `messages=${snapshot.conversationMessages.length}`,
      `tools=${snapshot.toolCalls.length}`,
      `tasks=${snapshot.tasks.length}`,
      `background=${snapshot.backgroundCommands.length}`,
      `subagents=${snapshot.subagents.length}`,
    ].join(" ");
  }

  private taskSummary(): string {
    const snapshot = this.store.getSnapshot();
    if (snapshot.tasks.length === 0) return "No tasks in this session.";
    return snapshot.tasks.map((task) => `${task.status}: ${task.title}`).join(" | ");
  }

  private subagentSummary(): string {
    const snapshot = this.store.getSnapshot();
    if (snapshot.subagents.length === 0) return "No subagents in this session.";
    return snapshot.subagents
      .map((subagent) => `${subagent.status}: ${subagent.promptSummary}`)
      .join(" | ");
  }
}

function interpolateTemplate(template: string, args: string): string {
  const body = template.replace(/^---\n[\s\S]*?\n---\n/, "");
  return body.replaceAll("$@", args).trim();
}
