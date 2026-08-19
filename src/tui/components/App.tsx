import React from "react";
import { Box, Static, useInput } from "ink";
import type { UseSessionApi } from "../useSession.js";
import { LogLine } from "./LogItem.js";
import { Footer } from "./Footer.js";

export function App({ session }: { session: UseSessionApi }): React.ReactElement {
  const { state, phase, busy, permission, input, setInput, submit, decide, interrupt, history } =
    session;

  useInput((_input, key) => {
    if (key.escape && busy && permission === null) interrupt();
  });
  const sessionKey = state.snapshot.session?.id ?? "none";
  return (
    <Box flexDirection="column">
      {/* key on session id: resume swaps the session → Static remounts and reprints history */}
      <Static key={sessionKey} items={state.log}>
        {(item) => <LogLine key={item.id} item={item} />}
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
      />
    </Box>
  );
}
