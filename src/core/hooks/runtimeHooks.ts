import type { Message, ToolCall } from "@earendil-works/pi-ai";
import type { AppContext } from "../app/context.js";
import { pushTaggedUserMessage } from "./messageInjection.js";
import { currentAgent } from "../agent/agent.js";
import type { ToolResultsReadyPayload } from "./hookBus.js";

type TaskLoopState = {
  roundsSinceTaskUpdate: number;
  sawTaskTool: boolean;
  sawTaskToolThisTurn: boolean;
  showTaskStatus: boolean;
};

function newTaskLoopState(): TaskLoopState {
  return {
    roundsSinceTaskUpdate: 0,
    sawTaskTool: false,
    sawTaskToolThisTurn: false,
    showTaskStatus: true,
  };
}

function agentName(): string {
  return currentAgent.getStore()?.id ?? "lead";
}

export function registerRuntimeHooks(app: AppContext): void {
  const taskStates = new Map<string, TaskLoopState>();
  const taskState = () => getTaskState(taskStates, agentName());

  app.hooks.register("LoopStart", () => {
    taskStates.set(agentName(), newTaskLoopState());
  });

  app.hooks.register("PreLLMCall", (messages) => {
    injectTaskStatus(app, taskState(), messages);
    injectAsyncWorkResults(app, messages);
  });

  app.hooks.register("PostToolUse", (block) => {
    markTaskToolUse(taskState(), block);
  });

  app.hooks.register("ToolResultsReady", (payload) => {
    appendTaskReminder(app, taskState(), payload);
  });
}

function getTaskState(states: Map<string, TaskLoopState>, name: string): TaskLoopState {
  let state = states.get(name);
  if (!state) {
    state = newTaskLoopState();
    states.set(name, state);
  }
  return state;
}

function injectTaskStatus(app: AppContext, state: TaskLoopState, messages: Message[]): void {
  if (!state.showTaskStatus) return;
  const taskSummary = app.toolRuntime.taskSummary();
  if (taskSummary) {
    pushTaggedUserMessage(messages, "task-status", taskSummary);
  }
  state.showTaskStatus = false;
}

function injectAsyncWorkResults(app: AppContext, messages: Message[]): void {
  if (agentName() !== "lead") return;
  const drained = app.inbox.drainNotifications();
  if (drained.length === 0) return;
  const background = drained.filter((n) => n.kind === "background");
  const subagent = drained.filter((n) => n.kind === "subagent");
  if (background.length > 0) {
    const text = background.map((n) => `[bg:${n.id}] ${n.status}: ${n.result}`).join("\n");
    pushTaggedUserMessage(messages, "background-results", text);
  }
  if (subagent.length > 0) {
    const text = subagent
      .map((n) => {
        const task = n.taskId ? ` (task ${n.taskId})` : "";
        return `[sub:${n.id}]${task} ${n.status}: ${n.result}`;
      })
      .join("\n\n");
    pushTaggedUserMessage(messages, "subagent-results", text);
  }
}

function markTaskToolUse(state: TaskLoopState, block: ToolCall): void {
  if (block.name !== "update_tasks") return;
  state.sawTaskTool = true;
  state.sawTaskToolThisTurn = true;
  state.showTaskStatus = true;
}

function appendTaskReminder(
  app: AppContext,
  state: TaskLoopState,
  payload: ToolResultsReadyPayload,
): void {
  if (!shouldRemindTaskUpdate(app, state)) return;
  payload.followups.push({
    role: "user",
    content: "<reminder>Update your tasks with update_tasks.</reminder>",
    timestamp: Date.now(),
  });
}

function shouldRemindTaskUpdate(app: AppContext, state: TaskLoopState): boolean {
  if (!state.sawTaskTool) return false;
  if (state.sawTaskToolThisTurn) {
    state.roundsSinceTaskUpdate = 0;
    state.sawTaskToolThisTurn = false;
    return false;
  }

  state.roundsSinceTaskUpdate += 1;
  if (state.roundsSinceTaskUpdate < 3) return false;
  state.roundsSinceTaskUpdate = 0;
  state.sawTaskTool = app.toolRuntime.hasActiveTasks();
  return state.sawTaskTool;
}
