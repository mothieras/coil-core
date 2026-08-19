import type { SessionListItem } from "../core/session/store/sessionStore.js";

export type TurnPhase = "thinking" | "waiting-async" | "auto-waking" | "idle";

export type TurnController = {
  handleUserMessage(text: string): Promise<unknown>;
  hasPendingAsyncWork(): boolean;
  waitForAsyncWork(o: { shouldStop?: () => boolean }): Promise<"completed" | "interrupted">;
  handleAutoWake(reason: "async_work_finished"): Promise<unknown>;
};

export async function drainTurn(
  text: string,
  deps: { controller: TurnController; onPhase: (p: TurnPhase) => void; shouldStop: () => boolean },
): Promise<void> {
  const { controller, onPhase, shouldStop } = deps;
  onPhase("thinking");
  try {
    await controller.handleUserMessage(text);
    while (controller.hasPendingAsyncWork()) {
      onPhase("waiting-async");
      const result = await controller.waitForAsyncWork({ shouldStop });
      if (result === "interrupted") break;
      onPhase("auto-waking");
      await controller.handleAutoWake("async_work_finished");
    }
  } finally {
    onPhase("idle");
  }
}

export function matchSession(items: SessionListItem[], arg: string): SessionListItem | null {
  const trimmed = arg.trim();
  if (trimmed === "") return null;
  if (/^\d+$/.test(trimmed)) {
    const idx = Number.parseInt(trimmed, 10) - 1;
    return items[idx] ?? null;
  }
  return items.find((s) => s.id.startsWith(trimmed)) ?? null;
}

export function formatSessionList(items: SessionListItem[]): string {
  if (items.length === 0) return "(no saved sessions)";
  return items.map((s, i) => `${i + 1}. ${s.id}  ${s.title}  ${s.updatedAt}`).join("\n");
}
