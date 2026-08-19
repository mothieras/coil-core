import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { SessionStore } from "../src/core/session/store/sessionStore.js";
import { createSessionRecord } from "../src/core/session/types.js";

test("listSessions returns session records newest-first, ignoring junk dirs", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "coil-list-"));
  const store = new SessionStore(root);
  const a = createSessionRecord({
    workspaceRoot: root,
    id: "a",
    title: "older",
    now: "2026-01-01T00:00:00.000Z",
  });
  const b = createSessionRecord({
    workspaceRoot: root,
    id: "b",
    title: "newer",
    now: "2026-01-02T00:00:00.000Z",
  });
  await store.create(a);
  await store.create(b);
  // a junk dir with no session.json must be skipped
  await fs.mkdir(path.join(root, ".coil", "sessions", "junk"), { recursive: true });

  const list = await store.listSessions();
  assert.deepEqual(
    list.map((s) => s.id),
    ["b", "a"],
  );
  assert.equal(list[0]?.title, "newer");
});

test("listSessions returns empty array when no sessions dir exists", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "coil-list-empty-"));
  const store = new SessionStore(root);
  assert.deepEqual(await store.listSessions(), []);
});
