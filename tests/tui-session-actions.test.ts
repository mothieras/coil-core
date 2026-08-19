import test from "node:test";
import assert from "node:assert/strict";
import {
  drainTurn,
  matchSession,
  formatSessionList,
  type TurnController,
  type TurnPhase,
} from "../src/tui/sessionActions.js";
import type { SessionListItem } from "../src/core/session/store/sessionStore.js";

function fakeController(asyncRounds: number): TurnController & { autoWakes: number } {
  let remaining = asyncRounds;
  return {
    autoWakes: 0,
    async handleUserMessage() {},
    hasPendingAsyncWork() {
      return remaining > 0;
    },
    async waitForAsyncWork() {
      remaining -= 1;
      return "completed";
    },
    async handleAutoWake() {
      (this as { autoWakes: number }).autoWakes += 1;
    },
  };
}

test("drainTurn runs the message then auto-wakes until no pending work", async () => {
  const c = fakeController(2);
  const phases: TurnPhase[] = [];
  await drainTurn("hi", { controller: c, onPhase: (p) => phases.push(p), shouldStop: () => false });
  assert.equal(c.autoWakes, 2);
  assert.equal(phases.at(0), "thinking");
  assert.equal(phases.at(-1), "idle");
});

test("drainTurn stops auto-wake loop when interrupted", async () => {
  const c: TurnController & { autoWakes: number } = {
    autoWakes: 0,
    async handleUserMessage() {},
    hasPendingAsyncWork() {
      return true;
    },
    async waitForAsyncWork() {
      return "interrupted";
    },
    async handleAutoWake() {
      (this as { autoWakes: number }).autoWakes += 1;
    },
  };
  await drainTurn("hi", { controller: c, onPhase: () => {}, shouldStop: () => true });
  assert.equal(c.autoWakes, 0);
});

test("drainTurn emits idle in finally even when the turn throws", async () => {
  const phases: TurnPhase[] = [];
  const c: TurnController = {
    async handleUserMessage() {
      throw new Error("boom");
    },
    hasPendingAsyncWork() {
      return false;
    },
    async waitForAsyncWork() {
      return "completed";
    },
    async handleAutoWake() {},
  };
  await assert.rejects(
    drainTurn("hi", { controller: c, onPhase: (p) => phases.push(p), shouldStop: () => false }),
    /boom/,
  );
  assert.equal(phases.at(-1), "idle");
});

const items: SessionListItem[] = [
  { id: "abc123", title: "first", createdAt: "t1", updatedAt: "t3" },
  { id: "def456", title: "second", createdAt: "t2", updatedAt: "t2" },
];

test("matchSession resolves by 1-based index and by id prefix", () => {
  assert.equal(matchSession(items, "1")?.id, "abc123");
  assert.equal(matchSession(items, "2")?.id, "def456");
  assert.equal(matchSession(items, "def")?.id, "def456");
  assert.equal(matchSession(items, "zzz"), null);
});

test("formatSessionList numbers entries", () => {
  const text = formatSessionList(items);
  assert.match(text, /1\. abc123/);
  assert.match(text, /first/);
});
