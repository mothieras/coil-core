# coil-core

[![CI](https://github.com/mothieras/coil-core/actions/workflows/ci.yml/badge.svg)](https://github.com/mothieras/coil-core/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

An embeddable, local-first coding agent engine — a small trusted core, real MCP, concurrent subagents, observable execution, session persistence, and reports. Ships with an Ink/React TUI; the engine itself has zero UI dependencies and can be embedded headlessly.

## Why

Most coding agents are black boxes wired to a single cloud model. `coil-core` is the opposite: a small engine you can run locally, observe turn-by-turn, extend with your own tools or MCP servers, and embed inside your own CLI, TUI, or backend.

- **Small trusted core.** One loop, one agent identity, one tool runtime. No UI in the engine, no special-case dispatch.
- **Observable.** Managed sessions record events through one funnel and project them into a snapshot and view events. Journal checkpoints let a session recover its conversation and tool execution evidence.
- **Real MCP.** Stdio MCP clients register as `mcp__server__tool` through the normal registry — no special dispatch path.
- **Concurrent subagents.** Fork agents with narrowed tool scopes; completions auto-wake the lead.
- **Provider-agnostic.** The loop talks to a `Provider` interface backed by pi-ai, so the default Anthropic path can be swapped for any built-in provider or a custom endpoint without touching the loop.

## Quickstart (TUI)

```bash
pnpm install
cp .env.example .env   # fill in provider credentials + MODEL_ID
pnpm dev               # launch the Ink TUI
```

## Providers

The default provider is Anthropic, backed by [pi-ai](https://github.com/earendil-works/pi). Set `COIL_LLM_PROVIDER` to any pi-ai built-in provider id (`openai`, `google`, `openrouter`, `zai`, `moonshotai`, `minimax`, `deepseek`, ...). `ANTHROPIC_BASE_URL` still routes Anthropic-compatible gateways and arbitrary model ids. See `.env.example` for the supported variables.

## Embed headlessly

```bash
pnpm build
tsx examples/headless-agent.ts "explain this repo's entry point"
```

```ts
import { createAppContext, createDefaultProvider, Agent, agentLoop } from "coil-core";

const app = createAppContext(process.cwd(), {});
const agent = new Agent({
  system: "You are a concise coding agent.",
  workspaceRoot: process.cwd(),
  toolRuntime: app.toolRuntime,
  provider: createDefaultProvider(),
  hooks: app.hooks,
  messages: [{ role: "user", content: prompt, timestamp: Date.now() }],
});
const result = await agentLoop(agent, {});
```

See `examples/` for a runnable one-shot agent and a custom-tool registration demo.

## 取消运行与关闭会话

无凭据演示使用构建后的公共导出、scripted provider 和真实本地进程。所有文件都写入临时 workspace：

```bash
pnpm build
pnpm exec tsx examples/cancel-run.ts
```

预期输出包含 `run=interrupted, reason=aborted, cleanup=confirmed`，并实际检查进程 PID 已退出。

需要按 run id 取消时，使用 app 的同一个 runtime；自建 runtime 可通过 `createAppContext(root, { agentRuntime })` 注入。这让主运行、子代理和后台进程共享工作归属：

```ts
import { createAgentRun } from "coil-core";

// agent 使用上文 app 的 toolRuntime；provider 可由 host 注入。
const run = createAgentRun({
  agentId: "lead",
  agentKind: "lead",
  trigger: { type: "user_message" },
});
const running = app.agentRuntime.run(agent, run); // 可选第三参数：{ signal }
const cancellation = await app.agentRuntime.cancelRun(run.id);
await running;
console.log(cancellation.status, cancellation.cleanup);
```

- `cancelRun` 返回 `accepted`、`noop`、`descendants_only` 或 `unknown`。正常完成的父 run 保持原终态；之后取消它只停止仍活动的所属后代。重复请求不会重启清理或延长预算。
- `cleanup.status` 区分 `not_needed`、`confirmed` 和 `unconfirmed`。`unconfirmed` 表示仍有资源或结果无法确认，不代表执行已停止；详情在 `resources` 和 `errors`。旧会话缺少该字段时只能视为未记录。
- `SessionController.cancelRun(id?)` 默认取消最近的主运行及其活动后代。`waitForAsyncWork({ shouldStop })` 仅停止等待，不取消工作。`close()` 拒绝新工作，停止全部所属工作和辅助请求，关闭共享连接，然后保存。重复关闭复用同一个 Promise；多个重要失败通过 `AggregateError.errors` 保留。
- 资源清理共享 5 秒预算；保存另有 5 秒预算。保存超时意味着保存未确认，不能推断文件系统操作已停止，也不自动重试。同步阻塞事件循环的自定义工具无法被抢占。
- 自定义 `Provider.generate`、工具 handler 和权限回调接收可选 `signal`。工具返回结构化结果；取消等控制结果使用公开的 `ExecutionStoppedError`，不能转换成普通成功文本。忽略信号的操作保留实际完成跟踪；它真正结束前，同一 Agent 不能进入新运行。
- 单个 MCP 请求取消不会关闭共享 server。远端操作不能证明已停止时保守报告未确认；其迟到结果不再改写活动消息。session 关闭才释放共享 MCP client。
- 前台和后台 shell 使用引擎创建的独立进程组，先 TERM，最多等 2 秒，再 KILL，最多等 1 秒，受总预算限制。当前已在 **macOS arm64 / Node 24** 验证进程及受管后代退出；Linux 是现有 CI 的验证目标，本轮尚无 Linux 执行证据。Windows 不承诺进程树清理。
- 自行脱离进程组的后代或远端操作可能仍在执行。**取消不会回滚已经发生的副作用**。

TUI 保持现有布局：运行或权限等待时按 **Ctrl+C** 取消运行；异步等待时按 **Esc** 只停止等待，按 **Ctrl+C** 取消所属工作；**Ctrl+D** 关闭整个 session。空闲时 Ctrl+C 仍为退出。界面分别显示正在停止、已停止、停止未确认和关闭失败，不依赖颜色区分。

### 自定义工具装配迁移

`BuiltinServices`、`loadBuiltinTools` 和 `createSubagentTools` 不再接收 `subAgentRunner/checkPermission`，改为注入 `startSubagent(prompt, options, context)`。使用 `createAppContext` 的调用者无需自行装配。自定义 host 应在 agent/app 层解析父身份并继承权限；工具目录只解析中立输入。协调类型 `SubAgentRunner` 与 `forkSubAgent` 已移到 agent 模块并通过 core 导出；旧 tools 深路径已删除。子代理工具范围取固定 profile、父范围和请求范围的交集。

### 工具结果与校验迁移（M2）

`ToolHandler` 和 `ToolRuntime.invokeTool()` 不再返回字符串，而是返回 `ToolExecutionResult`：

```ts
import { builtinTool } from "coil-core";

const echo = builtinTool(
  {
    name: "echo",
    description: "Echo text.",
    parameters: {
      type: "object",
      properties: { text: { type: "string" } },
      required: ["text"],
    },
  },
  (input) => ({ status: "completed", output: input.text as string }),
);
app.toolRuntime.registerTool(echo);
const result = await app.toolRuntime.invokeTool("echo", { text: "hello" });
console.log(result.status, result.output);
```

- 状态包括 `completed`、`unavailable`、`invalid_input`、`blocked`、`permission_denied`、`error`、`cancelled`、`timeout`、`unconfirmed`、`not_executed`。只有 `completed` 对应模型的 `isError: false`。文本中的 `Error:` 没有控制含义；MCP 的 `isError` 和 shell 退出码决定分类。
- 可修正失败返回 `{ status: "error", output: "修正建议" }`，或抛 `ToolExecutionError`。未知异常以 `ToolInvocationError` 终止运行，宿主可检查 `cause`、`toolName`、`toolCallId`、`runId`；不要直接序列化 cause，它可能包含敏感数据。任务存储故障不当作模型可修正失败。
- 取消、超时和停止未确认仍通过 `ExecutionStoppedError` 传播；handler 返回对应结构化状态时，runtime 也会将其转为控制异常。不能确认远端停止时使用 `unconfirmed`，可加 `stopReason: "timeout"` 保留原因。这些状态会停止后续派发，不是让模型继续尝试的普通工具结果。
- registry 编译工具提供的 JSON Schema；runtime 严格检查参数，不转换字符串数字、不注入默认值、不丢弃无效数组项。旧的 `requireString/requireNonEmptyString/optionalInteger` 等宽松解析辅助函数已删除，请把静态约束写入 schema。handler 只处理动态业务条件；不要直接调用 `registry.getHandler()` 绕过运行时门禁。
- loop 顺序为：取消检查 → 工具范围 → 管理 hook → 可用性和参数校验 → 权限 → 再查取消 → handler。直接调用 `invokeTool` 是受信任的宿主入口；需要授权时提供 `context.beforeInvoke`，它只会在参数验证通过后执行。子代理范围仍只收窄。
- 模型消息 `details`、生命周期事件和 session 投影保留状态与 `dispatched`；停止时还保留 `stopReason`。旧记录没有派发字段时表示未记录。批次停止或致命失败会补齐未执行结果，不自动重放，也不回滚已经发生的副作用。
- `BackgroundManager.run` 的危险命令拒绝、`SubAgentRunner.run` 的满额拒绝现在抛 `ToolExecutionError`，不再返回错误字符串。迁移直接使用这些入口的宿主时，应同步处理异常。

无凭据运行自定义工具示例，验证实际构建导出、成功结果和无效输入无副作用：

```bash
pnpm build
pnpm exec tsx examples/custom-tool.ts
```

## 恢复会话

在终端用 `/resume` 列出会话，再用 `/resume <序号或 ID>` 打开。会话从最后一个完整检查点恢复对话。若上次模型请求没有保存响应，界面会提示可能需要重新请求。

如果工具可能已经执行，但保存的记录无法确认结果，恢复会暂停对话和自动唤醒。输入 `/recover` 查看待处理操作。核实后用 `/recover verify <id>` 记录核实，或用 `/recover discard <id>` 放弃追查该结果。处理完所有条目后可以继续对话。若确实需要重做，在新消息里明确请求，按当前权限流程执行。

嵌入方使用 `SessionController.resume()`，从 `getSnapshot().recovery` 读取待处理操作和诊断，通过 `resolveRecovery(id, "verified" | "discarded")` 记录决定。检查点写入失败后，当前控制器会停止执行并返回写入错误。`flush()` 可重试保留的写入，随后可重新打开会话核对结果。

新版会话用 `events.jsonl` 的检查点和对应的私有消息槽位恢复状态。`snapshot.json`、`lead-messages.json` 等文件是派生视图。旧版 pi-ai 和 Anthropic 会话可恢复对话，首次写入新版检查点时会保留原始文件。恢复保证覆盖本地文件系统上的单进程会话及异常退出。直接使用 `agentLoop` 或宿主工具入口时，由嵌入方管理持久化。后台结果在恢复后的交付语义仍由后续阶段完善。

## Architecture

```
src/
  core/     engine — zero UI deps (agent, loop, context, session, tools, services, permission, hooks, providers, config, state)
  tui/      Ink/React consumer of core
  main.ts   TUI entrypoint
```

**Invariants the structure enforces:**

1. `agentLoop` is the only place that binds `currentAgent` (`AsyncLocalStorage<Agent>`).
2. Dependency direction is one-way: `Agent → ToolRuntime`. Tools never import `Agent`/`Session`.
3. The loop is UI-agnostic: it only orchestrates model calls, recovery, hooks, and `ToolRuntime.invokeTool()`.
4. One event funnel (`SessionProjectionStore.record`) → `events.jsonl` + pure snapshot + view events.
5. The TUI never calls the loop directly — only through `SessionController` + structured view events.
6. Pure TS: source is `.ts`/`.tsx` only, zero hand-written `.js`; `.tsx` is confined to `src/tui/` (Ink/React); `.js` appears only as NodeNext ESM import specifiers.

## Development

| Command                | What it does              |
| ---------------------- | ------------------------- |
| `pnpm dev`             | Run the TUI via `tsx`     |
| `pnpm test`            | Run the `node:test` suite |
| `pnpm typecheck`       | `tsc --noEmit` on `src/`  |
| `pnpm typecheck:tests` | typecheck `tests/`        |
| `pnpm build`           | `tsc` → `dist/`           |
| `pnpm lint`            | ESLint                    |
| `pnpm format:check`    | Prettier check            |

See `AGENTS.md` for the invariants agents must preserve.

## License

MIT © mothieras
