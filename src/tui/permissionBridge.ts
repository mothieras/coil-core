export type PermissionRequest = {
  id: string;
  toolName: string;
  reason: string;
  inputSummary?: string | undefined;
  input?: Record<string, unknown> | undefined;
  queueSize?: number | undefined;
};

export type PermissionBridge = {
  request(toolName: string, input: Record<string, unknown>, reason: string): Promise<boolean>;
  resolve(requestId: string, allow: boolean): void;
  current(): PermissionRequest | null;
  subscribe(listener: () => void): () => void;
};

type QueuedRequest = {
  req: PermissionRequest;
  resolve: (allow: boolean) => void;
};

export function createPermissionBridge(): PermissionBridge {
  // FIFO queue: concurrent agents (lead + subagents) can each have a request in
  // flight, so requests must not overwrite one another. The head is shown to the
  // user; resolving it advances to the next.
  const queue: QueuedRequest[] = [];
  let counter = 0;
  const listeners = new Set<() => void>();
  const notify = (): void => {
    for (const l of listeners) l();
  };
  const updateQueueSize = (): void => {
    const current = queue[0];
    if (current) current.req.queueSize = queue.length;
  };

  return {
    request(toolName, input, reason) {
      counter += 1;
      const req: PermissionRequest = { id: `perm-${counter}`, toolName, reason, input };
      const summary = summarizeInput(input);
      if (summary !== undefined) req.inputSummary = summary;
      const promise = new Promise<boolean>((resolve) => {
        queue.push({ req, resolve });
      });
      updateQueueSize();
      notify();
      return promise;
    },
    resolve(requestId, allow) {
      const head = queue[0];
      if (!head || head.req.id !== requestId) return;
      queue.shift();
      head.resolve(allow);
      updateQueueSize();
      notify();
    },
    current() {
      return queue[0]?.req ?? null;
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}

function summarizeInput(input: Record<string, unknown>): string | undefined {
  const keys = Object.keys(input);
  if (keys.length === 0) return undefined;
  const text = keys.map((k) => `${k}=${String(input[k]).slice(0, 40)}`).join(" ");
  return text.length > 120 ? `${text.slice(0, 119)}~` : text;
}
