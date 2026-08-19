import { Marked } from "marked";
import { markedTerminal } from "marked-terminal";

// One shared renderer: markedTerminal registers a terminal renderer that
// emits ANSI-styled text (colors auto-disable on non-TTY stdout).
const terminalMarked = new Marked(markedTerminal({ reflowText: false }));

/**
 * Renders assistant markdown to ANSI-styled terminal text. Total function:
 * any renderer failure falls back to the raw input so a malformed reply can
 * never break the log.
 */
export function renderMarkdown(text: string): string {
  if (typeof text !== "string" || text === "") return text;
  try {
    const out = terminalMarked.parse(text, { async: false });
    return typeof out === "string" ? out.replace(/\s+$/, "") : text;
  } catch {
    return text;
  }
}
