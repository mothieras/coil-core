import type Anthropic from "@anthropic-ai/sdk";

export function pushTaggedUserMessage(
  messages: Anthropic.Messages.MessageParam[],
  tag: string,
  body: string,
  style: "block" | "inline" = "block",
): void {
  messages.push({
    role: "user",
    content: style === "inline" ? `<${tag}>${body}</${tag}>` : `<${tag}>\n${body}\n</${tag}>`,
  });
}
