import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import type { Message } from "@earendil-works/pi-ai";
import type { SessionEvent } from "../types.js";
import type { AsyncWorkResultState } from "../../async/asyncWorkInbox.js";
import { writeAtomic } from "./atomicFile.js";

type ContextRef = { slot: 0 | 1; digest: string };
type JournalHeader = { type: "session_journal"; version: 1; sessionId: string; legacy: boolean };
type Checkpoint = {
  type: "checkpoint";
  sequence: number;
  eventsDigest: string;
  context: ContextRef;
  awaitingModel: boolean;
  digest: string;
};

type JournalRecovery = {
  events: SessionEvent[];
  messages: Message[];
  awaitingModel: boolean;
  asyncResults: AsyncWorkResultState[];
};

const JOURNAL = "events.jsonl";
const HEADER_TYPE = "session_journal";
const LEGACY_FILES = [
  "session.json",
  "conversation.json",
  "lead-messages.json",
  "snapshot.json",
  JOURNAL,
];

export class SessionJournal {
  private readonly file: string;
  private offset = 0;
  private last?: Checkpoint;
  private legacy = false;
  private truncatedPrefix: Buffer | undefined;
  discardedBytes = 0;

  constructor(
    private readonly directory: string,
    private readonly sessionId: string,
  ) {
    this.file = path.join(directory, JOURNAL);
  }

  async load(): Promise<JournalRecovery | undefined> {
    const bytes = await readIfPresent(this.file);
    const headerEnd = bytes?.indexOf(10) ?? -1;
    const first = bytes && headerEnd >= 0 ? parseLine(bytes.subarray(0, headerEnd)) : null;
    if (!bytes || first?.type !== HEADER_TYPE) {
      if (
        (await readIfPresent(this.contextPath(0))) ||
        (await readIfPresent(this.contextPath(1)))
      ) {
        throw this.corrupt("journal header missing");
      }
      this.legacy = true;
      return undefined;
    }
    const header = first as Partial<JournalHeader>;
    if (
      header.version !== 1 ||
      header.sessionId !== this.sessionId ||
      typeof header.legacy !== "boolean"
    ) {
      throw this.corrupt("unsupported or invalid journal header");
    }

    this.offset = headerEnd + 1;
    const events: SessionEvent[] = [];
    let batch: SessionEvent[] = [];
    let start = this.offset;
    // A complete line outside a confirmed batch is still checked for framing.
    for (let end = bytes.indexOf(10, start); end >= 0; end = bytes.indexOf(10, start)) {
      const record = parseLine(bytes.subarray(start, end));
      if (record?.type === "checkpoint") {
        const digest = hash(bytes.subarray(this.offset, start));
        const checkpoint = this.parseCheckpoint(record, digest);
        for (const event of batch) events.push(event);
        batch = [];
        this.last = checkpoint;
        this.offset = end + 1;
      } else {
        if (
          typeof record?.type !== "string" ||
          typeof record.id !== "string" ||
          typeof record.timestamp !== "string" ||
          record.sessionId !== this.sessionId
        ) {
          throw this.corrupt(`invalid event at byte ${start}`);
        }
        batch.push(record as unknown as SessionEvent);
      }
      start = end + 1;
    }
    this.discardedBytes = bytes.length - this.offset;
    if (this.discardedBytes > 0) this.truncatedPrefix = bytes.subarray(0, this.offset);

    if (!this.last) {
      // An upgrade can be interrupted after installing the header and before
      // its first checkpoint. The original legacy caches are still intact.
      if (header.legacy) return undefined;
      throw this.corrupt("no complete checkpoint");
    }

    const body = await readIfPresent(this.contextPath(this.last.context.slot));
    if (!body || hash(body) !== this.last.context.digest) {
      throw this.corrupt("checkpoint context is missing or damaged");
    }
    let messages: unknown;
    try {
      messages = JSON.parse(body.toString("utf8"));
    } catch {
      throw this.corrupt("invalid checkpoint context");
    }
    // Earlier version-1 contexts contain only the pi-ai message array.
    let asyncResults: AsyncWorkResultState[] = [];
    if (!Array.isArray(messages)) {
      const context = messages as {
        version?: unknown;
        messages?: unknown;
        asyncResults?: unknown;
      } | null;
      if (
        context?.version !== 1 ||
        !Array.isArray(context.messages) ||
        !validAsyncResults(context.asyncResults)
      )
        throw this.corrupt("invalid checkpoint context");
      asyncResults = context.asyncResults;
      messages = context.messages;
    }
    return {
      events,
      messages: messages as Message[],
      awaitingModel: this.last.awaitingModel,
      asyncResults,
    };
  }

  async commit(
    events: readonly SessionEvent[],
    messages: readonly Message[],
    awaitingModel: boolean,
    asyncResults: readonly AsyncWorkResultState[] = [],
  ): Promise<void> {
    if (this.offset === 0) await this.initialize();
    if (this.truncatedPrefix) {
      await fs.link(this.file, `${this.file}.partial-${randomUUID()}`);
      await writeAtomic(this.file, this.truncatedPrefix);
      this.truncatedPrefix = undefined;
    }

    const body = JSON.stringify(
      asyncResults.length ? { version: 1, messages, asyncResults } : messages,
    );
    const digest = hash(body);
    const previous = this.last;
    if (
      events.length === 0 &&
      previous?.context.digest === digest &&
      previous.awaitingModel === awaitingModel
    )
      return;
    const context =
      previous?.context.digest === digest
        ? previous.context
        : { slot: previous?.context.slot === 0 ? (1 as const) : (0 as const), digest };
    if (context !== previous?.context) await writeAtomic(this.contextPath(context.slot), body);

    const rows = events.map((event) => `${JSON.stringify(event)}\n`).join("");
    const checkpointData = {
      type: "checkpoint",
      sequence: (previous?.sequence ?? 0) + 1,
      eventsDigest: hash(rows),
      context,
      awaitingModel,
    } as const;
    const checkpoint: Checkpoint = { ...checkpointData, digest: checkpointDigest(checkpointData) };
    const encoded = Buffer.from(`${rows}${JSON.stringify(checkpoint)}\n`);
    await this.appendMissing(encoded);
    this.offset += encoded.length;
    this.last = checkpoint;
  }

  private async initialize(): Promise<void> {
    await fs.mkdir(this.directory, { recursive: true });
    if (this.legacy) {
      const archive = path.join(this.directory, `legacy-${randomUUID()}`);
      await fs.mkdir(archive, { mode: 0o700 });
      for (const file of LEGACY_FILES) {
        try {
          await fs.link(path.join(this.directory, file), path.join(archive, file));
        } catch (error) {
          if (!isMissing(error)) throw error;
        }
      }
    } else if (await readIfPresent(this.file)) {
      throw new Error(`Session ${this.sessionId} already has an event log`);
    }
    const header: JournalHeader = {
      type: HEADER_TYPE,
      version: 1,
      sessionId: this.sessionId,
      legacy: this.legacy,
    };
    const bytes = Buffer.from(`${JSON.stringify(header)}\n`);
    await writeAtomic(this.file, bytes);
    this.offset = bytes.length;
  }

  private async appendMissing(bytes: Buffer): Promise<void> {
    const file = await fs.open(this.file, "r");
    let matched: number;
    try {
      matched = (await file.stat()).size - this.offset;
      if (matched < 0 || matched > bytes.length) {
        throw this.corrupt("unexpected journal length while appending");
      }
      if (matched > 0) {
        const prefix = Buffer.alloc(matched);
        let read = 0;
        while (read < matched) {
          const result = await file.read(prefix, read, matched - read, this.offset + read);
          if (result.bytesRead === 0) throw this.corrupt("incomplete append prefix");
          read += result.bytesRead;
        }
        if (!prefix.equals(bytes.subarray(0, matched))) {
          throw this.corrupt("unexpected bytes after the last checkpoint");
        }
      }
    } finally {
      await file.close();
    }
    // Sync even when a previous append wrote every byte but failed to acknowledge it.
    await fs.appendFile(this.file, bytes.subarray(matched), { flush: true });
  }

  private parseCheckpoint(record: Record<string, unknown>, digest: string): Checkpoint {
    const checkpoint = record as Partial<Checkpoint>;
    const context = checkpoint.context;
    if (
      checkpoint.sequence !== (this.last?.sequence ?? 0) + 1 ||
      checkpoint.eventsDigest !== digest ||
      typeof checkpoint.awaitingModel !== "boolean" ||
      (context?.slot !== 0 && context?.slot !== 1) ||
      typeof context.digest !== "string" ||
      !/^[a-f0-9]{64}$/.test(context.digest) ||
      checkpoint.digest !== checkpointDigest(checkpoint as Checkpoint)
    ) {
      throw this.corrupt(`invalid checkpoint after byte ${this.offset}`);
    }
    return checkpoint as Checkpoint;
  }

  private contextPath(slot: 0 | 1): string {
    return path.join(this.directory, `lead-checkpoint-${slot}.json`);
  }

  private corrupt(reason: string): Error {
    return new Error(`Cannot recover session ${this.sessionId} from ${JOURNAL}: ${reason}`);
  }
}

function validAsyncResults(value: unknown): value is AsyncWorkResultState[] {
  if (!Array.isArray(value)) return false;
  const identities = new Set<string>();
  return value.every((result: unknown) => {
    if (!result || typeof result !== "object") return false;
    const entry = result as Partial<AsyncWorkResultState>;
    const notification = entry.notification;
    if (
      typeof entry.delivered !== "boolean" ||
      typeof entry.suppressed !== "boolean" ||
      !notification ||
      typeof notification !== "object" ||
      typeof notification.id !== "string" ||
      typeof notification.result !== "string" ||
      (notification.kind !== "background" && notification.kind !== "subagent") ||
      !["completed", "error", "interrupted", "timeout"].includes(notification.status) ||
      (notification.ownerRunId !== undefined && typeof notification.ownerRunId !== "string") ||
      (notification.taskId !== undefined && typeof notification.taskId !== "string")
    )
      return false;
    const identity = `${notification.kind}:${notification.id}`;
    if (identities.has(identity)) return false;
    identities.add(identity);
    return true;
  });
}

/** Low-level legacy appenders must not write unframed data into a checkpoint journal. */
export async function hasJournalHeader(file: string): Promise<boolean> {
  try {
    const handle = await fs.open(file, "r");
    try {
      const marker = Buffer.from(`{"type":"${HEADER_TYPE}"`);
      const prefix = Buffer.alloc(marker.length);
      const { bytesRead } = await handle.read(prefix, 0, prefix.length, 0);
      return bytesRead === marker.length && prefix.equals(marker);
    } finally {
      await handle.close();
    }
  } catch (error) {
    if (!isMissing(error)) throw error;
    return false;
  }
}

function parseLine(line: Buffer): Record<string, unknown> | null {
  try {
    const value: unknown = JSON.parse(line.toString("utf8"));
    return value && typeof value === "object" ? (value as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function hash(data: string | Buffer): string {
  return createHash("sha256").update(data).digest("hex");
}

function checkpointDigest(checkpoint: Omit<Checkpoint, "digest">): string {
  return hash(
    JSON.stringify([
      checkpoint.sequence,
      checkpoint.eventsDigest,
      checkpoint.context.slot,
      checkpoint.context.digest,
      checkpoint.awaitingModel,
    ]),
  );
}

function isMissing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException | null)?.code === "ENOENT";
}

async function readIfPresent(file: string): Promise<Buffer | undefined> {
  try {
    return await fs.readFile(file);
  } catch (error) {
    if (!isMissing(error)) throw error;
    return undefined;
  }
}
