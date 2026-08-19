import React from "react";
import { Box, Text } from "ink";
import type { SessionSnapshot } from "../../core/session/types.js";
import type { TurnPhase } from "../sessionActions.js";
import type { PermissionRequest } from "../permissionBridge.js";
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
  } = props;
  const counts = new Map<string, number>();
  for (const t of snapshot.tasks) counts.set(t.status, (counts.get(t.status) ?? 0) + 1);
  const taskSummary = [...counts.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([s, n]) => `${s}:${n}`)
    .join(" ");
  return (
    <Box flexDirection="column" borderStyle="single" borderColor="gray" paddingX={1}>
      <RunningActivity snapshot={snapshot} phase={phase} />
      {snapshot.tasks.length > 0 && <Text color="gray">Tasks {taskSummary}</Text>}
      <StatusBar snapshot={snapshot} model={model} />
      {permission ? (
        <PermissionModal request={permission} onDecision={onPermissionDecision} />
      ) : (
        <Input
          value={input}
          onChange={onInputChange}
          onSubmit={onSubmit}
          busy={busy}
          disabled={busy}
          history={history}
        />
      )}
      <Text color="gray">
        {busy ? "ESC interrupt · Ctrl+C quit" : "Enter send · /help · /resume · Ctrl+C quit"}
      </Text>
    </Box>
  );
}
