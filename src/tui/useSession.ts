import { useEffect, useRef, useState } from "react";
import type { CheckPermissionFn } from "../core/permission/types.js";
import { SessionController } from "../core/session/controller.js";
import { SessionStore } from "../core/session/store/sessionStore.js";
import type { ToolProviderLoadResult } from "../core/tools/types.js";
import { applyTuiEvent, appendInfoLog, createTuiState, type TuiState } from "./state.js";
import { applyTuiCommandResult } from "./commands.js";
import { drainTurn, matchSession, formatSessionList, type TurnPhase } from "./sessionActions.js";
import type { PermissionBridge, PermissionRequest } from "./permissionBridge.js";
import { classifyInput } from "./components/Input.js";

export type UseSessionOptions = {
  workspaceRoot: string;
  store: SessionStore;
  checkPermission: CheckPermissionFn;
  bridge: PermissionBridge;
  initialController: SessionController;
  loadProviders: () => Promise<ToolProviderLoadResult[]>;
  onExit?: (() => void) | undefined;
  model?: string | undefined;
};

export type UseSessionApi = {
  state: TuiState;
  phase: TurnPhase;
  busy: boolean;
  permission: PermissionRequest | null;
  input: string;
  setInput: (v: string) => void;
  submit: (v: string) => void;
  decide: (allow: boolean) => void;
  interrupt: () => void;
  quit: () => void;
  history: readonly string[];
};

export function useSession(opts: UseSessionOptions): UseSessionApi {
  const controllerRef = useRef<SessionController>(opts.initialController);
  const unsubRef = useRef<(() => void) | null>(null);
  const busyRef = useRef<boolean>(false);
  const interruptRef = useRef<boolean>(false);
  const seq = useRef<number>(0);
  const historyRef = useRef<string[]>([]);

  const [state, setState] = useState<TuiState>(() =>
    createTuiState(
      opts.initialController.getSnapshot(),
      opts.model !== undefined ? { model: opts.model } : {},
    ),
  );
  const [phase, setPhase] = useState<TurnPhase>("idle");
  const [busy, setBusy] = useState<boolean>(false);
  const [permission, setPermission] = useState<PermissionRequest | null>(null);
  const [input, setInput] = useState<string>("");

  // subscribe to permission bridge
  useEffect(() => {
    const update = (): void => setPermission(opts.bridge.current());
    update();
    return opts.bridge.subscribe(update);
  }, [opts.bridge]);

  // (re)subscribe to the active controller's view events
  function bindController(controller: SessionController): void {
    unsubRef.current?.();
    unsubRef.current = controller.subscribe((event, snapshot) => {
      setState((s) => applyTuiEvent({ ...s, snapshot }, event, snapshot));
    });
  }
  useEffect(() => {
    bindController(controllerRef.current);
    return () => {
      unsubRef.current?.();
      if (!busyRef.current) void controllerRef.current.close().catch(() => undefined);
    };
  }, []);

  function nextId(): string {
    seq.current += 1;
    return `ui-${seq.current}`;
  }

  function reportError(scope: string, err: unknown): void {
    const message = err instanceof Error ? err.message : String(err);
    setState((s) => appendInfoLog(s, { id: nextId(), title: `${scope} error`, detail: message }));
  }

  function beginOperation(scope: string): boolean {
    if (busyRef.current) {
      setState((s) =>
        appendInfoLog(s, {
          id: nextId(),
          title: scope,
          detail: "Another operation is already running.",
        }),
      );
      return false;
    }
    busyRef.current = true;
    setBusy(true);
    return true;
  }

  function endOperation(): void {
    busyRef.current = false;
    setBusy(false);
    setPhase("idle");
  }

  async function executeMessage(text: string): Promise<void> {
    interruptRef.current = false;
    try {
      await drainTurn(text, {
        controller: controllerRef.current,
        onPhase: setPhase,
        shouldStop: () => interruptRef.current,
      });
    } catch (err) {
      reportError("Turn", err);
    }
  }

  async function runMessage(text: string): Promise<void> {
    if (!beginOperation("Turn")) return;
    try {
      await executeMessage(text);
    } finally {
      endOperation();
    }
  }

  async function runSlash(command: string): Promise<void> {
    if (!beginOperation("Command")) return;
    try {
      const result = await controllerRef.current.handleSlashCommand(command);
      if (result.action === "message") {
        // Expanded .coil/commands templates run under the same operation lock.
        await executeMessage(result.text);
        return;
      }
      const id = nextId();
      setState((s) => applyTuiCommandResult(s, result, id).state);
      if (result.action === "exit") {
        await shutdown();
        opts.onExit?.();
      }
    } catch (err) {
      reportError("Command", err);
    } finally {
      endOperation();
    }
  }

  async function runResume(arg: string): Promise<void> {
    if (!beginOperation("Resume")) return;
    try {
      const items = await opts.store.listSessions();
      if (arg === "") {
        setState((s) =>
          appendInfoLog(s, {
            id: nextId(),
            title: "Resume: pick a session",
            detail: formatSessionList(items),
          }),
        );
        return;
      }
      const target = matchSession(items, arg);
      if (!target) {
        setState((s) =>
          appendInfoLog(s, {
            id: nextId(),
            title: "Resume",
            detail: `No session matching "${arg}". Type /resume to list.`,
          }),
        );
        return;
      }
      if (target.id === controllerRef.current.getSnapshot().session?.id) {
        setState((s) =>
          appendInfoLog(s, {
            id: nextId(),
            title: "Resume",
            detail: "That session is already active.",
          }),
        );
        return;
      }

      // Build the next controller before disposing the current one. If loading
      // the saved state fails, the current session remains fully usable.
      const providers = await opts.loadProviders();
      let next: SessionController;
      try {
        next = await SessionController.resume({
          workspaceRoot: opts.workspaceRoot,
          sessionId: target.id,
          store: opts.store,
          checkPermission: opts.checkPermission,
          toolProviderResults: providers,
        });
      } catch (error) {
        await closeProviderResults(providers);
        throw error;
      }

      unsubRef.current?.();
      try {
        await controllerRef.current.close();
      } catch (error) {
        bindController(controllerRef.current);
        await closeProviderResults(providers);
        throw error;
      }
      next.registerRuntimeHooks();
      controllerRef.current = next;
      bindController(next);
      historyRef.current = [];
      setInput("");
      setState(
        createTuiState(next.getSnapshot(), opts.model !== undefined ? { model: opts.model } : {}),
      );
    } catch (err) {
      reportError("Resume", err);
    } finally {
      endOperation();
    }
  }

  async function shutdown(): Promise<void> {
    unsubRef.current?.();
    await controllerRef.current.close();
  }

  function submit(value: string): void {
    if (busyRef.current) return;
    const c = classifyInput(value);
    setInput("");
    if (c.kind === "empty") return;
    const trimmed = value.trim();
    if (historyRef.current.at(-1) !== trimmed) {
      historyRef.current.push(trimmed);
      if (historyRef.current.length > 50) historyRef.current.shift();
    }
    if (c.kind === "resume") {
      void runResume(c.arg);
      return;
    }
    if (c.kind === "slash") {
      void runSlash(c.arg);
      return;
    }
    void runMessage(c.arg);
  }

  function decide(allow: boolean): void {
    if (permission !== null) opts.bridge.resolve(permission.id, allow);
  }

  function interrupt(): void {
    interruptRef.current = true;
  }

  function quit(): void {
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    void shutdown()
      .then(() => opts.onExit?.())
      .catch((error: unknown) => reportError("Exit", error))
      .finally(() => {
        busyRef.current = false;
        setBusy(false);
      });
  }

  return {
    state,
    phase,
    busy,
    permission,
    input,
    setInput,
    submit,
    decide,
    interrupt,
    quit,
    history: historyRef.current,
  };
}

async function closeProviderResults(results: readonly ToolProviderLoadResult[]): Promise<void> {
  for (const result of results) {
    try {
      await result.close?.();
    } catch {
      // Preserve the original resume error; provider cleanup is best effort.
    }
  }
}
