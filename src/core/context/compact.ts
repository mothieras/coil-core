import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type Anthropic from "@anthropic-ai/sdk";
import { getClient, getModel } from "../config/index.js";
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

export function trackerFromUsage(
  usage: Anthropic.Messages.Usage,
  coveredCount: number,
): ContextSizeTracker {
  return {
    baseTokens:
      usage.input_tokens +
      usage.output_tokens +
      (usage.cache_creation_input_tokens ?? 0) +
      (usage.cache_read_input_tokens ?? 0),
    coveredCount,
  };
}

export function contextTokens(
  messages: Anthropic.Messages.MessageParam[],
  tracker?: ContextSizeTracker,
): number {
  if (tracker && tracker.coveredCount <= messages.length) {
    return tracker.baseTokens + estimateTokens(messages.slice(tracker.coveredCount));
  }
  return estimateTokens(messages);
}

function buildToolNameMap(messages: Anthropic.Messages.MessageParam[]): Map<string, string> {
  const map = new Map<string, string>();
  for (const msg of messages) {
    if (msg.role !== "assistant") continue;
    if (!Array.isArray(msg.content)) continue;
    for (const block of msg.content) {
      if (block.type === "tool_use") {
        map.set(block.id, block.name);
      }
    }
  }
  return map;
}

export function microCompact(
  messages: Anthropic.Messages.MessageParam[],
  tracker?: ContextSizeTracker,
): boolean {
  if (contextTokens(messages, tracker) <= MICRO_COMPACT_THRESHOLD) return false;

  const nameMap = buildToolNameMap(messages);

  const located: Anthropic.Messages.ToolResultBlockParam[] = [];
  for (const msg of messages) {
    if (msg.role !== "user" || !Array.isArray(msg.content)) continue;
    for (const block of msg.content) {
      if (block.type === "tool_result") located.push(block);
    }
  }
  if (located.length <= KEEP_RECENT_TOOL_RESULTS) return false;

  let clearedAny = false;
  const toClear = located.slice(0, located.length - KEEP_RECENT_TOOL_RESULTS);
  for (const block of toClear) {
    if (typeof block.content !== "string") continue;
    if (block.content.length <= 100) continue;

    const toolName = nameMap.get(block.tool_use_id) ?? "unknown";
    if (PRESERVE_RESULT_TOOLS.has(toolName)) continue;

    block.content = [
      "[Previous tool result compacted]",
      `tool: ${toolName}`,
      `original_chars: ${block.content.length}`,
    ].join("\n");
    clearedAny = true;
  }
  return clearedAny;
}

function estimateTokens(messages: Anthropic.Messages.MessageParam[]): number {
  return Math.ceil(JSON.stringify(messages).length / 4);
}

async function saveTranscript(
  messages: Anthropic.Messages.MessageParam[],
  workspaceRoot: string,
): Promise<string> {
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

function messageToMarkdown(msg: Anthropic.Messages.MessageParam, index: number): string {
  const header = `## Message ${index + 1}: ${msg.role}`;
  if (typeof msg.content === "string") {
    return `${header}\n\n${msg.content}`;
  }

  const sections = msg.content.map((block, blockIndex) => {
    if (block.type === "text") {
      return `### Text ${blockIndex + 1}\n\n${block.text}`;
    }

    if (block.type === "tool_use") {
      return [
        `### Tool Use ${blockIndex + 1}`,
        `- id: ${block.id}`,
        `- name: ${block.name}`,
        `- input:${fenced("json", block.input)}`,
      ].join("\n");
    }

    if (block.type === "tool_result") {
      return [
        `### Tool Result ${blockIndex + 1}`,
        `- tool_use_id: ${block.tool_use_id}`,
        `- content:${fenced("text", block.content)}`,
      ].join("\n");
    }

    return `### Block ${blockIndex + 1}: ${block.type}${fenced("json", block)}`;
  });

  return `${header}\n\n${sections.join("\n")}`;
}

function hasToolResult(msg: Anthropic.Messages.MessageParam): boolean {
  return (
    msg.role === "user" &&
    Array.isArray(msg.content) &&
    msg.content.some((block) => block.type === "tool_result")
  );
}

function recentMessagesForSummary(
  messages: Anthropic.Messages.MessageParam[],
  maxChars: number,
): Anthropic.Messages.MessageParam[] {
  const selected: Anthropic.Messages.MessageParam[] = [];
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

  while (selected.length > 1 && hasToolResult(selected[0]!)) {
    selected.shift();
  }

  return selected;
}

export function splitMessagesForAutoCompact(
  messages: Anthropic.Messages.MessageParam[],
  recentRawCharLimit: number,
): {
  oldMessages: Anthropic.Messages.MessageParam[];
  recentMessages: Anthropic.Messages.MessageParam[];
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

  while (start > 0 && hasToolResult(messages[start]!)) {
    start -= 1;
  }

  return {
    oldMessages: messages.slice(0, start),
    recentMessages: messages.slice(start),
  };
}

function formatMessagesForSummary(messages: Anthropic.Messages.MessageParam[]): string {
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

async function summarizeConversation(summaryInput: string): Promise<string> {
  const response = await getClient().messages.create({
    model: getModel() as Anthropic.Model,
    messages: [
      {
        role: "user",
        content: [
          {
            type: "text",
            text: [
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
          },
        ],
      },
    ],
    max_tokens: 2000,
  });

  return response.content.find((block) => block.type === "text")?.text ?? "No summary generated.";
}

async function compactMessagesWithResult(
  messages: Anthropic.Messages.MessageParam[],
  reason: string,
  workspaceRoot = process.cwd(),
): Promise<ForceCompactResult> {
  const transcriptPath = await saveTranscript(messages, workspaceRoot);
  const { oldMessages, recentMessages } = splitMessagesForAutoCompact(
    messages,
    RECENT_RAW_CHAR_LIMIT,
  );
  const messagesToSummarize = oldMessages.length > 0 ? oldMessages : messages;
  const messagesToPreserve = oldMessages.length > 0 ? recentMessages : [];
  const summaryInput = formatMessagesForSummary(messagesToSummarize);
  const summary = await summarizeConversation(summaryInput);

  messages.splice(
    0,
    messages.length,
    {
      role: "user",
      content: [
        {
          type: "text",
          text: [
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
        },
      ],
    },
    ...messagesToPreserve,
  );

  return { compacted: true, transcriptPath };
}

async function compactMessages(
  messages: Anthropic.Messages.MessageParam[],
  reason: string,
  workspaceRoot = process.cwd(),
): Promise<boolean> {
  return (await compactMessagesWithResult(messages, reason, workspaceRoot)).compacted;
}

export async function autoCompactIfNeeded(
  messages: Anthropic.Messages.MessageParam[],
  workspaceRoot?: string,
  tracker?: ContextSizeTracker,
): Promise<boolean> {
  if (contextTokens(messages, tracker) <= AUTO_COMPACT_THRESHOLD) return false;

  return compactMessages(messages, "automatic token threshold", workspaceRoot);
}

export async function forceCompact(
  messages: Anthropic.Messages.MessageParam[],
  workspaceRoot?: string,
  reason = "manual slash command",
): Promise<boolean> {
  if (messages.length === 0) return false;

  return compactMessages(messages, reason, workspaceRoot);
}

export async function forceCompactWithResult(
  messages: Anthropic.Messages.MessageParam[],
  workspaceRoot?: string,
  reason = "manual slash command",
): Promise<ForceCompactResult> {
  if (messages.length === 0) return { compacted: false };

  return compactMessagesWithResult(messages, reason, workspaceRoot);
}
