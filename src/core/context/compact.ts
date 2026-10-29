import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type {
  ImageContent,
  Message,
  TextContent,
  ToolResultMessage,
  Usage,
} from "@earendil-works/pi-ai";
import { textGenerator, type TextGenerator } from "../providers/index.js";
import { transcriptStatePath } from "../state/paths.js";

const KEEP_RECENT_TOOL_RESULTS = 8;
const PRESERVE_RESULT_TOOLS = new Set<string>(["read_file"]);
const MICRO_COMPACT_THRESHOLD = 30_000;
// Exported so the TUI can show "distance to auto-compact" next to real usage.
export const AUTO_COMPACT_TOKEN_THRESHOLD = 50_000;
const AUTO_COMPACT_THRESHOLD = AUTO_COMPACT_TOKEN_THRESHOLD;
const SUMMARY_INPUT_CHAR_LIMIT = 80_000;
const RECENT_RAW_CHAR_LIMIT = 24_000;
const TOOL_RESULT_CHAR_LIMIT = 8_000;

export type ForceCompactResult = {
  compacted: boolean;
  transcriptPath?: string | undefined;
};

// Real context size reported by the provider: baseTokens covers
// messages[0..coveredCount-1]; anything appended after coveredCount is
// estimated heuristically until the next response refreshes the tracker.
export type ContextSizeTracker = {
  baseTokens: number;
  coveredCount: number;
};

export function trackerFromUsage(usage: Usage, coveredCount: number): ContextSizeTracker {
  return {
    baseTokens: usage.input + usage.output + usage.cacheRead + usage.cacheWrite,
    coveredCount,
  };
}

export function contextTokens(messages: Message[], tracker?: ContextSizeTracker): number {
  if (tracker && tracker.coveredCount <= messages.length) {
    return tracker.baseTokens + estimateTokens(messages.slice(tracker.coveredCount));
  }
  return estimateTokens(messages);
}

export function microCompact(messages: Message[], tracker?: ContextSizeTracker): boolean {
  if (contextTokens(messages, tracker) <= MICRO_COMPACT_THRESHOLD) return false;

  const located = messages.filter(
    (message): message is ToolResultMessage => message.role === "toolResult",
  );
  if (located.length <= KEEP_RECENT_TOOL_RESULTS) return false;

  let clearedAny = false;
  const toClear = located.slice(0, located.length - KEEP_RECENT_TOOL_RESULTS);
  for (const message of toClear) {
    if (PRESERVE_RESULT_TOOLS.has(message.toolName)) continue;
    const text = textOf(message.content);
    if (text.length <= 100) continue;

    message.content = [
      {
        type: "text",
        text: [
          "[Previous tool result compacted]",
          `tool: ${message.toolName}`,
          `original_chars: ${text.length}`,
        ].join("\n"),
      },
    ];
    clearedAny = true;
  }
  return clearedAny;
}

function textOf(content: (TextContent | ImageContent)[]): string {
  return content
    .filter((block): block is TextContent => block.type === "text")
    .map((block) => block.text)
    .join("\n");
}

function estimateTokens(messages: Message[]): number {
  return Math.ceil(JSON.stringify(messages).length / 4);
}

async function saveTranscript(messages: Message[], workspaceRoot: string): Promise<string> {
  const dir = transcriptStatePath(workspaceRoot);
  await mkdir(dir, { recursive: true });

  const transcriptPath = join(dir, `transcript_${Date.now()}.jsonl`);
  const lines = messages.map((msg) => JSON.stringify(msg));
  await writeFile(transcriptPath, `${lines.join("\n")}\n`, "utf8");

  return transcriptPath;
}

function truncateText(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  const omitted = text.length - maxChars;
  return `${text.slice(0, maxChars)}\n...[truncated ${omitted} chars]`;
}

function fenced(label: string, value: unknown, maxChars = TOOL_RESULT_CHAR_LIMIT): string {
  const text = typeof value === "string" ? value : JSON.stringify(value, null, 2);
  return `\n\`\`\`${label}\n${truncateText(text, maxChars)}\n\`\`\`\n`;
}

function messageToMarkdown(message: Message, index: number): string {
  const header = `## Message ${index + 1}: ${message.role}`;

  if (message.role === "user") {
    if (typeof message.content === "string") {
      return `${header}\n\n${message.content}`;
    }
    return `${header}\n\n${message.content
      .map((block, blockIndex) =>
        block.type === "text"
          ? `### Text ${blockIndex + 1}\n\n${block.text}`
          : `### Image ${blockIndex + 1}: ${block.mimeType}`,
      )
      .join("\n")}`;
  }

  if (message.role === "system") {
    const text =
      typeof message.content === "string"
        ? message.content
        : message.content.map((block) => block.text).join("\n");
    return `${header}\n\n${text}`;
  }

  if (message.role === "assistant") {
    const sections = message.content.map((block, blockIndex) => {
      if (block.type === "text") {
        return `### Text ${blockIndex + 1}\n\n${block.text}`;
      }
      if (block.type === "thinking") {
        return `### Thinking ${blockIndex + 1}\n\n${block.thinking}`;
      }
      return [
        `### Tool Call ${blockIndex + 1}`,
        `- id: ${block.id}`,
        `- name: ${block.name}`,
        `- input:${fenced("json", block.arguments)}`,
      ].join("\n");
    });
    return `${header}\n\n${sections.join("\n")}`;
  }

  return [
    header,
    `### Tool Result`,
    `- tool_call_id: ${message.toolCallId}`,
    `- tool: ${message.toolName}`,
    `- is_error: ${message.isError}`,
    `- content:${fenced("text", textOf(message.content))}`,
  ].join("\n");
}

function recentMessagesForSummary(messages: Message[], maxChars: number): Message[] {
  const selected: Message[] = [];
  let total = 0;

  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const msg = messages[i];
    if (!msg) continue;

    const msgText = messageToMarkdown(msg, i);
    if (selected.length > 0 && total + msgText.length > maxChars) break;

    selected.unshift(msg);
    total += msgText.length;
    if (total >= maxChars) break;
  }

  while (selected.length > 1 && selected[0]?.role === "toolResult") {
    selected.shift();
  }

  return selected;
}

export function splitMessagesForAutoCompact(
  messages: Message[],
  recentRawCharLimit: number,
): {
  oldMessages: Message[];
  recentMessages: Message[];
} {
  let start = messages.length;
  let total = 0;

  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const msg = messages[i];
    if (!msg) continue;

    const msgText = JSON.stringify(msg);
    if (start < messages.length && total + msgText.length > recentRawCharLimit) {
      break;
    }

    start = i;
    total += msgText.length;
    if (total >= recentRawCharLimit) break;
  }

  while (start > 0 && messages[start]?.role === "toolResult") {
    start -= 1;
  }

  return {
    oldMessages: messages.slice(0, start),
    recentMessages: messages.slice(start),
  };
}

function formatMessagesForSummary(messages: Message[]): string {
  const recentMessages = recentMessagesForSummary(messages, SUMMARY_INPUT_CHAR_LIMIT);

  return [
    "# Conversation Transcript Segment",
    "",
    "The following is a recent, complete-message slice of a longer agent session.",
    "Summarize it for continuity. Preserve concrete task state, file paths, decisions, commands, failures, and next steps.",
    "",
    ...recentMessages.map((msg, index) => messageToMarkdown(msg, index)),
  ].join("\n");
}

async function summarizeConversation(
  summaryInput: string,
  generate: TextGenerator,
): Promise<string> {
  const { text } = await generate(
    [
      "Summarize this conversation for continuity.",
      "Include:",
      "1. What was accomplished.",
      "2. Current state.",
      "3. Key decisions and constraints.",
      "4. Open tasks and exact next steps.",
      "Be concise, but preserve critical implementation details.",
      "",
      summaryInput,
    ].join("\n"),
    { maxTokens: 2000 },
  );

  return text === "" ? "No summary generated." : text;
}

async function compactMessagesWithResult(
  messages: Message[],
  reason: string,
  workspaceRoot = process.cwd(),
  generate?: TextGenerator,
): Promise<ForceCompactResult> {
  const transcriptPath = await saveTranscript(messages, workspaceRoot);
  const { oldMessages, recentMessages } = splitMessagesForAutoCompact(
    messages,
    RECENT_RAW_CHAR_LIMIT,
  );
  const messagesToSummarize = oldMessages.length > 0 ? oldMessages : messages;
  const messagesToPreserve = oldMessages.length > 0 ? recentMessages : [];
  const summaryInput = formatMessagesForSummary(messagesToSummarize);
  const summary = await summarizeConversation(summaryInput, generate ?? textGenerator());

  messages.splice(
    0,
    messages.length,
    {
      role: "user",
      content: [
        "[Conversation compressed]",
        "",
        "Older conversation history was compacted to preserve context window space.",
        `Reason: ${reason}`,
        `Full transcript: ${transcriptPath}`,
        `Recent raw messages preserved after this summary: ${messagesToPreserve.length}`,
        "",
        "Continue from this compressed state:",
        "",
        summary,
      ].join("\n"),
      timestamp: Date.now(),
    },
    ...messagesToPreserve,
  );

  return { compacted: true, transcriptPath };
}

async function compactMessages(
  messages: Message[],
  reason: string,
  workspaceRoot = process.cwd(),
  generate?: TextGenerator,
): Promise<boolean> {
  return (await compactMessagesWithResult(messages, reason, workspaceRoot, generate)).compacted;
}

export async function autoCompactIfNeeded(
  messages: Message[],
  workspaceRoot?: string,
  tracker?: ContextSizeTracker,
  generate?: TextGenerator,
): Promise<boolean> {
  if (contextTokens(messages, tracker) <= AUTO_COMPACT_THRESHOLD) return false;

  return compactMessages(messages, "automatic token threshold", workspaceRoot, generate);
}

export async function forceCompact(
  messages: Message[],
  workspaceRoot?: string,
  reason = "manual slash command",
  generate?: TextGenerator,
): Promise<boolean> {
  if (messages.length === 0) return false;

  return compactMessages(messages, reason, workspaceRoot, generate);
}

export async function forceCompactWithResult(
  messages: Message[],
  workspaceRoot?: string,
  reason = "manual slash command",
  generate?: TextGenerator,
): Promise<ForceCompactResult> {
  if (messages.length === 0) return { compacted: false };

  return compactMessagesWithResult(messages, reason, workspaceRoot, generate);
}
