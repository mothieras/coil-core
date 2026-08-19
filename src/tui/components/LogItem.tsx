import React from "react";
import { Text } from "ink";
import type { LogItem as LogItemModel } from "../state.js";
import { renderMarkdown } from "../markdown.js";

const ROLE_LABEL: Record<string, string> = { user: "YOU", assistant: "AGENT", system: "SYS" };

export function LogLine({ item }: { item: LogItemModel }): React.ReactElement {
  if (item.kind === "message") {
    const label = ROLE_LABEL[item.role ?? "system"] ?? "MSG";
    const color = item.role === "user" ? "cyan" : item.role === "assistant" ? "green" : "gray";
    const body = item.role === "assistant" ? renderMarkdown(item.title) : item.title;
    return (
      <Text>
        <Text color={color} bold>
          {label}{" "}
        </Text>
        {body}
      </Text>
    );
  }
  const head = `● ${item.kind} ${item.title}`;
  const status = item.status ? ` ${item.status}` : "";
  const detail = item.detail ? `  ${item.detail}` : "";
  const src = item.source ? ` (${item.source})` : "";
  return (
    <Text color="gray">
      {head}
      {status}
      {src}
      {detail}
    </Text>
  );
}
