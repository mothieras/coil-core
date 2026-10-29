import fs from "node:fs/promises";
import path from "node:path";
import type { Message } from "@earendil-works/pi-ai";
import { sessionPath, sessionStatePath } from "../../state/paths.js";
import type {
  ConversationMessage,
  SessionEvent,
  SessionRecord,
  SessionSnapshot,
} from "../types.js";
import { createEmptySessionSnapshot } from "../projection/projection.js";
import { importLegacyAnthropicMessages } from "./legacyMessages.js";

export type SessionListItem = {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
};

export class SessionStore {
  private tmpCounter = 0;

  constructor(private readonly workspaceRoot: string) {}

  async create(record: SessionRecord): Promise<void> {
    await this.ensureSessionDir(record.id);
    await this.writeJson(this.sessionRecordPath(record.id), record);
  }

  async appendEvents(sessionId: string, events: readonly SessionEvent[]): Promise<void> {
    if (events.length === 0) return;
    await this.ensureSessionDir(sessionId);
    const body = events.map((event) => JSON.stringify(event)).join("\n") + "\n";
    await fs.appendFile(this.eventsPath(sessionId), body, "utf8");
  }

  async saveConversation(
    sessionId: string,
    messages: readonly ConversationMessage[],
  ): Promise<void> {
    await this.ensureSessionDir(sessionId);
    await this.writeJson(this.conversationPath(sessionId), messages);
  }

  async saveLeadMessages(sessionId: string, messages: readonly Message[]): Promise<void> {
    await this.ensureSessionDir(sessionId);
    await this.writeJson(this.leadMessagesPath(sessionId), messages);
  }

  async saveSnapshot(sessionId: string, snapshot: SessionSnapshot): Promise<void> {
    await this.ensureSessionDir(sessionId);
    await this.writeJson(this.snapshotPath(sessionId), snapshot);
  }

  async writeReport(sessionId: string, fileName: string, content: string): Promise<string> {
    await this.ensureSessionDir(sessionId);
    const reportPath = path.join(this.pathForSession(sessionId), fileName);
    await fs.writeFile(reportPath, content, "utf8");
    return reportPath;
  }

  async loadSession(sessionId: string): Promise<SessionRecord> {
    const data = await fs.readFile(this.sessionRecordPath(sessionId), "utf8");
    return JSON.parse(data) as SessionRecord;
  }

  async listSessions(): Promise<SessionListItem[]> {
    const dir = sessionStatePath(this.workspaceRoot);
    let entries: import("node:fs").Dirent[];
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return [];
    }
    const items: SessionListItem[] = [];
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      try {
        const record = await this.loadSession(entry.name);
        items.push({
          id: record.id,
          title: record.title,
          createdAt: record.createdAt,
          updatedAt: record.updatedAt,
        });
      } catch {
        // skip dirs without a readable session.json
      }
    }
    return items.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  async loadLeadAgentMessages(sessionId: string): Promise<Message[]> {
    const data = await fs.readFile(this.leadMessagesPath(sessionId), "utf8");
    return importLegacyAnthropicMessages(JSON.parse(data));
  }

  async loadSnapshot(sessionId: string): Promise<SessionSnapshot> {
    const data = await fs.readFile(this.snapshotPath(sessionId), "utf8");
    return normalizeSnapshot(JSON.parse(data));
  }

  pathForSession(sessionId: string): string {
    return sessionPath(this.workspaceRoot, sessionId);
  }

  sessionTasksPath(sessionId: string): string {
    return path.join(this.pathForSession(sessionId), "tasks");
  }

  private async ensureSessionDir(sessionId: string): Promise<void> {
    await fs.mkdir(sessionPath(this.workspaceRoot, sessionId), { recursive: true });
  }

  private sessionRecordPath(sessionId: string): string {
    return path.join(this.pathForSession(sessionId), "session.json");
  }

  private eventsPath(sessionId: string): string {
    return path.join(this.pathForSession(sessionId), "events.jsonl");
  }

  private conversationPath(sessionId: string): string {
    return path.join(this.pathForSession(sessionId), "conversation.json");
  }

  private leadMessagesPath(sessionId: string): string {
    return path.join(this.pathForSession(sessionId), "lead-messages.json");
  }

  private snapshotPath(sessionId: string): string {
    return path.join(this.pathForSession(sessionId), "snapshot.json");
  }

  private async writeJson(filePath: string, value: unknown): Promise<void> {
    // Write to a unique temp file then rename: rename is atomic on the same
    // filesystem, so a crash mid-write (or an overlapping write to the same
    // file) can never leave a truncated JSON that breaks resume.
    const tmpPath = `${filePath}.${process.pid}.${this.tmpCounter++}.tmp`;
    await fs.writeFile(tmpPath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
    await fs.rename(tmpPath, filePath);
  }
}

function normalizeSnapshot(value: unknown): SessionSnapshot {
  const snapshot = value as Partial<SessionSnapshot>;
  return {
    ...createEmptySessionSnapshot(),
    ...snapshot,
    mcpServers: Array.isArray(snapshot.mcpServers) ? snapshot.mcpServers : [],
  };
}

export { sessionPath, sessionStatePath };
