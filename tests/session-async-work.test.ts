import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { SessionController } from "../src/core/session/controller.js";
import type { Provider } from "../src/core/providers/index.js";
import { fakeProvider, textMessage } from "./helpers/pi.js";

async function create(t: TestContext, provider: Provider) {
  const workspaceRoot = await mkdtemp(path.join(tmpdir(), "coil-async-"));
  const controller = await SessionController.createNew({
    workspaceRoot,
    provider,
    title: "Async work",
  });
  t.after(async () => {
    await controller.close();
    await rm(workspaceRoot, { recursive: true, force: true });
  });
  return controller;
}

function settle(controller: SessionController, id: string, ownerRunId?: string) {
  const notification = {
    id,
    kind: "subagent" as const,
    status: "running" as const,
    result: "",
    ownerRunId,
    record: { id, status: "running", promptSummary: `work ${id}`, parentRunId: ownerRunId },
  };
  controller.appContext.inbox.register(notification);
  controller.appContext.inbox.settle({
    ...notification,
    status: "completed",
    result: `result ${id}`,
    record: { ...notification.record, status: "completed", resultSummary: `result ${id}` },
  });
}

function resultMessages(controller: SessionController): string[] {
  return controller.leadAgentState.messages.flatMap((message) =>
    message.role === "user" &&
    typeof message.content === "string" &&
    message.content.includes("<subagent-results>")
      ? [message.content]
      : [],
  );
}

test(
  "headless wakes coalesce, consume ready results once and keep late results",
  { timeout: 5_000 },
  async (t) => {
    const entered = Promise.withResolvers<void>();
    const response = Promise.withResolvers<ReturnType<typeof textMessage>>();
    let active = 0;
    let peak = 0;
    const provider = fakeProvider(async () => {
      peak = Math.max(peak, ++active);
      entered.resolve();
      try {
        return await response.promise;
      } finally {
        active--;
      }
    });
    const controller = await create(t, provider);
    settle(controller, "one");
    settle(controller, "two");
    assert.equal(controller.hasPendingAsyncWork(), true);
    const first = controller.handleAutoWake("async_work_finished");
    const duplicate = controller.handleAutoWake("subagent_finished");
    const outcomes = Promise.all([first, duplicate]);
    await entered.promise;
    settle(controller, "three");
    response.resolve(textMessage("collected"));
    const [a, b] = await outcomes;
    assert.equal(a?.run.id, b?.run.id);
    assert.equal(provider.calls.length, 1);
    assert.equal(peak, 1);
    assert.equal(resultMessages(controller).length, 1);
    assert.match(resultMessages(controller)[0]!, /result one.*\n\n.*result two/);
    assert.equal(controller.hasPendingAsyncWork(), true);
    await controller.handleAutoWake("async_work_finished");
    assert.equal(provider.calls.length, 2);
    assert.equal(resultMessages(controller).length, 2);
    assert.match(resultMessages(controller)[1]!, /result three/);
    assert.equal(await controller.handleAutoWake("async_work_finished"), undefined);
    assert.equal(controller.hasPendingAsyncWork(), false);
  },
);

test(
  "a wake arriving during a user turn waits without reentry or adding a rejected user message",
  { timeout: 5_000 },
  async (t) => {
    const entered = Promise.withResolvers<void>();
    const response = Promise.withResolvers<ReturnType<typeof textMessage>>();
    let calls = 0;
    const provider = fakeProvider(() => {
      if (++calls === 1) {
        entered.resolve();
        return response.promise;
      }
      return textMessage("handled result");
    });
    const controller = await create(t, provider);
    const turn = controller.handleUserMessage("user input");
    await entered.promise;
    settle(controller, "during-turn");
    const wake = controller.handleAutoWake("async_work_finished");
    const duplicate = controller.handleAutoWake("async_work_finished");
    const outcomes = Promise.all([turn, wake, duplicate]);
    await assert.rejects(controller.handleUserMessage("rejected input"), /active turn/);
    assert.equal(provider.calls.length, 1);
    response.resolve(textMessage("user response"));
    const [, a, b] = await outcomes;
    assert.equal(a?.run.id, b?.run.id);
    assert.equal(provider.calls.length, 2);
    assert.equal(controller.getSnapshot().agentRuns.length, 2);
    assert.equal(
      JSON.stringify(controller.leadAgentState.messages).includes("rejected input"),
      false,
    );
    assert.equal(resultMessages(controller).length, 1);
  },
);

test(
  "cancel suppresses a queued wake and retains its owner's completed result",
  { timeout: 5_000 },
  async (t) => {
    const entered = Promise.withResolvers<void>();
    const provider = fakeProvider(
      (_request, call) =>
        new Promise((resolve) => {
          entered.resolve();
          call.options?.signal?.addEventListener("abort", () => resolve(textMessage("late")), {
            once: true,
          });
        }),
    );
    const controller = await create(t, provider);
    const turn = controller.handleUserMessage("work");
    await entered.promise;
    const runId = controller.getSnapshot().agentRuns[0]!.id;
    settle(controller, "owned", runId);
    const wake = controller.handleAutoWake("async_work_finished");
    await controller.cancelRun(runId);
    await turn;
    assert.equal(await wake, undefined);
    assert.equal(await controller.handleAutoWake("async_work_finished"), undefined);
    assert.equal(provider.calls.length, 1);
    assert.equal(controller.appContext.inbox.getResults().length, 1);
    assert.equal(resultMessages(controller).length, 0);
  },
);

test(
  "cancelling an older run preserves a wake for another run's result",
  { timeout: 5_000 },
  async (t) => {
    const entered = Promise.withResolvers<void>();
    const response = Promise.withResolvers<ReturnType<typeof textMessage>>();
    let calls = 0;
    const provider = fakeProvider(() => {
      if (++calls === 2) {
        entered.resolve();
        return response.promise;
      }
      return textMessage("done");
    });
    const controller = await create(t, provider);
    const older = await controller.handleUserMessage("first");
    const current = controller.handleUserMessage("second");
    await entered.promise;
    const currentRun = controller.getSnapshot().agentRuns.at(-1)!;
    settle(controller, "older", older.run.id);
    settle(controller, "current", currentRun.id);
    const wake = controller.handleAutoWake("async_work_finished");
    await controller.cancelRun(older.run.id);
    response.resolve(textMessage("second done"));
    await current;
    assert.equal((await wake)?.run.trigger.type, "auto_wake");
    assert.equal(provider.calls.length, 3);
    assert.equal(resultMessages(controller).length, 1);
    assert.match(resultMessages(controller)[0]!, /result current/);
    assert.doesNotMatch(resultMessages(controller)[0]!, /result older/);
  },
);
