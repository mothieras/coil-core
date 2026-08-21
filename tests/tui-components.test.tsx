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
import {
  classifyInput,
  commandSuggestions,
  splitPastedInput,
  Input,
} from "../src/tui/components/Input.js";
import { displayWidth } from "../src/tui/format.js";
import { borderStyleFor, shouldAnimateActivity, symbolsFor } from "../src/tui/theme.js";
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
    quit: () => {},
    busy: false,
    ...overrides,
  };
}

function InputHarness({
  history = [],
  submitted,
}: {
  history?: string[];
  submitted?: string[];
}): React.ReactElement {
  const [value, setValue] = React.useState("");
  return (
    <Input
      value={value}
      onChange={setValue}
      busy={false}
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

  assert.match(user, /› hello there/);
  assert.doesNotMatch(user, /YOU/);
  assert.match(assistant, /●.*done/);
  assert.doesNotMatch(assistant, /AGENT|\*\*/);
  assert.match(assistant, /fix\(\)|step/);
  assert.match(tool, /✓ Read file.*src\/main\.ts.*42ms.*120 chars/s);
});

test("StatusBar prioritizes active work and fits terminal cell width", () => {
  const full = frameOf(<StatusBar snapshot={snap()} model="deepseek" />);
  for (const token of ["sess9", "deepseek", "↑14 ↓6", "ctx≈9/50k", "run t1", "mcp 1"])
    assert.ok(full.includes(token));

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
  assert.deepEqual(splitPastedInput("/help\r"), { submit: "/help", value: "" });
  assert.deepEqual(splitPastedInput("fix the bug\r\nthen run tests\n"), {
    submit: "fix the bug",
    value: "then run tests",
  });
});

test("Input submits pasted chunks without leaking carriage returns", async () => {
  const submitted: string[] = [];
  const app = render(<InputHarness submitted={submitted} />);
  app.stdin.write("/help\r");
  await waitForInput();
  const frame = app.lastFrame() ?? "";
  app.unmount();

  assert.deepEqual(submitted, ["/help"]);
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
  const base = sessionApi({
    interrupt: () => {
      interrupts += 1;
    },
    quit: () => {
      quits += 1;
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
  assert.equal(interrupts, 0, "ESC cannot cancel foreground turns");

  await send({ ...base, busy: true, phase: "waiting-async" }, "\x1b");
  assert.equal(interrupts, 1, "ESC stops cooperative async waiting");

  await send(base, "\x03");
  await send({ ...base, busy: true, phase: "thinking" }, "\x03");
  assert.equal(quits, 1, "Ctrl+C quits only while idle");
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
  assert.match(frame, /#sess9/);
  assert.match(frame, /› Ask coil to change the code/);
});
