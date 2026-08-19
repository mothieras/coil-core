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
  record: unknown;
}

export type AsyncWorkListener = (notification: AsyncWorkNotification) => void;

/**
 * Single delivery point for async work (subagents + background commands).
 * Owns the pending-set (UI wake via hasPending), the settled-notification
 * queue (the PreLLMCall hook drains it), and a subscriber fan-out that fires
 * on register (started) and settle (finished/interrupted) so the session
 * layer can record subagent_ and background_ events. Dependency-neutral.
 */
export class AsyncWorkInbox {
  private readonly running = new Set<string>();
  private notifications: AsyncWorkNotification[] = [];
  private readonly listeners = new Set<AsyncWorkListener>();

  register(notification: AsyncWorkNotification): void {
    this.running.add(key(notification.kind, notification.id));
    this.emit(notification);
  }

  settle(notification: AsyncWorkNotification): void {
    this.running.delete(key(notification.kind, notification.id));
    this.notifications.push(notification);
    this.emit(notification);
  }

  hasPending(): boolean {
    return this.running.size > 0;
  }

  drainNotifications(): AsyncWorkNotification[] {
    const drained = this.notifications.slice();
    this.notifications = [];
    return drained;
  }

  subscribe(listener: AsyncWorkListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
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
