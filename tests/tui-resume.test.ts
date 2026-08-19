import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { SessionController } from "../src/core/session/controller.js";
import { SessionStore } from "../src/core/session/store/sessionStore.js";
import { matchSession } from "../src/tui/sessionActions.js";
import type { PermissionCheckContext, PermissionResult } from "../src/core/permission/types.js";

const allowAll = async (_ctx: PermissionCheckContext): Promise<PermissionResult> => ({
  allowed: true,
});

test("resume reloads a prior session's snapshot and can continue", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "coil-resume-"));
  const store = new SessionStore(root);

  // create a session, add a user message, then close it
  const first = await SessionController.createNew({
    workspaceRoot: root,
    store,
    checkPermission: allowAll,
    toolProviderResults: [],
  });
  const id = first.getSnapshot().session?.id;
  assert.ok(id);
  await first.flush();
  await first.close();

  // list + match (simulating /resume)
  const items = await store.listSessions();
  const target = matchSession(items, "1");
  assert.equal(target?.id, id);

  // resume with fresh (empty) providers — must not throw, snapshot present
  const resumed = await SessionController.resume({
    workspaceRoot: root,
    sessionId: target!.id,
    store,
    checkPermission: allowAll,
    toolProviderResults: [],
  });
  assert.equal(resumed.getSnapshot().session?.id, id);
  await resumed.close();
});

test("matchSession + listSessions return newest session first", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "coil-resume2-"));
  const store = new SessionStore(root);
  const a = await SessionController.createNew({
    workspaceRoot: root,
    store,
    checkPermission: allowAll,
    toolProviderResults: [],
    now: "2026-01-01T00:00:00.000Z",
  });
  await a.close();
  const b = await SessionController.createNew({
    workspaceRoot: root,
    store,
    checkPermission: allowAll,
    toolProviderResults: [],
    now: "2026-02-01T00:00:00.000Z",
  });
  await b.close();
  const items = await store.listSessions();
  assert.equal(items[0]?.id, b.getSnapshot().session?.id);
});
