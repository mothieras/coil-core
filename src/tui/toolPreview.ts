const MAX_SIDE_LINES = 8;
const MAX_CONTENT_LINES = 10;

function sideLines(text: string, prefix: "- " | "+ ", cap: number): string[] {
  const lines = text.split("\n");
  const shown = lines.slice(0, cap).map((line) => `${prefix}${line}`);
  if (lines.length > cap) shown.push(`${prefix}… (+${lines.length - cap} more)`);
  return shown;
}

/**
 * Preview lines for the permission prompt: what will actually change if the
 * user allows this call. Lines are prefixed "- " / "+ " / "$ " so the modal
 * can color them; returns null when a tool has no meaningful preview.
 */
export function formatToolPreview(
  toolName: string,
  input: Record<string, unknown>,
): string[] | null {
  if (toolName === "edit_file") {
    const oldText = input["old_text"];
    const newText = input["new_text"];
    if (typeof oldText !== "string" || typeof newText !== "string") return null;
    return [
      ...sideLines(oldText, "- ", MAX_SIDE_LINES),
      ...sideLines(newText, "+ ", MAX_SIDE_LINES),
    ];
  }
  if (toolName === "write_file") {
    const content = input["content"];
    if (typeof content !== "string") return null;
    return sideLines(content, "+ ", MAX_CONTENT_LINES);
  }
  if (toolName === "bash" || toolName === "background_run") {
    const command = input["command"];
    if (typeof command !== "string") return null;
    return [`$ ${command}`];
  }
  return null;
}
