import React from "react";
import { Box, Text } from "ink";
import type { SessionSnapshot, TaskProjection } from "../../core/session/types.js";
import type { TurnPhase } from "../sessionActions.js";
import type { PermissionRequest } from "../permissionBridge.js";
import { TUI_BORDER_STYLE, TUI_COLORS, TUI_SYMBOLS } from "../theme.js";
import { RunningActivity } from "./RunningActivity.js";
import { StatusBar } from "./StatusBar.js";
import { Input } from "./Input.js";
import { PermissionModal } from "./PermissionModal.js";

export type FooterProps = {
  snapshot: SessionSnapshot;
  model?: string | undefined;
  phase: TurnPhase;
  busy: boolean;
  input: string;
  onInputChange: (v: string) => void;
  onSubmit: (v: string) => void;
  history?: readonly string[] | undefined;
  permission: PermissionRequest | null;
  onPermissionDecision: (allow: boolean) => void;
  width?: number | undefined;
};

export function Footer(props: FooterProps): React.ReactElement {
  const {
    snapshot,
    model,
    phase,
    busy,
    input,
    onInputChange,
    onSubmit,
    history,
    permission,
    onPermissionDecision,
    width = 80,
  } = props;
  const taskSummary = formatTaskSummary(snapshot.tasks);

  return (
    <Box flexDirection="column" width={width}>
      <RunningActivity snapshot={snapshot} phase={phase} width={width} />
      {taskSummary !== null && (
        <Box paddingX={1} marginBottom={1}>
          <Text color={TUI_COLORS.muted}>
            {TUI_SYMBOLS.task} {taskSummary}
          </Text>
        </Box>
      )}
      {permission ? (
        <PermissionModal request={permission} onDecision={onPermissionDecision} width={width} />
      ) : busy ? (
        <Box paddingX={1}>
          <Text color={TUI_COLORS.muted}>Working, input paused.</Text>
        </Box>
      ) : (
        <Box
          flexDirection="column"
          width={width}
          borderStyle={TUI_BORDER_STYLE}
          borderColor={TUI_COLORS.primary}
          paddingX={1}
        >
          <Input
            value={input}
            onChange={onInputChange}
            onSubmit={onSubmit}
            busy={false}
            disabled={false}
            history={history}
          />
        </Box>
      )}
      <StatusBar snapshot={snapshot} model={model} width={width} />
      {!permission && (
        <Box paddingX={1}>
          <Text color={TUI_COLORS.muted}>{footerHint(phase, busy, width)}</Text>
        </Box>
      )}
    </Box>
  );
}

export function formatTaskSummary(tasks: readonly TaskProjection[]): string | null {
  if (tasks.length === 0) return null;
  const active = tasks.filter((task) => task.status === "in_progress").length;
  const queued = tasks.filter((task) => task.status === "pending").length;
  const done = tasks.filter((task) => task.status === "completed").length;
  const parts: string[] = [];
  if (active > 0) parts.push(`${active} active`);
  if (queued > 0) parts.push(`${queued} queued`);
  if (done > 0) parts.push(`${done} done`);
  return `Tasks · ${parts.join(" · ") || `${tasks.length} tracked`}`;
}

function footerHint(phase: TurnPhase, busy: boolean, width: number): string {
  if (!busy) {
    return width < 72
      ? "Enter send · / commands · Ctrl+C quit"
      : "Enter send · ↑↓ history · / commands · Ctrl+C quit";
  }
  if (phase === "waiting-async") {
    return "Esc stop waiting for async work · Ctrl+C available when idle";
  }
  if (phase === "auto-waking") return "Applying async results · Ctrl+C available when idle";
  return "Operation running · Ctrl+C available when idle";
}
