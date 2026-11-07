export type AsyncWorkKind = "subagent" | "background";

export type AsyncWorkStatus = "running" | "completed" | "error" | "interrupted" | "timeout";

/**
 * A neutral async-work notification. `record` is opaque to the inbox: the
 * subscriber (which knows the kind) narrows and casts it to rebuild session
 * events. Keeping it opaque is what lets the inbox import nothing.
 */
export interface AsyncWorkNotification {
  id: string;
  kind: AsyncWorkKind;
  status: AsyncWorkStatus;
  result: string;
  taskId?: string | undefined;
  ownerRunId?: string | undefined;
  record: unknown;
}

export type AsyncWorkListener = (notification: AsyncWorkNotification) => void;

/** A settled result remains inspectable after delivery or wake suppression. */
export type AsyncWorkResultState = {
  notification: AsyncWorkNotification;
  delivered: boolean;
  suppressed: boolean;
};

/** Owns active identities and one settled result per identity, independently. */
export class AsyncWorkInbox {
  private readonly running = new Map<string, AsyncWorkNotification>();
  private readonly results = new Map<string, AsyncWorkResultState>();
  private readonly suppressed = new Set<string>();
  private readonly staged = new Set<string>();
  private suppressFuture = false;
  private readonly listeners = new Set<AsyncWorkListener>();

  suppress(kind: AsyncWorkKind, id: string): void {
    const identity = key(kind, id);
    this.suppressed.add(identity);
    const result = this.results.get(identity);
    if (result) result.suppressed = true;
  }

  suppressRun(runId: string): void {
    for (const notification of [...this.running.values(), ...this.getResults()]) {
      if (notification.ownerRunId === runId) this.suppress(notification.kind, notification.id);
    }
  }

  suppressAll(): void {
    this.suppressFuture = true;
    for (const notification of [...this.running.values(), ...this.getResults()])
      this.suppress(notification.kind, notification.id);
  }

  register(notification: AsyncWorkNotification): void {
    const identity = key(notification.kind, notification.id);
    if (this.running.has(identity) || this.results.has(identity)) return;
    this.running.set(identity, notification);
    if (this.suppressFuture) this.suppress(notification.kind, notification.id);
    this.emit(notification);
  }

  settle(notification: AsyncWorkNotification): void {
    const identity = key(notification.kind, notification.id);
    if (this.results.has(identity)) return;
    this.running.delete(identity);
    this.results.set(identity, {
      notification,
      delivered: false,
      suppressed: this.suppressFuture || this.suppressed.has(identity),
    });
    this.emit(notification);
  }

  hasPending(): boolean {
    return [...this.running.keys()].some((identity) => !this.suppressed.has(identity));
  }

  hasNotifications(): boolean {
    return [...this.results].some(([identity, result]) => this.deliverable(identity, result));
  }

  getResults(): AsyncWorkNotification[] {
    return [...this.results.values()].map((result) => result.notification);
  }

  /** Reserve results for message injection; release only after the matching save. */
  stageNotifications(): AsyncWorkNotification[] {
    const notifications: AsyncWorkNotification[] = [];
    for (const [identity, result] of this.results) {
      if (!this.deliverable(identity, result)) continue;
      this.staged.add(identity);
      notifications.push(result.notification);
    }
    return notifications;
  }

  stagedIds(): string[] {
    return [...this.staged];
  }

  acknowledgeNotifications(identities: readonly string[]): void {
    for (const identity of identities) {
      const result = this.results.get(identity);
      if (result) result.delivered = true;
      this.staged.delete(identity);
    }
  }

  drainNotifications(): AsyncWorkNotification[] {
    const notifications = this.stageNotifications();
    this.acknowledgeNotifications(
      notifications.map((notification) => key(notification.kind, notification.id)),
    );
    return notifications;
  }

  captureResults(deliveredIds: readonly string[] = []): AsyncWorkResultState[] {
    const delivered = new Set(deliveredIds);
    return structuredClone(
      [...this.results].map(([identity, result]) => ({
        ...result,
        delivered: result.delivered || delivered.has(identity),
      })),
    );
  }

  restoreResults(results: readonly AsyncWorkResultState[]): void {
    for (const result of results) {
      const { kind, id } = result.notification;
      const identity = key(kind, id);
      if (!this.results.has(identity)) this.results.set(identity, structuredClone(result));
      if (result.suppressed) this.suppressed.add(identity);
    }
  }

  subscribe(listener: AsyncWorkListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  private deliverable(identity: string, result: AsyncWorkResultState): boolean {
    return !result.delivered && !result.suppressed && !this.staged.has(identity);
  }

  private emit(notification: AsyncWorkNotification): void {
    for (const listener of this.listeners) {
      try {
        listener(notification);
      } catch {
        // Subscriber failures (UI/projection) must never break async work.
      }
    }
  }
}

function key(kind: AsyncWorkKind, id: string): string {
  return `${kind}:${id}`;
}
