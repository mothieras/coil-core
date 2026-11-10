import { execFile } from "node:child_process";
import { useEffect, useRef, useState } from "react";
import type { AuthEvent, AuthPrompt } from "@earendil-works/pi-ai";
import type { ModelConnection } from "../core/providers/index.js";

export type PendingLoginPrompt = {
  id: number;
  prompt: AuthPrompt;
  answer: (value: string) => void;
};

export type LoginView = { prompt?: PendingLoginPrompt | undefined; notes: readonly string[] };

export function useLogin() {
  const [view, setView] = useState<LoginView | null>(null);
  const sequence = useRef(0);
  const active = useRef<{ abort: AbortController; done: Promise<string | undefined> } | null>(null);

  useEffect(() => () => active.current?.abort.abort(), []);

  function start(connection: ModelConnection, providerId: string | undefined) {
    const abort = new AbortController();
    setView({ notes: [] });
    const done = connection
      .login(providerId, {
        signal: abort.signal,
        prompt: (prompt) =>
          new Promise((resolve, reject) => {
            const signal = prompt.signal
              ? AbortSignal.any([abort.signal, prompt.signal])
              : abort.signal;
            signal.throwIfAborted();
            const id = ++sequence.current;
            const clear = () => {
              signal.removeEventListener("abort", onAbort);
              setView((current) =>
                current?.prompt?.id === id ? { ...current, prompt: undefined } : current,
              );
            };
            const onAbort = () => {
              clear();
              reject(signal.reason);
            };
            signal.addEventListener("abort", onAbort, { once: true });
            const answer = (value: string) => {
              clear();
              resolve(value);
            };
            setView((current) =>
              current ? { ...current, prompt: { id, prompt, answer } } : current,
            );
          }),
        notify: (event) => {
          if (abort.signal.aborted) return;
          const note = describeAuthEvent(event);
          setView((current) =>
            current ? { ...current, notes: [...current.notes, note] } : current,
          );
          if (event.type === "auth_url") openBrowser(event.url);
          if (event.type === "device_code") openBrowser(event.verificationUri);
        },
      })
      .catch((error: unknown) => {
        if (
          abort.signal.aborted &&
          (error === abort.signal.reason || (error instanceof Error && error.name === "AbortError"))
        )
          return undefined;
        throw error;
      })
      .finally(() => {
        active.current = null;
        setView(null);
      });
    active.current = { abort, done };
    return done;
  }

  function cancel() {
    const task = active.current;
    task?.abort.abort();
    return task?.done;
  }

  return { view, start, cancel };
}

function describeAuthEvent(event: AuthEvent): string {
  switch (event.type) {
    case "auth_url":
      return [event.instructions, event.url].filter(Boolean).join("\n");
    case "device_code":
      return `Enter code ${event.userCode} at ${event.verificationUri}`;
    case "info":
      return [event.message, ...(event.links ?? []).map((link) => link.url)].join("\n");
    case "progress":
      return event.message;
  }
}

function openBrowser(url: string): void {
  const parsed = URL.parse(url);
  if (parsed?.protocol !== "https:") return;
  if (process.platform === "darwin") {
    execFile("open", [parsed.href], { timeout: 10_000 }, () => {});
  } else if (process.platform === "linux" && (process.env.DISPLAY || process.env.WAYLAND_DISPLAY)) {
    execFile("xdg-open", [parsed.href], { timeout: 10_000 }, () => {});
  }
}
