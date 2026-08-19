import type { AgentKind } from "../agent/run.js";
import type { ToolSource } from "./types.js";

export type ToolInput = Record<string, unknown>;
export type ToolInvocationContext = {
  toolCallId?: string | undefined;
  toolName: string;
  runId?: string | undefined;
  sessionId?: string | undefined;
  agentId?: string | undefined;
  agentKind?: AgentKind | undefined;
  source?: ToolSource | undefined;
};
export type ToolHandler = (
  input: ToolInput,
  context?: ToolInvocationContext,
) => Promise<string> | string;
export type InputResult<T> = { value: T } | { error: string };

function hasOwn(input: ToolInput, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(input, key);
}

export function requireString(input: ToolInput, key: string): string | null {
  if (!hasOwn(input, key)) return null;
  const raw = input[key];
  if (raw === null || raw === undefined) return "";
  if (typeof raw === "string") return raw;
  if (typeof raw === "number") return String(raw);
  return null;
}

export function requireNonEmptyString(
  input: ToolInput,
  key: string,
  toolName: string,
): InputResult<string> {
  const value = requireString(input, key);
  if (!value || value.trim() === "") {
    return { error: `Error: Missing required '${key}' for ${toolName}.` };
  }
  return { value };
}

export function requireInteger(input: ToolInput, key: string): number | null {
  if (!hasOwn(input, key)) return null;
  const raw = input[key];
  if (typeof raw === "number" && Number.isInteger(raw)) return raw;
  return null;
}

export function optionalInteger(input: ToolInput, key: string): number | undefined {
  const value = requireInteger(input, key);
  return value === null ? undefined : value;
}

export function optionalArrayOfIntegers(input: ToolInput, key: string): number[] | undefined {
  if (!hasOwn(input, key)) return undefined;
  const raw = input[key];
  if (!Array.isArray(raw)) return undefined;
  return raw.filter((value) => typeof value === "number" && Number.isInteger(value)) as number[];
}

export function optionalArrayOfStrings(input: ToolInput, key: string): string[] | undefined {
  if (!hasOwn(input, key)) return undefined;
  const raw = input[key];
  if (!Array.isArray(raw)) return undefined;
  return raw.filter((value) => typeof value === "string") as string[];
}
