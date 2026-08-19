import React from "react";
import { Box, Text, useInput } from "ink";
import type { PermissionRequest } from "../permissionBridge.js";
import { formatToolPreview } from "../toolPreview.js";

const MAX_PREVIEW_LINES = 16;

function previewColor(line: string): string {
  if (line.startsWith("- ")) return "red";
  if (line.startsWith("+ ")) return "green";
  return "gray";
}

export function PermissionModal({
  request,
  onDecision,
}: {
  request: PermissionRequest;
  onDecision: (allow: boolean) => void;
}): React.ReactElement {
  useInput((input) => {
    const k = input.toLowerCase();
    if (k === "y") onDecision(true);
    else if (k === "n") onDecision(false);
  });
  const preview = request.input
    ? formatToolPreview(request.toolName, request.input)?.slice(0, MAX_PREVIEW_LINES)
    : undefined;
  return (
    <Box flexDirection="column" borderStyle="round" borderColor="yellow" paddingX={1}>
      <Text color="yellow" bold>
        ⚠ Permission — {request.toolName}
      </Text>
      <Text>{request.reason}</Text>
      {preview
        ? preview.map((line, index) => (
            <Text key={index} color={previewColor(line)}>
              {line}
            </Text>
          ))
        : request.inputSummary !== undefined && <Text color="gray">{request.inputSummary}</Text>}
      <Text>
        <Text color="green">[y]</Text> allow <Text color="red">[n]</Text> deny
      </Text>
    </Box>
  );
}
