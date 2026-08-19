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
  history: readonly string[];
};

export function useSession(opts: UseSessionOptions): UseSessionApi {
  const controllerRef = useRef<SessionController>(opts.initialController);
  const unsubRef = useRef<(() => void) | null>(null);
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
      void controllerRef.current.close();
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

  async function runMessage(text: string): Promise<void> {
    setBusy(true);
    interruptRef.current = false;
    try {
      try {
        await drainTurn(text, {
          controller: controllerRef.current,
          onPhase: setPhase,
          shouldStop: () => interruptRef.current,
        });
      } catch (err) {
        reportError("Turn", err);
      }
    } finally {
      setBusy(false);
      setPhase("idle");
    }
  }

  async function runSlash(command: string): Promise<void> {
    try {
      const result = await controllerRef.current.handleSlashCommand(command);
      if (result.action === "message") {
        // Expanded .coil/commands template — run it as a normal user turn.
        await runMessage(result.text);
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
    }
  }

  async function runResume(arg: string): Promise<void> {
    try {
      if (busy) {
        setState((s) =>
          appendInfoLog(s, {
            id: nextId(),
            title: "Resume",
            detail: "Cannot switch sessions while a turn is running.",
          }),
        );
        return;
      }
      const items = await opts.store.listSessions();
      if (arg === "") {
        setState((s) =>
          appendInfoLog(s, {
            id: nextId(),
            title: "Resume — pick a session",
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
      // hot-swap: load new providers FIRST — if this throws, the old session stays intact
      const providers = await opts.loadProviders();
      // close old only after providers are ready
      unsubRef.current?.();
      await controllerRef.current.close();
      const next = await SessionController.resume({
        workspaceRoot: opts.workspaceRoot,
        sessionId: target.id,
        store: opts.store,
        checkPermission: opts.checkPermission,
        toolProviderResults: providers,
      });
      next.registerRuntimeHooks();
      controllerRef.current = next;
      bindController(next);
      setState(
        createTuiState(next.getSnapshot(), opts.model !== undefined ? { model: opts.model } : {}),
      );
    } catch (err) {
      reportError("Resume", err);
    }
  }

  async function shutdown(): Promise<void> {
    unsubRef.current?.();
    await controllerRef.current.close();
  }

  function submit(value: string): void {
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
    opts.bridge.resolve(allow);
  }

  function interrupt(): void {
    interruptRef.current = true;
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
    history: historyRef.current,
  };
}
