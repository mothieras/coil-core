import React from "react";
import { useApp } from "ink";
import { createPermissionChecker } from "../core/permission/permission.js";
import type { CheckPermissionFn } from "../core/permission/types.js";
import { openModelConnection } from "../core/providers/index.js";
import { SessionController } from "../core/session/controller.js";
import { SessionStore } from "../core/session/store/sessionStore.js";
import { loadConfiguredMcpTools } from "../core/tools/mcp/index.js";
import type { ToolProviderLoadResult } from "../core/tools/types.js";
import { App } from "./components/App.js";
import { createPermissionBridge } from "./permissionBridge.js";
import { useSession } from "./useSession.js";
import { renderTerminal } from "./terminal.js";

export async function runTui(): Promise<void> {
  const workspaceRoot = process.cwd();
  const modelConnection = await openModelConnection(workspaceRoot);
  const store = new SessionStore(workspaceRoot);
  const bridge = createPermissionBridge();
  const checkPermission: CheckPermissionFn = createPermissionChecker(
    workspaceRoot,
    (toolName, input, reason, context) => bridge.request(toolName, input, reason, context),
  );
  const loadProviders = (): Promise<ToolProviderLoadResult[]> =>
    loadConfiguredMcpTools(workspaceRoot);

  const providers = await loadProviders();
  let controller: SessionController;
  try {
    controller = await SessionController.createNew({
      workspaceRoot,
      store,
      checkPermission,
      provider: modelConnection.provider,
      toolProviderResults: providers,
    });
  } catch (error) {
    await closeProviders(providers);
    throw error;
  }

  try {
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
        modelConnection,
      });
      return <App session={session} />;
    }

    const instance = renderTerminal(<Root />);
    await instance.waitUntilExit();
    // /exit and Ctrl+C both await useSession.shutdown() before Root requests exit.
  } finally {
    // Normal exits already close the active controller. This covers startup or
    // render failures and is idempotent for the original controller.
    await controller.close().catch(() => undefined);
  }
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
