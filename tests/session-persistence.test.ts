import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { SessionController } from "../src/core/session/controller.js";
import { SessionStore } from "../src/core/session/store/sessionStore.js";
import type { CreateSessionControllerOptions } from "../src/core/session/controller.js";
import { fakeProvider, textMessage, toolCall, toolCallMessage } from "./helpers/pi.js";

async function create(t: TestContext, options: Partial<CreateSessionControllerOptions> = {}) {
  const workspaceRoot = await fs.mkdtemp(path.join(tmpdir(), "coil-persistence-"));
  t.after(() => fs.rm(workspaceRoot, { recursive: true, force: true }));
  const store = new SessionStore(workspaceRoot);
  const sessionId = "durable";
  const controller = await SessionController.createNew({
    workspaceRoot,
    sessionId,
    store,
    title: "Persistence test",
    ...options,
  });
  const directory = store.pathForSession(sessionId);
  return {
    controller,
    workspaceRoot,
    sessionId,
    store,
    directory,
    journal: path.join(directory, "events.jsonl"),
  };
}

const calls = [
  toolCall("write_file", { path: "effect", content: "first" }, "write"),
  toolCall("background_run", { command: "printf started > background-effect" }, "background"),
  toolCall("subagent", { prompt: "child work" }, "child"),
];

for (const call of calls) {
  test(`an intent write failure prevents ${call.name} from running`, async (t) => {
    const provider = fakeProvider(() => toolCallMessage([call]));
    let checked = 0;
    const session = await create(t, {
      provider,
      checkPermission: async () => {
        checked++;
        return { allowed: true };
      },
      onSessionEvent: () => {
        throw new Error("observers are isolated");
      },
    });
    const error = new Error("intent disk failure");
    const append = fs.appendFile;
    t.mock.method(fs, "appendFile", async (...args: Parameters<typeof append>) => {
      if (
        args[0] === session.journal &&
        String(args[1]).includes('"type":"tool_execution_intended"')
      )
        throw error;
      await append(...args);
    });
    const { controller, workspaceRoot } = session;
    await assert.rejects(controller.handleUserMessage("act"), (cause) => cause === error);
    assert.equal(checked, 1);
    assert.equal(provider.calls.length, 1);
    assert.equal(controller.getSnapshot().toolCalls[0]?.dispatched, false);
    assert.equal(controller.getSnapshot().backgroundCommands.length, 0);
    assert.equal(controller.getSnapshot().subagents.length, 0);
    await assert.rejects(fs.access(path.join(workspaceRoot, "effect")), { code: "ENOENT" });
    await assert.rejects(fs.access(path.join(workspaceRoot, "background-effect")), {
      code: "ENOENT",
    });
    await assert.rejects(controller.handleUserMessage("try again"), (cause) => cause === error);

    const resumed = await SessionController.resume(session);
    assert.equal(resumed.getSnapshot().recovery?.modelResponseUnconfirmed, true);
    assert.deepEqual(resumed.getSnapshot().recovery?.pending, []);
  });
}

test("a result write failure exposes its cause and prevents subsequent dispatch", async (t) => {
  const provider = fakeProvider(() =>
    toolCallMessage([
      calls[0]!,
      toolCall("write_file", { path: "skipped", content: "second" }, "second"),
    ]),
  );
  const session = await create(t, { provider });
  const error = new Error("result disk failure");
  const decisionError = new Error("decision disk failure");
  const append = fs.appendFile;
  let failDecision = false;
  t.mock.method(fs, "appendFile", async (...args: Parameters<typeof append>) => {
    if (args[0] === session.journal) {
      const rows = String(args[1]);
      if (rows.includes('"type":"tool_execution_recorded"')) throw error;
      if (failDecision && rows.includes('"type":"recovery_resolved"')) throw decisionError;
    }
    await append(...args);
  });
  const { controller, workspaceRoot } = session;
  await assert.rejects(controller.handleUserMessage("act"), (cause) => cause === error);
  assert.equal(await fs.readFile(path.join(workspaceRoot, "effect"), "utf8"), "first");
  await assert.rejects(fs.access(path.join(workspaceRoot, "skipped")), { code: "ENOENT" });
  assert.equal(provider.calls.length, 1);
  assert.equal(controller.getSnapshot().toolCalls.at(-1)?.status, "not_executed");
  const resumed = await SessionController.resume(session);
  const pending = resumed.getSnapshot().recovery?.pending[0];
  assert.equal(pending?.name, "write_file");
  assert.ok(pending);
  await assert.rejects(resumed.handleAutoWake("async_work_finished"), /outcome unknown/);

  failDecision = true;
  await assert.rejects(
    resumed.resolveRecovery(pending.id, "discarded"),
    (cause) => cause === decisionError,
  );
  assert.deepEqual(resumed.getSnapshot().recovery?.pending, [pending]);
  failDecision = false;
  await resumed.flush();
  assert.deepEqual(resumed.getSnapshot().recovery?.pending, []);
  assert.deepEqual((await SessionController.resume(session)).getSnapshot().recovery?.pending, []);
});

test(
  "recovery reports durable launches with unfinished child and background work",
  { timeout: 10_000 },
  async (t) => {
    const provider = fakeProvider((request, call) => {
      if (request.system?.startsWith("You are a subagent")) {
        return new Promise((resolve) => {
          const signal = call.options?.signal;
          const stop = () => resolve(textMessage("Child stopped"));
          if (signal?.aborted) stop();
          else signal?.addEventListener("abort", stop, { once: true });
        });
      }
      return request.messages.at(-1)?.role === "user"
        ? toolCallMessage([
            toolCall("background_run", { command: "sleep 30" }, "background"),
            calls[2]!,
          ])
        : textMessage("Both jobs launched.");
    });
    const session = await create(t, { provider });
    try {
      await session.controller.handleUserMessage("launch");
      assert.equal(session.controller.hasPendingAsyncWork(), true);
      // Load the last checkpoint without taking ownership of the original jobs.
      const resumed = await SessionController.resume(session);
      const snapshot = resumed.getSnapshot();
      assert.deepEqual(
        snapshot.recovery?.pending.map((item) => item.kind),
        ["background", "subagent"],
      );
      assert.equal(snapshot.backgroundCommands[0]?.status, "interrupted");
      assert.equal(snapshot.subagents[0]?.status, "interrupted");
      assert.equal(resumed.hasPendingAsyncWork(), false);
      await assert.rejects(resumed.handleAutoWake("async_work_finished"), /outcome unknown/);
    } finally {
      await session.controller.close();
    }
  },
);

for (const written of ["nothing", "prefix", "everything"] as const) {
  test(`flush retries the same batch after an append wrote ${written}`, async (t) => {
    const session = await create(t);
    const error = new Error("append acknowledgement failed");
    const append = fs.appendFile;
    t.mock.method(
      fs,
      "appendFile",
      async (...args: Parameters<typeof append>) => {
        const [file, data, options] = args;
        assert.equal(file, session.journal);
        assert.ok(Buffer.isBuffer(data));
        if (written === "prefix")
          await append(file, data.subarray(0, Math.floor(data.length / 2)), options);
        if (written === "everything") await append(...args);
        throw error;
      },
      { times: 1 },
    );
    const { controller } = session;
    recordReport(controller, "first");
    await assert.rejects(controller.flush(), (cause) => cause === error);
    recordReport(controller, "second");
    await controller.flush();
    const saved = await fs.readFile(session.journal, "utf8");
    await controller.flush();
    assert.equal(await fs.readFile(session.journal, "utf8"), saved);
    assert.equal(saved.match(/"type":"report_written"/g)?.length, 2);
    const resumed = await SessionController.resume(session);
    assert.deepEqual(
      resumed.getSnapshot().reports.map((report) => report.id),
      ["first", "second"],
    );
  });
}

test("unexpected append bytes prevent retry and are preserved", async (t) => {
  const session = await create(t);
  const append = fs.appendFile;
  t.mock.method(
    fs,
    "appendFile",
    async (file: string) => {
      await append(file, "unexpected bytes");
      throw new Error("ambiguous append failure");
    },
    { times: 1 },
  );
  recordReport(session.controller, "failed");
  await assert.rejects(session.controller.flush(), /ambiguous append failure/);
  const broken = await fs.readFile(session.journal);
  await assert.rejects(session.controller.flush(), /unexpected bytes after the last checkpoint/);
  assert.deepEqual(await fs.readFile(session.journal), broken);
});

test("concurrent flushes keep each derived snapshot at its confirmed event boundary", async (t) => {
  const session = await create(t);
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const append = fs.appendFile;
  t.mock.method(
    fs,
    "appendFile",
    async (...args: Parameters<typeof append>) => {
      entered.resolve();
      await release.promise;
      await append(...args);
    },
    { times: 1 },
  );
  const views: string[][] = [];
  const saveSnapshot = session.store.saveSnapshot.bind(session.store);
  t.mock.method(session.store, "saveSnapshot", async (...args: Parameters<typeof saveSnapshot>) => {
    views.push(args[1].reports.map((report) => report.id));
    await saveSnapshot(...args);
  });

  recordReport(session.controller, "first");
  const first = session.controller.flush();
  await entered.promise;
  recordReport(session.controller, "second");
  const second = session.controller.flush();
  release.resolve();
  await Promise.all([first, second]);
  assert.deepEqual(views, [["first"], ["first", "second"]]);
  assert.deepEqual(
    (await session.store.loadSnapshot(session.sessionId)).reports.map((report) => report.id),
    ["first", "second"],
  );
});

test("a torn tail is reported on read and preserved when continuing from the verified prefix", async (t) => {
  const session = await create(t, { provider: fakeProvider(() => textMessage("first answer")) });
  await session.controller.handleUserMessage("first question");
  const event = JSON.stringify({
    type: "session_titled",
    id: "uncommitted-tail",
    sessionId: session.sessionId,
    timestamp: new Date().toISOString(),
    title: "unconfirmed",
  });
  const partial = `${event}\n{"type":"checkp`;
  await fs.appendFile(session.journal, partial);
  const original = await fs.readFile(session.journal);

  const resumed = await SessionController.resume({
    ...session,
    provider: fakeProvider(() => textMessage("second answer")),
  });
  assert.equal(resumed.getSnapshot().session?.title, "Persistence test");
  assert.equal(resumed.getSnapshot().recovery?.ignoredJournalBytes, Buffer.byteLength(partial));
  assert.deepEqual(await fs.readFile(session.journal), original);
  await resumed.handleUserMessage("continue");
  const archive = (await fs.readdir(session.directory)).find((file) =>
    file.startsWith("events.jsonl.partial-"),
  );
  assert.ok(archive);
  assert.deepEqual(await fs.readFile(path.join(session.directory, archive)), original);
  const next = await SessionController.resume(session);
  assert.equal(next.getSnapshot().conversationMessages.at(-1)?.content, "second answer");
  assert.equal(next.getSnapshot().recovery?.ignoredJournalBytes, undefined);
});

test("a damaged committed record fails recovery without modifying the journal", async (t) => {
  const session = await create(t);
  recordReport(session.controller, "first");
  await session.controller.flush();
  recordReport(session.controller, "second");
  await session.controller.flush();
  const damaged = (await fs.readFile(session.journal, "utf8")).replace(
    '"id":"first"',
    '"id":"other"',
  );
  await fs.writeFile(session.journal, damaged);
  await assert.rejects(
    SessionController.resume(session),
    /Cannot recover session .*invalid checkpoint/,
  );
  assert.equal(await fs.readFile(session.journal, "utf8"), damaged);
});

test("the legacy append API cannot write unframed events to a checkpoint session", async (t) => {
  const session = await create(t);
  const saved = await fs.readFile(session.journal);
  await assert.rejects(
    session.store.appendEvents(session.sessionId, [
      {
        type: "session_closed",
        sessionId: session.sessionId,
        id: "unframed",
        timestamp: new Date().toISOString(),
      },
    ]),
    /Use SessionController/,
  );
  assert.deepEqual(await fs.readFile(session.journal), saved);
});

function recordReport(controller: SessionController, id: string): void {
  controller.recordReportWritten({ id, title: id, path: `${id}.md` });
}
