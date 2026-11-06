import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { SessionController } from "../src/core/session/controller.js";
import { SessionStore } from "../src/core/session/store/sessionStore.js";
import { ExecutionStoppedError } from "../src/core/loop/cancellation.js";
import { fakeProvider, textMessage, toolCall, toolCallMessage } from "./helpers/pi.js";

async function workspace() {
  return mkdtemp(path.join(tmpdir(), "coil-cancel-"));
}

test("public controller cancels permission wait, removes the request and permits a legal next turn", async () => {
  const dir = await workspace();
  const entered = Promise.withResolvers<void>();
  let calls = 0;
  const controller = await SessionController.createNew({
    workspaceRoot: dir,
    title: "test",
    provider: fakeProvider(() =>
      ++calls === 1
        ? toolCallMessage([toolCall("bash", { command: "echo should-not-run" })])
        : textMessage("done"),
    ),
    checkPermission: (context) =>
      new Promise((_resolve, reject) => {
        entered.resolve();
        context.signal?.addEventListener("abort", () => reject(context.signal?.reason), {
          once: true,
        });
      }),
  });
  try {
    const turn = controller.handleUserMessage("test");
    await entered.promise;
    const result = await controller.cancelRun();
    assert.equal(result.cleanup?.status, "confirmed");
    assert.equal((await turn).run.status, "interrupted");
    await controller.handleUserMessage("continue");
    assert.equal(calls, 2);
    assert.equal(
      controller.leadAgentState.messages.filter((m) => m.role === "toolResult").length,
      1,
    );
  } finally {
    await controller.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test(
  "close reports an uncooperative tool within the shared budget and cannot reopen the session",
  { timeout: 12_000 },
  async () => {
    const dir = await workspace();
    const entered = Promise.withResolvers<void>();
    const late = Promise.withResolvers<string>();
    const controller = await SessionController.createNew({
      workspaceRoot: dir,
      title: "fixed",
      provider: fakeProvider(() => toolCallMessage([toolCall("remote", {})])),
    });
    controller.appContext.toolRuntime.registerTool({
      name: "remote",
      definition: {
        name: "remote",
        description: "fixture",
        parameters: { type: "object", properties: {} },
      },
      source: { type: "builtin" },
      handler: () => {
        entered.resolve();
        return late.promise.then((output) => ({ status: "completed" as const, output }));
      },
    });
    try {
      const running = controller.handleUserMessage("remote");
      await entered.promise;
      const start = Date.now();
      const closing = controller.close();
      assert.equal(controller.close(), closing);
      await assert.rejects(
        closing,
        (error: unknown) =>
          error instanceof AggregateError &&
          error.errors.some((e) => /unconfirmed/.test(String(e))),
      );
      assert.ok(Date.now() - start < 8_000);
      const result = await running;
      assert.equal(result.run.cleanup?.status, "unconfirmed");
      const messages = structuredClone(controller.leadAgentState.messages);
      const run = structuredClone(result.run);
      await assert.rejects(controller.handleUserMessage("not allowed"), /closing/);
      late.resolve("late success");
      await controller.appContext.agentRuntime.whenSettled(result.run.id);
      assert.deepEqual(controller.leadAgentState.messages, messages);
      assert.deepEqual(result.run, run);
    } finally {
      late.resolve("cleanup");
      await controller.close().catch(() => undefined);
      await rm(dir, { recursive: true, force: true });
    }
  },
);

test("close is idempotent, rejects new turns and retains independent cleanup and save errors", async () => {
  const dir = await workspace();
  const store = new SessionStore(dir);
  let closes = 0;
  const controller = await SessionController.createNew({
    workspaceRoot: dir,
    store,
    title: "test",
    provider: fakeProvider(() => textMessage("done")),
    toolProviderResults: ["one", "two"].map((name) => ({
      tools: [],
      diagnostics: [],
      close: () => {
        closes++;
        throw new Error(`close-${name}`);
      },
    })),
  });
  store.saveSnapshot = async () => {
    throw new Error("save-failed");
  };
  const closing = controller.close();
  assert.equal(controller.close(), closing);
  await assert.rejects(controller.handleUserMessage("late"), /closing/);
  await assert.rejects(controller.handleSlashCommand("/ping"), /closing/);
  await assert.rejects(closing, (error: unknown) => {
    assert.ok(error instanceof AggregateError);
    const errors = error.errors.map(String).join("\n");
    assert.match(errors, /close-one/);
    assert.match(errors, /close-two/);
    assert.match(errors, /save-failed/);
    return true;
  });
  assert.equal(closes, 2);
  await rm(dir, { recursive: true, force: true });
});

test("cancelling a completed parent stops only its active child without rewriting the parent", async () => {
  const dir = await workspace();
  const entered = Promise.withResolvers<void>();
  let childStopped = false;
  const controller = await SessionController.createNew({
    workspaceRoot: dir,
    title: "fixed",
    provider: fakeProvider((request, call) => {
      if (
        request.messages.length === 1 &&
        request.messages[0]?.role === "user" &&
        request.messages[0].content === "child-task"
      ) {
        entered.resolve();
        return new Promise((_resolve, reject) =>
          call.options?.signal?.addEventListener(
            "abort",
            () => {
              childStopped = true;
              reject(call.options?.signal?.reason);
            },
            { once: true },
          ),
        );
      }
      if (!request.messages.some((message) => message.role === "toolResult"))
        return toolCallMessage([toolCall("subagent", { prompt: "child-task" })]);
      return textMessage("parent done");
    }),
  });
  try {
    const parent = await controller.handleUserMessage("spawn");
    await entered.promise;
    const before = structuredClone(parent.run);
    assert.equal(childStopped, false);
    const cancellation = await controller.cancelRun(parent.run.id);
    assert.equal(cancellation.status, "descendants_only");
    assert.equal(cancellation.cleanup?.status, "confirmed");
    assert.equal(childStopped, true);
    assert.deepEqual(parent.run, before);
    assert.deepEqual(controller.appContext.inbox.drainNotifications(), []);
    assert.equal(
      controller.getSnapshot().agentRuns.filter((run) => run.id === parent.run.id).length,
      1,
    );
  } finally {
    await controller.close();
    await rm(dir, { recursive: true, force: true });
  }
});

for (const action of ["auto-title", "compact", "ping"] as const) {
  test(`session close cancels ${action} and rejects its late state changes`, async () => {
    const dir = await workspace();
    const entered = Promise.withResolvers<void>();
    const response = Promise.withResolvers<ReturnType<typeof textMessage>>();
    let calls = 0;
    let signal: AbortSignal | undefined;
    const controller = await SessionController.createNew({
      workspaceRoot: dir,
      ...(action !== "auto-title" ? { title: "fixed" } : {}),
      provider: fakeProvider((_request, call) => {
        if (++calls === 1 && action !== "ping") return textMessage("first");
        signal = call.options?.signal;
        entered.resolve();
        return response.promise;
      }),
    });
    try {
      let operation: Promise<unknown>;
      if (action === "auto-title") operation = controller.handleUserMessage("hello");
      else {
        if (action === "compact") await controller.handleUserMessage("hello");
        operation =
          action === "compact" ? controller.compact() : controller.handleSlashCommand("/ping");
      }
      const observed = operation.catch((error) => {
        assert.ok(error instanceof ExecutionStoppedError);
      });
      await entered.promise;
      const before = structuredClone(controller.leadAgentState.messages);
      const closing = controller.close();
      assert.equal(signal?.aborted, true);
      response.resolve(textMessage("late replacement"));
      await observed;
      await closing;
      assert.deepEqual(controller.leadAgentState.messages, before);
      assert.notEqual(controller.getSnapshot().session?.title, "late replacement");
    } finally {
      await controller.close();
      await rm(dir, { recursive: true, force: true });
    }
  });
}
