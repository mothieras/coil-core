/** Real Ink/TTY fixture. Run in a disposable directory passed in argv[2]. */
import React from "react";
import { render, useApp } from "ink";
import { SessionController } from "../../src/core/session/controller.js";
import { SessionStore } from "../../src/core/session/store/sessionStore.js";
import { createPermissionChecker } from "../../src/core/permission/permission.js";
import { createPermissionBridge } from "../../src/tui/permissionBridge.js";
import { useSession } from "../../src/tui/useSession.js";
import { App } from "../../src/tui/components/App.js";
import { fakeProvider, textMessage, toolCall, toolCallMessage } from "../helpers/pi.js";

const workspaceRoot = process.argv[2]!;
const bridge = createPermissionBridge();
const checkPermission = createPermissionChecker(workspaceRoot, (name, input, reason, context) =>
  bridge.request(name, input, reason, context),
);
const store = new SessionStore(workspaceRoot);
const remote = Promise.withResolvers<string>();
const provider = fakeProvider((request) => {
  const last = request.messages.at(-1);
  if (last?.role !== "user") return textMessage("done");
  if (last.content === "permission")
    return toolCallMessage([toolCall("bash", { command: "rm demo-file" })]);
  if (last.content === "running")
    return toolCallMessage([
      toolCall("bash", { command: "sleep 60 & echo $$ $! > running-ready; wait" }),
    ]);
  if (last.content === "background")
    return toolCallMessage([
      toolCall("background_run", { command: "sleep 60 & echo $$ $! > background-ready; wait" }),
    ]);
  if (last.content === "unknown") return toolCallMessage([toolCall("remote", {})]);
  return textMessage("ready");
});
const controller = await SessionController.createNew({
  workspaceRoot,
  title: "Cancellation TTY fixture",
  store,
  provider,
  checkPermission,
  toolProviderResults: process.argv.includes("--close-error")
    ? [
        {
          tools: [],
          diagnostics: [],
          close: () => {
            throw new Error("fixture provider close failed");
          },
        },
      ]
    : [],
});
controller.appContext.toolRuntime.registerTool({
  name: "remote",
  definition: {
    name: "remote",
    description: "Uncooperative fixture",
    parameters: { type: "object", properties: {} },
  },
  source: { type: "builtin" },
  handler: () => remote.promise.then((output) => ({ status: "completed", output })),
});
function Root() {
  const { exit } = useApp();
  return React.createElement(App, {
    session: useSession({
      workspaceRoot,
      store,
      bridge,
      checkPermission,
      initialController: controller,
      loadProviders: async () => [],
      onExit: exit,
      model: "scripted-local",
    }),
  });
}
const instance = render(React.createElement(Root), {
  exitOnCtrlC: false,
  kittyKeyboard: { mode: "disabled" },
});
process.once("SIGTERM", () => {
  remote.resolve("fixture shutdown");
  instance.unmount();
});
try {
  await instance.waitUntilExit();
} finally {
  remote.resolve("fixture shutdown");
  await controller.close().catch((error) => console.error(String(error)));
}
