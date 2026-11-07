# coil-core

[![CI](https://github.com/mothieras/coil-core/actions/workflows/ci.yml/badge.svg)](https://github.com/mothieras/coil-core/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

可嵌入的本地优先 coding agent 引擎，提供模型与工具循环、MCP、并发子代理、运行取消、会话持久化与报告。核心位于 `src/core/`，不依赖 UI；仓库附带的 Ink/React TUI 是它的一个客户端。

## 快速开始

需要 Node.js 22.19 或更高版本，以及 pnpm 11.0.9。在仓库目录执行：

```bash
pnpm install
pnpm build
pnpm exec tsx examples/headless-agent.ts --scripted hello
pnpm exec tsx examples/custom-tool.ts
pnpm exec tsx examples/cancel-run.ts
pnpm exec tsx examples/recover-session.ts
```

这些示例通过包的公共导出消费构建产物，使用临时 workspace，无需模型配置或凭据：

| 示例                                           | 预期结果                                                                                                               |
| ---------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| [headless-agent](examples/headless-agent.ts)   | `--scripted hello` 输出 `本地演示已收到：hello`                                                                        |
| [custom-tool](examples/custom-tool.ts)         | 有效输入返回 `completed`，无效输入返回 `invalid_input` 且不执行 handler                                                |
| [cancel-run](examples/cancel-run.ts)           | 启动真实进程后取消，输出 `interrupted`、`aborted`、`confirmed`，检查进程已退出                                         |
| [recover-session](examples/recover-session.ts) | 在文件副作用发生、结果保存前终止真实进程；恢复后先阻止继续执行，核实文件并保存决定后才接受新消息，检查副作用只发生一次 |

使用真实模型和 TUI 时，再配置环境：

```bash
cp .env.example .env
# 在 .env 中填写模型 ID 和对应 provider 的凭据
pnpm dev
```

默认通过 [pi-ai](https://github.com/earendil-works/pi) 使用 Anthropic。设置 `COIL_LLM_PROVIDER` 可选择已安装 pi-ai 的其他内置 provider，同时配置该 provider 的凭据和目录中的 `MODEL_ID`。使用 Anthropic 兼容网关时保留 `COIL_LLM_PROVIDER=anthropic`，设置 `ANTHROPIC_BASE_URL`、网关密钥和模型 ID。配置示例见 [.env.example](.env.example)。

## 嵌入应用

`SessionController` 管理会话、运行、异步结果和保存，适合需要取消或恢复能力的宿主。先构建，再通过包的公共导出使用：

```bash
pnpm build
```

```ts
import { SessionController } from "coil-core";

const controller = await SessionController.createNew({
  workspaceRoot: process.cwd(),
});

try {
  const turn = await controller.handleUserMessage("说明这个项目的入口和主要模块");
  console.log(turn.assistantMessage.content);

  while (controller.hasPendingAsyncWork()) {
    await controller.waitForAsyncWork();
    const wake = await controller.handleAutoWake("async_work_finished");
    if (wake) console.log(wake.assistantMessage.content);
  }
} finally {
  await controller.close();
}
```

示例使用 `.env` 中的模型配置。宿主也可注入 `provider` 和 `checkPermission`。headless 宿主负责调用 `handleAutoWake()`，TUI 已接入这一流程；core 合并并发唤醒请求，避免主代理重入。没有可交付结果或请求失效时，该方法返回 `undefined`。`hasPendingAsyncWork()` 同时包含活动工作和已完成但未消费的结果。

只需要模型与工具循环时，可直接使用 `Agent` 和 `agentLoop`，参见 [headless 示例](examples/headless-agent.ts)；去掉 `--scripted` 即使用真实模型。此入口的持久化与资源管理由宿主负责；需要按运行 ID 取消时，使用 `app.agentRuntime.run()` 和 `cancelRun()`，参见取消示例。

导入 `coil-core` 不会校验模型配置；注入 provider 可完全绕过默认模型配置。创建默认 provider 时才检查 `MODEL_ID`（兼容旧名 `ANTHROPIC_MODEL`），请求时由 pi-ai 检查凭据。

## 扩展工具与模型

- 用 `builtinTool()` 定义自定义工具，经 `app.toolRuntime.registerTool()` 注册。参数由 JSON Schema 校验；handler 返回 `{ status, output }` 形式的 `ToolExecutionResult`，不再返回字符串。参见 [自定义工具示例](examples/custom-tool.ts)。
- TUI 从 `.coil/config/mcp.json` 加载 stdio MCP server，工具以 `mcp__server__tool` 命名。headless 宿主可调用 `loadConfiguredMcpTools()`，将结果传入 controller 的 `toolProviderResults`。
- 注入实现 `Provider` 接口的对象即可替换模型后端。pi-ai 适配位于 `src/core/providers/`。

## 取消与关闭

`SessionController.cancelRun(id?)` 取消指定运行及其活动后代，省略 ID 时选择最近的主运行。父运行正常结束后，已启动的子代理和后台工作可以继续；`close()` 则停止整个会话所属的工作、关闭连接并保存。重复关闭复用同一个 Promise，清理或保存失败会返回错误。

`waitForAsyncWork({ shouldStop })` 允许宿主只停止等待，不取消任务。有结果可交付时，等待即可结束，无需等待其余工作全部完成。取消或关闭会抑制相关唤醒，保留的结果仍可通过 `controller.appContext.inbox.getResults()` 检查。

TUI 快捷键：

| 操作                     | 按键                  |
| ------------------------ | --------------------- |
| 取消当前运行或其异步工作 | Ctrl+C                |
| 只停止等待异步结果       | 异步等待时按 Esc      |
| 关闭会话                 | Ctrl+D，空闲时 Ctrl+C |

取消不会回滚已经发生的副作用。无法确认进程或远端操作停止时，`cleanup.status` 为 `unconfirmed`，宿主不能将其视为已停止。单个 MCP 请求取消不会关闭其他调用共享的连接。进程清理已在 macOS arm64 / Node 24 和 [Linux CI / Node 22](https://github.com/mothieras/coil-core/actions/runs/42363374521) 中验证，范围限于引擎创建且留在受管进程组内的 shell 与后代；脱离进程组的进程、远端操作和 Windows 进程树清理不在已验证范围内。工具权限规则不提供操作系统沙箱隔离。

## 保存与恢复

TUI 中用 `/resume` 列出会话，使用 `/resume <序号或 ID>` 打开。headless 宿主使用 `SessionController.resume({ workspaceRoot, sessionId })`。运行状态、消息和报告保存在 workspace 的 `.coil/state/` 下，不应提交到版本库。

恢复使用最后一个可信检查点。已保存但未交付的异步结果可继续消费，已确认加入主消息的结果不会重复应用。如果工具或异步工作可能已执行但没有可靠结果，恢复会阻止继续执行和自动唤醒；用 `/recover` 查看，再用 `/recover verify <id>` 记录核实，或用 `/recover discard <id>` 放弃追查。headless 宿主从 `getSnapshot().recovery` 读取待处理项，通过 `resolveRecovery(id, "verified" | "discarded")` 记录决定。需要重做时，在新消息中明确请求，并重新经过权限流程。

`resolveRecovery()` 只保存核实或放弃的决定，不会自动继续执行，也不会将历史未知结果改为成功。恢复演示会读取已知的本地标记文件完成核实；真实宿主需检查相应文件或外部系统后再记录决定。

检查点写入失败后，当前 controller 停止继续执行；`flush()` 可重试保留的写入，随后重新打开会话核对结果。`events.jsonl` 的可信检查点及其引用的私有上下文槽位是恢复依据，`snapshot.json` 和 `lead-messages.json` 是派生视图。旧版 pi-ai 和 Anthropic 会话仍可恢复对话，但缺少执行证据时无法提供同等恢复保证。

恢复保证面向本地文件系统上的单进程会话和进程异常退出，不承诺跨崩溃的模型调用或自动唤醒恰好执行一次。

## 迁移已有嵌入代码

- 自定义工具 handler 从字符串返回值改为 `ToolExecutionResult`，例如 `{ status: "completed", output: "done" }`；可供模型修正的失败使用对应状态，存储和运行时故障继续抛出。
- 直接调用 `agentLoop()` 时可传 `signal`；需要运行记录、按 ID 取消及所属工作的收尾时改用 `AgentRuntime`。`createAppContext()` 消费者在退出时应关闭 `app.agentRuntime` 和工具 providers。
- `handleAutoWake()` 的结果现在可能为 `undefined`；等待异步工作时同时考虑活动工作与待交付结果，参照上面的嵌入示例。
- 需要保存与恢复保证时通过 `SessionController` 执行和 `flush()`；不要向新版 `events.jsonl` 直接追加无检查点事件。恢复未决项后，用 `resolveRecovery()` 保存决定，再明确提交下一条消息。

## 开发

```text
src/core/   可嵌入的引擎与公共导出
src/tui/    Ink/React 客户端
examples/   嵌入与自定义工具示例
```

| 模块                 | 职责                                                                  |
| -------------------- | --------------------------------------------------------------------- |
| `agent/`、`loop/`    | Agent 身份与消息、运行终态与取消、模型及工具循环                      |
| `tools/`、`app/`     | 工具校验与派发、共享连接、子代理及后台工作的装配与归属                |
| `session/`、`async/` | 主运行准入、结果交付、检查点保存、恢复、投影与报告                    |
| `providers/`         | pi-ai 模型接入、请求取消与错误信息；core 其他模块只依赖 provider 契约 |
| `src/tui/`           | 通过 controller 和 view events 展示状态、处理输入与权限请求           |

| 命令                   | 用途                 |
| ---------------------- | -------------------- |
| `pnpm dev`             | 从源码启动 TUI       |
| `pnpm dev:watch`       | 监听源码变动并重启   |
| `pnpm build`           | 清理并编译到 `dist/` |
| `pnpm start`           | 运行已构建的 TUI     |
| `pnpm test`            | 运行测试             |
| `pnpm typecheck`       | 检查 `src/` 类型     |
| `pnpm typecheck:tests` | 检查源码与测试类型   |
| `pnpm lint`            | ESLint               |
| `pnpm format:check`    | 检查格式             |

`TERM=dumb` 会启用 ASCII 显示。组件测试包含 Unicode 输出断言，在此环境下可用 `TERM=xterm-256color pnpm test` 运行。工程约束和代理工作说明见 [AGENTS.md](AGENTS.md)。

## License

MIT © mothieras
