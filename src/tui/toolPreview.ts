const MAX_CHANGED_LINES = 8;
const MAX_CONTENT_LINES = 10;
const CONTEXT_LINES = 2;

function sideLines(text: string, prefix: "- " | "+ ", cap: number): string[] {
  const lines = text.split("\n");
  const shown = lines.slice(0, cap).map((line) => `${prefix}${line}`);
  if (lines.length > cap) shown.push(`${prefix}… (+${lines.length - cap} more)`);
  return shown;
}

export function formatToolTarget(
  toolName: string,
  input: Record<string, unknown>,
): string | undefined {
  if (toolName === "edit_file" || toolName === "write_file" || toolName === "read_file") {
    const target = input["path"] ?? input["filepath"];
    return typeof target === "string" ? target : undefined;
  }
  if (toolName === "bash" || toolName === "background_run") {
    return typeof input["command"] === "string" ? input["command"] : undefined;
  }
  if (toolName === "subagent") {
    return typeof input["task"] === "string"
      ? input["task"]
      : typeof input["prompt"] === "string"
        ? input["prompt"]
        : undefined;
  }
  return undefined;
}

/**
 * Bounded preview for permission decisions. Diff prefixes and shell prompts are
 * semantic, not decorative, so the preview stays useful without ANSI color.
 */
export function formatToolPreview(
  toolName: string,
  input: Record<string, unknown>,
): string[] | null {
  if (toolName === "edit_file") {
    const oldText = input["old_text"];
    const newText = input["new_text"];
    if (typeof oldText !== "string" || typeof newText !== "string") return null;
    return contextualDiff(oldText, newText);
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

function contextualDiff(oldText: string, newText: string): string[] {
  const oldLines = oldText.split("\n");
  const newLines = newText.split("\n");
  let prefix = 0;
  while (
    prefix < oldLines.length &&
    prefix < newLines.length &&
    oldLines[prefix] === newLines[prefix]
  ) {
    prefix += 1;
  }

  let suffix = 0;
  while (
    suffix < oldLines.length - prefix &&
    suffix < newLines.length - prefix &&
    oldLines[oldLines.length - 1 - suffix] === newLines[newLines.length - 1 - suffix]
  ) {
    suffix += 1;
  }

  if (prefix === oldLines.length && prefix === newLines.length) return ["  (no textual change)"];

  const lines: string[] = [];
  const contextStart = Math.max(0, prefix - CONTEXT_LINES);
  if (contextStart > 0) lines.push("  …");
  for (const line of oldLines.slice(contextStart, prefix)) lines.push(`  ${line}`);

  const oldChanged = oldLines.slice(prefix, oldLines.length - suffix);
  const newChanged = newLines.slice(prefix, newLines.length - suffix);
  if (oldChanged.length > 0) {
    lines.push(...sideLines(oldChanged.join("\n"), "- ", MAX_CHANGED_LINES));
  }
  if (newChanged.length > 0) {
    lines.push(...sideLines(newChanged.join("\n"), "+ ", MAX_CHANGED_LINES));
  }

  const oldSuffixStart = oldLines.length - suffix;
  const suffixLines = oldLines.slice(oldSuffixStart, oldSuffixStart + CONTEXT_LINES);
  for (const line of suffixLines) lines.push(`  ${line}`);
  if (suffix > CONTEXT_LINES) lines.push("  …");
  return lines;
}
