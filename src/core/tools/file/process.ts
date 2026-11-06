import { spawn } from "node:child_process";
import { ExecutionStoppedError, throwIfAborted } from "../../loop/cancellation.js";
import type { RunCleanupResult } from "../../agent/run.js";

export type ProcessResult = { output: string; code: number | null; signal: NodeJS.Signals | null };
export type ManagedProcess = {
  pid: number | undefined;
  done: Promise<ProcessResult>;
  stop(deadlineAt?: number): Promise<RunCleanupResult>;
};

/** Only the private process group created here is signalled; never a caller's group. */
export function startManagedProcess(
  command: string,
  cwd: string,
  options: { signal?: AbortSignal | undefined; timeoutMs?: number } = {},
): ManagedProcess {
  throwIfAborted(options.signal);
  const grouped = process.platform === "darwin" || process.platform === "linux";
  const child = spawn(command, {
    cwd,
    shell: true,
    detached: grouped,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  const append = (chunk: Buffer) => {
    output = (output + chunk.toString()).slice(-50_000);
  };
  child.stdout.on("data", append);
  child.stderr.on("data", append);
  let exited = false;
  const closed = new Promise<ProcessResult>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code, signal) => {
      exited = true;
      resolve({ output: output.trim() || "(no output)", code, signal });
    });
  });
  let stopping: Promise<RunCleanupResult> | undefined;
  let reason: "aborted" | "timeout" = "aborted";
  const alive = () => {
    if (!child.pid) return !exited;
    if (!grouped) return !exited;
    try {
      process.kill(-child.pid, 0);
      return true;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "ESRCH") return false;
      // Darwin can report EPERM while a terminating group is being reaped.
      // It is not proof of exit: keep waiting and require a later ESRCH.
      if (code === "EPERM") return true;
      throw error;
    }
  };
  const waitUntil = async (until: number) => {
    while (alive() && Date.now() < until)
      await new Promise((resolve) =>
        setTimeout(resolve, Math.min(20, Math.max(1, until - Date.now()))),
      );
  };
  const stop = (deadlineAt = Date.now() + 5_000): Promise<RunCleanupResult> => {
    if (stopping) return stopping;
    stopping = (async () => {
      const errors: string[] = [];
      const send = (signal: NodeJS.Signals) => {
        if (!child.pid) return;
        try {
          if (grouped) process.kill(-child.pid, signal);
          else child.kill(signal);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ESRCH") errors.push(String(error));
        }
      };
      try {
        send("SIGTERM");
        await waitUntil(Math.min(deadlineAt, Date.now() + 2_000));
        if (alive()) {
          send("SIGKILL");
          await waitUntil(Math.min(deadlineAt, Date.now() + 1_000));
        }
        const unconfirmed = alive() || !grouped;
        return {
          status: unconfirmed || errors.length ? "unconfirmed" : "confirmed",
          resources: unconfirmed ? [`process-group:${child.pid ?? "unknown"}`] : [],
          errors,
        };
      } catch (error) {
        return {
          status: "unconfirmed",
          resources: [`process-group:${child.pid ?? "unknown"}`],
          errors: [...errors, String(error)],
        };
      }
    })();
    return stopping;
  };
  const abort = () => {
    void stop();
  };
  options.signal?.addEventListener("abort", abort, { once: true });
  if (options.signal?.aborted) abort();
  const timer =
    options.timeoutMs === undefined
      ? undefined
      : setTimeout(() => {
          reason = "timeout";
          void stop();
        }, options.timeoutMs);
  const done = (async () => {
    try {
      const result = await closed;
      // A shell can exit while redirected descendants keep running. Its close
      // event alone is not proof that our process group has stopped.
      while (grouped && alive()) {
        await new Promise<void>((resolve) => {
          const poll = setTimeout(resolve, 20);
          if (stopping) poll.unref();
        });
      }
      if (stopping) {
        const cleanup = await stopping;
        if (cleanup.status === "unconfirmed")
          throw new ExecutionStoppedError(reason, `process-group:${child.pid}`, "unconfirmed", {
            cause: cleanup,
          });
        throw new ExecutionStoppedError(reason, `process:${child.pid}`);
      }
      return result;
    } finally {
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", abort);
    }
  })();
  return { pid: child.pid, done, stop };
}
