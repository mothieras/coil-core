import type { SessionSnapshot } from "./types.js";

export type BuildSessionReportOptions = {
  title: string;
  createdAt: string;
};

export function buildSessionReport(
  snapshot: SessionSnapshot,
  options: BuildSessionReportOptions,
): string {
  const session = snapshot.session;
  const lines: string[] = [];
  lines.push(`# ${options.title}`);
  lines.push("");
  lines.push("## Session");
  lines.push(`- ID: ${session?.id ?? "unknown"}`);
  lines.push(`- Status: ${session?.status ?? "unknown"}`);
  lines.push(`- Workspace: ${session?.workspaceRoot ?? "unknown"}`);
  lines.push(`- Created: ${session?.createdAt ?? "unknown"}`);
  lines.push(`- Reported: ${options.createdAt}`);
  lines.push("");
  lines.push("## Conversation");
  lines.push(`- Messages: ${snapshot.conversationMessages.length}`);
  for (const message of snapshot.conversationMessages.slice(-8)) {
    lines.push(`- ${message.role}: ${singleLine(message.content)}`);
  }
  lines.push("");
  lines.push("## Activity");
  lines.push(`- Agent runs: ${snapshot.agentRuns.length}`);
  lines.push(`- Tool calls: ${snapshot.toolCalls.length}`);
  lines.push(`- Tasks: ${snapshot.tasks.length}`);
  lines.push(`- Background commands: ${snapshot.backgroundCommands.length}`);
  lines.push(`- Subagents: ${snapshot.subagents.length}`);
  lines.push(`- Permission decisions: ${snapshot.permissionDecisions.length}`);
  lines.push("");
  lines.push("## MCP");
  if (snapshot.mcpServers.length === 0) {
    lines.push("- No MCP servers configured.");
  } else {
    for (const server of snapshot.mcpServers) {
      const tools = server.toolCount !== undefined ? `, ${server.toolCount} tools` : "";
      const reason = server.reason !== undefined ? ` (${server.reason})` : "";
      lines.push(`- ${server.name}: ${server.status}${tools}${reason}`);
    }
    const mcpCalls = snapshot.toolCalls.filter((call) => call.toolName.startsWith("mcp__"));
    lines.push(`- MCP tool calls: ${mcpCalls.length}`);
  }
  lines.push("");
  lines.push("## Verification");
  const completedTools = snapshot.toolCalls.filter((call) => call.status === "completed");
  if (completedTools.length === 0) {
    lines.push("- No completed tool calls recorded in this session.");
  } else {
    for (const call of completedTools.slice(-10)) {
      lines.push(`- ${call.toolName}: ${call.resultSummary ?? call.status}`);
    }
  }
  lines.push("");
  lines.push("## Risks And Follow-ups");
  const failedTools = snapshot.toolCalls.filter((call) => call.status !== "completed");
  if (failedTools.length === 0) {
    lines.push("- No failed or blocked tool calls recorded.");
  } else {
    for (const call of failedTools.slice(-10)) {
      lines.push(`- ${call.toolName}: ${call.error ?? call.status}`);
    }
  }
  lines.push("");
  return `${lines.join("\n")}\n`;
}

function singleLine(value: string): string {
  return value.replace(/\s+/g, " ").trim().slice(0, 240);
}
