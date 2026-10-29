import type { Api, AssistantMessage, Model } from "@earendil-works/pi-ai";

// ── Constants ──

export const ESCALATED_MAX_TOKENS = 64_000;
export const DEFAULT_MAX_TOKENS = 8_000;
export const MAX_RECOVERY_RETRIES = 3;
export const MAX_RETRIES = 10;
export const BASE_DELAY_MS = 500;
const MAX_DELAY_MS = 32_000;
const MAX_CONSECUTIVE_529 = 3;

export const CONTINUATION_PROMPT =
  "Output token limit hit. Resume directly — " + "no apology, no recap. Pick up mid-thought.";

// ── Types ──

export interface RecoveryState {
  hasEscalated: boolean;
  recoveryCount: number;
  consecutive529: number;
  hasAttemptedReactiveCompact: boolean;
  retryAttempt: number;
}

export type RecoveryAction =
  | { type: "none" }
  | { type: "retry"; maxTokens: number; nextState: RecoveryState }
  | { type: "continue_with_prompt"; nextState: RecoveryState }
  | { type: "compact_and_retry"; nextState: RecoveryState }
  | {
      type: "backoff_and_retry";
      delayMs: number;
      nextState: RecoveryState;
      nextModel?: Model<Api>;
    }
  | { type: "abort"; message: string };

export type LLMOutcome =
  { kind: "success"; response: AssistantMessage } | { kind: "error"; error: unknown };

export type RecoveryOptions = {
  fallbackModel?: Model<Api>;
};

// ── State factory ──

export function initialRecoveryState(): RecoveryState {
  return {
    hasEscalated: false,
    recoveryCount: 0,
    consecutive529: 0,
    hasAttemptedReactiveCompact: false,
    retryAttempt: 0,
  };
}

// ── Error classifiers ──

function isRateLimitError(error: unknown): boolean {
  const e = error as { status?: number; name?: string; message?: string };
  if (typeof e.status === "number" && e.status === 429) return true;
  if (typeof e.name === "string" && e.name.includes("RateLimit")) return true;
  return false;
}

function isOverloadedError(error: unknown): boolean {
  const e = error as { status?: number; name?: string; message?: string };
  if (typeof e.status === "number" && e.status === 529) return true;
  const msg = typeof e.message === "string" ? e.message.toLowerCase() : "";
  if (
    msg.includes("overloaded") &&
    !msg.includes("not overloaded") &&
    (msg.includes("model") || msg.includes("api") || msg === "overloaded")
  ) {
    return true;
  }
  return false;
}

function isTransientNetworkError(error: unknown): boolean {
  const e = error as { code?: string; name?: string; message?: string; status?: number };
  if (typeof e.status === "number") return false;

  const transientCodes = new Set([
    "ECONNRESET",
    "ETIMEDOUT",
    "ECONNABORTED",
    "ECONNREFUSED",
    "EHOSTUNREACH",
    "ENETUNREACH",
    "ENOTFOUND",
    "EAI_AGAIN",
  ]);
  if (typeof e.code === "string" && transientCodes.has(e.code)) return true;

  const name = typeof e.name === "string" ? e.name.toLowerCase() : "";
  if (name.includes("apiconnection")) return true;

  // pi-ai collapses transport failures into a message ("fetch failed",
  // "socket hang up") and drops the original error code.
  const message = typeof e.message === "string" ? e.message.toLowerCase() : "";
  if (message.includes("fetch failed") || message.includes("socket hang up")) return true;
  for (const code of transientCodes) {
    if (message.includes(code.toLowerCase())) return true;
  }

  return false;
}

export function isContextOverflowError(error: unknown): boolean {
  const e = error as { status?: number; name?: string; message?: string };
  const msg = (typeof e.message === "string" ? e.message : "").toLowerCase();
  return (
    (typeof e.status === "number" &&
      e.status === 400 &&
      msg.includes("prompt") &&
      (msg.includes("too long") ||
        msg.includes("longer than") ||
        msg.includes("exceeds") ||
        msg.includes("maximum context"))) ||
    msg.includes("prompt_is_too_long") ||
    msg.includes("context_length_exceeded") ||
    msg.includes("max_context_window")
  );
}

// ── Backoff ──

export function retryDelay(attempt: number, retryAfter?: number): number {
  if (retryAfter !== undefined && retryAfter >= 0) return retryAfter;
  const base = Math.min(BASE_DELAY_MS * 2 ** attempt, MAX_DELAY_MS);
  const jitter = Math.random() * base * 0.25;
  return base + jitter;
}

function getHeader(headers: unknown, name: string): string | null {
  if (!headers || typeof headers !== "object") return null;
  const get = (headers as { get?: unknown }).get;
  if (typeof get !== "function") return null;
  const value = get.call(headers, name);
  return typeof value === "string" ? value : null;
}

export function extractRetryAfterMs(error: unknown, nowMs = Date.now()): number | undefined {
  const headers = (error as { headers?: unknown }).headers;
  const retryAfterMs = getHeader(headers, "retry-after-ms");
  if (retryAfterMs) {
    const parsed = Number.parseFloat(retryAfterMs);
    if (Number.isFinite(parsed) && parsed >= 0) return parsed;
  }

  const retryAfter = getHeader(headers, "retry-after");
  if (!retryAfter) return undefined;

  const seconds = Number.parseFloat(retryAfter);
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000;

  const dateMs = Date.parse(retryAfter);
  if (!Number.isFinite(dateMs)) return undefined;
  const delayMs = dateMs - nowMs;
  return delayMs >= 0 ? delayMs : 0;
}

// ── Formatting ──

function formatError(error: unknown): string {
  if (error instanceof Error) {
    return `${error.name}: ${error.message.slice(0, 200)}`;
  }
  if (typeof error === "object" && error !== null) {
    const e = error as { code?: unknown; message?: unknown };
    const code = typeof e.code === "string" ? `${e.code}: ` : "";
    const message = typeof e.message === "string" ? e.message : JSON.stringify(error);
    return `${code}${message.slice(0, 200)}`;
  }
  return `Unknown error: ${String(error).slice(0, 200)}`;
}

function hasToolUse(response: AssistantMessage): boolean {
  return response.content.some((block) => block.type === "toolCall");
}

// ── Decision engine ──

export function decideRecovery(
  outcome: LLMOutcome,
  state: RecoveryState,
  options: RecoveryOptions = {},
): RecoveryAction {
  // ── Error outcomes ──
  if (outcome.kind === "error") {
    const error = outcome.error;

    // context overflow → compact once, then give up
    if (isContextOverflowError(error)) {
      if (!state.hasAttemptedReactiveCompact) {
        return {
          type: "compact_and_retry",
          nextState: { ...state, hasAttemptedReactiveCompact: true },
        };
      }
      return {
        type: "abort",
        message: "Context still too large after compaction.",
      };
    }

    // Rate limit (429) → exponential backoff
    if (isRateLimitError(error)) {
      const retryAfterMs = extractRetryAfterMs(error);
      if (state.retryAttempt >= MAX_RETRIES) {
        return {
          type: "abort",
          message: `Max retries (${MAX_RETRIES}) exceeded for rate limit.`,
        };
      }
      return {
        type: "backoff_and_retry",
        delayMs: retryDelay(state.retryAttempt, retryAfterMs),
        nextState: {
          ...state,
          retryAttempt: state.retryAttempt + 1,
          consecutive529: 0,
        },
      };
    }

    // Overloaded (529) → exponential backoff, fallback model hint
    if (isOverloadedError(error)) {
      const retryAfterMs = extractRetryAfterMs(error);
      if (state.retryAttempt >= MAX_RETRIES) {
        return {
          type: "abort",
          message: `Max retries (${MAX_RETRIES}) exceeded for overload.`,
        };
      }
      const newConsecutive529 = state.consecutive529 + 1;
      const nextModel =
        newConsecutive529 >= MAX_CONSECUTIVE_529 ? options.fallbackModel : undefined;
      return {
        type: "backoff_and_retry",
        delayMs: retryDelay(state.retryAttempt, retryAfterMs),
        nextState: {
          ...state,
          retryAttempt: state.retryAttempt + 1,
          consecutive529: newConsecutive529,
        },
        ...(nextModel ? { nextModel } : {}),
      };
    }

    // Network transport failures are usually transient and should not kill the loop.
    if (isTransientNetworkError(error)) {
      const retryAfterMs = extractRetryAfterMs(error);
      if (state.retryAttempt >= MAX_RETRIES) {
        return {
          type: "abort",
          message: `Max retries (${MAX_RETRIES}) exceeded for transient network error.`,
        };
      }
      return {
        type: "backoff_and_retry",
        delayMs: retryDelay(state.retryAttempt, retryAfterMs),
        nextState: {
          ...state,
          retryAttempt: state.retryAttempt + 1,
          consecutive529: 0,
        },
      };
    }

    // Unknown error → unrecoverable
    return { type: "abort", message: formatError(error) };
  }

  // ── Successful response ──
  const response = outcome.response;

  // Output truncated
  if (response.stopReason === "length") {
    // First escalation: don't append truncated output, retry same request
    if (!state.hasEscalated) {
      return {
        type: "retry",
        maxTokens: ESCALATED_MAX_TOKENS,
        nextState: { ...state, hasEscalated: true },
      };
    }
    // Already escalated: append truncated output + continuation prompt
    if (hasToolUse(response)) {
      return {
        type: "abort",
        message: "Output truncated during toolCall; cannot continue safely.",
      };
    }
    if (state.recoveryCount < MAX_RECOVERY_RETRIES) {
      return {
        type: "continue_with_prompt",
        nextState: { ...state, recoveryCount: state.recoveryCount + 1 },
      };
    }
    return {
      type: "abort",
      message: `Output still truncated after ${MAX_RECOVERY_RETRIES} continuation retries.`,
    };
  }

  // Normal completion — reset transient counters
  return {
    type: "none",
  };
}
