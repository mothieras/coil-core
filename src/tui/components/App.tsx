import React from "react";
import path from "node:path";
import { Box, Text, useInput, useWindowSize } from "ink";
import type { UseSessionApi } from "../useSession.js";
import { LogLine } from "./LogItem.js";
import { Footer } from "./Footer.js";
import { TUI_COLORS, TUI_SYMBOLS } from "../theme.js";
import { ScrollView } from "./ScrollView.js";

export function App({ session }: { session: UseSessionApi }): React.ReactElement {
  const {
    state,
    phase,
    busy,
    permission,
    login,
    setupMessage,
    input,
    setInput,
    submit,
    decide,
    interrupt,
    cancel,
    quit,
    history,
  } = session;
  const { columns, rows } = useWindowSize();
  const width = Math.max(1, columns);
  const height = Math.max(1, rows);
  const workspace = state.snapshot.session?.workspaceRoot ?? process.cwd();

  useInput((keyInput, key) => {
    if (key.ctrl && keyInput === "c") {
      if (busy) cancel();
      else if (input !== "") setInput("");
      else quit();
      return;
    }
    if (key.ctrl && keyInput === "d") {
      quit();
      return;
    }
    if (key.escape && busy && permission === null) {
      if (phase === "waiting-async") interrupt();
      else if (login || phase === "thinking" || phase === "auto-waking") cancel();
    }
  });
  const sessionKey = state.snapshot.session?.id ?? "none";
  return (
    <Box flexDirection="column" width={width} height={height} overflow="hidden">
      <Box flexDirection="column" height={2} flexShrink={0} paddingX={1}>
        <Text wrap="truncate-end">
          <Text color={TUI_COLORS.primary} bold>
            {TUI_SYMBOLS.brand} coil
          </Text>
          <Text color={TUI_COLORS.muted}> · {state.model ?? "no model selected"}</Text>
        </Text>
        <Text color={TUI_COLORS.muted} wrap="truncate-middle">
          {workspace}
        </Text>
      </Box>
      <ScrollView key={sessionKey} width={width} permission={permission !== null}>
        {state.snapshot.conversationMessages.length === 0 && (
          <Box paddingX={1} marginY={1}>
            <Text color={TUI_COLORS.muted}>
              {setupMessage ?? `Ask about ${path.basename(workspace)}, or describe a change.`}
            </Text>
          </Box>
        )}
        {state.log.map((item) => (
          <LogLine key={item.id} item={item} width={Math.max(1, width - 1)} />
        ))}
      </ScrollView>
      <ScrollView
        key={`${sessionKey}:${permission?.id ?? (login ? "login" : "composer")}`}
        width={width}
        maxHeight={Math.max(3, height - 6)}
        footer
        permission={permission !== null}
      >
        <Footer
          snapshot={state.snapshot}
          model={state.model}
          phase={phase}
          busy={busy}
          input={input}
          onInputChange={setInput}
          onSubmit={submit}
          history={history}
          permission={permission}
          login={login}
          onPermissionDecision={decide}
          width={Math.max(1, width - 1)}
        />
      </ScrollView>
    </Box>
  );
}
