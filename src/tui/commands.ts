import type { SessionCommandResult } from "../core/session/commands/actions.js";
import { appendInfoLog, type TuiState } from "./state.js";

export type TuiCommandOutcome = { action: "continue" | "exit"; state: TuiState };

export function applyTuiCommandResult(
  state: TuiState,
  result: SessionCommandResult,
  idSeed: string,
): TuiCommandOutcome {
  switch (result.action) {
    case "exit":
      return {
        action: "exit",
        state: appendInfoLog(state, {
          id: `cmd:${idSeed}`,
          title: result.title,
          detail: result.body,
        }),
      };
    case "notice":
      return {
        action: "continue",
        state: appendInfoLog(state, {
          id: `cmd:${idSeed}`,
          title: result.title,
          detail: result.body,
        }),
      };
    case "compact":
      return {
        action: "continue",
        state: appendInfoLog(state, {
          id: `cmd:${idSeed}`,
          title: "Compact",
          detail: result.message,
        }),
      };
    case "report":
      return {
        action: "continue",
        state: appendInfoLog(state, {
          id: `cmd:${idSeed}`,
          title: "Report",
          detail: result.message,
        }),
      };
    case "message":
      // Handled upstream (useSession runs the expanded text as a user turn);
      // nothing to log here.
      return { action: "continue", state };
  }
}
