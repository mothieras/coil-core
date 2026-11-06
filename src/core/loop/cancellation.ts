import type { RunCleanupResult } from "../agent/run.js";

export const CLEANUP_TIMEOUT_MS = 5_000;

/** A control outcome, never an ordinary model-correctable tool failure. */
export class ExecutionStoppedError extends Error {
  constructor(
    readonly reason: "aborted" | "timeout" = "aborted",
    readonly resource?: string,
    readonly confirmation: "confirmed" | "unconfirmed" = "confirmed",
    options?: ErrorOptions,
  ) {
    super(
      `Execution stopped: ${reason}${resource ? ` (${resource})` : ""}; stop ${confirmation}`,
      options,
    );
    this.name = "ExecutionStoppedError";
  }
}

export function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw signal.reason instanceof ExecutionStoppedError
      ? signal.reason
      : new ExecutionStoppedError();
  }
}

/** Only stops waiting. The caller must retain the operation to confirm cleanup. */
export async function waitWithSignal<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  // Install both handlers even for an already-aborted signal (late rejection is observed).
  let onAbort: (() => void) | undefined;
  const aborted = new Promise<never>((_, reject) => {
    onAbort = () => {
      try {
        throwIfAborted(signal);
      } catch (error) {
        reject(error);
      }
    };
    signal?.addEventListener("abort", onAbort, { once: true });
    onAbort();
  });
  try {
    const result = await Promise.race([promise, aborted]);
    throwIfAborted(signal);
    return result;
  } finally {
    if (onAbort) signal?.removeEventListener("abort", onAbort);
  }
}

export async function cancellableDelay(ms: number, signal?: AbortSignal): Promise<void> {
  throwIfAborted(signal);
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await waitWithSignal(
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, ms);
      }),
      signal,
    );
  } finally {
    clearTimeout(timer);
  }
}

/** Retains actual completion independently from callers that stop waiting. */
export class ExecutionScope {
  readonly controller = new AbortController();
  private readonly pending = new Map<Promise<unknown>, string>();
  private readonly errors: string[] = [];
  get signal(): AbortSignal {
    return this.controller.signal;
  }

  async wait<T>(promise: Promise<T>, resource: string): Promise<T> {
    this.pending.set(promise, resource);
    void promise.then(
      () => this.pending.delete(promise),
      (error: unknown) => {
        this.pending.delete(promise);
        if (
          this.signal.aborted &&
          (!(error instanceof ExecutionStoppedError) || error.confirmation === "unconfirmed") &&
          !(error instanceof Error && error.name === "AbortError")
        ) {
          this.errors.push(`${resource}: ${String(error)}`);
        }
      },
    );
    try {
      return await waitWithSignal(promise, this.signal);
    } catch (error) {
      if (error instanceof ExecutionStoppedError)
        throw new ExecutionStoppedError(
          error.reason,
          resource,
          this.pending.has(promise) ? "unconfirmed" : error.confirmation,
        );
      throw error;
    }
  }

  async settled(): Promise<void> {
    while (this.pending.size) await Promise.allSettled([...this.pending.keys()]);
  }

  async cleanup(deadlineAt: number): Promise<RunCleanupResult> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        this.settled(),
        new Promise<void>((resolve) => {
          timer = setTimeout(resolve, Math.max(0, deadlineAt - Date.now()));
        }),
      ]);
      return {
        status: this.pending.size || this.errors.length ? "unconfirmed" : "confirmed",
        resources: [...this.pending.values()],
        errors: [...this.errors],
      };
    } finally {
      clearTimeout(timer);
    }
  }
}
