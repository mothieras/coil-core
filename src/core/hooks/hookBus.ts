import type { Message, ToolCall, ToolResultMessage, UserMessage } from "@earendil-works/pi-ai";

export type HookEvent =
  "LoopStart" | "PreLLMCall" | "PreToolUse" | "PostToolUse" | "ToolResultsReady" | "Stop";

export type EffectHookEvent = "LoopStart" | "PreLLMCall" | "PostToolUse" | "ToolResultsReady";

export type ControlHookEvent = "PreToolUse" | "Stop";

/** Tool results plus any user messages a hook wants appended after them. */
export type ToolResultsReadyPayload = {
  results: ToolResultMessage[];
  followups: UserMessage[];
};

export type HookArgs = {
  LoopStart: [messages: Message[]];
  PreLLMCall: [messages: Message[]];
  PreToolUse: [block: ToolCall];
  PostToolUse: [block: ToolCall, output: string];
  ToolResultsReady: [payload: ToolResultsReadyPayload];
  Stop: [messages: Message[]];
};

export type EffectHookCallback<Event extends EffectHookEvent> = (...args: HookArgs[Event]) => void;

export type ControlHookCallback<Event extends ControlHookEvent> = (
  ...args: HookArgs[Event]
) => string | null;

export type HookCallback<Event extends HookEvent> = Event extends EffectHookEvent
  ? EffectHookCallback<Event>
  : Event extends ControlHookEvent
    ? ControlHookCallback<Event>
    : never;

function emptyEffectHooks(): {
  [Event in EffectHookEvent]: Array<EffectHookCallback<Event>>;
} {
  return {
    LoopStart: [],
    PreLLMCall: [],
    PostToolUse: [],
    ToolResultsReady: [],
  };
}

function emptyControlHooks(): {
  [Event in ControlHookEvent]: Array<ControlHookCallback<Event>>;
} {
  return {
    PreToolUse: [],
    Stop: [],
  };
}

function isControlHook(event: HookEvent): event is ControlHookEvent {
  return event === "PreToolUse" || event === "Stop";
}

export class HookBus {
  private readonly effectHooks = emptyEffectHooks();
  private readonly controlHooks = emptyControlHooks();

  register<Event extends EffectHookEvent>(event: Event, callback: EffectHookCallback<Event>): void;
  register<Event extends ControlHookEvent>(
    event: Event,
    callback: ControlHookCallback<Event>,
  ): void;
  register(event: HookEvent, callback: unknown): void {
    if (isControlHook(event)) {
      this.controlHooks[event].push(callback as ControlHookCallback<typeof event>);
      return;
    }
    this.effectHooks[event].push(callback as EffectHookCallback<typeof event>);
  }

  emitEffect<Event extends EffectHookEvent>(event: Event, ...args: HookArgs[Event]): void {
    for (const cb of this.effectHooks[event]) {
      cb(...args);
    }
  }

  triggerControl<Event extends ControlHookEvent>(
    event: Event,
    ...args: HookArgs[Event]
  ): string | null {
    for (const cb of this.controlHooks[event]) {
      const result = cb(...args);
      if (result !== null) return result;
    }
    return null;
  }
}
