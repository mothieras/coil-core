import React from "react";
import { Box, Text } from "ink";
import Spinner from "ink-spinner";
import type { SessionSnapshot } from "../../core/session/types.js";
import type { TurnPhase } from "../sessionActions.js";
import { humanizeIdentifier, truncateEnd } from "../format.js";
import { selectRunningTools, selectRunningSubagents, selectRunningBackground } from "../state.js";
import { shouldAnimateActivity, TUI_COLORS, TUI_SYMBOLS } from "../theme.js";

const PHASE_LABEL: Record<TurnPhase, string> = {
  thinking: "Working",
  "waiting-async": "Waiting for async work",
  "auto-waking": "Resuming with async results",
  idle: "",
};

type ActivityRow = { id: string; marker: string; label: string; summary?: string | undefined };

export function RunningActivity({
  snapshot,
  phase,
  width = 80,
  animated = shouldAnimateActivity(),
}: {
  snapshot: SessionSnapshot;
  phase: TurnPhase;
  width?: number | undefined;
  animated?: boolean | undefined;
}): React.ReactElement | null {
  const rows: ActivityRow[] = [
    ...selectRunningTools(snapshot).map((tool) => ({
      id: `tool:${tool.id}`,
      marker: TUI_SYMBOLS.branch,
      label: humanizeIdentifier(tool.toolName),
      summary: tool.inputSummary,
    })),
    ...selectRunningSubagents(snapshot).map((agent) => ({
      id: `subagent:${agent.id}`,
      marker: TUI_SYMBOLS.subagent,
      label: "Subagent",
      summary: agent.promptSummary,
    })),
    ...selectRunningBackground(snapshot).map((command) => ({
      id: `background:${command.id}`,
      marker: TUI_SYMBOLS.background,
      label: "Background",
      summary: command.commandSummary,
    })),
  ];
  const phaseLabel = PHASE_LABEL[phase];
  if (phaseLabel === "" && rows.length === 0) return null;

  const maxRows = width < 72 ? 2 : 4;
  const shownRows = rows.slice(0, maxRows);
  const hiddenCount = rows.length - shownRows.length;
  return (
    <Box flexDirection="column" width={width} paddingX={1} marginBottom={1}>
      <Text color={TUI_COLORS.primary} bold>
        {animated ? <Spinner type="dots" /> : TUI_SYMBOLS.running} {phaseLabel || "Working"}
      </Text>
      {shownRows.map((row) => (
        <Text key={row.id} wrap="truncate-end">
          <Text color={TUI_COLORS.muted}>{row.marker} </Text>
          <Text>{row.label}</Text>
          {row.summary ? (
            <Text color={TUI_COLORS.muted}>
              {" "}
              {truncateEnd(row.summary, Math.max(12, width - 24))}
            </Text>
          ) : null}
        </Text>
      ))}
      {hiddenCount > 0 && (
        <Text color={TUI_COLORS.muted}>
          {TUI_SYMBOLS.branch} {hiddenCount} more active
        </Text>
      )}
    </Box>
  );
}
