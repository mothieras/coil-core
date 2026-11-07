import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { SessionController } from "../src/core/session/controller.js";
import { SessionStore } from "../src/core/session/store/sessionStore.js";
import { fakeProvider, textMessage } from "./helpers/pi.js";

async function create(t: TestContext) {
  const workspaceRoot = await fs.mkdtemp(path.join(tmpdir(), "coil-delivery-"));
  t.after(() => fs.rm(workspaceRoot, { recursive: true, force: true }));
  const sessionId = "delivery";
  const store = new SessionStore(workspaceRoot);
  const provider = fakeProvider(() => textMessage("collected"));
  const options = { workspaceRoot, sessionId, store, provider };
  const controller = await SessionController.createNew({ ...options, title: "Delivery" });
  const journal = path.join(store.pathForSession(sessionId), "events.jsonl");
  const notification = {
    id: "job",
    kind: "subagent" as const,
    status: "running" as const,
    result: "",
    record: { id: "job", status: "running", promptSummary: "child work" },
  };
  controller.appContext.inbox.register(notification);
  await controller.flush();
  const settle = () =>
    controller.appContext.inbox.settle({
      ...notification,
      status: "completed",
      result: "FULL_ASYNC_RESULT_" + "x".repeat(2000),
      record: { ...notification.record, status: "completed", resultSummary: "summary" },
    });
  const resume = () => SessionController.resume(options);
  return { controller, provider, journal, store, options, settle, resume };
}

function delivered(controller: SessionController) {
  return controller.leadAgentState.messages.filter(
    (message) =>
      message.role === "user" &&
      typeof message.content === "string" &&
      message.content.includes("FULL_ASYNC_RESULT_"),
  );
}

test("saved results recover in full and their message handoff is not applied twice", async (t) => {
  const session = await create(t);
  session.settle();
  await session.controller.flush();
  const resumed = await session.resume();
  assert.equal(resumed.appContext.inbox.getResults()[0]?.result.length, 2018);
  assert.equal(resumed.hasPendingAsyncWork(), true);
  await resumed.handleAutoWake("async_work_finished");
  assert.equal(delivered(resumed).length, 1);
  const reopened = await session.resume();
  assert.equal(delivered(reopened).length, 1);
  assert.equal(await reopened.handleAutoWake("async_work_finished"), undefined);
  assert.equal(reopened.appContext.inbox.getResults().length, 1);
  const events = await fs.readFile(session.journal, "utf8");
  assert.equal(events.includes("FULL_ASYNC_RESULT_"), false);
});

test("failure after injection but before message confirmation recovers the pending result", async (t) => {
  const session = await create(t);
  session.settle();
  await session.controller.flush();
  const append = fs.appendFile;
  const failure = new Error("handoff disk failure");
  t.mock.method(fs, "appendFile", async (...args: Parameters<typeof append>) => {
    if (args[0] === session.journal && String(args[1]).includes('"awaitingModel":true'))
      throw failure;
    await append(...args);
  });
  await assert.rejects(
    session.controller.handleAutoWake("async_work_finished"),
    (error) => error === failure,
  );
  assert.equal(session.provider.calls.length, 0);
  assert.equal(session.controller.appContext.inbox.getResults().length, 1);
  const resumed = await session.resume();
  assert.equal(delivered(resumed).length, 0);
  assert.equal(resumed.hasPendingAsyncWork(), true);
  t.mock.restoreAll();
  await resumed.handleAutoWake("async_work_finished");
  assert.equal(delivered(resumed).length, 1);
});

test("a partial handoff append can be retried without duplicate messages or results", async (t) => {
  const session = await create(t);
  session.settle();
  await session.controller.flush();
  const append = fs.appendFile;
  let injected = false;
  t.mock.method(fs, "appendFile", async (...args: Parameters<typeof append>) => {
    if (
      !injected &&
      args[0] === session.journal &&
      String(args[1]).includes('"awaitingModel":true')
    ) {
      injected = true;
      await append(args[0], Buffer.from(args[1] as Uint8Array).subarray(0, 31));
      throw new Error("partial handoff append");
    }
    await append(...args);
  });
  await assert.rejects(session.controller.handleAutoWake("async_work_finished"), /partial handoff/);
  assert.equal(delivered(session.controller).length, 1);
  await session.controller.flush();
  const resumed = await session.resume();
  assert.equal(delivered(resumed).length, 1);
  assert.equal(resumed.hasPendingAsyncWork(), false);
  assert.equal(await resumed.handleAutoWake("async_work_finished"), undefined);
});

test("a failed derived snapshot after confirmed handoff does not redeliver", async (t) => {
  const session = await create(t);
  session.settle();
  await session.controller.flush();
  t.mock.method(
    session.store,
    "saveSnapshot",
    async () => {
      throw new Error("derived snapshot failure");
    },
    { times: 1 },
  );
  await assert.rejects(
    session.controller.handleAutoWake("async_work_finished"),
    /derived snapshot failure/,
  );
  const resumed = await session.resume();
  assert.equal(delivered(resumed).length, 1);
  assert.equal(resumed.hasPendingAsyncWork(), false);
  assert.equal(await resumed.handleAutoWake("async_work_finished"), undefined);
});

test("a failed completion save keeps the result inspectable and recovery marks its outcome unknown", async (t) => {
  const session = await create(t);
  const append = fs.appendFile;
  const failure = new Error("completion save failure");
  t.mock.method(fs, "appendFile", async (...args: Parameters<typeof append>) => {
    if (args[0] === session.journal && String(args[1]).includes('"type":"subagent_finished"'))
      throw failure;
    await append(...args);
  });
  session.settle();
  await assert.rejects(session.controller.flush(), (error) => error === failure);
  assert.equal(session.controller.appContext.inbox.getResults().length, 1);
  await assert.rejects(
    session.controller.handleAutoWake("async_work_finished"),
    (error) => error === failure,
  );
  await assert.rejects(session.controller.waitForAsyncWork(), (error) => error === failure);
  const resumed = await session.resume();
  assert.equal(resumed.appContext.inbox.getResults().length, 0);
  assert.equal(resumed.getSnapshot().recovery?.pending[0]?.id, "subagent:job");
  assert.equal(session.provider.calls.length, 0);
});

test(
  "an earlier queued flush cannot acknowledge results injected into a later context",
  { timeout: 5_000 },
  async (t) => {
    const session = await create(t);
    session.settle();
    await session.controller.flush();
    session.controller.recordReportWritten({ id: "barrier", title: "Barrier", path: "barrier.md" });
    const writing = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const injected = Promise.withResolvers<void>();
    session.controller.appContext.hooks.register("PreLLMCall", () => injected.resolve());
    const append = fs.appendFile;
    t.mock.method(fs, "appendFile", async (...args: Parameters<typeof append>) => {
      if (args[0] === session.journal) {
        const rows = String(args[1]);
        if (rows.includes('"type":"report_written"')) {
          writing.resolve();
          await release.promise;
        }
        if (rows.includes('"awaitingModel":true')) throw new Error("later context save failure");
      }
      await append(...args);
    });
    const flush = session.controller.flush();
    await writing.promise;
    const wake = assert.rejects(
      session.controller.handleAutoWake("async_work_finished"),
      /later context save failure/,
    );
    await injected.promise;
    release.resolve();
    await Promise.all([flush, wake]);
    const resumed = await session.resume();
    assert.equal(delivered(resumed).length, 0);
    assert.equal(resumed.hasPendingAsyncWork(), true);
    assert.equal(resumed.appContext.inbox.captureResults()[0]?.delivered, false);
  },
);
