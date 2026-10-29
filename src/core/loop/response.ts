import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { AgentLoopStopReason } from "./loop.js";

function textFromContent(content: AssistantMessage["content"]): string {
  const parts: string[] = [];
  for (const block of content) {
    if (block.type !== "text") continue;
    const t = block.text.trim();
    if (t !== "") parts.push(t);
  }
  return parts.join("\n\n");
}

export function describeFinalResponse(
  content: AssistantMessage["content"],
  stopReason: AgentLoopStopReason,
): string {
  const text = textFromContent(content);
  if (text !== "") return text;
  const blockTypes = [...new Set(content.map((b) => b.type))].join(",");
  return `[no text response] stopReason=${stopReason ?? "unknown"}, blocks=${blockTypes || "none"}`;
}
