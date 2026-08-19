const SUMMARY_CHAR_LIMIT = 500;
const MAX_ARRAY_ITEMS = 5;
const MAX_OBJECT_DEPTH = 4;
const REDACTED = "[redacted]";

const SENSITIVE_KEY_PATTERN =
  /(?:api[_-]?key|auth(?:orization)?|bearer|cookie|credential|password|passwd|private[_-]?key|refresh[_-]?token|secret|session[_-]?id|token)/i;
const RAW_CONTENT_KEYS_BY_TOOL = new Map<string, Set<string>>([
  ["edit_file", new Set(["old_text", "new_text"])],
  ["write_file", new Set(["content"])],
]);

type SummaryOptions = {
  key?: string | undefined;
  toolName?: string | undefined;
  depth?: number | undefined;
};

export function summarizeLifecycleText(text: string): string {
  return truncateLifecycleSummary(redactSecrets(text));
}

export function summarizeLifecycleValue(value: unknown): string {
  return stringifySummary(summarizeValue(value));
}

export function summarizeToolInput(toolName: string, value: unknown): string {
  return stringifySummary(summarizeValue(value, { toolName }));
}

export function summarizeToolResult(output: string): string {
  const chars = output.length;
  const lines = output === "" ? 0 : output.split(/\r?\n/).length;
  const label = isToolErrorOutput(output) ? "error output" : "output";
  return `${label} (${chars} chars, ${lines} line${lines === 1 ? "" : "s"})`;
}

export function summarizeLifecycleError(error: unknown): string {
  if (error instanceof Error) {
    return summarizeLifecycleText(`${error.name}: ${error.message}`);
  }
  return summarizeLifecycleValue(error);
}

export function isToolErrorOutput(output: string): boolean {
  return output.trimStart().startsWith("Error:");
}

function summarizeValue(value: unknown, options: SummaryOptions = {}): unknown {
  const depth = options.depth ?? 0;
  if (options.key && isSensitiveKey(options.key)) return REDACTED;
  if (options.key && shouldSummarizeRawContent(options.toolName, options.key)) {
    return summarizeRawValue(value);
  }

  if (typeof value === "string") return summarizeLifecycleText(value);
  if (typeof value === "number" || typeof value === "boolean" || value === null) {
    return value;
  }
  if (value === undefined) return undefined;
  if (Array.isArray(value)) {
    if (depth >= MAX_OBJECT_DEPTH) return `[array:${value.length}]`;
    const items = value.slice(0, MAX_ARRAY_ITEMS).map((item) =>
      summarizeValue(item, {
        toolName: options.toolName,
        depth: depth + 1,
      }),
    );
    if (value.length > MAX_ARRAY_ITEMS) {
      items.push(`[${value.length - MAX_ARRAY_ITEMS} more items]`);
    }
    return items;
  }
  if (typeof value === "object") {
    if (depth >= MAX_OBJECT_DEPTH) return "[object]";
    const summarized: Record<string, unknown> = {};
    for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
      summarized[key] = summarizeValue(nested, {
        key,
        toolName: options.toolName,
        depth: depth + 1,
      });
    }
    return summarized;
  }
  return summarizeLifecycleText(String(value));
}

function stringifySummary(value: unknown): string {
  if (typeof value === "string") return value;
  try {
    return truncateLifecycleSummary(JSON.stringify(value));
  } catch {
    return summarizeLifecycleText(String(value));
  }
}

function isSensitiveKey(key: string): boolean {
  return SENSITIVE_KEY_PATTERN.test(key);
}

function shouldSummarizeRawContent(toolName: string | undefined, key: string): boolean {
  if (!toolName) return false;
  return RAW_CONTENT_KEYS_BY_TOOL.get(toolName)?.has(key) ?? false;
}

function summarizeRawValue(value: unknown): string {
  const text = typeof value === "string" ? value : stringifySummary(value);
  return `[content omitted: ${text.length} chars]`;
}

function redactSecrets(text: string): string {
  return text
    .replace(/(Bearer\s+)[A-Za-z0-9._~+/=-]+/gi, `$1${REDACTED}`)
    .replace(/(Basic\s+)[A-Za-z0-9._~+/=-]+/gi, `$1${REDACTED}`)
    .replace(/sk-ant-[A-Za-z0-9_-]+/g, REDACTED)
    .replace(
      /([A-Za-z0-9_.-]*(?:api[_-]?key|auth(?:orization)?|password|passwd|secret|token)[A-Za-z0-9_.-]*\s*[:=]\s*)("[^"]*"|'[^']*'|[^\s,;}]+)/gi,
      `$1${REDACTED}`,
    );
}

function truncateLifecycleSummary(text: string): string {
  if (text.length <= SUMMARY_CHAR_LIMIT) return text;
  const omitted = text.length - SUMMARY_CHAR_LIMIT;
  return `${text.slice(0, SUMMARY_CHAR_LIMIT)}\n...[truncated ${omitted} chars]`;
}
