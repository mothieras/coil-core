import type { AgentKind } from "../agent/run.js";
import type { ToolSource } from "../tools/types.js";

export interface PermissionResult {
  allowed: boolean;
  reason?: string;
  requested?: boolean | undefined;
}

export type PermissionCheckContext = {
  permissionId: string;
  toolName: string;
  input: Record<string, unknown>;
  runId: string;
  sessionId?: string | undefined;
  agentId: string;
  agentKind: AgentKind;
  toolCallId: string;
  source?: ToolSource | undefined;
  inputSummary?: string | undefined;
  emitPermissionRequested?: ((reason: string) => void) | undefined;
};

export type CheckPermissionFn = (context: PermissionCheckContext) => Promise<PermissionResult>;

export type AskUserFn = (
  toolName: string,
  input: Record<string, unknown>,
  reason: string,
) => Promise<boolean>;
