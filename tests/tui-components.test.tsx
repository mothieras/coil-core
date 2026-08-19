import test from "node:test";
import assert from "node:assert/strict";
import React from "react";
import { render } from "ink-testing-library";
import { App } from "../src/tui/components/App.js";
import { createTuiState } from "../src/tui/state.js";
import type { UseSessionApi } from "../src/tui/useSession.js";
import { LogLine } from "../src/tui/components/LogItem.js";
import { StatusBar } from "../src/tui/components/StatusBar.js";
import { RunningActivity } from "../src/tui/components/RunningActivity.js";
import { PermissionModal } from "../src/tui/components/PermissionModal.js";
import { classifyInput, splitPastedInput, Input } from "../src/tui/components/Input.js";
import type { SessionSnapshot } from "../src/core/session/types.js";

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

test("LogLine renders a message with role prefix", () => {
  const { lastFrame, unmount } = render(
    <LogLine item={{ id: "x", kind: "message", role: "user", title: "hello there" }} />,
  );
  assert.match(lastFrame() ?? "", /hello there/);
  unmount();
});

test("LogLine renders assistant replies as terminal markdown", () => {
  const { lastFrame, unmount } = render(
    <LogLine
      item={{
        id: "a",
        kind: "message",
        role: "assistant",
        title: "**done** with `fix()`\n\n- step",
      }}
    />,
  );
  const frame = lastFrame() ?? "";
  assert.match(frame, /AGENT/);
  assert.match(frame, /done/);
  assert.match(frame, /fix\(\)/);
  assert.match(frame, /step/);
  assert.doesNotMatch(frame, /\*\*/);
  unmount();
});

test("StatusBar shows session id, model, usage and mcp counts", () => {
  const { lastFrame, unmount } = render(<StatusBar snapshot={snap()} model="deepseek" />);
  const frame = lastFrame() ?? "";
  assert.match(frame, /sess9/);
  assert.match(frame, /deepseek/);
  assert.match(frame, /↑14 ↓6/);
  assert.match(frame, /ctx≈9\/50\.0k/);
  assert.match(frame, /MCP:1\/0/);
  unmount();
});

test("RunningActivity lists running tools while thinking", () => {
  const { lastFrame, unmount } = render(<RunningActivity snapshot={snap()} phase="thinking" />);
  assert.match(lastFrame() ?? "", /bash/);
  unmount();
});

test("classifyInput distinguishes message, slash, resume and empty", () => {
  assert.deepEqual(classifyInput("  "), { kind: "empty", arg: "" });
  assert.deepEqual(classifyInput("fix the bug"), { kind: "message", arg: "fix the bug" });
  assert.deepEqual(classifyInput("/status"), { kind: "slash", arg: "/status" });
  assert.deepEqual(classifyInput("/resume 2"), { kind: "resume", arg: "2" });
  assert.deepEqual(classifyInput("/resume"), { kind: "resume", arg: "" });
  assert.deepEqual(classifyInput("/resumed"), { kind: "slash", arg: "/resumed" });
});

test("splitPastedInput treats the first embedded newline as Enter", () => {
  assert.deepEqual(splitPastedInput("/help"), { submit: undefined, value: "/help" });
  assert.deepEqual(splitPastedInput("/help\r"), { submit: "/help", value: "" });
  assert.deepEqual(splitPastedInput("fix the bug\r\nthen run tests\n"), {
    submit: "fix the bug",
    value: "then run tests",
  });
  assert.deepEqual(splitPastedInput("\rtail"), { submit: undefined, value: "tail" });
});

test("Input submits a pasted chunk with an embedded newline and keeps the frame clean", async () => {
  const submitted: string[] = [];
  function Harness(): React.ReactElement {
    const [value, setValue] = React.useState("");
    return (
      <Input
        value={value}
        onChange={setValue}
        busy={false}
        disabled={false}
        onSubmit={(v) => {
          submitted.push(v);
          setValue("");
        }}
      />
    );
  }
  const app = render(<Harness />);
  // tmux send-keys / paste delivers the text and the newline as ONE stdin
  // chunk; ink reports it as a single input event with key.return = false.
  app.stdin.write("/help\r");
  await new Promise((resolve) => setTimeout(resolve, 50));
  const frame = app.lastFrame() ?? "";
  app.unmount();
  assert.deepEqual(submitted, ["/help"]);
  assert.equal(frame.includes("\r"), false, "raw carriage return must never reach the frame");
});

test("Input recalls history with arrow keys", async () => {
  function Harness(): React.ReactElement {
    const [value, setValue] = React.useState("");
    return (
      <Input
        value={value}
        onChange={setValue}
        busy={false}
        disabled={false}
        history={["first command", "second command"]}
        onSubmit={() => {}}
      />
    );
  }
  const app = render(<Harness />);
  app.stdin.write("[A"); // up
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.match(app.lastFrame() ?? "", /second command/);
  app.stdin.write("[A"); // up again
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.match(app.lastFrame() ?? "", /first command/);
  app.stdin.write("[B"); // down
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.match(app.lastFrame() ?? "", /second command/);
  app.unmount();
});

test("PermissionModal shows tool name and reason", () => {
  const { lastFrame, unmount } = render(
    <PermissionModal
      request={{
        id: "p1",
        toolName: "edit_file",
        reason: "writes a tracked file",
        inputSummary: "path=src/x.ts",
      }}
      onDecision={() => {}}
    />,
  );
  const frame = lastFrame() ?? "";
  assert.match(frame, /edit_file/);
  assert.match(frame, /writes a tracked file/);
  assert.match(frame, /y.*allow|allow.*y/i);
  unmount();
});

test("PermissionModal shows a diff preview for edit_file requests", () => {
  const { lastFrame, unmount } = render(
    <PermissionModal
      request={{
        id: "p9",
        toolName: "edit_file",
        reason: "workspace write",
        input: { filepath: "a.ts", old_text: "const a = 1;", new_text: "const a = 2;" },
      }}
      onDecision={() => {}}
    />,
  );
  const frame = lastFrame() ?? "";
  assert.match(frame, /- const a = 1;/);
  assert.match(frame, /\+ const a = 2;/);
  unmount();
});

test("ESC interrupts only while busy and no permission pending", async () => {
  let interrupts = 0;
  const base: UseSessionApi = {
    state: createTuiState(snap(), {}),
    phase: "idle" as const,
    permission: null,
    input: "",
    history: [],
    setInput: () => {},
    submit: () => {},
    decide: () => {},
    interrupt: () => {
      interrupts += 1;
    },
    busy: false,
  };

  // not busy: ESC does nothing
  const idle = render(<App session={{ ...base, busy: false }} />);
  idle.stdin.write("\x1b");
  // wait for ink's 20ms escape-flush timer + margin
  await new Promise((resolve) => setTimeout(resolve, 50));
  const afterIdle = interrupts;

  // busy: ESC should call interrupt
  const busy = render(<App session={{ ...base, busy: true }} />);
  busy.stdin.write("\x1b");
  await new Promise((resolve) => setTimeout(resolve, 50));

  idle.unmount();
  busy.unmount();

  assert.equal(afterIdle, 0, "ESC while idle should not interrupt");
  assert.ok(interrupts >= 1, "ESC while busy should interrupt");
});

test("App renders footer prompt and seeded log together", () => {
  const seeded = createTuiState(
    {
      session: {
        id: "sessA",
        workspaceRoot: "/r",
        createdAt: "t",
        updatedAt: "t",
        status: "active",
        title: "T",
      },
      conversationMessages: [
        {
          id: "m1",
          sessionId: "sessA",
          role: "user",
          content: "hello world",
          createdAt: "t",
          source: "user_input",
        },
      ],
      leadAgentMessages: [],
      agentRuns: [],
      toolCalls: [],
      permissionDecisions: [],
      backgroundCommands: [],
      subagents: [],
      tasks: [],
      reports: [],
      mcpServers: [],
      usage: { inputTokens: 0, outputTokens: 0, apiCalls: 0, lastInputTokens: 0 },
    },
    { model: "deepseek" },
  );
  const api: UseSessionApi = {
    state: seeded,
    phase: "idle",
    busy: false,
    permission: null,
    input: "",
    setInput: () => {},
    submit: () => {},
    decide: () => {},
    interrupt: () => {},
    history: [],
  };
  const { lastFrame, unmount } = render(<App session={api} />);
  const frame = lastFrame() ?? "";
  assert.match(frame, /hello world/);
  assert.match(frame, /sessA/);
  assert.match(frame, /coil ›/);
  unmount();
});
