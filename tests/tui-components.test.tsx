import test from "node:test";
import assert from "node:assert/strict";
import React from "react";
import { render } from "ink-testing-library";
import { App } from "../src/tui/components/App.js";
import { createTuiState } from "../src/tui/state.js";
import type { UseSessionApi } from "../src/tui/useSession.js";
import { LogLine } from "../src/tui/components/LogItem.js";
import { StatusBar, formatStatusLine } from "../src/tui/components/StatusBar.js";
import { RunningActivity } from "../src/tui/components/RunningActivity.js";
import { PermissionModal } from "../src/tui/components/PermissionModal.js";
import { Footer } from "../src/tui/components/Footer.js";
import {
  classifyInput,
  commandSuggestions,
  normalizePastedInput,
  Input,
} from "../src/tui/components/Input.js";
import { displayWidth } from "../src/tui/format.js";
import {
  borderStyleFor,
  shouldAnimateActivity,
  symbolsFor,
  TUI_SYMBOLS,
} from "../src/tui/theme.js";
import type { SessionSnapshot } from "../src/core/session/types.js";

const waitForInput = (ms = 50): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

function snap(): SessionSnapshot {
  return {
    session: {
      id: "sess9",
      workspaceRoot: "/r",
      createdAt: "t",
      updatedAt: "t",
      status: "active",
      title: "T",
    },
    conversationMessages: [],
    leadAgentMessages: [],
    agentRuns: [],
    toolCalls: [
      {
        id: "t1",
        sessionId: "sess9",
        runId: "r",
        agentId: "lead",
        agentKind: "lead",
        toolName: "bash",
        status: "running",
        startedAt: "t",
      },
    ],
    permissionDecisions: [],
    backgroundCommands: [],
    subagents: [],
    tasks: [],
    reports: [],
    mcpServers: [{ name: "demo", status: "connected", toolCount: 1, updatedAt: "t" }],
    usage: { inputTokens: 14, outputTokens: 6, apiCalls: 2, lastInputTokens: 9 },
  };
}

function frameOf(element: React.ReactElement): string {
  const app = render(element);
  const frame = app.lastFrame() ?? "";
  app.unmount();
  return frame;
}

function sessionApi(overrides: Partial<UseSessionApi> = {}): UseSessionApi {
  return {
    state: createTuiState(snap(), {}),
    phase: "idle",
    permission: null,
    input: "",
    history: [],
    setInput: () => {},
    submit: () => {},
    decide: () => {},
    interrupt: () => {},
    cancel: () => {},
    quit: () => {},
    busy: false,
    ...overrides,
  };
}

function InputHarness({
  history = [],
  submitted,
  busy = false,
}: {
  history?: string[];
  submitted?: string[];
  busy?: boolean;
}): React.ReactElement {
  const [value, setValue] = React.useState("");
  return (
    <Input
      value={value}
      onChange={setValue}
      busy={busy}
      disabled={false}
      history={history}
      onSubmit={(next) => {
        submitted?.push(next);
        setValue("");
      }}
    />
  );
}

test("LogLine keeps conversation primary and tool traces scannable", () => {
  const user = frameOf(
    <LogLine item={{ id: "u", kind: "message", role: "user", title: "hello there" }} />,
  );
  const assistant = frameOf(
    <LogLine
      item={{
        id: "a",
        kind: "message",
        role: "assistant",
        title: "**done** with `fix()`\n\n- step",
      }}
    />,
  );
  const tool = frameOf(
    <LogLine
      item={{
        id: "tool:1",
        kind: "tool",
        title: "read_file",
        status: "completed",
        summary: '{"path":"src/main.ts"}',
        detail: "output (120 chars, 8 lines)",
        durationMs: 42,
      }}
    />,
  );

  assert.ok(user.includes(`${TUI_SYMBOLS.user} hello there`));
  assert.doesNotMatch(user, /YOU/);
  assert.ok(assistant.includes(TUI_SYMBOLS.assistant));
  assert.match(assistant, /done/);
  assert.doesNotMatch(assistant, /AGENT|\*\*/);
  assert.match(assistant, /fix\(\)|step/);
  assert.ok(tool.includes(`${TUI_SYMBOLS.success} Read file`));
  assert.match(tool, /Read file src\/main\.ts.*42ms.*output \(120 chars/s);
  assert.doesNotMatch(tool, /\{"path"/);
});

test("tool contract failures never render as success at 80 columns", () => {
  for (const status of ["invalid_input", "unavailable", "not_executed"]) {
    const frame = frameOf(
      <LogLine width={80} item={{ id: status, kind: "tool", title: "read_file", status }} />,
    );
    assert.ok(frame.includes(`${TUI_SYMBOLS.error} Read file`));
    assert.ok(!frame.includes(`${TUI_SYMBOLS.success} Read file`));
    assert.ok(frame.toLowerCase().includes(status.replaceAll("_", " ")));
    assert.ok(frame.split("\n").every((line) => displayWidth(line) <= 80));
  }
});

test("StatusBar prioritizes active work and fits terminal cell width", () => {
  const full = frameOf(<StatusBar snapshot={snap()} model="deepseek" />);
  for (const token of ["deepseek", "ctx≈9/50k", "run t1", "mcp 1"]) assert.ok(full.includes(token));
  assert.doesNotMatch(full, /sess9|↑14 ↓6/);

  const narrow = formatStatusLine(snap(), "provider/very-long-model-name", 60);
  assert.match(narrow, /^run t1 · r · .*ctx≈9\/50k/);
  assert.ok(displayWidth(narrow) <= 58);
  assert.doesNotMatch(narrow, /↑14|#sess9| · T · /);

  const loaded = snap();
  loaded.session = {
    ...loaded.session!,
    workspaceRoot: "/workspace/中文项目名称特别长特别长",
    title: "A very long generated session title that should be optional",
  };
  loaded.subagents = [
    { id: "s1", sessionId: "sess9", status: "running", promptSummary: "review everything" },
  ];
  loaded.backgroundCommands = [
    { id: "b1", sessionId: "sess9", status: "running", commandSummary: "pnpm test" },
  ];
  loaded.mcpServers = [{ name: "broken", status: "failed", reason: "offline", updatedAt: "t" }];
  const bounded = formatStatusLine(loaded, "提供商/超长模型名称特别长特别长", 80);
  assert.ok(displayWidth(bounded) <= 78);
  assert.match(bounded, /mcp !1.*run t1\/a1\/bg1|run t1\/a1\/bg1.*mcp !1/);
});

test("RunningActivity names foreground work", () => {
  const frame = frameOf(<RunningActivity snapshot={snap()} phase="thinking" animated={false} />);
  assert.match(frame, /Working.*Bash/s);
});

test("theme falls back to ASCII and reduced motion", () => {
  assert.equal(symbolsFor({}).brand, "⊙");
  assert.equal(symbolsFor({}).assistant, "⊙");
  assert.equal(symbolsFor({ TERM: "dumb" }).brand, "(o)");
  const symbols = symbolsFor({ TERM: "dumb" });
  assert.deepEqual([symbols.user, symbols.success, symbols.error], [">", "+", "x"]);
  assert.equal(borderStyleFor({ TERM: "dumb" }), "classic");
  assert.equal(shouldAnimateActivity({ TERM: "dumb" }), false);
  assert.equal(shouldAnimateActivity({ COIL_REDUCED_MOTION: "1" }), false);
});

test("input helpers classify commands, suggestions, and pasted newlines", () => {
  assert.deepEqual(classifyInput("  "), { kind: "empty", arg: "" });
  assert.deepEqual(classifyInput("fix the bug"), { kind: "message", arg: "fix the bug" });
  assert.deepEqual(classifyInput("/status"), { kind: "slash", arg: "/status" });
  assert.deepEqual(classifyInput("/resume 2"), { kind: "resume", arg: "2" });
  assert.deepEqual(classifyInput("/resumed"), { kind: "slash", arg: "/resumed" });
  assert.deepEqual(
    commandSuggestions("/res").map((item) => item.command),
    ["/resume"],
  );
  assert.deepEqual(commandSuggestions("plain text"), []);
  assert.deepEqual(commandSuggestions("/resume 2"), []);
  assert.equal(normalizePastedInput("/help\r"), "/help\n");
  assert.equal(
    normalizePastedInput("fix the bug\r\nthen run tests\n"),
    "fix the bug\nthen run tests\n",
  );
});

test("Input preserves a multiline paste until explicit submission", async () => {
  const submitted: string[] = [];
  const app = render(<InputHarness submitted={submitted} />);
  app.stdin.write("fix the bug\r\nthen run tests");
  await waitForInput();
  const frame = app.lastFrame() ?? "";
  assert.deepEqual(submitted, []);
  assert.match(frame, /fix the bug\s+then run tests/);
  app.stdin.write("\r");
  await waitForInput();
  app.unmount();

  assert.deepEqual(submitted, ["fix the bug\nthen run tests"]);
  assert.doesNotMatch(frame, /\r/);
});

test("Input recalls history with arrow keys", async () => {
  const app = render(<InputHarness history={["first command", "second command"]} />);
  for (const [key, expected] of [
    ["\x1b[A", /second command/],
    ["\x1b[A", /first command/],
    ["\x1b[B", /second command/],
  ] as const) {
    app.stdin.write(key);
    await waitForInput();
    assert.match(app.lastFrame() ?? "", expected);
  }
  app.unmount();
});

test("PermissionModal presents context, queue state, and diff", () => {
  const frame = frameOf(
    <PermissionModal
      request={{
        id: "p1",
        toolName: "edit_file",
        reason: "writes a tracked file",
        input: { filepath: "a.ts", old_text: "const a = 1;", new_text: "const a = 2;" },
        queueSize: 2,
      }}
      onDecision={() => {}}
    />,
  );

  assert.match(frame, /Edit file.*writes a tracked file/s);
  assert.match(frame, /a\.ts.*- const a = 1;.*\+ const a = 2;/s);
  assert.match(frame, /y.*allow|allow.*y/i);
  assert.match(frame, /Esc deny/);
  assert.match(frame, /2 queued/);
});

test("PermissionModal treats Escape as deny", async () => {
  const decisions: boolean[] = [];
  const app = render(
    <PermissionModal
      request={{ id: "p1", toolName: "bash", reason: "shell access", input: { command: "ls" } }}
      onDecision={(allow) => decisions.push(allow)}
    />,
  );
  app.stdin.write("\x1b");
  await waitForInput();
  app.unmount();
  assert.deepEqual(decisions, [false]);
});

test("App invokes only supported interrupt and quit paths", async () => {
  let interrupts = 0;
  let quits = 0;
  let cancels = 0;
  const base = sessionApi({
    interrupt: () => {
      interrupts += 1;
    },
    quit: () => {
      quits += 1;
    },
    cancel: () => {
      cancels += 1;
    },
  });
  const send = async (session: UseSessionApi, key: string): Promise<void> => {
    const app = render(<App session={session} />);
    app.stdin.write(key);
    await waitForInput();
    app.unmount();
  };

  await send(base, "\x1b");
  await send({ ...base, busy: true, phase: "thinking" }, "\x1b");
  assert.equal(interrupts, 0, "foreground cancellation does not just stop async waiting");
  assert.equal(cancels, 1, "ESC cancels foreground turns");

  await send({ ...base, busy: true, phase: "waiting-async" }, "\x1b");
  assert.equal(interrupts, 1, "ESC stops cooperative async waiting");

  await send(base, "\x03");
  await send({ ...base, busy: true, phase: "thinking" }, "\x03");
  assert.equal(quits, 1, "Ctrl+C quits only while idle");
  assert.equal(cancels, 2, "Ctrl+C also cancels a foreground turn");
  await send({ ...base, busy: true, phase: "thinking" }, "\x04");
  assert.equal(quits, 2, "Ctrl+D closes even while running");
});

test("App renders the transcript and composer together", () => {
  const snapshot = snap();
  snapshot.toolCalls = [];
  snapshot.conversationMessages = [
    {
      id: "m1",
      sessionId: "sess9",
      role: "user",
      content: "hello world",
      createdAt: "t",
      source: "user_input",
    },
  ];
  const frame = frameOf(
    <App session={sessionApi({ state: createTuiState(snapshot, { model: "deepseek" }) })} />,
  );

  assert.match(frame, /hello world/);
  assert.ok(frame.includes(`${TUI_SYMBOLS.brand} coil · deepseek`));
  assert.match(frame, /deepseek/);
  assert.ok(frame.includes(`${TUI_SYMBOLS.user} Ask anything, or describe a change`));
  assert.doesNotMatch(frame, /╭|╰|│|#sess9/);
});

test("composer, multiline messages and permission previews fit narrow terminals", () => {
  const text = "请检查这个函数的行为，然后说明修改的原因。";
  for (const width of [40, 80, 120]) {
    const message = frameOf(
      <LogLine
        width={width}
        item={{ id: "cn", kind: "message", role: "user", title: `${text}\n第二行` }}
      />,
    );
    assert.ok(message.includes("第二行"));
    const footer = frameOf(
      <Footer
        snapshot={snap()}
        width={width}
        phase="thinking"
        busy
        input={text}
        onInputChange={() => {}}
        onSubmit={() => {}}
        permission={null}
        onPermissionDecision={() => {}}
      />,
    );
    const permission = frameOf(
      <PermissionModal
        width={width}
        request={{
          id: "p1",
          toolName: "edit_file",
          reason: "writes a tracked file",
          input: {
            filepath: "src/中文文件.ts",
            old_text: "const a = 1;",
            new_text: "const a = 2;",
          },
        }}
        onDecision={() => {}}
      />,
    );
    for (const frame of [message, footer, permission]) {
      assert.ok(
        frame.split("\n").every((line) => displayWidth(line) <= width),
        frame,
      );
    }
    assert.ok(footer.includes("Working"));
    assert.ok(!footer.includes("input paused"));
  }
});

test("Input selects slash commands and completes their arguments with Tab", async () => {
  const submitted: string[] = [];
  const app = render(<InputHarness submitted={submitted} />);
  for (const key of ["/re", "\x1b[B", "\t", "verify operation-1", "\r"]) {
    app.stdin.write(key);
    await waitForInput();
  }
  assert.deepEqual(submitted, ["/recover verify operation-1"]);
  app.unmount();
});

test("Input runs the selected command with Enter and dismisses suggestions with Escape", async () => {
  const submitted: string[] = [];
  const app = render(<InputHarness submitted={submitted} />);
  for (const key of ["/re", "\x1b[B", "\r"]) {
    app.stdin.write(key);
    await waitForInput();
  }
  assert.deepEqual(submitted, ["/recover"]);
  app.stdin.write("/");
  await waitForInput();
  app.stdin.write("\x1b");
  await waitForInput();
  assert.doesNotMatch(app.lastFrame() ?? "", /show commands|Tab complete/);
  app.unmount();
});

test("Input restores a draft after navigating history", async () => {
  const app = render(<InputHarness history={["older prompt", "/status"]} />);
  for (const key of ["unfinished draft", "\x1b[A", "\x1b[A"]) {
    app.stdin.write(key);
    await waitForInput();
  }
  assert.match(app.lastFrame() ?? "", /older prompt/);
  for (const key of ["\x1b[B", "\x1b[B"]) {
    app.stdin.write(key);
    await waitForInput();
  }
  assert.match(app.lastFrame() ?? "", /unfinished draft/);
  app.unmount();
});

test("Input keeps a busy draft and sends it only after idle and another Enter", async () => {
  const submitted: string[] = [];
  const app = render(<InputHarness busy submitted={submitted} />);
  app.stdin.write("next change");
  await waitForInput();
  app.stdin.write("\r");
  await waitForInput();
  assert.deepEqual(submitted, []);
  assert.match(app.lastFrame() ?? "", /next change/);
  app.rerender(<InputHarness submitted={submitted} />);
  await waitForInput();
  assert.deepEqual(submitted, []);
  app.stdin.write("\r");
  await waitForInput();
  assert.deepEqual(submitted, ["next change"]);
  app.unmount();
});

test("App clears an idle draft before Ctrl+C can quit", async () => {
  let quits = 0;
  const edits: string[] = [];
  const app = render(
    <App
      session={sessionApi({
        input: "draft",
        setInput: (value) => edits.push(value),
        quit: () => {
          quits += 1;
        },
      })}
    />,
  );
  app.stdin.write("\x03");
  await waitForInput();
  assert.deepEqual(edits, [""]);
  assert.equal(quits, 0);
  app.unmount();
});

test("permission keyboard selection denies without interrupting the run", async () => {
  const decisions: boolean[] = [];
  let cancels = 0;
  const request = { id: "p1", toolName: "bash", reason: "shell access" };
  const session = sessionApi({
    busy: true,
    phase: "thinking",
    permission: request,
    decide: (allow) => decisions.push(allow),
    cancel: () => {
      cancels += 1;
    },
  });
  const app = render(<App session={session} />);
  for (const key of ["\x1b[B", "\r", "\x1b"]) {
    app.stdin.write(key);
    await waitForInput();
  }
  assert.deepEqual(decisions, [false, false]);
  assert.equal(cancels, 0);
  app.rerender(<App session={{ ...session, permission: { ...request, id: "p2" } }} />);
  await waitForInput();
  app.stdin.write("\r");
  await waitForInput();
  assert.deepEqual(decisions, [false, false, true]);
  app.unmount();
});

function resizeApp(app: ReturnType<typeof render>, columns: number, rows: number): void {
  Object.defineProperty(app.stdout, "columns", { configurable: true, value: columns });
  Object.defineProperty(app.stdout, "rows", { configurable: true, value: rows });
  app.stdout.emit("resize");
}

test("full-screen transcript scrolls by line, holds history on new output and follows at the bottom", async () => {
  const snapshot = snap();
  snapshot.toolCalls = [];
  snapshot.mcpServers = [];
  snapshot.conversationMessages = [
    {
      id: "long",
      sessionId: "sess9",
      role: "assistant",
      source: "agent_result",
      content: Array.from(
        { length: 100 },
        (_, i) => `history-line-${String(i).padStart(3, "0")}`,
      ).join("\n"),
      createdAt: "t",
    },
  ];
  const session = () => sessionApi({ state: createTuiState(snapshot, { model: "test-model" }) });
  const app = render(<App session={session()} />);
  resizeApp(app, 80, 24);
  await waitForInput();
  let frame = app.lastFrame() ?? "";
  assert.equal(frame.split("\n").length, 24, frame);
  assert.match(frame, /history-line-099/);
  assert.doesNotMatch(frame, /history-line-000/);
  assert.match(frame.split("\n")[0]!, /coil/);
  assert.match(frame.split("\n").at(-1)!, /Ctrl\+D quit/);

  app.stdin.write("\x1b[5~");
  await waitForInput();
  frame = app.lastFrame() ?? "";
  assert.match(frame, /Reading history/);
  assert.doesNotMatch(frame, /history-line-099/);
  const firstVisible = frame.match(/history-line-\d+/)?.[0];
  assert.ok(firstVisible);
  snapshot.conversationMessages.push({
    ...snapshot.conversationMessages[0]!,
    id: "new",
    content: "new result",
  });
  app.rerender(<App session={session()} />);
  await waitForInput();
  assert.equal((app.lastFrame() ?? "").match(/history-line-\d+/)?.[0], firstVisible);

  for (let i = 0; i < 3; i++) {
    app.stdin.write("\x1b[6~");
    await waitForInput();
  }
  assert.match(app.lastFrame() ?? "", /new result/);
  assert.doesNotMatch(app.lastFrame() ?? "", /Reading history/);
  for (const [columns, rows] of [
    [40, 12],
    [120, 30],
  ]) {
    resizeApp(app, columns!, rows!);
    await waitForInput();
    frame = app.lastFrame() ?? "";
    assert.equal(frame.split("\n").length, rows, frame);
    assert.ok(
      frame.split("\n").every((line) => displayWidth(line) <= columns!),
      frame,
    );
    assert.match(frame, /new result/);
    assert.match(frame.split("\n").at(-1)!, /Ctrl\+D quit/);
  }
  app.unmount();
});

test("short screens keep permission choices reachable and let users page through the preview", async () => {
  const request = {
    id: "p1",
    toolName: "edit_file",
    reason: "Review this change before allowing it.",
    input: {
      filepath: "src/demo.ts",
      old_text: Array.from({ length: 8 }, (_, i) => `old ${i}`).join("\n"),
      new_text: Array.from({ length: 8 }, (_, i) => `new ${i}`).join("\n"),
    },
  };
  const app = render(
    <App session={sessionApi({ busy: true, phase: "thinking", permission: request })} />,
  );
  resizeApp(app, 60, 16);
  await waitForInput();
  assert.equal((app.lastFrame() ?? "").split("\n").length, 16);
  assert.match(app.lastFrame() ?? "", /Yes, allow once/);
  assert.match(app.lastFrame() ?? "", /No, deny/);
  for (let i = 0; i < 5; i++) {
    app.stdin.write("\x1b[5~");
    await waitForInput();
  }
  assert.match(app.lastFrame() ?? "", /Permission required/);
  assert.match(app.lastFrame() ?? "", /Review this change/);
  app.unmount();
});

test("long drafts remain pageable without changing their text or submitting", async () => {
  let edits = 0;
  let submits = 0;
  const input = Array.from({ length: 50 }, (_, i) => `draft-line-${i}`).join("\n");
  const app = render(
    <App
      session={sessionApi({
        input,
        setInput: () => {
          edits += 1;
        },
        submit: () => {
          submits += 1;
        },
      })}
    />,
  );
  resizeApp(app, 80, 24);
  await waitForInput();
  assert.match(app.lastFrame() ?? "", /draft-line-49/);
  assert.match(app.lastFrame() ?? "", /Scroll to review your draft/);
  assert.equal((app.lastFrame() ?? "").split("\n").length, 24);
  app.stdin.write("\x1b\x1b[5~");
  await waitForInput();
  assert.doesNotMatch(app.lastFrame() ?? "", /draft-line-49/);
  assert.equal(edits, 0);
  assert.equal(submits, 0);
  app.unmount();
});
