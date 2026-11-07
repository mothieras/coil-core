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
      ) : (
        <Box
          flexDirection="column"
          width={width}
          borderStyle={TUI_BORDER_STYLE}
          borderLeft={false}
          borderRight={false}
          borderColor={TUI_COLORS.border}
          paddingX={1}
        >
          <Input
            value={input}
            onChange={onInputChange}
            onSubmit={onSubmit}
            busy={busy}
            disabled={phase === "closing" || phase === "close-failed"}
            history={history}
          />
        </Box>
      )}
      <StatusBar snapshot={snapshot} model={model} width={width} />
      {snapshot.agentRuns.some((run) => run.status === "stopping") && (
        <Box paddingX={1}>
          <Text color={TUI_COLORS.warning}>Stopping execution; waiting for confirmation.</Text>
        </Box>
      )}
      {
        <Box paddingX={1}>
          <Text color={TUI_COLORS.muted}>
            {permission
              ? "Scroll to review · Ctrl+C cancel · Ctrl+D close"
              : footerHint(phase, busy, width)}
          </Text>
        </Box>
      }
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
  if (phase === "closing") return "Stopping owned work and saving session.";
  if (phase === "close-failed")
    return "Session closed to new work. Inspect cleanup errors before exiting.";
  if (!busy) {
    return width < 72 ? "/ commands · Ctrl+D quit" : "/ commands · ↑↓ prompts · Ctrl+D quit";
  }
  if (phase === "waiting-async") {
    return "Esc stop waiting · Ctrl+C cancel work · draft kept";
  }
  return width < 72
    ? "Esc interrupt · draft kept"
    : "Esc interrupt · Ctrl+C cancel · draft kept until you send";
}
