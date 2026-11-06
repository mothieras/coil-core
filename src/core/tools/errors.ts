import type { ToolInvocationContext } from "./input.js";
import type { ToolExecutionResult } from "./types.js";

/** An expected, model-correctable failure. The message must be safe for model feedback. */
export class ToolExecutionError extends Error {
  readonly status: "error" | "blocked";
  constructor(message: string, options?: ErrorOptions & { status?: "error" | "blocked" }) {
    super(redactToolDiagnostic(message), options);
    this.name = "ToolExecutionError";
    this.status = options?.status ?? "error";
  }
}

/** Unexpected failure: keep the original cause private, never serialize it into messages. */
export class ToolInvocationError extends Error {
  readonly toolName: string;
  readonly toolCallId: string | undefined;
  readonly runId: string | undefined;
  constructor(toolName: string, context: ToolInvocationContext | undefined, cause: unknown) {
    super("Tool execution failed internally; execution stopped.", { cause });
    this.name = "ToolInvocationError";
    this.toolName = toolName;
    this.toolCallId = context?.toolCallId;
    this.runId = context?.runId;
  }
}

/** File tools operate on user-selected files, unlike runtime task/session storage. */
export function fileToolFailure(error: unknown): ToolExecutionResult {
  if (error instanceof ToolExecutionError) return { status: "error", output: error.message };
  const code = (error as NodeJS.ErrnoException | null)?.code;
  if (
    code &&
    ["ENOENT", "EACCES", "EPERM", "EISDIR", "ENOTDIR", "ENOSPC", "EROFS", "EEXIST"].includes(code)
  )
    return {
      status: "error",
      output: `File operation failed (${code}). Check the path, permissions and available space.`,
    };
  throw error;
}

const REDACTED = "[redacted]";

export function redactToolDiagnostic(text: string): string {
  return text
    .replace(/(Bearer\s+)[A-Za-z0-9._~+/=-]+/gi, `$1${REDACTED}`)
    .replace(/(Basic\s+)[A-Za-z0-9._~+/=-]+/gi, `$1${REDACTED}`)
    .replace(/sk-ant-[A-Za-z0-9_-]+/g, REDACTED)
    .replace(
      /([A-Za-z0-9_.-]*(?:api[_-]?key|auth(?:orization)?|password|passwd|secret|token)[A-Za-z0-9_.-]*\s*[:=]\s*)("[^"]*"|'[^']*'|[^\s,;}]+)/gi,
      `$1${REDACTED}`,
    );
}
