import React from "react";
import { Text } from "ink";
import type { SessionSnapshot } from "../../core/session/types.js";
import { AUTO_COMPACT_TOKEN_THRESHOLD } from "../../core/context/compact.js";

function fmt(n: number): string {
  return n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n);
}

export function StatusBar({
  snapshot,
  model,
}: {
  snapshot: SessionSnapshot;
  model?: string | undefined;
}): React.ReactElement {
  const sessionId = snapshot.session?.id ?? "no-session";
  const tools = snapshot.toolCalls.filter((c) => c.status === "running").length;
  const bg = snapshot.backgroundCommands.filter((c) => c.status === "running").length;
  const sub = snapshot.subagents.filter((s) => s.status === "running").length;
  const mcpOk = snapshot.mcpServers.filter((s) => s.status === "connected").length;
  const mcpBad = snapshot.mcpServers.filter((s) => s.status === "failed").length;
  const u = snapshot.usage;
  const title = snapshot.session?.title;
  const shownTitle = title && title !== "Untitled session" ? `${title.slice(0, 24)} · ` : "";
  return (
    <Text color="gray">
      {shownTitle}
      {sessionId} · {model ?? "unknown-model"} · ↑{fmt(u.inputTokens)} ↓{fmt(u.outputTokens)} · ctx≈
      {fmt(u.lastInputTokens)}/{fmt(AUTO_COMPACT_TOKEN_THRESHOLD)} · Tools:{tools} Bg:{bg} Sub:{sub}{" "}
      MCP:{mcpOk}/{mcpBad}
    </Text>
  );
}
