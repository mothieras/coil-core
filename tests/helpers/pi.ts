import type {
  Api,
  AssistantMessage,
  Model,
  ToolCall,
  Usage,
  UserMessage,
} from "@earendil-works/pi-ai";
import type {
  Provider,
  ProviderCallOptions,
  ProviderRequest,
} from "../../src/core/providers/index.js";

export const ZERO_USAGE: Usage = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

export function userMessage(content: string): UserMessage {
  return { role: "user", content, timestamp: Date.now() };
}

export function testModel(id = "test-model"): Model<Api> {
  return {
    id,
    name: id,
    api: "anthropic-messages",
    provider: "anthropic",
    baseUrl: "https://example.invalid",
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 200_000,
    maxTokens: 64_000,
  };
}

export function assistantMessage(
  content: AssistantMessage["content"],
  stopReason: AssistantMessage["stopReason"] = "stop",
  usage: Usage = ZERO_USAGE,
): AssistantMessage {
  return {
    role: "assistant",
    content,
    api: "anthropic-messages",
    provider: "anthropic",
    model: "test-model",
    usage,
    stopReason,
    timestamp: Date.now(),
  };
}

export function textMessage(
  text: string,
  stopReason: AssistantMessage["stopReason"] = "stop",
  usage: Usage = ZERO_USAGE,
): AssistantMessage {
  return assistantMessage(text === "" ? [] : [{ type: "text", text }], stopReason, usage);
}

export function toolCall(
  name: string,
  args: Record<string, unknown> = {},
  id = `toolu_${name}`,
): ToolCall {
  return {
    type: "toolCall",
    id,
    name,
    arguments: args as ToolCall["arguments"],
  };
}

export function toolCallMessage(
  calls: ToolCall[],
  text = "",
  usage: Usage = ZERO_USAGE,
): AssistantMessage {
  const content: AssistantMessage["content"] = [
    ...(text === "" ? [] : [{ type: "text" as const, text }]),
    ...calls,
  ];
  return assistantMessage(content, "toolUse", usage);
}

export function usage(input: number, output: number): Usage {
  return {
    ...ZERO_USAGE,
    input,
    output,
    totalTokens: input + output,
  };
}

export type FakeProviderCall = {
  model: Model<Api>;
  request: ProviderRequest;
  options: ProviderCallOptions | undefined;
};

export type FakeProvider = Provider & {
  calls: FakeProviderCall[];
};

export type FakeProviderScript = (
  request: ProviderRequest,
  call: FakeProviderCall,
) => AssistantMessage | Promise<AssistantMessage>;

/** Scripted provider: no network, records every request for assertions. */
export function fakeProvider(
  script: FakeProviderScript,
  options: { model?: Model<Api>; fallbackModel?: Model<Api> } = {},
): FakeProvider {
  const model = options.model ?? testModel();
  const calls: FakeProviderCall[] = [];
  return {
    model,
    ...(options.fallbackModel !== undefined ? { fallbackModel: options.fallbackModel } : {}),
    calls,
    async generate(requestedModel, request, callOptions) {
      const call: FakeProviderCall = {
        model: requestedModel,
        request,
        options: callOptions,
      };
      calls.push(call);
      return script(request, call);
    },
  };
}
