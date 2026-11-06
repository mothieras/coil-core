import { ExecutionStoppedError, throwIfAborted } from "../../loop/cancellation.js";
import { ToolExecutionError } from "../errors.js";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import type { McpServerConfig } from "./config.js";
import type { McpClient, McpToolResult, McpToolSchema } from "./types.js";

const REQUEST_TIMEOUT_MS = 10_000;

type JsonRpcResponse = {
  id?: number;
  result?: unknown;
  error?: { message?: string };
};

type PendingResolver = {
  resolve: (value: unknown) => void;
  reject: (reason: Error) => void;
};

/**
 * Buffers a JSON-RPC-over-stdio byte stream and routes each response to the
 * pending request that owns its `id`. A single instance reads the whole stream,
 * so concurrent in-flight requests (e.g. multiple subagents sharing one MCP
 * server) are demultiplexed correctly and out-of-order responses are fine.
 */
export class JsonRpcStream {
  private buffer = "";
  private readonly pending = new Map<number, PendingResolver>();

  add(id: number, resolver: PendingResolver): void {
    this.pending.set(id, resolver);
  }

  delete(id: number): void {
    this.pending.delete(id);
  }

  push(chunk: string): void {
    this.buffer += chunk;
    let newline = this.buffer.indexOf("\n");
    while (newline !== -1) {
      const line = this.buffer.slice(0, newline).trim();
      this.buffer = this.buffer.slice(newline + 1);
      if (line !== "") this.dispatch(line);
      newline = this.buffer.indexOf("\n");
    }
  }

  rejectAll(error: Error): void {
    const resolvers = [...this.pending.values()];
    this.pending.clear();
    this.buffer = "";
    for (const r of resolvers) r.reject(error);
  }

  private dispatch(line: string): void {
    // stdout on an MCP stdio server carries only JSON-RPC; a line that isn't a
    // JSON object is a framing/protocol fault that breaks the whole stream, so
    // fail every in-flight request fast rather than hang until they time out.
    let parsed: unknown;
    try {
      parsed = JSON.parse(line) as unknown;
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      this.rejectAll(new Error(`Invalid MCP JSON response: ${reason}`));
      return;
    }
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      this.rejectAll(new Error("Invalid MCP JSON response: expected object."));
      return;
    }
    const response = parsed as JsonRpcResponse;
    if (typeof response.id !== "number") return; // notification — not a response
    const resolver = this.pending.get(response.id);
    if (!resolver) return; // already settled (e.g. timed out) or unknown id
    this.pending.delete(response.id);
    if (response.error)
      resolver.reject(new ToolExecutionError(response.error.message ?? "MCP error"));
    else resolver.resolve(response.result);
  }
}

export class StdioMcpClient implements McpClient {
  private child: ChildProcessWithoutNullStreams | null = null;
  private initialized = false;
  private initializing: Promise<void> | null = null;
  private nextId = 1;
  private closing = false;
  private closePromise?: Promise<void>;
  private readonly stream = new JsonRpcStream();

  constructor(private readonly config: McpServerConfig) {}

  async listTools(): Promise<McpToolSchema[]> {
    await this.ensureInitialized();
    const result = await this.request("tools/list", {});
    const tools = (result as { tools?: unknown }).tools;
    return Array.isArray(tools) ? (tools as McpToolSchema[]) : [];
  }

  async callTool(
    name: string,
    input: unknown,
    options?: { signal?: AbortSignal | undefined },
  ): Promise<McpToolResult> {
    throwIfAborted(options?.signal);
    await this.ensureInitialized();
    throwIfAborted(options?.signal);
    const result = await this.request("tools/call", {
      name,
      arguments: input,
    });
    return result as McpToolResult;
  }

  close(): Promise<void> {
    if (this.closePromise) return this.closePromise;
    this.closing = true;
    this.stream.rejectAll(new Error("MCP client closed."));
    const child = this.child;
    this.closePromise = (async () => {
      if (!child || child.exitCode !== null || child.signalCode !== null) return;
      const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
      let timer: ReturnType<typeof setTimeout> | undefined;
      const wait = async (ms: number) => {
        try {
          await Promise.race([
            exited,
            new Promise<void>((resolve) => {
              timer = setTimeout(resolve, ms);
            }),
          ]);
        } finally {
          clearTimeout(timer);
        }
      };
      child.kill("SIGTERM");
      await wait(2_000);
      if (child.exitCode === null && child.signalCode === null) {
        child.kill("SIGKILL");
        await wait(1_000);
      }
      if (child.exitCode === null && child.signalCode === null)
        throw new Error("MCP server stop unconfirmed");
    })();
    return this.closePromise;
  }

  private async ensureInitialized(): Promise<void> {
    if (this.closing) throw new Error("MCP client closed.");
    if (this.initialized) return;
    if (!this.initializing) {
      this.initializing = this.initialize().catch((error) => {
        this.initializing = null;
        throw error;
      });
    }
    await this.initializing;
  }

  private async initialize(): Promise<void> {
    await this.request("initialize", {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "coil", version: "0.1.0" },
    });
    this.notify("notifications/initialized", {});
    this.initialized = true;
  }

  private request(method: string, params: unknown): Promise<unknown> {
    const child = this.ensureStarted();
    const id = this.nextId++;
    return new Promise<unknown>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.stream.delete(id);
        reject(new ExecutionStoppedError("timeout", `mcp-request:${id}`, "unconfirmed"));
      }, REQUEST_TIMEOUT_MS);
      this.stream.add(id, {
        resolve: (value) => {
          clearTimeout(timeout);
          resolve(value);
        },
        reject: (error) => {
          clearTimeout(timeout);
          reject(error);
        },
      });
      child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
    });
  }

  private notify(method: string, params: unknown): void {
    const child = this.ensureStarted();
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method, params })}\n`);
  }

  private ensureStarted(): ChildProcessWithoutNullStreams {
    if (this.closing) throw new Error("MCP client closed.");
    if (this.child) return this.child;
    const child = spawn(this.config.command, this.config.args, {
      env: { ...process.env, ...this.config.env },
      stdio: "pipe",
    });
    child.stderr.resume();
    child.stdout.on("data", (chunk: Buffer) => {
      if (this.child === child) this.stream.push(chunk.toString("utf8"));
    });
    child.on("error", (error: Error) => {
      if (this.child !== child) return;
      this.teardown(child);
      this.stream.rejectAll(error);
    });
    child.once("exit", (code, signal) => {
      if (this.child !== child) return;
      this.teardown(child);
      this.stream.rejectAll(
        new Error(
          `MCP server '${this.config.name}' exited before responding (${formatExit(code, signal)}).`,
        ),
      );
    });
    this.child = child;
    return this.child;
  }

  private teardown(child: ChildProcessWithoutNullStreams): void {
    if (this.child !== child) return;
    this.child = null;
    this.initialized = false;
    this.initializing = null;
  }
}

function formatExit(code: number | null, signal: NodeJS.Signals | null): string {
  if (code !== null) return `code ${code}`;
  if (signal !== null) return `signal ${signal}`;
  return "unknown exit status";
}
