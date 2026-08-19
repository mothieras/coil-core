import type { McpClient, McpToolResult, McpToolSchema } from "./types.js";

type MockMcpHandler = (input: unknown) => Promise<McpToolResult> | McpToolResult;

export type MockMcpClientOptions = {
  tools?: McpToolSchema[];
  handlers?: Record<string, MockMcpHandler>;
  listError?: unknown;
};

export class MockMcpClient implements McpClient {
  readonly calls: Array<{ name: string; input: unknown }> = [];
  private readonly tools: McpToolSchema[];
  private readonly handlers: Record<string, MockMcpHandler>;
  private readonly listError: unknown;

  constructor(options: MockMcpClientOptions = {}) {
    this.tools = options.tools ?? [];
    this.handlers = options.handlers ?? {};
    this.listError = options.listError;
  }

  async listTools(): Promise<McpToolSchema[]> {
    if (this.listError !== undefined) throw this.listError;
    return this.tools;
  }

  async callTool(name: string, input: unknown): Promise<McpToolResult> {
    this.calls.push({ name, input });
    const handler = this.handlers[name];
    if (!handler) {
      return {
        content: [{ type: "text", text: `Mock MCP tool '${name}' called.` }],
      };
    }
    return handler(input);
  }
}
