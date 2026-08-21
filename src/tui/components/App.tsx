import React from "react";
import { Box, Static, useInput, useWindowSize } from "ink";
import type { UseSessionApi } from "../useSession.js";
import { LogLine } from "./LogItem.js";
import { Footer } from "./Footer.js";

export function App({ session }: { session: UseSessionApi }): React.ReactElement {
  const {
    state,
    phase,
    busy,
    permission,
    input,
    setInput,
    submit,
    decide,
    interrupt,
    quit,
    history,
  } = session;
  const { columns } = useWindowSize();
  const width = Math.max(20, columns);

  useInput((keyInput, key) => {
    if (key.ctrl && keyInput === "c") {
      if (!busy) quit();
      return;
    }
    if (key.escape && phase === "waiting-async" && busy && permission === null) interrupt();
  });
  const sessionKey = state.snapshot.session?.id ?? "none";
  return (
    <Box flexDirection="column" width={width}>
      {/* Resuming swaps the session, so remount Static and print the restored transcript once. */}
      <Static key={sessionKey} items={state.log}>
        {(item) => <LogLine key={item.id} item={item} width={width} />}
      </Static>
      <Footer
        snapshot={state.snapshot}
        {...(state.model !== undefined ? { model: state.model } : {})}
        phase={phase}
        busy={busy}
        input={input}
        onInputChange={setInput}
        onSubmit={submit}
        history={history}
        permission={permission}
        onPermissionDecision={decide}
        width={width}
      />
    </Box>
  );
}
