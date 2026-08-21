import React from "react";
import { Box, Text, useInput } from "ink";
import type { PermissionRequest } from "../permissionBridge.js";
import { formatToolPreview, formatToolTarget } from "../toolPreview.js";
import { humanizeIdentifier, truncateMiddle } from "../format.js";
import { TUI_BORDER_STYLE, TUI_COLORS, TUI_SYMBOLS } from "../theme.js";

const MAX_PREVIEW_LINES = 14;

function previewColor(line: string): string {
  if (line.startsWith("- ")) return TUI_COLORS.danger;
  if (line.startsWith("+ ")) return TUI_COLORS.success;
  if (line.startsWith("$ ")) return TUI_COLORS.warning;
  return TUI_COLORS.muted;
}

export function PermissionModal({
  request,
  onDecision,
  width = 80,
}: {
  request: PermissionRequest;
  onDecision: (allow: boolean) => void;
  width?: number | undefined;
}): React.ReactElement {
  useInput((input, key) => {
    const normalized = input.toLowerCase();
    if (normalized === "y") onDecision(true);
    else if (normalized === "n" || key.escape) onDecision(false);
  });

  const preview = request.input
    ? formatToolPreview(request.toolName, request.input)?.slice(0, MAX_PREVIEW_LINES)
    : undefined;
  const target = request.input ? formatToolTarget(request.toolName, request.input) : undefined;
  const queueLabel =
    request.queueSize && request.queueSize > 1 ? ` · ${request.queueSize} queued` : "";

  return (
    <Box
      flexDirection="column"
      width={width}
      borderStyle={TUI_BORDER_STYLE}
      borderColor={TUI_COLORS.warning}
      paddingX={1}
    >
      <Text color={TUI_COLORS.warning} bold>
        {TUI_SYMBOLS.warning} Permission required{queueLabel}
      </Text>
      <Text>
        {humanizeIdentifier(request.toolName)}
        {target ? (
          <Text color={TUI_COLORS.muted}>
            {" "}
            · {truncateMiddle(target, Math.max(16, width - 26))}
          </Text>
        ) : null}
      </Text>
      <Text color={TUI_COLORS.muted}>{request.reason}</Text>
      {preview
        ? preview.map((line, index) => (
            <Text key={`${index}:${line}`} color={previewColor(line)} wrap="truncate-end">
              {line}
            </Text>
          ))
        : request.inputSummary !== undefined && (
            <Text color={TUI_COLORS.muted} wrap="truncate-end">
              {request.inputSummary}
            </Text>
          )}
      <Text>
        <Text color={TUI_COLORS.success} bold>
          y
        </Text>{" "}
        allow once · <Text color={TUI_COLORS.danger}>n</Text> deny · Esc deny
      </Text>
    </Box>
  );
}
