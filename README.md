# coil-core

[![CI](https://github.com/mothieras/coil-core/actions/workflows/ci.yml/badge.svg)](https://github.com/mothieras/coil-core/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

可嵌入的本地优先 coding agent 引擎，提供模型与工具循环、MCP、并发子代理、运行取消、会话持久化与报告。核心位于 `src/core/`，不依赖 UI；仓库附带的 Ink/React TUI 是它的一个客户端。

## 快速开始

需要 Node.js 22.19 或更高版本，以及 pnpm 11.0.9。在仓库目录执行：

```bash
pnpm install
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

只需要模型与工具循环时，可直接使用 `Agent` 和 `agentLoop`，参见 [headless 示例](examples/headless-agent.ts)；此入口的持久化与资源管理由宿主负责。

## 扩展工具与模型

- 用 `builtinTool()` 定义自定义工具，经 `app.toolRuntime.registerTool()` 注册。参数由 JSON Schema 校验；handler 返回 `{ status, output }` 形式的 `ToolExecutionResult`，不再返回字符串。参见 [自定义工具示例](examples/custom-tool.ts)。
- TUI 从 `.coil/config/mcp.json` 加载 stdio MCP server，工具以 `mcp__server__tool` 命名。headless 宿主可调用 `loadConfiguredMcpTools()`，将结果传入 controller 的 `toolProviderResults`。
- 注入实现 `Provider` 接口的对象即可替换模型后端。pi-ai 适配位于 `src/core/providers/`。

无需模型凭据即可运行以下示例。它们使用构建产物和临时 workspace；取消示例会启动真实本地进程并检查退出：

```bash
pnpm build
pnpm exec tsx examples/custom-tool.ts
pnpm exec tsx examples/cancel-run.ts
```

## 取消与关闭

`SessionController.cancelRun(id?)` 取消指定运行及其活动后代，省略 ID 时选择最近的主运行。父运行正常结束后，已启动的子代理和后台工作可以继续；`close()` 则停止整个会话所属的工作、关闭连接并保存。重复关闭复用同一个 Promise，清理或保存失败会返回错误。

`waitForAsyncWork({ shouldStop })` 允许宿主只停止等待，不取消任务。有结果可交付时，等待即可结束，无需等待其余工作全部完成。取消或关闭会抑制相关唤醒，保留的结果仍可通过 `controller.appContext.inbox.getResults()` 检查。

TUI 快捷键：

| 操作                     | 按键                  |
| ------------------------ | --------------------- |
| 取消当前运行或其异步工作 | Ctrl+C                |
| 只停止等待异步结果       | 异步等待时按 Esc      |
| 关闭会话                 | Ctrl+D，空闲时 Ctrl+C |

取消不会回滚已经发生的副作用。无法确认进程或远端操作停止时，`cleanup.status` 为 `unconfirmed`，宿主不能将其视为已停止。单个 MCP 请求取消不会关闭其他调用共享的连接。进程清理已在 macOS arm64 / Node 24 和 [Linux CI / Node 22](https://github.com/mothieras/coil-core/actions/runs/42363374521) 中验证；Windows 进程树清理尚未验证。

## 保存与恢复

TUI 中用 `/resume` 列出会话，使用 `/resume <序号或 ID>` 打开。headless 宿主使用 `SessionController.resume({ workspaceRoot, sessionId })`。运行状态、消息和报告保存在 workspace 的 `.coil/state/` 下，不应提交到版本库。

恢复使用最后一个可信检查点。已保存但未交付的异步结果可继续消费，已确认加入主消息的结果不会重复应用。如果工具或异步工作可能已执行但没有可靠结果，恢复会阻止继续执行和自动唤醒；用 `/recover` 查看，再用 `/recover verify <id>` 记录核实，或用 `/recover discard <id>` 放弃追查。headless 宿主从 `getSnapshot().recovery` 读取待处理项，通过 `resolveRecovery(id, "verified" | "discarded")` 记录决定。需要重做时，在新消息中明确请求，并重新经过权限流程。

检查点写入失败后，当前 controller 停止继续执行；`flush()` 可重试保留的写入，随后重新打开会话核对结果。旧版 pi-ai 和 Anthropic 会话仍可恢复对话，但缺少执行证据时无法提供同等恢复保证。

恢复保证面向本地文件系统上的单进程会话和进程异常退出，不承诺跨崩溃的模型调用或自动唤醒恰好执行一次。

## 开发

```text
src/core/   可嵌入的引擎与公共导出
src/tui/    Ink/React 客户端
examples/   嵌入与自定义工具示例
```

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
