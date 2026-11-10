import React, { useState } from "react";
import { Box, Text, useInput } from "ink";
import TextInput from "ink-text-input";
import type { LoginView, PendingLoginPrompt } from "../useLogin.js";
import { TUI_COLORS, TUI_SYMBOLS } from "../theme.js";

export function LoginPanel({ view }: { view: LoginView }): React.ReactElement {
  return (
    <Box flexDirection="column">
      <Text color={TUI_COLORS.primary} bold>
        Model login
      </Text>
      {view.notes.length > 0 && <Text>{view.notes.join("\n")}</Text>}
      {view.prompt ? (
        <LoginPrompt key={view.prompt.id} {...view.prompt} />
      ) : (
        <Text color={TUI_COLORS.muted}>Waiting for sign-in…</Text>
      )}
    </Box>
  );
}

function LoginPrompt({ prompt, answer }: PendingLoginPrompt): React.ReactElement {
  const [value, setValue] = useState("");
  const [selected, setSelected] = useState(0);
  const query = value.trim().toLowerCase();
  const choices =
    prompt.type === "select"
      ? prompt.options.filter(({ id, label, description }) =>
          `${id} ${label} ${description ?? ""}`.toLowerCase().includes(query),
        )
      : [];
  const index = Math.min(selected, Math.max(0, choices.length - 1));
  const first = Math.max(0, index - 4);
  const hidden = prompt.type === "secret" || prompt.type === "manual_code";

  useInput(
    (_input, key) => {
      if (choices.length === 0) return;
      if (key.upArrow || key.downArrow) {
        const direction = key.upArrow ? -1 : 1;
        setSelected((index + direction + choices.length) % choices.length);
      }
    },
    { isActive: prompt.type === "select" },
  );

  return (
    <Box flexDirection="column">
      <Text>{prompt.message}</Text>
      <TextInput
        value={value}
        placeholder={prompt.type === "select" ? "Filter options…" : (prompt.placeholder ?? "")}
        {...(hidden ? { mask: "*" } : {})}
        onChange={(next) => {
          setValue(next);
          setSelected(0);
        }}
        onSubmit={(next) => {
          if (prompt.type === "select") {
            const choice = choices[index];
            if (choice) answer(choice.id);
          } else if (!hidden || next.trim()) {
            answer(next.trim());
          }
        }}
      />
      {choices.slice(first, first + 5).map(({ id, label, description }, offset) => (
        <Text
          key={id}
          color={first + offset === index ? TUI_COLORS.primary : TUI_COLORS.muted}
          wrap="truncate-end"
        >
          {first + offset === index ? `${TUI_SYMBOLS.user} ` : "  "}
          {label}
          {description && description.toLowerCase() !== label.toLowerCase()
            ? ` · ${description}`
            : ""}
        </Text>
      ))}
      {prompt.type === "select" && (
        <Text color={TUI_COLORS.muted}>
          {choices.length ? "↑↓ select · Enter confirm" : "No matching options"}
        </Text>
      )}
    </Box>
  );
}
