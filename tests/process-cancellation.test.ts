import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { startManagedProcess } from "../src/core/tools/file/process.js";
import { ExecutionStoppedError } from "../src/core/loop/cancellation.js";

async function ready(file: string): Promise<number[]> {
  const deadline = Date.now() + 3_000;
  while (Date.now() < deadline) {
    try {
      const text = await readFile(file, "utf8");
      if (text.trim()) return text.trim().split(/\s+/).map(Number);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("Process fixture did not become ready");
}

test(
  "managed shell cancellation confirms the private process group and descendants exit",
  { timeout: 10_000 },
  async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "coil-process-"));
    const abort = new AbortController();
    const process = startManagedProcess("sleep 60 & child=$!; echo $$ $child > ready; wait", dir, {
      signal: abort.signal,
    });
    const outcome = assert.rejects(process.done, ExecutionStoppedError);
    try {
      const pids = await ready(path.join(dir, "ready"));
      abort.abort();
      const first = process.stop();
      assert.equal(process.stop(), first);
      assert.equal((await first).status, "confirmed");
      await outcome;
      for (const pid of pids)
        assert.throws(() => globalThis.process.kill(pid, 0), { code: "ESRCH" });
    } finally {
      await process.stop();
      await outcome;
      await rm(dir, { recursive: true, force: true });
    }
  },
);

test(
  "termination errors remain unconfirmed instead of claiming exit",
  { timeout: 5_000 },
  async (t) => {
    const dir = await mkdtemp(path.join(tmpdir(), "coil-process-failure-"));
    const managed = startManagedProcess("echo $$ > ready; while :; do :; done", dir);
    const originalKill = process.kill.bind(process);
    const outcome = assert.rejects(
      managed.done,
      (error: unknown) =>
        error instanceof ExecutionStoppedError && error.confirmation === "unconfirmed",
    );
    try {
      await ready(path.join(dir, "ready"));
      const mocked = t.mock.method(process, "kill", (pid: number, signal?: string | number) => {
        if (pid === -managed.pid! && signal !== 0)
          throw Object.assign(new Error("fixture denied termination"), { code: "EPERM" });
        return originalKill(pid, signal);
      });
      const cleanup = await managed.stop(Date.now());
      assert.equal(cleanup.status, "unconfirmed");
      assert.equal(cleanup.errors.length, 2);
      assert.equal(originalKill(managed.pid!, 0), true, "the real process is still alive");
      mocked.mock.restore();
    } finally {
      originalKill(-managed.pid!, "SIGKILL");
      await outcome;
      await rm(dir, { recursive: true, force: true });
    }
  },
);

test("managed process timeout escalates a TERM-ignoring shell", { timeout: 10_000 }, async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "coil-process-"));
  const process = startManagedProcess("trap '' TERM; echo $$ > ready; while :; do :; done", dir, {
    timeoutMs: 100,
  });
  const outcome = assert.rejects(
    process.done,
    (error: unknown) => error instanceof ExecutionStoppedError && error.reason === "timeout",
  );
  try {
    const [pid] = await ready(path.join(dir, "ready"));
    await outcome;
    assert.throws(() => globalThis.process.kill(pid!, 0), { code: "ESRCH" });
  } finally {
    await process.stop();
    await outcome;
    await rm(dir, { recursive: true, force: true });
  }
});
