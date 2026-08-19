import React from "react";
import { Box, Text, useInput } from "ink";
import TextInput from "ink-text-input";

export type InputClass = { kind: "empty" | "message" | "slash" | "resume"; arg: string };

export type PastedInput = { submit: string | undefined; value: string };

// A multi-character stdin chunk (paste, scripted input) reaches ink's useInput
// as ONE event with any newline embedded in the text instead of a separate
// return keypress, so ink-text-input inserts the raw "\r" into the value:
// Enter never fires, and rendering the "\r" resets the cursor to column 0 and
// corrupts the frame. Treat the first embedded newline as Enter — submit what
// precedes it, keep the remainder (later newlines collapse to spaces; only one
// turn can start per event anyway).
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
  // null = live buffer; otherwise an index into history being recalled.
  const historyIndex = React.useRef<number | null>(null);

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
    <Box>
      <Text color={busy ? "gray" : "cyan"}>coil › </Text>
      {disabled ? (
        <Text color="gray">{busy ? "(running… input paused)" : value}</Text>
      ) : (
        <TextInput
          value={value}
          onChange={(next) => {
            historyIndex.current = null; // typing leaves history-recall mode
            const pasted = splitPastedInput(next);
            // Submit before onChange: the submit handler clears the buffer,
            // and the later onChange call wins the batch with the remainder.
            if (pasted.submit !== undefined) onSubmit(pasted.submit);
            onChange(pasted.value);
          }}
          onSubmit={(v) => {
            historyIndex.current = null;
            onSubmit(v);
          }}
        />
      )}
    </Box>
  );
}
