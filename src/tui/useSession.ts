import { useEffect, useRef, useState } from "react";
import type { CheckPermissionFn } from "../core/permission/types.js";
import type { ModelConnection } from "../core/providers/index.js";
import { SessionController } from "../core/session/controller.js";
import { SessionStore } from "../core/session/store/sessionStore.js";
import type { ToolProviderLoadResult } from "../core/tools/types.js";
import { applyTuiEvent, appendInfoLog, createTuiState, type TuiState } from "./state.js";
import { applyTuiCommandResult } from "./commands.js";
import { drainTurn, matchSession, formatSessionList, type TurnPhase } from "./sessionActions.js";
import type { PermissionBridge, PermissionRequest } from "./permissionBridge.js";
import { classifyInput } from "./components/Input.js";
import { useLogin, type LoginView } from "./useLogin.js";

export type UseSessionOptions = {
  workspaceRoot: string;
  store: SessionStore;
  checkPermission: CheckPermissionFn;
  bridge: PermissionBridge;
  initialController: SessionController;
  loadProviders: () => Promise<ToolProviderLoadResult[]>;
  onExit?: (() => void) | undefined;
  model?: string | undefined;
  modelConnection?: ModelConnection | undefined;
};

export type UseSessionApi = {
  state: TuiState;
  phase: TurnPhase;
  busy: boolean;
  permission: PermissionRequest | null;
  login?: LoginView | null | undefined;
  setupMessage?: string | undefined;
  input: string;
  setInput: (v: string) => void;
  submit: (v: string) => void;
  decide: (allow: boolean) => void;
  interrupt: () => void;
  cancel: () => void;
  quit: () => void;
  history: readonly string[];
};

export function useSession(opts: UseSessionOptions): UseSessionApi {
  const controllerRef = useRef<SessionController>(opts.initialController);
  const unsubRef = useRef<(() => void) | null>(null);
  const busyRef = useRef<boolean>(false);
  const interruptRef = useRef<boolean>(false);
  const closingRef = useRef<boolean>(false);
  const seq = useRef<number>(0);
  const historyRef = useRef<string[]>([]);
  const { modelConnection } = opts;
  const login = useLogin();

  const [state, setState] = useState<TuiState>(() =>
    createTuiState(opts.initialController.getSnapshot(), {
      model: modelConnection?.modelId ?? opts.model,
    }),
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
    const message =
      err instanceof AggregateError
        ? `${err.message}: ${err.errors.map((e) => String(e)).join("; ")}`
        : err instanceof Error
          ? err.message
          : String(err);
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
    if (closingRef.current) return;
    busyRef.current = false;
    setBusy(false);
    setPhase("idle");
  }

  async function executeMessage(text: string): Promise<void> {
    if (modelConnection?.setupMessage) {
      reportError("Model setup", modelConnection.setupMessage);
      return;
    }
    interruptRef.current = false;
    try {
      await drainTurn(text, {
        controller: controllerRef.current,
        onPhase: (phase) => {
          if (!closingRef.current) setPhase(phase);
        },
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
      if (modelConnection && result.action === "notice" && result.title === "Help") {
        result.body += " /login";
      }
      const id = nextId();
      setState((s) => applyTuiCommandResult(s, result, id).state);
      if (result.action === "exit") {
        await shutdown();
        opts.onExit?.();
      }
    } catch (err) {
      if (closingRef.current) setPhase("close-failed");
      reportError("Command", err);
    } finally {
      endOperation();
    }
  }

  async function runLogin(connection: ModelConnection, arg: string): Promise<void> {
    if (!beginOperation("Login")) return;
    try {
      if (/\s/.test(arg)) {
        throw new Error("Use /login [provider] and enter credentials when prompted.");
      }
      if (controllerRef.current.appContext.subAgentRunner.hasRunning()) {
        throw new Error(
          "Wait for running subagents to finish before changing the model connection.",
        );
      }
      const model = await login.start(connection, arg || undefined);
      if (model !== undefined) {
        setState((s) =>
          appendInfoLog(
            { ...s, model },
            {
              id: nextId(),
              title: "Login saved",
              detail: `Using ${model}. Run /ping to check the connection.`,
            },
          ),
        );
      }
    } catch (err) {
      reportError("Login", err);
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
          provider: modelConnection?.provider,
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
        createTuiState(next.getSnapshot(), { model: modelConnection?.modelId ?? opts.model }),
      );
    } catch (err) {
      reportError("Resume", err);
    } finally {
      endOperation();
    }
  }

  async function shutdown(): Promise<void> {
    closingRef.current = true;
    setPhase("closing");
    interruptRef.current = true;
    await login.cancel()?.catch(() => undefined);
    await controllerRef.current.close();
    unsubRef.current?.();
  }

  function submit(value: string): void {
    if (busyRef.current) return;
    const c = classifyInput(value);
    setInput("");
    if (c.kind === "empty") return;
    // Provider credentials are answered in the login prompt, outside input history.
    if (c.kind === "login" && modelConnection) {
      void runLogin(modelConnection, c.arg);
      return;
    }
    const trimmed = value.trim();
    if (historyRef.current.at(-1) !== trimmed) {
      historyRef.current.push(trimmed);
      if (historyRef.current.length > 50) historyRef.current.shift();
    }
    if (c.kind === "resume") {
      void runResume(c.arg);
      return;
    }
    if (c.kind === "slash" || c.kind === "login") {
      void runSlash(trimmed);
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

  function cancel(): void {
    const loginDone = login.cancel();
    if (loginDone) {
      void loginDone.catch(() => undefined);
      return;
    }
    interruptRef.current = true;
    void controllerRef.current.cancelRun().catch((error) => reportError("Cancel", error));
  }

  function quit(): void {
    busyRef.current = true;
    setBusy(true);
    void shutdown()
      .then(() => opts.onExit?.())
      .catch((error: unknown) => {
        setPhase("close-failed");
        reportError("Exit", error);
      });
  }

  return {
    state,
    phase,
    busy,
    permission,
    login: login.view,
    setupMessage: modelConnection?.setupMessage,
    input,
    setInput,
    submit,
    decide,
    interrupt,
    cancel,
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
