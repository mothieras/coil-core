import assert from "node:assert/strict";
import { fork } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { SessionController } from "../src/core/session/controller.js";
import { SessionStore } from "../src/core/session/store/sessionStore.js";
import { builtinTool } from "../src/core/tools/types.js";
import { logFromSnapshot } from "../src/tui/state.js";
import type { CrashWindow } from "./fixtures/session-crash.js";
import { fakeProvider, textMessage, toolCall, toolCallMessage } from "./helpers/pi.js";

const fixture = fileURLToPath(new URL("./fixtures/session-crash.ts", import.meta.url));
const windows: CrashWindow[] = [
  "before_intent",
  "after_intent",
  "after_effect",
  "after_result",
  "model_reply",
];

async function crash(workspace: string, window: CrashWindow): Promise<void> {
  const child = fork(fixture, [workspace, window], {
    execArgv: ["--import", "tsx"],
    stdio: ["ignore", "ignore", "pipe", "ipc"],
  });
  let stderr = "";
  child.stderr!.setEncoding("utf8").on("data", (text: string) => {
    stderr += text;
  });
  const exited = once(child, "exit");
  try {
    const message = await Promise.race([
      once(child, "message", { signal: AbortSignal.timeout(8_000) }),
      exited.then(() => {
        throw new Error(`Fixture exited before ${window}: ${stderr}`);
      }),
    ]);
    assert.equal(message[0], "checkpoint reached");
  } finally {
    child.kill("SIGKILL");
    const [code, signal] = await exited;
    assert.deepEqual([code, signal], [null, "SIGKILL"], stderr);
  }
}

async function effects(workspace: string): Promise<string> {
  try {
    return await fs.readFile(path.join(workspace, "effects"), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    return "";
  }
}

for (const window of windows) {
  test(`recovers the real process crash window ${window}`, { timeout: 15_000 }, async (t) => {
    const workspaceRoot = await fs.mkdtemp(path.join(tmpdir(), "coil-crash-recovery-"));
    t.after(() => fs.rm(workspaceRoot, { recursive: true, force: true }));
    await crash(workspaceRoot, window);
    const expectedEffects = window === "after_effect" || window === "after_result" ? "first\n" : "";
    assert.equal(await effects(workspaceRoot), expectedEffects);

    const store = new SessionStore(workspaceRoot);
    const options = { workspaceRoot, sessionId: "crash", store };
    const cache = store.pathForSession(options.sessionId);
    if (window === "after_result") {
      assert.equal((await store.loadSnapshot(options.sessionId)).toolCalls.length, 0);
      await fs.writeFile(path.join(cache, "snapshot.json"), "broken projection cache");
      await fs.writeFile(
        path.join(cache, "lead-messages.json"),
        '[{"role":"user","content":"wrong generation","timestamp":0}]',
      );
    }
    const unknown = window === "after_intent" || window === "after_effect";
    const provider = fakeProvider((request) =>
      unknown && request.messages.at(-1)?.role === "user"
        ? toolCallMessage([toolCall("append_marker", {}, "retry")])
        : textMessage("Continued by explicit request."),
    );
    let approvals = 0;
    const resumed = await SessionController.resume({
      ...options,
      provider,
      checkPermission: async () => {
        approvals++;
        return { allowed: false, requested: true, reason: "User denied retry" };
      },
    });
    resumed.appContext.toolRuntime.registerTool(
      builtinTool(
        { name: "append_marker", description: "Retry fixture", parameters: { type: "object" } },
        async () => {
          await fs.appendFile(path.join(workspaceRoot, "effects"), "retry\n");
          return { status: "completed", output: "Should have required permission" };
        },
      ),
    );
    const snapshot = resumed.getSnapshot();
    assert.equal(snapshot.conversationMessages.length, 1);
    assert.equal(snapshot.agentRuns[0]?.status, "interrupted");
    assert.equal(provider.calls.length, 0);
    assert.equal(resumed.hasPendingAsyncWork(), false);
    assert.equal(
      snapshot.recovery?.modelResponseUnconfirmed === true,
      window === "before_intent" || window === "model_reply",
    );

    const lead = resumed.leadAgentState.messages;
    const toolResults = lead.filter((message) => message.role === "toolResult");
    if (window === "after_result") {
      assert.equal(snapshot.toolCalls[0]?.status, "completed");
      assert.deepEqual(
        toolResults.map((result) => [result.toolCallId, result.isError]),
        [
          ["first", false],
          ["second", true],
        ],
      );
      assert.deepEqual(toolResults[0]?.content, [
        { type: "text", text: "Full result from the tool" },
      ]);
      const savedResponse = lead.find((message) => message.role === "assistant");
      assert.equal(savedResponse?.model, "test-model");
      assert.deepEqual(savedResponse?.content[0], {
        type: "thinking",
        thinking: "Fixture thought",
        thinkingSignature: "fixture-signature",
      });
      assert.equal(
        await fs.readFile(path.join(cache, "snapshot.json"), "utf8"),
        "broken projection cache",
      );
    }
    if (window === "model_reply" || window === "before_intent") {
      assert.deepEqual(
        lead.map((message) => message.role),
        ["user"],
      );
      assert.match(logFromSnapshot(snapshot).at(-1)?.detail ?? "", /no saved response/);
    }
    if (unknown) {
      const pending = snapshot.recovery?.pending ?? [];
      assert.equal(pending.length, 1);
      const operation = pending[0]!;
      assert.equal(operation.kind, "tool");
      assert.equal(snapshot.toolCalls[0]?.status, "unconfirmed");
      assert.deepEqual(
        toolResults.map((result) => [result.toolCallId, result.isError]),
        [
          ["first", true],
          ["second", true],
        ],
      );
      assert.match(
        logFromSnapshot(snapshot).at(-1)?.detail ?? "",
        /Outcome unknown|outcome unknown/,
      );
      const listing = await resumed.handleSlashCommand("/recover");
      assert.ok(listing.action === "notice" && listing.body.includes(operation.id));
      await assert.rejects(resumed.handleUserMessage("continue"), /outcome unknown/);
      await assert.rejects(resumed.handleAutoWake("async_work_finished"), /outcome unknown/);
      assert.equal(provider.calls.length, 0);
      assert.equal(approvals, 0);
      await resumed.flush();
      const stillBlocked = await SessionController.resume(options);
      assert.deepEqual(stillBlocked.getSnapshot().recovery?.pending, pending);
      if (window === "after_intent") {
        await resumed.resolveRecovery(operation.id, "verified");
      } else {
        const discarded = await resumed.handleSlashCommand(`/recover discard ${operation.id}`);
        assert.deepEqual(discarded, {
          action: "notice",
          title: "Session recovery",
          body: "Operation set aside.",
        });
      }
      assert.equal(resumed.getSnapshot().recovery?.pending.length, 0);
      assert.equal(await effects(workspaceRoot), expectedEffects);
    } else {
      assert.deepEqual(snapshot.recovery?.pending, []);
    }

    await resumed.handleUserMessage("Continue explicitly.");
    if (unknown) {
      assert.equal(approvals, 1);
      assert.equal(resumed.getSnapshot().toolCalls.at(-1)?.status, "permission_denied");
    }
    await resumed.close();
    assert.equal(await effects(workspaceRoot), expectedEffects);
    const reopened = await SessionController.resume(options);
    assert.deepEqual(reopened.getSnapshot().recovery?.pending, []);
    await reopened.close();
  });
}
