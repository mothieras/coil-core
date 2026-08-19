import React from "react";
import { Box, Text } from "ink";
import Spinner from "ink-spinner";
import type { SessionSnapshot } from "../../core/session/types.js";
import type { TurnPhase } from "../sessionActions.js";
import { selectRunningTools, selectRunningSubagents, selectRunningBackground } from "../state.js";

const PHASE_LABEL: Record<TurnPhase, string> = {
  thinking: "thinking",
  "waiting-async": "waiting on async work",
  "auto-waking": "resuming",
  idle: "",
};

export function RunningActivity({
  snapshot,
  phase,
}: {
  snapshot: SessionSnapshot;
  phase: TurnPhase;
}): React.ReactElement | null {
  const tools = selectRunningTools(snapshot);
  const subs = selectRunningSubagents(snapshot);
  const bg = selectRunningBackground(snapshot);
  const label = PHASE_LABEL[phase];
  if (label === "" && tools.length === 0 && subs.length === 0 && bg.length === 0) return null;
  return (
    <Box flexDirection="column">
      {label !== "" && (
        <Text color="yellow">
          <Spinner type="dots" /> {label}
        </Text>
      )}
      {tools.map((t) => (
        <Text key={t.id} color="yellow">
          {" "}
          ↳ tool {t.toolName}
          {t.inputSummary ? `  ${t.inputSummary}` : ""}
        </Text>
      ))}
      {subs.map((s) => (
        <Text key={s.id} color="yellow">
          {" "}
          ↳ subagent {s.promptSummary}
        </Text>
      ))}
      {bg.map((c) => (
        <Text key={c.id} color="yellow">
          {" "}
          ↳ bg {c.commandSummary}
        </Text>
      ))}
    </Box>
  );
}
