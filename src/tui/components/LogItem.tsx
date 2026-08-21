import React from "react";
import { Box, Text } from "ink";
import type { LogItem as LogItemModel } from "../state.js";
import { formatDuration, humanizeIdentifier, truncateEnd } from "../format.js";
import { renderMarkdown } from "../markdown.js";
import { TUI_COLORS, TUI_SYMBOLS } from "../theme.js";

type EventVisual = { marker: string; color: string; label: string; summary?: string | undefined };

export function LogLine({
  item,
  width = 100,
}: {
  item: LogItemModel;
  width?: number | undefined;
}): React.ReactElement {
  if (item.kind === "message") return <MessageLine item={item} width={width} />;

  const visual = eventVisual(item);
  const status = visibleStatus(item.status);
  const detail = item.kind === "session" ? undefined : item.detail;
  const summary = visual.summary
    ? truncateEnd(visual.summary, Math.max(16, Math.min(72, width - visual.label.length - 12)))
    : undefined;
  return (
    <Box flexDirection="column" width={width} paddingLeft={1}>
      <Text wrap="truncate-end">
        <Text color={visual.color}>{visual.marker}</Text>{" "}
        <Text bold={item.kind === "info" || isExceptional(item.status)}>{visual.label}</Text>
        {summary ? <Text color={TUI_COLORS.muted}> {summary}</Text> : null}
        {status ? <Text color={visual.color}> · {status}</Text> : null}
        {item.source ? <Text color={TUI_COLORS.muted}> [{item.source}]</Text> : null}
        {item.durationMs !== undefined ? (
          <Text color={TUI_COLORS.muted}> · {formatDuration(item.durationMs)}</Text>
        ) : null}
      </Text>
      {detail ? (
        <Text color={isExceptional(item.status) ? visual.color : TUI_COLORS.muted}>
          {"  "}
          {detail}
        </Text>
      ) : null}
    </Box>
  );
}

function MessageLine({ item, width }: { item: LogItemModel; width: number }): React.ReactElement {
  const role = item.role ?? "system";
  const marker =
    role === "user"
      ? TUI_SYMBOLS.user
      : role === "assistant"
        ? TUI_SYMBOLS.assistant
        : TUI_SYMBOLS.system;
  const color = role === "system" ? TUI_COLORS.warning : TUI_COLORS.primary;
  const body = role === "assistant" ? renderMarkdown(item.title) : item.title;
  return (
    <Box width={width} paddingLeft={1} marginTop={role === "user" ? 1 : 0}>
      <Text>
        <Text color={color} bold>
          {marker}
          {role === "system" ? " System" : ""}{" "}
        </Text>
        {body}
      </Text>
    </Box>
  );
}

function eventVisual(item: LogItemModel): EventVisual {
  const exceptional = isExceptional(item.status);
  if (item.kind === "tool") {
    return {
      marker: exceptional ? markerForStatus(item.status) : TUI_SYMBOLS.success,
      color: colorForStatus(item.status),
      label: humanizeIdentifier(item.title),
      summary: item.summary,
    };
  }
  if (item.kind === "subagent") {
    return {
      marker: exceptional ? markerForStatus(item.status) : TUI_SYMBOLS.subagent,
      color: colorForStatus(item.status),
      label: "Subagent",
      summary: item.title,
    };
  }
  if (item.kind === "background") {
    return {
      marker: exceptional ? markerForStatus(item.status) : TUI_SYMBOLS.background,
      color: colorForStatus(item.status),
      label: "Background",
      summary: item.title,
    };
  }
  if (item.kind === "permission") {
    return {
      marker: item.status === "allowed" ? TUI_SYMBOLS.success : TUI_SYMBOLS.error,
      color: item.status === "allowed" ? TUI_COLORS.success : TUI_COLORS.danger,
      label: "Permission",
      summary: humanizeIdentifier(item.title),
    };
  }
  if (item.kind === "compact") {
    return {
      marker: item.status === "failed" ? TUI_SYMBOLS.error : TUI_SYMBOLS.compact,
      color: item.status === "failed" ? TUI_COLORS.danger : TUI_COLORS.info,
      label: "Context",
      summary: "compacted",
    };
  }
  if (item.kind === "report") {
    return {
      marker: TUI_SYMBOLS.report,
      color: TUI_COLORS.success,
      label: "Report",
      summary: item.title,
    };
  }
  if (item.kind === "mcp") {
    return {
      marker: item.status === "failed" ? TUI_SYMBOLS.error : TUI_SYMBOLS.mcp,
      color: item.status === "failed" ? TUI_COLORS.danger : TUI_COLORS.success,
      label: "MCP",
      summary: item.title,
    };
  }
  if (item.kind === "session") {
    return {
      marker: TUI_SYMBOLS.info,
      color: TUI_COLORS.muted,
      label: "Session",
      summary: item.detail,
    };
  }
  return { marker: TUI_SYMBOLS.info, color: TUI_COLORS.info, label: item.title };
}

function isExceptional(status: string | undefined): boolean {
  return (
    status === "error" ||
    status === "failed" ||
    status === "blocked" ||
    status === "permission_denied" ||
    status === "denied" ||
    status === "timeout" ||
    status === "interrupted"
  );
}

function colorForStatus(status: string | undefined): string {
  if (status === "blocked" || status === "timeout" || status === "interrupted") {
    return TUI_COLORS.warning;
  }
  return isExceptional(status) ? TUI_COLORS.danger : TUI_COLORS.success;
}

function markerForStatus(status: string | undefined): string {
  return status === "blocked" || status === "timeout" || status === "interrupted"
    ? TUI_SYMBOLS.warning
    : TUI_SYMBOLS.error;
}

function visibleStatus(status: string | undefined): string | undefined {
  if (
    status === undefined ||
    status === "completed" ||
    status === "written" ||
    status === "finished"
  ) {
    return undefined;
  }
  return humanizeIdentifier(status);
}
