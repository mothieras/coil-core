import fs from "node:fs/promises";
import path from "node:path";
import { SessionController } from "../../src/core/session/controller.js";
import { builtinTool } from "../../src/core/tools/types.js";
import { assistantMessage, fakeProvider, textMessage, toolCall } from "../helpers/pi.js";

export type CrashWindow =
  | "before_intent"
  | "after_intent"
  | "after_effect"
  | "after_result"
  | "model_reply"
  | "async_saved"
  | "async_injected"
  | "async_confirmed";

const workspaceRoot = process.argv[2]!;
const window = process.argv[3] as CrashWindow;
const first = toolCall("append_marker", { marker: "first" }, "first");
const second = toolCall("append_marker", { marker: "second" }, "second");
const provider = fakeProvider(() =>
  window.startsWith("async_")
    ? textMessage("FULL_ASYNC_RESULT_FROM_CHILD")
    : window === "model_reply"
      ? textMessage("Reply not yet saved.")
      : assistantMessage(
          [
            {
              type: "thinking",
              thinking: "Fixture thought",
              thinkingSignature: "fixture-signature",
            },
            first,
            second,
          ],
          "toolUse",
        ),
);
const controller = await SessionController.createNew({
  workspaceRoot,
  sessionId: "crash",
  title: "Crash fixture",
  provider,
});
await controller.flush();
if (window.startsWith("async_")) {
  const completed = Promise.withResolvers<void>();
  controller.appContext.inbox.subscribe((notification) => {
    if (notification.status !== "running") completed.resolve();
  });
  controller.appContext.subAgentRunner.run(controller.leadAgentState, "child result", {
    sessionId: "crash",
  });
  await completed.promise;
  await controller.flush();
  if (window === "async_saved") await awaitKill();
  const append = fs.appendFile;
  fs.appendFile = async (...args) => {
    const handoff =
      String(args[0]).endsWith("events.jsonl") && String(args[1]).includes('"awaitingModel":true');
    if (handoff && window === "async_injected") await awaitKill();
    await append(...args);
    if (handoff && window === "async_confirmed") await awaitKill();
  };
  await controller.handleAutoWake("async_work_finished");
  throw new Error(`Crash window ${window} was not reached`);
}
controller.appContext.toolRuntime.registerTool(
  builtinTool(
    {
      name: "append_marker",
      description: "Append an execution marker to a fixture file.",
      parameters: {
        type: "object",
        properties: { marker: { type: "string" } },
        required: ["marker"],
      },
    },
    async (input) => {
      await fs.appendFile(path.join(workspaceRoot, "effects"), `${String(input.marker)}\n`);
      return { status: "completed", output: "Full result from the tool" };
    },
  ),
);

const append = fs.appendFile;
fs.appendFile = async (...args) => {
  const [file, data] = args;
  if (!String(file).endsWith("events.jsonl") || !Buffer.isBuffer(data)) return append(...args);
  const rows = data.toString("utf8");
  const intent = rows.includes('"type":"tool_execution_intended"');
  const result = rows.includes('"type":"tool_execution_recorded"');
  const assistant = rows.includes('"role":"assistant"') && rows.includes('"source":"agent_result"');
  if (
    (window === "before_intent" && intent) ||
    (window === "after_effect" && result) ||
    (window === "model_reply" && assistant)
  ) {
    await awaitKill();
  }
  await append(...args);
  if ((window === "after_intent" && intent) || (window === "after_result" && result)) {
    await awaitKill();
  }
};

function awaitKill(): Promise<never> {
  process.send!("checkpoint reached");
  return new Promise((_, reject) => {
    setTimeout(() => reject(new Error("Crash fixture was not killed")), 15_000);
  });
}

await controller.handleUserMessage("Perform the fixture work.");
throw new Error(`Crash window ${window} was not reached`);
