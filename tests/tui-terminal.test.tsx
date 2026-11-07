import test from "node:test";
import assert from "node:assert/strict";
import { PassThrough, Writable } from "node:stream";
import { stripVTControlCharacters } from "node:util";
import React from "react";
import { TerminalInput, renderTerminal, type TerminalMouseEvent } from "../src/tui/terminal.js";
import { App } from "../src/tui/components/App.js";
import { createTuiState } from "../src/tui/state.js";
import { createEmptySessionSnapshot } from "../src/core/session/projection/projection.js";
import type { UseSessionApi } from "../src/tui/useSession.js";

class InputStream extends PassThrough {
  isTTY = true;
  raw = false;
  setRawMode(value: boolean): this {
    this.raw = value;
    return this;
  }
  ref(): this {
    return this;
  }
  unref(): this {
    return this;
  }
}
class OutputStream extends Writable {
  isTTY = true;
  columns = 80;
  rows = 24;
  frames: string[] = [];
  override _write(
    chunk: Buffer,
    _encoding: BufferEncoding,
    callback: (error?: Error | null) => void,
  ): void {
    this.frames.push(chunk.toString());
    callback();
  }
  frame(): string {
    return stripVTControlCharacters(this.frames.findLast((frame) => frame.includes("coil")) ?? "");
  }
}
const wait = (ms = 60) => new Promise((resolve) => setTimeout(resolve, ms));
const mouse = (code: number, x = 10, y = 8, release = false) =>
  `\x1b[<${code};${x};${y}${release ? "m" : "M"}`;
const asInput = (stream: InputStream) => stream as unknown as NodeJS.ReadStream;
const asOutput = (stream: OutputStream) => stream as unknown as NodeJS.WriteStream;

test("terminal input separates fragmented mouse reports, UTF-8 keys, and literal bracketed paste", async () => {
  const source = new InputStream();
  const output = new OutputStream();
  const input = new TerminalInput(asInput(source), asOutput(output));
  const events: TerminalMouseEvent[] = [];
  let keys = "";
  input.on("data", (chunk: Buffer) => {
    keys += chunk.toString();
  });
  input.on("coil:mouse", (event: TerminalMouseEvent) => {
    if (!event.fallback) events.push({ ...event });
  });
  input.setRawMode(true);
  const original = `中${mouse(64)}${mouse(73)}${mouse(0, 80, 5)}${mouse(32, 80, 8)}${mouse(0, 80, 8, true)}\x1b[Ahello`;
  for (const byte of Buffer.from(original)) source.write(Buffer.from([byte]));
  const paste = `\x1b[200~literal ${mouse(64)}\n😀abcd\x1b[201~`;
  for (const byte of Buffer.from(paste)) source.write(Buffer.from([byte]));
  source.write(mouse(66)); // horizontal wheel is consumed without vertical movement
  source.write("\x1b");
  await wait(80);
  assert.equal(keys, `中\x1b[Ahello${paste}\x1b`);
  assert.deepEqual(
    events.map((event) => [event.kind, event.remaining]),
    [
      ["wheel", -1],
      ["wheel", 5],
      ["press", 0],
      ["move", 0],
      ["release", 0],
    ],
  );
  assert.equal(source.raw, true);
  input.dispose();
  assert.equal(source.raw, false);
  const modes = output.frames.join("");
  assert.match(modes, /\x1b\[\?1006h/);
  assert.match(modes, /\x1b\[\?1006l/);
  assert.equal(source.listenerCount("data"), 0);
});

function sessionFixture(input = "draft"): UseSessionApi {
  const snapshot = createEmptySessionSnapshot();
  snapshot.session = {
    id: "mouse-session",
    workspaceRoot: "/test/coil",
    title: "Mouse test",
    status: "active",
    createdAt: "t",
    updatedAt: "t",
  };
  snapshot.conversationMessages = [
    {
      id: "long",
      sessionId: "mouse-session",
      role: "assistant",
      source: "agent_result",
      content: Array.from({ length: 100 }, (_, i) => `line-${String(i).padStart(3, "0")}`).join(
        "\n",
      ),
      createdAt: "t",
    },
  ];
  return {
    state: createTuiState(snapshot),
    phase: "idle",
    busy: false,
    permission: null,
    input,
    setInput: () => {
      throw new Error("mouse report reached the editor");
    },
    submit: () => {
      throw new Error("unexpected submission");
    },
    decide: () => {
      throw new Error("unexpected approval");
    },
    interrupt: () => {},
    cancel: () => {},
    quit: () => {},
    history: [],
  };
}
function mount(session: UseSessionApi) {
  const source = new InputStream();
  const output = new OutputStream();
  const instance = renderTerminal(<App session={session} />, {
    stdin: asInput(source),
    stdout: asOutput(output),
    debug: true,
    patchConsole: false,
  });
  return { source, output, instance };
}
const firstLine = (frame: string) => Number(frame.match(/line-(\d+)/)?.[1]);

test("real Ink input handles wheel bursts, preserves history and supports clicking Latest and dragging the scrollbar", async () => {
  const session = sessionFixture();
  const { source, output, instance } = mount(session);
  try {
    await wait();
    const initial = firstLine(output.frame());
    assert.match(output.frame(), /line-099/);
    source.write(mouse(64).repeat(12));
    await wait();
    assert.equal(firstLine(output.frame()), initial - 12, "every trackpad event moves one line");
    assert.match(output.frame(), /Reading history/);
    assert.match(output.frame(), /draft/);
    const snapshot = session.state.snapshot;
    snapshot.conversationMessages.push({
      ...snapshot.conversationMessages[0]!,
      id: "new",
      content: "new-result",
    });
    session.state = createTuiState(snapshot);
    instance.rerender(<App session={session} />);
    await wait();
    assert.equal(firstLine(output.frame()), initial - 12);
    const rows = output.frame().split("\n");
    const latestRow = rows.findIndex((line) => line.includes("Latest"));
    source.write(mouse(0, rows[latestRow]!.indexOf("Latest") + 1, latestRow + 1));
    await wait();
    assert.match(output.frame(), /new-result/);
    assert.doesNotMatch(output.frame(), /Reading history/);
    // Grab the scrollbar thumb at the bottom, drag to its top, then release.
    source.write(mouse(0, 80, 19) + mouse(32, 80, 4) + mouse(0, 80, 4, true));
    await wait();
    assert.match(output.frame(), /line-000/);
    source.write(mouse(65).repeat(150));
    await wait();
    assert.match(output.frame(), /new-result/);
    assert.doesNotMatch(output.frame(), /Reading history/);
  } finally {
    instance.unmount();
  }
  assert.equal(source.raw, false);
  assert.match(output.frames.join(""), /\x1b\[\?1006l/);
});

test("wheel follows the pointer over long drafts and falls back to conversation over an unscrollable composer", async () => {
  const session = sessionFixture(Array.from({ length: 50 }, (_, i) => `draft-${i}`).join("\n"));
  const { source, output, instance } = mount(session);
  try {
    await wait();
    const first = firstLine(output.frame());
    source.write(mouse(64, 10, 18).repeat(5));
    await wait();
    assert.equal(firstLine(output.frame()), first);
    assert.doesNotMatch(output.frame(), /draft-49/);
    source.write(mouse(64, 10, 4));
    await wait();
    assert.equal(firstLine(output.frame()), first - 1);
    session.input = "draft";
    instance.rerender(<App session={session} />);
    await wait();
    const before = firstLine(output.frame());
    source.write(mouse(64, 10, 21));
    await wait();
    assert.equal(firstLine(output.frame()), before - 1);
  } finally {
    instance.unmount();
  }
});

test("wheel over a permission preview reveals its context without approving or typing", async () => {
  const session = sessionFixture();
  session.busy = true;
  session.phase = "thinking";
  session.permission = {
    id: "p1",
    toolName: "edit_file",
    reason: "Review this change before allowing it.",
    input: {
      filepath: "src/demo.ts",
      old_text: Array.from({ length: 8 }, (_, i) => `old ${i}`).join("\n"),
      new_text: Array.from({ length: 8 }, (_, i) => `new ${i}`).join("\n"),
    },
  };
  const { source, output, instance } = mount(session);
  try {
    output.rows = 16;
    output.emit("resize");
    await wait();
    assert.match(output.frame(), /Yes, allow once/);
    source.write(mouse(64, 10, 12).repeat(30));
    await wait();
    assert.match(output.frame(), /Permission required/);
    assert.match(output.frame(), /Review this change/);
    assert.equal(output.frame().trimEnd().split("\n").length, 16);
  } finally {
    instance.unmount();
  }
});

test("slowly split mouse reports stay out of text and a paste preserves emoji at chunk boundaries", async () => {
  const source = new InputStream();
  const output = new OutputStream();
  const input = new TerminalInput(asInput(source), asOutput(output));
  let keys = "";
  let wheels = 0;
  input.on("data", (chunk: Buffer) => {
    keys += chunk.toString();
  });
  input.on("coil:mouse", (event: TerminalMouseEvent) => {
    if (!event.fallback) wheels += 1;
  });
  try {
    source.write("\x1b[<64;");
    await wait(80);
    assert.equal(keys, "");
    source.write("10;8M");
    source.write("\x1b[200~");
    source.write("😀abcd");
    source.write("\x1b[201~");
    await wait();
    assert.equal(wheels, 1);
    assert.equal(keys, "\x1b[200~😀abcd\x1b[201~");
  } finally {
    input.dispose();
  }
});
