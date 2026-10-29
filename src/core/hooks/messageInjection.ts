import type { Message } from "@earendil-works/pi-ai";

export function pushTaggedUserMessage(
  messages: Message[],
  tag: string,
  body: string,
  style: "block" | "inline" = "block",
): void {
  messages.push({
    role: "user",
    content: style === "inline" ? `<${tag}>${body}</${tag}>` : `<${tag}>\n${body}\n</${tag}>`,
    timestamp: Date.now(),
  });
}
