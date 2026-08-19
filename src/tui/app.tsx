import React from "react";
import { render, useApp } from "ink";
import { getModel } from "../core/config/index.js";
import { createPermissionChecker } from "../core/permission/permission.js";
import type { CheckPermissionFn } from "../core/permission/types.js";
import { SessionController } from "../core/session/controller.js";
import { SessionStore } from "../core/session/store/sessionStore.js";
import { loadConfiguredMcpTools } from "../core/tools/mcp/index.js";
import type { ToolProviderLoadResult } from "../core/tools/types.js";
import { App } from "./components/App.js";
import { createPermissionBridge } from "./permissionBridge.js";
import { useSession } from "./useSession.js";

export async function runTui(): Promise<void> {
  const workspaceRoot = process.cwd();
  const store = new SessionStore(workspaceRoot);
  const bridge = createPermissionBridge();
  const checkPermission: CheckPermissionFn = createPermissionChecker(
    workspaceRoot,
    (toolName, input, reason) => bridge.request(toolName, input, reason),
  );
  const loadProviders = (): Promise<ToolProviderLoadResult[]> =>
    loadConfiguredMcpTools(workspaceRoot);

  const providers = await loadConfiguredMcpTools(workspaceRoot);
  let controller: SessionController;
  try {
    controller = await SessionController.createNew({
      workspaceRoot,
      store,
      checkPermission,
      toolProviderResults: providers,
    });
  } catch (error) {
    await closeProviders(providers);
    throw error;
  }
  controller.registerRuntimeHooks();

  function Root(): React.ReactElement {
    const { exit } = useApp();
    const session = useSession({
      workspaceRoot,
      store,
      checkPermission,
      bridge,
      initialController: controller,
      loadProviders,
      onExit: () => exit(),
      ...(getModel() !== undefined ? { model: getModel() } : {}),
    });
    return <App session={session} />;
  }

  const instance = render(<Root />, { kittyKeyboard: { mode: "disabled" } });
  await instance.waitUntilExit();
  // useSession.shutdown() closes the active controller on /exit; ensure close on ctrl+c too:
  // (idempotent: close() guards on already-closed status)
}

async function closeProviders(results: readonly ToolProviderLoadResult[]): Promise<void> {
  for (const r of results) {
    try {
      await r.close?.();
    } catch {
      /* best effort */
    }
  }
}
