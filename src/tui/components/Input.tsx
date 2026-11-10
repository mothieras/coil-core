import React from "react";
import { Box, Text, useInput } from "ink";
import TextInput from "ink-text-input";
import { TUI_COLORS, TUI_SYMBOLS } from "../theme.js";

export type InputClass = { kind: "empty" | "message" | "slash" | "resume" | "login"; arg: string };

export type CommandSuggestion = { command: string; description: string };

const COMMANDS: readonly CommandSuggestion[] = [
  { command: "/help", description: "show commands" },
  { command: "/status", description: "session status" },
  { command: "/tasks", description: "list tasks" },
  { command: "/subagents", description: "list subagents" },
  { command: "/resume", description: "switch session" },
  { command: "/recover", description: "review unknown outcomes" },
  { command: "/login", description: "sign in and select a model" },
  { command: "/ping", description: "check provider" },
  { command: "/compact", description: "compact context" },
  { command: "/report", description: "write report" },
  { command: "/exit", description: "save and quit" },
  { command: "/quit", description: "save and quit" },
];

// Pasting is editing, never submission. Preserve code blocks and normalize CRLF
// so carriage returns cannot overwrite the terminal frame.
export function normalizePastedInput(next: string): string {
  return next.replace(/\r\n?/g, "\n");
}

export function classifyInput(text: string): InputClass {
  const trimmed = text.trim();
  if (trimmed === "") return { kind: "empty", arg: "" };
  if (/^\/login(?:\s|$)/.test(trimmed)) return { kind: "login", arg: trimmed.slice(6).trim() };
  if (trimmed === "/resume" || trimmed.startsWith("/resume ")) {
    return { kind: "resume", arg: trimmed.slice("/resume".length).trim() };
  }
  if (trimmed.startsWith("/")) return { kind: "slash", arg: trimmed };
  return { kind: "message", arg: trimmed };
}

export function commandSuggestions(value: string, limit = COMMANDS.length): CommandSuggestion[] {
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
  const draft = React.useRef("");
  const [selected, setSelected] = React.useState(0);
  const [dismissed, setDismissed] = React.useState<string | null>(null);
  const [editorKey, setEditorKey] = React.useState(0);
  const suggestions =
    disabled || busy || historyIndex.current !== null || dismissed === value
      ? []
      : commandSuggestions(value);
  const selectedIndex = Math.min(selected, Math.max(0, suggestions.length - 1));
  const firstVisible = Math.max(0, selectedIndex - 4);

  React.useEffect(() => {
    setSelected(0);
    setDismissed(null);
  }, [value]);

  function replaceInput(next: string): void {
    onChange(next);
    // ink-text-input does not move its cursor to the end on external changes.
    setEditorKey((key) => key + 1);
  }

  useInput(
    (_input, key) => {
      if (key.escape) {
        setDismissed(value);
        return;
      }
      if (suggestions.length > 0) {
        if (key.upArrow || key.downArrow) {
          const direction = key.upArrow ? -1 : 1;
          setSelected((selectedIndex + direction + suggestions.length) % suggestions.length);
          return;
        }
        if (key.tab) {
          replaceInput(`${suggestions[selectedIndex]!.command} `);
          return;
        }
      }
      if (key.upArrow) {
        if (history.length === 0) return;
        if (historyIndex.current === null) draft.current = value;
        const next =
          historyIndex.current === null
            ? history.length - 1
            : Math.max(0, historyIndex.current - 1);
        historyIndex.current = next;
        replaceInput(history[next] ?? "");
        return;
      }
      if (key.downArrow) {
        if (historyIndex.current === null) return;
        const next = historyIndex.current + 1;
        if (next >= history.length) {
          historyIndex.current = null;
          replaceInput(draft.current);
        } else {
          historyIndex.current = next;
          replaceInput(history[next] ?? "");
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
          <Text color={TUI_COLORS.muted}>Session closed to new input</Text>
        ) : (
          <TextInput
            key={editorKey}
            value={value}
            placeholder={busy ? "Draft your next message…" : "Ask anything, or describe a change…"}
            onChange={(next) => {
              historyIndex.current = null;
              onChange(normalizePastedInput(next));
            }}
            onSubmit={(next) => {
              if (busy) return;
              historyIndex.current = null;
              onSubmit(suggestions[selectedIndex]?.command ?? next);
            }}
          />
        )}
      </Box>
      {suggestions.slice(firstVisible, firstVisible + 5).map((suggestion, index) => (
        <Text key={suggestion.command} color={TUI_COLORS.muted}>
          <Text color={TUI_COLORS.primary}>
            {firstVisible + index === selectedIndex ? `${TUI_SYMBOLS.user} ` : "  "}
          </Text>
          <Text
            color={firstVisible + index === selectedIndex ? TUI_COLORS.primary : TUI_COLORS.muted}
            bold={firstVisible + index === selectedIndex}
          >
            {suggestion.command.padEnd(12)}
          </Text>
          {suggestion.description}
        </Text>
      ))}
      {suggestions.length > 0 && (
        <Text color={TUI_COLORS.muted}> ↑↓ select · Tab complete · Enter run · Esc dismiss</Text>
      )}
    </Box>
  );
}
