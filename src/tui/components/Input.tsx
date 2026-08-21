import React from "react";
import { Box, Text, useInput } from "ink";
import TextInput from "ink-text-input";
import { TUI_COLORS, TUI_SYMBOLS } from "../theme.js";

export type InputClass = { kind: "empty" | "message" | "slash" | "resume"; arg: string };

export type PastedInput = { submit: string | undefined; value: string };

export type CommandSuggestion = { command: string; description: string };

const COMMANDS: readonly CommandSuggestion[] = [
  { command: "/help", description: "show commands" },
  { command: "/status", description: "session status" },
  { command: "/tasks", description: "list tasks" },
  { command: "/subagents", description: "list subagents" },
  { command: "/resume", description: "switch session" },
  { command: "/ping", description: "check provider" },
  { command: "/compact", description: "compact context" },
  { command: "/report", description: "write report" },
  { command: "/exit", description: "save and quit" },
];

// A pasted multi-line stdin chunk reaches Ink as one event. Submit the first
// line and keep the remaining text in the composer so raw carriage returns can
// never corrupt the terminal frame.
export function splitPastedInput(next: string): PastedInput {
  if (!/[\r\n]/.test(next)) return { submit: undefined, value: next };
  const index = next.search(/[\r\n]/);
  const head = next.slice(0, index).trim();
  const rest = next
    .slice(index)
    .replace(/[\r\n]+/g, " ")
    .trim();
  return { submit: head === "" ? undefined : head, value: rest };
}

export function classifyInput(text: string): InputClass {
  const trimmed = text.trim();
  if (trimmed === "") return { kind: "empty", arg: "" };
  if (trimmed === "/resume" || trimmed.startsWith("/resume ")) {
    return { kind: "resume", arg: trimmed.slice("/resume".length).trim() };
  }
  if (trimmed.startsWith("/")) return { kind: "slash", arg: trimmed };
  return { kind: "message", arg: trimmed };
}

export function commandSuggestions(value: string, limit = 3): CommandSuggestion[] {
  const trimmed = value.trimStart();
  if (!trimmed.startsWith("/") || trimmed.includes(" ")) return [];
  return COMMANDS.filter((item) => item.command.startsWith(trimmed)).slice(0, limit);
}

export type InputProps = {
  value: string;
  onChange: (v: string) => void;
  onSubmit: (v: string) => void;
  busy: boolean;
  disabled: boolean;
  history?: readonly string[] | undefined;
};

export function Input({
  value,
  onChange,
  onSubmit,
  busy,
  disabled,
  history = [],
}: InputProps): React.ReactElement {
  const historyIndex = React.useRef<number | null>(null);
  const suggestions = disabled ? [] : commandSuggestions(value);

  useInput(
    (_input, key) => {
      if (key.upArrow) {
        if (history.length === 0) return;
        const next =
          historyIndex.current === null
            ? history.length - 1
            : Math.max(0, historyIndex.current - 1);
        historyIndex.current = next;
        onChange(history[next] ?? "");
        return;
      }
      if (key.downArrow) {
        if (historyIndex.current === null) return;
        const next = historyIndex.current + 1;
        if (next >= history.length) {
          historyIndex.current = null;
          onChange("");
        } else {
          historyIndex.current = next;
          onChange(history[next] ?? "");
        }
      }
    },
    { isActive: !disabled },
  );

  return (
    <Box flexDirection="column">
      <Box>
        <Text color={disabled ? TUI_COLORS.muted : TUI_COLORS.primary} bold>
          {TUI_SYMBOLS.user}{" "}
        </Text>
        {disabled ? (
          <Text color={TUI_COLORS.muted}>{busy ? "Input paused while the turn runs" : value}</Text>
        ) : (
          <TextInput
            value={value}
            placeholder="Ask coil to change the code"
            onChange={(next) => {
              historyIndex.current = null;
              const pasted = splitPastedInput(next);
              if (pasted.submit !== undefined) onSubmit(pasted.submit);
              onChange(pasted.value);
            }}
            onSubmit={(next) => {
              historyIndex.current = null;
              onSubmit(next);
            }}
          />
        )}
      </Box>
      {suggestions.map((suggestion) => (
        <Text key={suggestion.command} color={TUI_COLORS.muted}>
          {"  "}
          <Text color={TUI_COLORS.primary}>{suggestion.command.padEnd(12)}</Text>
          {suggestion.description}
        </Text>
      ))}
    </Box>
  );
}
