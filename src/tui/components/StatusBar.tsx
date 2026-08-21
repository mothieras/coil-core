import path from "node:path";
import React from "react";
import { Box, Text } from "ink";
import type { SessionSnapshot } from "../../core/session/types.js";
import { AUTO_COMPACT_TOKEN_THRESHOLD } from "../../core/context/compact.js";
import { displayWidth, formatCount, truncateEnd, truncateMiddle } from "../format.js";
import { TUI_COLORS } from "../theme.js";

const WIDE_WIDTH = 96;
const COMPACT_WIDTH = 72;

export function formatStatusLine(
  snapshot: SessionSnapshot,
  model: string | undefined,
  width: number,
): string {
  const session = snapshot.session;
  const workspace = path.basename(session?.workspaceRoot ?? process.cwd()) || "/";
  const compact = width < COMPACT_WIDTH;
  const wide = width >= WIDE_WIDTH;
  const runningTools = snapshot.toolCalls.filter((call) => call.status === "running").length;
  const runningBackground = snapshot.backgroundCommands.filter(
    (command) => command.status === "running",
  ).length;
  const runningSubagents = snapshot.subagents.filter((agent) => agent.status === "running").length;
  const mcpConnected = snapshot.mcpServers.filter((server) => server.status === "connected").length;
  const mcpFailed = snapshot.mcpServers.filter((server) => server.status === "failed").length;

  // Operational failures and active work come first. Low-priority identity and
  // token totals are admitted only when the line still fits.
  const important: string[] = [];
  if (mcpFailed > 0) important.push(`mcp !${mcpFailed}`);
  const running = formatRunningCounts(runningTools, runningSubagents, runningBackground);
  if (running !== null) important.push(running);

  important.push(truncateEnd(workspace, compact ? 12 : wide ? 22 : 16));
  important.push(truncateMiddle(model ?? "unknown model", compact ? 14 : wide ? 28 : 20));
  important.push(
    `ctx≈${formatCount(snapshot.usage.lastInputTokens)}/${formatCount(AUTO_COMPACT_TOKEN_THRESHOLD)}`,
  );

  const optional: string[] = [];
  if (mcpConnected > 0 && mcpFailed === 0) optional.push(`mcp ${mcpConnected}`);
  if (!compact && session?.title && session.title !== "Untitled session") {
    optional.push(truncateEnd(session.title, 22));
  }
  if (wide && session) optional.push(`#${session.id.slice(0, 8)}`);
  if (wide && (snapshot.usage.inputTokens > 0 || snapshot.usage.outputTokens > 0)) {
    optional.push(
      `↑${formatCount(snapshot.usage.inputTokens)} ↓${formatCount(snapshot.usage.outputTokens)}`,
    );
  }

  return fitStatusParts([...important, ...optional], Math.max(18, width - 2));
}

export function StatusBar({
  snapshot,
  model,
  width = 100,
}: {
  snapshot: SessionSnapshot;
  model?: string | undefined;
  width?: number | undefined;
}): React.ReactElement {
  return (
    <Box width={width} paddingX={1}>
      <Text aria-label="Session status" color={TUI_COLORS.muted} wrap="truncate-end">
        {formatStatusLine(snapshot, model, width)}
      </Text>
    </Box>
  );
}

function formatRunningCounts(tools: number, subagents: number, background: number): string | null {
  const counts: string[] = [];
  if (tools > 0) counts.push(`t${tools}`);
  if (subagents > 0) counts.push(`a${subagents}`);
  if (background > 0) counts.push(`bg${background}`);
  return counts.length > 0 ? `run ${counts.join("/")}` : null;
}

function fitStatusParts(parts: readonly string[], maxLength: number): string {
  const fitted: string[] = [];
  let length = 0;
  for (const part of parts) {
    if (part === "") continue;
    const added = (fitted.length === 0 ? 0 : 3) + displayWidth(part);
    if (length + added > maxLength) continue;
    fitted.push(part);
    length += added;
  }
  return fitted.join(" · ");
}
