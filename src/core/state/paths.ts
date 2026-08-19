import path from "node:path";

export const COIL_STATE_DIR = ".coil";

/** Committed/shared config (e.g. MCP server registration). */
export function coilConfigPath(workspaceRoot: string, ...segments: string[]): string {
  return path.join(workspaceRoot, COIL_STATE_DIR, "config", ...segments);
}

/** Local runtime state — never committed. */
export function coilStatePath(workspaceRoot: string, ...segments: string[]): string {
  return path.join(workspaceRoot, COIL_STATE_DIR, "state", ...segments);
}

export function mcpConfigPath(workspaceRoot: string): string {
  return coilConfigPath(workspaceRoot, "mcp.json");
}

export function taskStatePath(workspaceRoot: string): string {
  return coilStatePath(workspaceRoot, "tasks");
}

export function memoryStatePath(workspaceRoot: string): string {
  return coilStatePath(workspaceRoot, "memory");
}

export function transcriptStatePath(workspaceRoot: string): string {
  return coilStatePath(workspaceRoot, "transcripts");
}

export function sessionStatePath(workspaceRoot: string): string {
  return coilStatePath(workspaceRoot, "sessions");
}

export function sessionPath(workspaceRoot: string, sessionId: string): string {
  return coilStatePath(workspaceRoot, "sessions", sessionId);
}
