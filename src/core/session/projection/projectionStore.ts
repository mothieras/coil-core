import { applySessionEvent, createEmptySessionSnapshot } from "../projection/projection.js";
import type { SessionEvent, SessionSnapshot } from "../types.js";
import { toSessionViewEvents, type SessionViewEventListener } from "../viewEvents.js";

export class SessionProjectionStore {
  private snapshot: SessionSnapshot;
  private readonly pendingEvents: SessionEvent[] = [];
  private readonly listeners = new Set<SessionViewEventListener>();

  constructor(snapshot: SessionSnapshot = createEmptySessionSnapshot()) {
    this.snapshot = snapshot;
  }

  record(event: SessionEvent): void {
    this.pendingEvents.push(event);
    // A recovery decision releases an execution gate. Show it only after commit.
    if (event.type !== "recovery_resolved") this.apply(event);
  }

  subscribe(listener: SessionViewEventListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  getSnapshot(): SessionSnapshot {
    return this.snapshot;
  }

  getPending(): readonly SessionEvent[] {
    return this.pendingEvents.slice();
  }

  acknowledge(count: number): void {
    for (const event of this.pendingEvents.splice(0, count)) {
      if (event.type === "recovery_resolved") this.apply(event);
    }
  }

  private apply(event: SessionEvent): void {
    this.snapshot = applySessionEvent(this.snapshot, event);
    this.publish(event);
  }

  private publish(event: SessionEvent): void {
    if (this.listeners.size === 0) return;
    const viewEvents = toSessionViewEvents(event, this.snapshot);
    if (viewEvents.length === 0) return;
    for (const viewEvent of viewEvents) {
      for (const listener of [...this.listeners]) {
        try {
          listener(viewEvent, this.snapshot);
        } catch {
          // UI observation must not affect agent execution or session persistence.
        }
      }
    }
  }
}
