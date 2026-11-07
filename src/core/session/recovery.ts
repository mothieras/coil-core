import type { Message, ToolResultMessage } from "@earendil-works/pi-ai";
import { summarizeLifecycleText } from "../agent/lifecycleSummary.js";
import type { RecoveryOperation, SessionEvent, SessionRecovery, SessionSnapshot } from "./types.js";

export function findUnresolvedOperations(
  snapshot: SessionSnapshot,
  events: readonly SessionEvent[],
): RecoveryOperation[] {
  const pending = new Map(snapshot.recovery?.pending.map((operation) => [operation.id, operation]));
  const intents = new Map<string, Extract<RecoveryOperation, { kind: "tool" }>>();
  for (const event of events) {
    switch (event.type) {
      case "tool_execution_intended":
        intents.set(event.operation.id, event.operation);
        break;
      case "tool_execution_recorded":
        if (!event.uncertain) intents.delete(event.intentId);
        break;
      case "recovery_resolved":
        intents.delete(event.operationId);
        break;
    }
  }
  for (const [id, operation] of intents) {
    const summary = snapshot.toolCalls.find(
      (call) => call.runId === operation.runId && call.id === operation.toolCallId,
    )?.inputSummary;
    pending.set(id, { ...operation, ...(summary ? { summary } : {}) });
  }
  for (const command of snapshot.backgroundCommands) {
    if (command.status !== "running") continue;
    const id = `background:${command.id}`;
    pending.set(id, {
      id,
      kind: "background",
      name: "Background command",
      summary: summarizeLifecycleText(command.commandSummary),
    });
  }
  for (const agent of snapshot.subagents) {
    if (agent.status !== "running") continue;
    const id = `subagent:${agent.id}`;
    pending.set(id, {
      id,
      kind: "subagent",
      name: "Subagent",
      summary: summarizeLifecycleText(agent.promptSummary),
    });
  }
  return [...pending.values()];
}

export function applySessionRecovery(
  snapshot: SessionSnapshot,
  recovery: SessionRecovery,
  timestamp: string,
): SessionSnapshot {
  const unknown = new Set(
    recovery.pending.flatMap((operation) =>
      operation.kind === "tool" ? [toolKey(operation.runId, operation.toolCallId)] : [],
    ),
  );
  return {
    ...snapshot,
    recovery,
    agentRuns: snapshot.agentRuns.map((run) =>
      run.status === "running" || run.status === "stopping"
        ? {
            ...run,
            status: "interrupted",
            stopReason: "process_interrupted",
            finishedAt: timestamp,
          }
        : run,
    ),
    toolCalls: snapshot.toolCalls.map((call) => {
      if (unknown.has(toolKey(call.runId, call.id))) {
        return {
          ...call,
          status: "unconfirmed",
          error: "Execution outcome unknown after recovery.",
          resultSummary: undefined,
          finishedAt: call.finishedAt ?? timestamp,
        };
      }
      return call.status === "running"
        ? { ...call, status: "not_executed", dispatched: false, finishedAt: timestamp }
        : call;
    }),
    backgroundCommands: snapshot.backgroundCommands.map((command) =>
      command.status === "running"
        ? {
            ...command,
            status: "interrupted",
            resultSummary: "Execution outcome unknown.",
            finishedAt: timestamp,
          }
        : command,
    ),
    subagents: snapshot.subagents.map((agent) =>
      agent.status === "running"
        ? {
            ...agent,
            status: "interrupted",
            resultSummary: "Execution outcome unknown.",
            finishedAt: timestamp,
          }
        : agent,
    ),
  };
}

/** Complete interrupted assistant batches without dispatching any tool. */
export function pairRecoveredMessages(
  messages: readonly Message[],
  recovery: SessionRecovery,
  lastLeadRunId: string | undefined,
): Message[] {
  const unknown = new Set(
    recovery.pending.flatMap((operation) =>
      operation.kind === "tool" &&
      operation.agentKind === "lead" &&
      operation.runId === lastLeadRunId
        ? [operation.toolCallId]
        : [],
    ),
  );
  const lastToolBatch = messages.findLastIndex(
    (message) =>
      message.role === "assistant" && message.content.some((block) => block.type === "toolCall"),
  );
  const paired: Message[] = [];
  const missing = new Map<string, string>();
  let currentBatch = -1;
  const recoveredResult = (id: string, name: string): ToolResultMessage => {
    const uncertain = recovery.legacy || (currentBatch === lastToolBatch && unknown.has(id));
    return {
      role: "toolResult",
      toolCallId: id,
      toolName: name,
      isError: true,
      content: [
        {
          type: "text",
          text: uncertain
            ? "Previous execution outcome is unknown. Do not retry without a new user request."
            : "The previous run stopped before this tool was executed.",
        },
      ],
      details: uncertain
        ? { status: "unconfirmed" }
        : { status: "not_executed", dispatched: false },
      timestamp: Date.now(),
    };
  };
  const finishBatch = () => {
    for (const [id, name] of missing) paired.push(recoveredResult(id, name));
    missing.clear();
  };
  for (const [index, message] of messages.entries()) {
    if (message.role === "toolResult") {
      missing.delete(message.toolCallId);
      if (currentBatch === lastToolBatch && unknown.has(message.toolCallId) && !message.isError) {
        paired.push(recoveredResult(message.toolCallId, message.toolName));
        continue;
      }
    } else {
      finishBatch();
      if (message.role === "assistant") {
        currentBatch = index;
        for (const block of message.content) {
          if (block.type === "toolCall") missing.set(block.id, block.name);
        }
      }
    }
    paired.push(message);
  }
  finishBatch();
  return paired;
}

export function recoveryWarnings(recovery: SessionRecovery): string[] {
  const warnings: string[] = [];
  if (recovery.legacy) warnings.push("Older session. Only the conversation was recovered.");
  if (recovery.ignoredJournalBytes)
    warnings.push(
      `Recovered the last complete checkpoint. Ignored ${recovery.ignoredJournalBytes} bytes at the end of the journal.`,
    );
  if (recovery.modelResponseUnconfirmed)
    warnings.push("The last model request has no saved response. You may need to repeat it.");
  return warnings;
}

function toolKey(runId: string, toolCallId: string): string {
  return JSON.stringify([runId, toolCallId]);
}
