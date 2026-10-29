import type {
  AssistantMessage,
  Message,
  TextContent,
  ThinkingContent,
  ToolCall,
  ToolResultMessage,
  Usage,
} from "@earendil-works/pi-ai";

const ZERO_USAGE: Usage = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

type RecordValue = Record<string, unknown>;

function isRecord(value: unknown): value is RecordValue {
  return typeof value === "object" && value !== null;
}

function looksLegacy(value: unknown): boolean {
  if (!isRecord(value)) return true;
  // Every pi-ai message variant carries a numeric timestamp; the pre-pi-ai
  // Anthropic MessageParam format had none.
  return typeof value.timestamp !== "number";
}

function textFromAnthropicContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return content === undefined ? "" : JSON.stringify(content);
  return content
    .map((block) => {
      if (typeof block === "string") return block;
      if (isRecord(block) && block.type === "text" && typeof block.text === "string") {
        return block.text;
      }
      return JSON.stringify(block);
    })
    .join("\n");
}

function asTimestamp(value: unknown): number {
  return typeof value === "number" ? value : Date.now();
}

/**
 * Reads sessions persisted by the pre-pi-ai format (Anthropic MessageParam[])
 * and rewrites them as pi-ai messages. Already-migrated messages pass through.
 */
export function importLegacyAnthropicMessages(raw: unknown): Message[] {
  if (!Array.isArray(raw)) return [];

  const messages: Message[] = [];
  const toolNames = new Map<string, string>();

  for (const value of raw) {
    if (!isRecord(value)) continue;

    if (!looksLegacy(value)) {
      messages.push(value as Message);
      continue;
    }

    const timestamp = asTimestamp(value.timestamp);
    if (value.role === "assistant") {
      messages.push(convertAssistant(value, timestamp, toolNames));
      continue;
    }

    if (value.role === "user") {
      messages.push(...convertUser(value, timestamp, toolNames));
    }
  }

  return messages;
}

function convertAssistant(
  value: RecordValue,
  timestamp: number,
  toolNames: Map<string, string>,
): AssistantMessage {
  const content: AssistantMessage["content"] = [];
  const blocks = Array.isArray(value.content) ? value.content : [];

  for (const block of blocks) {
    if (!isRecord(block)) continue;
    if (block.type === "text" && typeof block.text === "string") {
      content.push({ type: "text", text: block.text });
      continue;
    }
    if (
      block.type === "tool_use" &&
      typeof block.id === "string" &&
      typeof block.name === "string"
    ) {
      toolNames.set(block.id, block.name);
      const toolCall: ToolCall = {
        type: "toolCall",
        id: block.id,
        name: block.name,
        arguments: isRecord(block.input) ? (block.input as ToolCall["arguments"]) : {},
      };
      content.push(toolCall);
      continue;
    }
    if (block.type === "thinking" && typeof block.thinking === "string") {
      const thinking: ThinkingContent = {
        type: "thinking",
        thinking: block.thinking,
        ...(typeof block.signature === "string" ? { thinkingSignature: block.signature } : {}),
      };
      content.push(thinking);
    }
  }

  const hasToolCall = content.some((block) => block.type === "toolCall");
  return {
    role: "assistant",
    content,
    api: "anthropic-messages",
    provider: "anthropic",
    model: typeof value.model === "string" ? value.model : "legacy",
    usage: ZERO_USAGE,
    stopReason: hasToolCall ? "toolUse" : "stop",
    timestamp,
  };
}

function convertUser(
  value: RecordValue,
  timestamp: number,
  toolNames: Map<string, string>,
): Message[] {
  if (typeof value.content === "string") {
    return [{ role: "user", content: value.content, timestamp }];
  }
  if (!Array.isArray(value.content)) return [];

  const results: ToolResultMessage[] = [];
  const textBlocks: TextContent[] = [];

  for (const block of value.content) {
    if (!isRecord(block)) continue;
    if (block.type === "tool_result" && typeof block.tool_use_id === "string") {
      const result: ToolResultMessage = {
        role: "toolResult",
        toolCallId: block.tool_use_id,
        toolName: toolNames.get(block.tool_use_id) ?? "unknown",
        content: [{ type: "text", text: textFromAnthropicContent(block.content) }],
        isError: block.is_error === true,
        timestamp,
      };
      results.push(result);
      continue;
    }
    if (block.type === "text" && typeof block.text === "string") {
      textBlocks.push({ type: "text", text: block.text });
    }
  }

  const converted: Message[] = [...results];
  if (textBlocks.length > 0) {
    converted.push({ role: "user", content: textBlocks, timestamp });
  }
  return converted;
}
