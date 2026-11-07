import type { Message } from "@earendil-works/pi-ai";
import { throwIfAborted } from "../../loop/cancellation.js";
import type { SessionProjectionStore } from "../projection/projectionStore.js";
import type { SessionEvent, SessionSnapshot } from "../types.js";
import type { SessionJournal } from "./sessionJournal.js";
import type { SessionStore } from "./sessionStore.js";
import type { AsyncWorkInbox, AsyncWorkResultState } from "../../async/asyncWorkInbox.js";

type LeadContext = {
  messages: readonly Message[];
  awaitingModel: boolean;
  revision: number;
  deliveredIds: readonly string[];
};
type Batch = {
  events: readonly SessionEvent[];
  snapshot: SessionSnapshot;
  lead: LeadContext;
  asyncResults: readonly AsyncWorkResultState[];
};

/** Orders authority writes and keeps the exact in-flight batch until acknowledged. */
export class SessionPersistence {
  private writes = Promise.resolve();
  private inFlight: Batch | undefined;
  private lead: LeadContext;
  private revision = 0;
  failure?: { cause: unknown };

  constructor(
    private readonly sessionId: string,
    private readonly journal: SessionJournal,
    private readonly projection: SessionProjectionStore,
    private readonly store: SessionStore,
    messages: readonly Message[],
    private readonly inbox: AsyncWorkInbox,
  ) {
    this.lead = {
      messages: structuredClone(messages),
      awaitingModel: false,
      revision: 0,
      deliveredIds: [],
    };
  }

  setLead(messages: readonly Message[], awaitingModel = false): void {
    this.captureLead(messages, awaitingModel)();
  }

  captureLead(messages: readonly Message[], awaitingModel: boolean): () => void {
    const lead = {
      messages: structuredClone(messages),
      awaitingModel,
      revision: ++this.revision,
      deliveredIds: this.inbox.stagedIds(),
    };
    return () => {
      // A cancelled run can finish pairing its messages while a write is queued.
      if (lead.revision > this.lead.revision) this.lead = lead;
    };
  }

  assertWritable(): void {
    if (this.failure) throw this.failure.cause;
  }

  confirm(record: () => void, signal?: AbortSignal): Promise<void> {
    return this.enqueue(async () => {
      this.assertWritable();
      throwIfAborted(signal);
      try {
        record();
        await this.commit();
      } catch (cause) {
        this.failure = { cause };
        throw cause;
      }
    });
  }

  flush(retry = false): Promise<void> {
    return this.enqueue(async () => {
      if (!retry) this.assertWritable();
      let batch: Batch;
      try {
        batch = await this.commit();
      } catch (cause) {
        this.failure ??= { cause };
        throw cause;
      }
      // These views can lag after a failed write. Resume only reads the journal.
      if (batch.snapshot.session) await this.store.create(batch.snapshot.session);
      await this.store.saveConversation(this.sessionId, batch.snapshot.conversationMessages);
      await this.store.saveLeadMessages(this.sessionId, batch.lead.messages);
      await this.store.saveSnapshot(this.sessionId, batch.snapshot);
    });
  }

  private enqueue(write: () => Promise<void>): Promise<void> {
    const operation = this.writes.then(write);
    this.writes = operation.catch(() => {});
    return operation;
  }

  private async commit(): Promise<Batch> {
    if (this.inFlight) await this.write(this.inFlight);
    const batch: Batch = {
      events: structuredClone(this.projection.getPending()),
      snapshot: this.projection.getSnapshot(),
      lead: this.lead,
      asyncResults: this.inbox.captureResults(this.lead.deliveredIds),
    };
    this.inFlight = batch;
    await this.write(batch);
    return batch;
  }

  private async write(batch: Batch): Promise<void> {
    await this.journal.commit(
      batch.events,
      batch.lead.messages,
      batch.lead.awaitingModel,
      batch.asyncResults,
    );
    this.projection.acknowledge(batch.events.length);
    this.inbox.acknowledgeNotifications(batch.lead.deliveredIds);
    this.inFlight = undefined;
  }
}
