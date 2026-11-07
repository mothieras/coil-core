# Agent runtime 架构优化与可靠性打磨规格

状态：M0–M4 已完成。M1 出口见第 9.6 节，M2 契约与出口见第 9.7–9.8 节，M3 协议见第 9.9 节，M4 异步结果交接与出口见第 9.10 节。M5 尚未开始。

基线：仓库提交 `54551bc`。本文是内部开发规格；公共使用说明继续以 `README.md` 为准，工程约束以 `AGENTS.md` 为准。

## 1. 背景与定位

本轮工作的主要目标是建立并展示 Agent runtime 的工程能力，而不是复制一个通用 coding agent，或证明模型解题能力优于成熟产品。

coil-core 的定位保持为可嵌入、本地优先的 coding agent 引擎。coding 任务是验证运行时的实际场景，TUI 是参考客户端。项目应让使用者和代码审阅者能够理解、运行并验证以下能力：

- 执行生命周期与取消传播。
- 工具调用、权限和失败处理。
- 会话持久化、恢复及不确定状态处理。
- 并发子代理和后台工作的生命周期管理。

架构优化与能力建设共同推进：每项重构必须对应已确认的维护问题、行为缺陷或本规格中的具体需求，不以目录数量、文件长度或抽象层数作为成果。

## 2. 目标、范围与非目标

### 2.1 目标

| 编号 | 目标                                 | 可观察的完成证据                                                   |
| ---- | ------------------------------------ | ------------------------------------------------------------------ |
| G1   | 明确运行状态、资源和收尾逻辑的所有权 | 职责说明、调用路径及跨模块行为测试一致                             |
| G2   | 支持真实、可解释的取消               | 信号传递到实际消费者；停止后不再派发新工作；不能确认停止时明确报告 |
| G3   | 建立一致的工具执行契约               | 输入错误、拒绝、失败、超时、取消可区分，并映射到模型和事件         |
| G4   | 恢复时不误报成功、不盲目重放副作用   | 故障注入覆盖关键写入窗口，未确认结果进入待核实状态                 |
| G5   | 可靠管理异步工作                     | 并发限制、父子关系、结果交付、关闭清理有确定性测试                 |
| G6   | 形成可复现的工程展示                 | 无凭据示例、真实本地集成检查和准确的 README 说明                   |

### 2.2 本轮范围

工作分为两条线，按里程碑交替推进：

1. 架构线：只读审查、职责与状态所有权梳理、必要的模块重构、删除被替代的实现。
2. 能力线：生命周期与取消 → 工具执行契约 → 持久化与恢复 → 异步工作管理。

保留 pi-ai、现有自研 loop、Ink 客户端及本地文件存储作为基线。重构可以改变内部组织，但不预先要求合并或拆分特定类。

### 2.3 非目标

以下事项不作为本轮验收条件：

- 迁移到 Vercel AI SDK、pi-agent-core 或其他 agent framework。
- 更换 TUI 框架、视觉重设计或增加 Web 客户端。
- 建立通用 workflow 平台、插件市场、多 SDK 通用类型系统。
- 分布式调度、多进程共同写同一会话、跨机器任务迁移。
- 自动回滚任意 shell 命令、跨外部系统的 exactly-once 执行保证。
- 默认引入数据库、worktree 隔离、费用路由或任务队列。
- 对模型回答质量或真实编码任务成功率作未经评测的承诺。

端到端流式输出、工具进度展示、MCP 官方 SDK 迁移可以后续单独立项；本轮不为它们提前增加抽象。已有 recovery、context compaction、memory、skill 等模块保持回归保障，不要求逐目录重写；与本轮取消或恢复链路直接相关的调用必须纳入调整。

## 3. 已确认的现状与待审查问题

以下九项基线观察已在 M0 对照源码复核，均成立。第 3.1–3.4 节记录执行路径、资源所有权、重构依据和测试缺口；静态确认不等同于已运行取消或崩溃故障复现。

| 代码位置                                         | 已确认的现状                                                                                | 本轮关注点                                      |
| ------------------------------------------------ | ------------------------------------------------------------------------------------------- | ----------------------------------------------- |
| `src/core/providers/types.ts`                    | `generate()` 返回完整 `AssistantMessage`；调用选项包含 token 上限和超时，没有 `AbortSignal` | 建立请求取消契约；继续使用 pi-ai 消息类型       |
| `src/core/loop/deadline.ts`                      | `awaitWithDeadline()` 通过 Promise 竞争限制等待时间                                         | 停止等待不等于停止底层操作                      |
| `src/core/agent/run.ts`、`runtime.ts`            | 状态修改函数直接赋值；runtime 在 loop 返回后调用完成逻辑                                    | 终态保护、结束原因和重复收尾的统一规则          |
| `src/core/tools/input.ts`、`runtime.ts`          | 调用上下文没有取消信号；工具主要返回字符串，异常格式化为字符串                              | 控制结果不能仅依赖展示文本识别                  |
| `src/core/tools/background/backgroundManager.ts` | `exec()` 返回的进程句柄未保存；`interruptRunning()` 修改记录并通知                          | 实际进程停止、资源清理与状态更新的关系          |
| `src/core/tools/subagent/subagentRunner.ts`      | 已有限流和迟到结果保护；中断路径修改记录，未向 child loop 传递取消信号                      | 复用已有机制，补齐实际执行取消和 run 终态一致性 |
| `src/core/session/controller.ts`                 | `flush()` 先取走待写事件，再顺序写事件和多个状态文件                                        | 写失败、并发 flush 和跨文件一致性               |
| `src/core/session/store/sessionStore.ts`         | JSON 文件采用临时文件加 rename；事件采用追加写                                              | 单文件替换不能代表跨文件事务或断电持久性        |
| `src/core/session/projection/projectionStore.ts` | `record()` 更新内存投影、排队事件并发布 view events                                         | 内存可见与持久化完成必须区分                    |

### 3.1 六条执行路径

定位以 `54551bc` 的文件和函数为准。下述“当前”描述实现，“M1”描述待实施设计，不能混用为能力声明。

```text
用户消息 / 自动唤醒
  → SessionController → SessionRunner → AgentRuntime → agentLoop
                                                       ├─ provider / compact
                                                       └─ hooks → permission → ToolRuntime → handler
子代理 handler → SubAgentRunner → child AgentRuntime → child agentLoop
后台 handler → BackgroundManager → exec
MCP handler → 共享 StdioMcpClient → 请求 id / stdio 子进程

runtime lifecycle ──→ controller.emit ────────────┐
manager → inbox ────→ controller.recordAsyncWork ├─→ projectionStore.record
用户消息 / session / commands ──────────────────┘       ├─→ 纯投影 → view events → TUI
                                                        └─→ pending events
controller.flush → drainPending → appendEvents → conversation / lead-messages / snapshot
```

1. **用户消息**：`src/tui/useSession.ts` 的 `submit/runMessage` 由 UI 的 `busyRef` 串行化，经 `src/tui/sessionActions.ts:drainTurn` 调 `SessionController.handleUserMessage`。`src/core/session/runner.ts:runUserTurn` 写用户消息、创建 run；`AgentRuntime.run` 启动并在 loop 返回/抛错后写终态。loop 是唯一生产 ALS 绑定点，修改 `Agent.messages`；runner 将回答转成 conversation event。controller 在 finally 保存 lead 摘要、尝试自动命名、flush。当前没有运行取消句柄，controller 的 `running` 仅赋值，不拒绝并发调用；finally 中的命名/flush 还可能掩盖原执行错误。M1 在 runtime 统一终态、controller 统一准入与关闭，不合并四个类。
2. **自动唤醒**：子代理/后台 manager 调 `AsyncWorkInbox.register/settle`；controller 的订阅仅记录状态，不启动模型。`drainTurn` 在父 turn 后按 `hasPendingAsyncWork → waitForAsyncWork → handleAutoWake` 等待全部活动工作结束；`SessionRunner.runAutoWake` 新建 lead run，`src/core/hooks/runtimeHooks.ts:injectAsyncWorkResults` 在 lead 的 `PreLLMCall` drain 并注入结果。等待中断只返回 `interrupted`，没有取消任务。run 终态与保存仍由 runtime/controller 完成。M1 阻止取消/关闭后的唤醒；M4 完善忙时合并、去重和可靠交接。
3. **工具**：`src/core/loop/loop.ts:executeToolUseBlock` 发 started，依次检查 allowedTools、控制 hook、权限，再调 `ToolRuntime.invokeTool`；handler 产出字符串，loop 发 finished，批次全部完成才将 results 写入 messages。started 包含尚未实际派发的授权阶段，不是副作用已开始的证据。loop 的 deadline 只结束等待；runtime catch 和 loop 内层 catch 将普通异常文本化，未向 handler 传 signal。超时可在已加入 assistant tool calls、但尚未追加 results 时返回。M1 保留顺序，增加派发前取消检查、控制错误和完整配对；M2 再统一参数校验与普通错误。
4. **子代理**：`src/core/tools/subagent/subagentTool.ts` 读 `currentAgent`，把 session/run/tool-call 身份交给 `SubAgentRunner.run`；后者检查容量（默认 3）、fork、登记 Map/inbox，并异步启动 child runtime。正常父 run 完成不停止子工作。runner 的 `.then/.catch` 结算任务，runtime 另写 run 终态，controller 订阅 inbox 并保存。`interruptRunning` 只改记录、立即释放逻辑槽位；child loop 未被停止。M1 把 fork/协调移出 tools，由协调方保存完成句柄并调用 runtime 取消；工具仅接收注入的中立启动能力。
5. **关闭**：`useSession.shutdown/quit` 调 `SessionController.close`；当前依次标后台和子代理 interrupted、补 child run 终态、记录 session_closed、调用 app.closeToolProviders，finally flush。后台无进程句柄，MCP close 只 kill 不等退出；lead、权限队列、辅助请求未被取消，也没有 closed 准入门禁。app 记住已成功关闭的 provider，但 controller 没有共享 close Promise，多错误只保留部分。M1 先禁止新工作，再取消并有限确认退出，最后关闭共享连接并保存；终态只由 runtime 确定，保存/清理失败必须可见。
6. **恢复**：`useSession.runResume` 先加载新 MCP providers、调用 `SessionController.resume`，成功后才关闭旧 controller 并换订阅。resume 分别读取 `SessionStore.loadSession/loadLeadAgentMessages/loadSnapshot`，转换 legacy 消息，重新 build app/runner，清旧 MCP 诊断并记录 resumed。当前不重放 events.jsonl，也不重建旧进程或活动任务；旧 snapshot 的 running 记录只是展示。新 providers 由新 app 接管，失败由 UI 清理。M3 才建立跨文件一致性点、未决副作用阻断和恢复证据；M0/M1 不宣称执行恢复已经安全。

### 3.2 可变状态与资源所有权

没有唯一所有者的地方明确标为缺口，不将现有共享可变对象描述为已解决的设计。

| 状态或资源          | 当前创建、持有与释放方                                                                                                | M1 权威所有者及交接                                                                                              |
| ------------------- | --------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| run 记录与终态      | runner 创建；runtime start/complete/fail；subagent runner interrupt；controller 补事件；projection 另保护 interrupted | runtime 独占终态决策及最终事件；runner/controller 只请求，投影只消费事实。可序列化记录不放控制器                 |
| lead/child messages | Agent 持有数组；runner、loop、hooks、compact 写；controller 读取保存，恢复时注入                                      | 同一 Agent 的活动执行独占写入；controller 对手动压缩和 turn 做准入，压缩提交前复查取消；不把数组交给新状态所有者 |
| run 控制句柄        | 当前没有 AbortController，也未保存 child completion Promise                                                           | runtime 私有活动表持有 controller、deadline、执行完成 Promise；协调方持有后代归属与资源完成句柄，不直接写 run    |
| provider/压缩请求   | loop/compact 发起，provider/SDK 执行；textGenerator 没有取消选项                                                      | run 内请求继承 run signal；session 命名、手动压缩、ping 由 controller 追踪并在关闭时取消                         |
| 定时器              | deadline 的 finally 清自身 timer；loop sleep 不可取消；waitForAsyncWork 每轮 500ms；MCP request 每次 10s              | 各创建方清理 timer/listener；runtime 统一触发取消，不把 Promise race 当底层结束                                  |
| 权限等待            | loop 创建 permission context，checker 调 askUser；TUI bridge 持 FIFO resolver，只有手工 resolve                       | checker/bridge 接收 signal，取消时移除对应项并结束等待；loop 在实际派发前复查；headless 同样遵守                 |
| 前台/后台 shell     | `file/bash.ts:execAsync` 和 BackgroundManager 创建 exec；均丢弃 ChildProcess；后台 Map 仅保留记录                     | 进程执行模块持有句柄、退出 Promise、timer；后台 manager 保存 session/run/父调用归属；停止确认后才结算资源        |
| 子代理              | SubAgentRunner 持 child、run 和任务状态，但不持完成句柄；按 status 计容量                                             | 移至 agent 层的协调模块持 child 与完成句柄，runtime 控制执行；未确认停止仍占槽位                                 |
| MCP 连接/进程       | loader 创建 client 并将 close 能力交 app；client 持 child/初始化 Promise，JsonRpcStream 持请求 resolver               | app/session 独占共享连接生命周期；client 独占进程退出确认；单请求取消只释放该请求等待，不关闭连接                |
| 活动工作/结果       | inbox 持 running Set、通知队列和订阅；settle 删除 running 并入队；hook drain                                          | 执行模块确认实际结束后释放活动容量；inbox 只负责结果交付。M1 加归属与取消抑制，M4 去重并衔接持久化               |
| 待写事实/投影       | projectionStore.record 排队、纯 apply、发布；controller drain 并写 store；inbox 订阅未保存解绑句柄                    | 保留单一入口；controller 关闭时管理订阅和收尾。M3 再改为有确认的串行 flush，确认前不释放事实                     |

### 3.3 问题、最小调整与验证

以下为源码可确认的问题；验证栏是后续必做检查，不表示 M0 已执行新测试。

| 编号 / 契约    | 确认证据及影响                                                                                                                                                                                                                                       | 最小调整与验证入口                                                                                                                                                         |
| -------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| R1：L1、L2     | `agent/runtime.ts:run` 将所有 loop 正常返回 complete；`agent/run.ts` 转换直接赋值；`subagentRunner.ts:interruptRunning`、`controller.ts:recordInterruptedSubagentRun` 重复决定终态；`projection.ts:applyRuntimeLifecycleEvent` 仅拦 interrupted 覆写 | T005–T006：runtime 单一状态转换与最终事件，删除补发路径；`agent-runtime`、`runtime-lifecycle`、`session-projection`、`session-report` 检查完成/取消/超时先后及最终事件计数 |
| R2：L3、L4     | `providers/types.ts` 无 signal，`pi.ts` 把 aborted 与 error 一并包装；`loop/deadline.ts` 只有 race，`loop.ts` sleep 无取消；`permission/types.ts` 与 bridge 无取消契约                                                                               | T007–T010：signal 到真实消费者、派发前检查、保留 HTTP/retry-after；`pi-provider` 的本地 HTTP 请求取消、`error-recovery` 的调用计数、权限迟到允许无副作用                   |
| R3：L3、L5     | `context/compact.ts:compactMessagesWithResult` await 摘要后直接 splice；`controller.ts:maybeAutoTitle` 在 running=false 后调用；`commands.ts:compact/ping` 无关闭归属                                                                                | T010、T017：辅助请求登记、信号和提交门禁；压缩及 `session-controller` 用可控完成顺序证明无迟到改写，不只比较状态                                                           |
| R4：T3、T4     | `tools/runtime.ts:invokeTool` catch 全部字符串化；loop 解析 Error 前缀；tool results 批末才追加；`tools/file/bash.ts:runBash` 非零退出有输出时返回普通文本                                                                                           | M1 的 T011、T014 只处理取消/超时/停止未确认及消息配对；M2 的 T021–T025 统一普通结果、校验和 shell 失败。检查未派发调用计数、完整上下文及含 Error 文本的正常结果            |
| R5：L4、C2     | bash/background 丢弃 exec 句柄；background 无 run 归属，interrupt 只改记录；`mcp/stdioClient.ts:close` kill 后立即清 child 并返回                                                                                                                    | T012–T013、T016：保留句柄、退出确认和请求隔离；真实进程/后代、TERM 忽略与失败清理，以及 MCP 另一在途调用继续完成                                                           |
| R6：A3、C1、L5 | `tools/subagent/subagent.ts`、`subagentRunner.ts` import Agent/Runtime；`subagentTool.ts` import currentAgent；runner 按逻辑状态放开槽位，迟到保护只保护任务记录                                                                                     | T015–T016：移出协调职责、注入启动能力、保存 completion；补生产 import 方向检查；取消后实际未退出时新启动仍被拒绝                                                           |
| R7：A3、T2     | `subagent.ts:forkSubAgent` 只取 requested ∩ profile，未取受限 parent.allowedTools；现有“never widens”用例的 parent 没有限制                                                                                                                          | T015：最终范围取父允许范围 ∩ profile ∩ 请求范围；增加受限 parent + subagent 入口的实际拒绝计数，保留默认完整 profile 行为                                                  |
| R8：L5、C3、C4 | controller handleUserMessage/handleAutoWake 无 busy/closed 拒绝；close 不停止 lead；inbox settle 可重复、drain 无确认；TUI 承担自动唤醒调度                                                                                                          | T017 先完成关闭/取消准入与同 Agent 非重入，T037–T042 再完善去重和交接；公开 controller 并发请求、重复关闭、迟到结果与多错误检查                                            |
| R9：P1–P5      | controller.flush 在 append 前 drain；snapshot/message 多文件顺序写无协调；resume 独立加载不读日志；lifecycle 为摘要且 safeEmit 吞观察错误                                                                                                            | T027–T035：确认通道与观察通道分离、有序确认和恢复协议；保留 record 单入口。追加失败/部分追加/快照失败、并发 flush 与五个真实崩溃窗口验证，不用摘要重建完整消息             |

待验证风险：自动唤醒只看 running Set，工作在父 turn 返回前刚好结算且未被最后一次 hook 消费时，已排队结果可能不触发唤醒；并发 flush 可能旧状态覆盖新状态；MCP 初始化与 close 竞争可能重新启动进程；停止后的压缩可能覆写后续消息。这些路径有静态依据，但 M0 未运行专门竞态复现。分别在 T040、T031、T013/T017、T010 建立可控同步测试后下行为结论。

保留项：Agent 的身份/策略/消息、runtime 的单次执行、runner 的会话 turn、controller 的会话装配职责可以保留；不按类数合并。保留唯一 ALS 绑定、UI 无关 loop、ToolRegistry 的注册/命名空间职责、hooks 与权限的分工、pi-ai 消息与懒配置、显式并发拒绝、runner 的迟到结果隔离和 rejection 结算、MCP 按 id 解复用及共享初始化、纯投影和观察者异常隔离。`ToolRuntime` 本身没有 import Agent/Session，偏差集中在子代理工具链；不能借迁移把依赖倒置到 runtime。

### 3.4 既有测试的证据边界

M0 全量 237 测试通过；这里只指出它们未证明的保证，不撤销已有证据。

| 现有检查                                                                                                           | 已证明                                                                                         | M1 或后续所缺证据                                                                                     |
| ------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| `tests/agent-runtime.test.ts`、`tests/runtime-lifecycle.test.ts`                                                   | 正常终态/异常、事件顺序、权限/工具错误和观察者隔离                                             | 返回 error/timeout/max_turns 的状态映射；不同竞争顺序只提交一次终态                                   |
| `tests/subagent-runner.test.ts` 的 interruptRunning、`tests/session-controller.test.ts` 的 running subagents close | 永不 resolve 的 fake runtime/provider 下记录及 snapshot 变 interrupted                         | 实际 provider/工具停止、迟到完成不重写 run、停止中容量仍占用；不得沿用“记录中断即可释放”的预期        |
| `tests/runtime-boundaries.test.ts` 的 background、`tests/session-controller.test.ts` 的 background close           | 真实短进程自然完成、pending/记录变化                                                           | 主动取消、超时、升级终止、受管后代实际退出和重复清理；新增 fixture 必须有限超时、失败也回收           |
| `tests/builtin-tool-ownership.test.ts`、`tests/runtime-boundaries.test.ts`                                         | 每工具工厂/manifest、固定 profile 收窄；部分测试手工绑定 ALS                                   | tools 到 Agent/Session 的生产 import 检查；真实 loop 入口的身份及受限 parent 权限传播                 |
| `tests/pi-provider.test.ts`、`tests/mcp-stdio-client.test.ts`                                                      | provider 选项和错误状态/headers（含真实 pi-ai 的自定义 fetch 路径）；真实 stdio 并发乱序解复用 | 真实本地 HTTP 取消/不重试；单 MCP 请求取消不影响另一请求；close 等实际退出，不能只 await 当前 close   |
| `tests/session-controller.test.ts` 的 partial flush failure、`tests/session-store.test.ts`                         | append 成功后 saveConversation 失败再 flush 不重复 append；单 JSON 原子替换                    | append 自身失败的事实保留、部分成功识别、并发排序及真实崩溃恢复（M3），不能将当前测试称为完整事务验证 |
| `tests/async-work-inbox.test.ts`、TUI session actions 测试                                                         | 基本 register/settle/drain、订阅隔离、停止等待不唤醒                                           | 重复结算、取消/关闭后迟到、headless 非重入与结果保存交接（M1 基本门禁，M4 完整保证）                  |

M0 没有新增生产代码或测试，也未执行新的取消、进程树或崩溃试验。Linux CI 配置存在不等于此次 Linux 已验证；准确环境和命令结果见 TASKS T001。

## 4. 架构优化要求

### A1. 先建立职责与资源所有权图

审查必须覆盖用户消息、自动唤醒、工具调用、子代理、关闭和恢复六条路径，列出：

- 谁创建运行，谁拥有运行中的控制句柄，谁确认终态。
- 谁创建和释放模型请求、定时器、权限等待、子进程与 MCP 连接。
- 谁将事实送入事件入口，谁生成投影，谁完成持久化。
- 失败与取消如何向上报告、向下传播。

一个可变事实必须有明确的权威写入方。多个展示或持久化副本必须说明同步方式，不以共享可变对象代替所有权设计。

### A2. 重构必须有具体依据

每项重构记录问题位置、受影响行为、最小调整和验证方式。优先减少调用方必须了解的状态、顺序和错误处理细节。

不接受只改名、搬文件或新增转发层作为独立架构成果。允许审查结论是保留现状。发现无关问题时登记，不顺手扩大实现范围。

### A3. 保持现有架构约束

遵守 `AGENTS.md` 全部不变量，特别是：

- 只有 `agentLoop` 绑定 `currentAgent`。
- 工具运行时与工具不得依赖 `Agent` 或 `Session`；子代理协调位置需要符合这一方向。
- loop 不增加 TUI、MCP、具体内置工具或子代理特判。
- 持久化事实仍经 `SessionProjectionStore.record` 单一入口，投影保持纯函数。
- TUI 经 `SessionController` 和结构化 view events 交互。
- pi-ai 的运行时接入集中在 provider 层，不以本轮重构引入厂商 SDK。

### A4. 以公开 interface 验证行为

优先沿现有调用入口注入 provider、工具和存储依赖。仅为具体测试或实际变化建立内部替换点，不暴露不必要的内部状态，也不为假想的第二种实现预建框架。

## 5. 行为规格

本节中的状态名称是语义约定，不要求 TypeScript 类型逐字采用。里程碑设计必须明确其与现有 `status`、`stopReason`、事件和持久化字段的映射。

### 5.1 运行生命周期与取消

#### L1. 明确运行结束语义

运行至少可区分：未启动、执行中、正在停止，以及成功、失败、取消、超时、达到执行限制等结束原因。

“Promise 正常返回”不等于任务成功。loop 返回错误、超时或达到轮次上限时，不得在报告中无条件显示成功。运行状态与结束原因可以分字段表达。

#### L2. 终态只确定一次

正常返回、异常、超时、取消必须由统一的终态决策规则处理：

- 先被权威状态所有者接受的终态决策生效。
- 取消被接受后，进入停止过程；迟到的正常结果不得将其改成成功。
- 若运行已完成，再次取消对该 run 本身是可识别的无操作，不改写原结果；仍活动的后代按 L5 的归属范围处理。
- 重复取消、关闭和完成回调不得造成重复收尾或重复释放。

同一进程存活期间，每个已启动 run 只提交一个最终运行事件。跨崩溃恢复不宣称全局 exactly-once；重复记录按稳定身份识别，具体规则在恢复里程碑确定。

#### L3. 取消贯穿执行链路

从 headless 调用入口和 `SessionController` 发起取消，经 runtime/loop 传递到 provider、重试等待、权限等待和工具调用上下文。

模型请求包括主回复和运行内的压缩等辅助请求。不得只取消主请求而遗留同一工作范围内的辅助请求。

- 取消后不再派发新的模型调用、工具或重试。
- 用户取消不进入网络重试、模型降级或上下文压缩补救路径。
- 权限等待被取消后，即使收到迟到的允许答复，也不能执行工具。
- 必须在实际派发前再次检查取消，不能只在一轮开始时检查。
- 超时复用停止与清理机制，但保留不同于用户取消的结束原因。

#### L4. 区分取消请求与实际停止

支持协作取消的操作接收信号；受 runtime 管理的本地子进程必须保留句柄，并根据验证过的平台策略请求终止、等待退出及执行必要的升级终止。

对于无法取消的外部操作，不得宣称副作用已停止。应暴露“停止未确认”或“结果未知”，禁止继续派发工作，并隔离迟到结果对终态的修改。取消不回滚已经发生的文件或远端修改。

超时等待或 Promise 竞争只能证明调用方停止等待，不能作为进程退出或远端操作终止的证据。

#### L5. 明确取消范围与关闭行为

以下默认行为已在 M0 评审中由用户确认，作为实现契约：

| 动作             | 作用范围                                                                |
| ---------------- | ----------------------------------------------------------------------- |
| 停止等待异步结果 | 仅结束等待，不取消任务；命名和返回值必须体现区别                        |
| 取消一个运行     | 取消该 run 及其创建且仍活动的后代工作，不影响其他运行拥有的工作         |
| 父运行正常结束   | 允许已显式启动的异步子代理或后台工作继续，由 session 管理后续结果       |
| 关闭 session     | 拒绝新工作，停止该 session 所有活动工作，再关闭工具连接并持久化收尾状态 |

运行取消期间到达的后代结果不得自动唤醒主代理，使其重新开始执行。session 关闭后也不得自动唤醒。已有结果可保留供用户后续检查。

关闭必须有有限的清理等待策略；M0 冻结的初始预算和平台策略见第 9.3 节。到期仍未确认停止的资源必须报告，不得标成清理成功。

### 5.2 工具执行与失败契约

#### T1. 结构化地区分执行结果

工具执行应能区分成功、未知或不可用工具、输入无效、权限拒绝、执行失败、取消、超时，以及停止未确认。可以保持模型侧文本输出，但运行时分类不能依赖解析 `Error:` 等文本前缀。

现有字符串返回值如何演进，由 M2 决定；不要求一次引入通用结果框架。

#### T2. 保持权限与执行顺序

只在输入满足执行要求、工具范围允许、控制 hooks 和权限检查通过后产生工具副作用。明确校验与授权次序，保留现有管理阻止规则。子代理工具范围只能收窄，不能通过恢复或 adapter 扩大权限。

工具参数无效时，返回可供模型修正的信息，不执行 handler。注册工具的校验责任必须明确，不能让多个层各自实现不一致的 schema 规则。

#### T3. 不混淆可恢复失败与系统故障

可供模型修正的工具错误可返回工具结果；运行取消、存储故障和 runtime 内部不变量破坏不能被格式化为普通字符串后继续假装正常运行。

保留诊断所需的工具身份、调用身份和原始错误因果信息。不得将凭据写入事件、快照或展示文本。

#### T4. 保持消息和事件完整性

每个已派发调用都有可关联的开始与结束或未确认状态。未派发调用与已执行调用必须可区分。

取消发生在一批 tool calls 中间时，后续模型上下文不得出现无说明的悬空调用；由 M1/M2 明确生成取消结果或安全整理上下文的策略。不得伪造成功结果。

本轮不新增通用工具并行执行；若保留已有并发路径，执行顺序、结果顺序和事件关联必须有测试。

### 5.3 会话持久化与恢复

#### P1. 明确持久化承诺

内存 `record()`、界面收到事件、`flush()` 成功是不同阶段。对外宣称保存成功必须以持久化确认完成为准。

本轮保证范围以单进程写入、本地文件系统和进程异常退出为基础。不自动承诺断电恢复、磁盘硬件故障恢复或多写者一致性。

#### P2. 写失败不能静默丢失状态

失败时保留足够的信息用于诊断和安全重试；不能因事件已从内存队列取走就认为写入成功。并发 flush 必须有明确排序，不得让旧快照覆盖已确认的新状态。

事件追加成功而快照失败时，后续重试不得制造无法识别的重复事实。若追加结果不确定，必须检测或保守处理，不能盲目再次追加。

执行意图未能可靠记录时，不得开始新的副作用操作。执行结果写入失败后不得对外报告该结果已安全保存，也不得继续无界派发工作。

#### P3. 定义可恢复的一致性点

M3 必须确定权威记录、写入顺序、必要的格式版本或检查点标识，以及恢复算法。继续使用现有文件存储，除非有证据表明无法满足契约并另行批准替换。

恢复以最后一个可验证的一致性点为依据。消息、事件和快照不一致时，不得只选看起来最新的文件拼成成功状态。

尾部不完整记录与日志中部损坏需要区分：允许从已验证前缀恢复时必须提示缺失范围；无法确认一致性时明确失败，不覆盖原始数据。

#### P4. 不自动重放结果未知的副作用

必须覆盖以下故障窗口：

| 中断位置                         | 恢复要求                                                     |
| -------------------------------- | ------------------------------------------------------------ |
| 工具执行意图尚未可靠保存         | 工具不得开始；保留可恢复的会话状态                           |
| 意图已保存，无法确认工具是否开始 | 标记为结果未知，不自动重放                                   |
| 工具产生副作用，结果尚未可靠保存 | 标记为结果未知，要求核实，不推断成功或失败                   |
| 结果已保存，快照尚未更新         | 从权威记录重建，不再次执行工具                               |
| 模型返回但消息尚未可靠保存       | 不将丢失内容视为已交付；从一致性点继续时明确可能需要重新请求 |

“结果未知”必须能由 headless 消费者和 TUI 识别。后续继续执行前，用户需明确核实或放弃该未决操作；重新执行必须重新经过权限流程，不能仅靠再次打开会话触发。

#### P5. 保持已有会话可读

保留现有 pi-ai 消息格式及 legacy transcript 加载能力。新增元数据时提供兼容加载规则和旧 fixture 测试。

旧会话缺乏执行证据时，允许降级为恢复对话，不得据此宣称执行安全恢复。禁止为完成迁移而静默删除旧会话或将未知状态归为成功。

### 5.4 子代理与后台工作

#### C1. 保留明确的并发策略

沿用现有子代理并发上限机制；达到上限时明确拒绝启动并返回可处理结果。本轮不增加隐式排队。

正在停止、但实际执行尚未确认结束的工作不能仅因记录改成中断就立即释放执行槽位。对停止未确认工作的后续准入策略必须明确，不能悄悄绕过上限。

#### C2. 记录工作归属

异步工作应能关联所属 session、创建它的 run 和必要的父调用身份。调用方不需要访问内部 Map 才能取消、观察或清理工作。

共享 MCP 连接的生命周期归 session/app，而不是某个单独工具调用。取消一个调用不能默认关闭其他运行正在使用的共享连接。

#### C3. 结果交付与自动唤醒有明确语义

同一存活会话内，重复完成回调不能产生重复结算、重复结果消费或重复唤醒。多个工作同时完成可以合并唤醒；忙碌中的主代理不得被重入执行。

关闭或取消决策之后到达的结果，按 L5 处理。正常父运行结束后仍活动的工作，可以按已有自动唤醒机制继续交付。

跨进程恢复后的结果去重与未决状态必须遵守 P3/P4，不宣称跨崩溃的自动唤醒 exactly-once。

#### C4. 子代理失败不破坏会话

子代理失败应成为明确的任务结果，由主代理或用户决定下一步；不得导致未处理的 Promise rejection。session 关闭应回收其控制的任务与资源，不能只把记录改成 `interrupted`。

## 6. 验收场景与证据

优先扩展现有 `node:test`、scripted `Provider` 和本地 fixtures，不要求模型 API 凭据。测试必须验证实际行为，不能只断言状态字符串。

| 编号 | 场景                             | 必须验证的结果                                                         | 主要里程碑 |
| ---- | -------------------------------- | ---------------------------------------------------------------------- | ---------- |
| V01  | 正常模型与工具循环               | 结果、消息、事件和 run 终态一致；现有路径保持可用                      | M1–M4      |
| V02  | 模型请求中取消                   | 实际 provider adapter 传递取消；不再请求模型或派发工具；只收尾一次     | M1         |
| V03  | 退避、权限或辅助模型请求中取消   | 等待可结束；迟到允许不执行；无额外重试或压缩                           | M1         |
| V04  | 用户取消与正常完成、超时竞争     | 按 L2 决策，迟到结果不改写终态，原因不混淆                             | M1         |
| V05  | 本地进程执行中取消或关闭         | 测试进程实际退出；已验证平台上的受管后代按策略清理；未确认退出明确报告 | M1         |
| V06  | 不支持取消的工具                 | 显示未确认状态，不再派发工作；不能将超时等待视为终止                   | M1         |
| V07  | 无效参数、权限拒绝、工具异常     | 分类准确；拒绝和无效输入没有副作用；错误原因可追踪                     | M2         |
| V08  | 一批 tool calls 中途停止         | 未派发工具不执行；继续对话时上下文合法；无伪造结果                     | M2         |
| V09  | 事件或快照写入失败               | 调用者获知失败；不丢失待处理事实、不报告保存成功                       | M3         |
| V10  | 工具副作用前后进程中断           | 已完成且持久化的工具不重跑；未知结果阻止自动继续                       | M3         |
| V11  | 部分写入、重复 flush、并发 flush | 恢复点一致；无无法识别的重复事件或旧快照覆盖                           | M3         |
| V12  | 旧会话加载与损坏记录             | 兼容格式可读；损坏可诊断，不覆盖原始数据                               | M3         |
| V13  | 并发达到上限、工作停止中         | 明确拒绝额外启动；未退出工作不提前释放槽位                             | M4         |
| V14  | 父取消、父正常完成、session 关闭 | 三种策略分别符合 L5；session 内无不应发生的唤醒                        | M4         |
| V15  | 多个子任务同时完成或重复完成     | 结果不丢失、不重复消费；主代理不重入                                   | M4         |
| V16  | 子代理失败、共享 MCP 调用取消    | 失败可收集；无未处理拒绝；不误断其他调用                               | M4         |

证据层级：

1. 单元测试：状态转换、错误分类、事件投影及恢复决策。
2. 契约测试：通过公开入口使用受控 provider、工具和故障注入存储，验证跨模块行为。
3. 本地集成测试：真实子进程、临时目录、真实文件恢复及本地 MCP fixture。取消 adapter 的检查应穿过真实 pi-ai adapter，例如使用可控本地 HTTP 服务；只替换 `Provider` 不能证明 adapter 集成正确。
4. 可选在线冒烟：有凭据时验证实际模型服务；记录模型和条件，不作为无凭据测试集的前置要求，也不把本地模拟称为线上验证。

竞态测试优先使用显式同步点和可控依赖，避免依赖任意 sleep。集成测试设置有界超时，并清理自己创建的进程和临时数据。

## 7. 里程碑与交付边界

| 阶段               | 工作                                                                     | 完成条件                                                            |
| ------------------ | ------------------------------------------------------------------------ | ------------------------------------------------------------------- |
| M0：只读架构审查   | 覆盖 A1 路径，核实问题，整理职责和资源归属，选择第一轮最小重构范围       | 每项建议有证据与验证方式；无实现改动；在本文补充审查结论与必要决策  |
| M1：生命周期与取消 | 确定状态映射、取消入口、取消范围、清理预算和平台策略；实施必要的结构调整 | V01–V06 通过；headless 和现有 TUI 可准确发起或呈现取消；不重设计 UI |
| M2：工具执行契约   | 统一结果分类、校验责任和消息映射；清除被替代的文本控制分支               | V07–V08 通过，M1 行为保持；普通错误与控制信号不混淆                 |
| M3：持久化与恢复   | 明确权威记录与恢复算法，完善写入失败处理和兼容加载                       | V09–V12 通过；原始会话不被静默破坏；未知副作用不自动重放            |
| M4：异步工作可靠性 | 完善归属、并发准入、结果消费、唤醒与关闭                                 | V13–V16 通过；真实执行状态与记录一致；关闭无静默遗留                |
| M5：交付与展示     | 整理公共说明、headless 示例、可复现演示和能力限制                        | 新使用者能按 README 跑通；实现、测试、示例和声明一致                |

M1 包含子代理和后台工作的基本取消传播，不能把端到端取消依赖推迟到 M4。M4 再完善并发准入和结果交付等管理语义。

每阶段都应保持项目可运行。局部兼容迁移必须在同阶段完成，不长期保留两套状态所有者或执行路径。发现需求冲突时更新并评审本规格，不通过修改测试期望绕过契约。

M1 完成后即可形成一个独立展示版本，不要求所有里程碑完成后才开始求职展示。未完成项保持明确标注。

## 8. 兼容性、安全与验证门槛

### 8.1 兼容性

- 保持无 UI 的嵌入方式、provider 注入、现有内置工具与 MCP 注册路径可用。
- 公共 interface 如需破坏性调整，先在本文记录原因、影响、迁移方式，再同步修改调用方、示例、测试和 README。
- 不保证内部类名与私有组织不变；不以兼容为由永久保留重复抽象。
- 保持懒加载配置行为：仅导入 core 不因缺少模型凭据而失败。

### 8.2 安全

- 取消和恢复不得绕过权限检查或扩大子代理工具范围。
- 不承诺 shell 安全规则等同于沙箱；本轮不新增安全隔离保证。
- 不将密钥、完整环境变量或无必要的敏感输出写入日志与演示素材。
- 不自动清理用户文件、删除旧会话或回滚已有修改。

### 8.3 每阶段验证

实现阶段根据受影响路径运行聚焦测试，并在交付前执行：

```bash
pnpm test
pnpm exec tsc --noEmit
pnpm typecheck:tests
pnpm lint
pnpm format:check
```

最终发布形态与示例检查另运行 `pnpm build`，并实际执行相关 headless 示例。源码编译不能代替测试类型检查。

如有基线失败，先记录并判断是否影响本阶段证据；不得把未通过或未执行的检查写成成功。新增 UI 状态需要检查实际终端呈现，不能只以组件快照代替使用验证。

M0 已执行上述五项基线检查，并检查文档格式、引用路径、条目一致性与变更范围；当时未验证 runtime 的新增保证。M1 已完成 V01–V06、构建、取消演示及真实终端检查，见第 9.6 节；崩溃恢复和后续阶段保证仍未实施。

## 9. 评审项与实施前决策

M0 评审结论：用户在本次结构化确认中选择“全部采用”“有限清理、按证据声明”“批准限定演进”。据此确认 L5 的四种作用范围、满额拒绝且不排队，以及第 2.3 节非目标。资源预算与限定公共兼容调整如下；M0 当时的设计批准不含实现授权，随后用户单独授权的 M1 实施结果见第 9.6 节。

### 9.1 状态、结束原因与事件映射

保留 `created/running/completed/failed/interrupted`，增加非终态 `stopping`；不要为每个原因另造一套运行状态。运行原因与资源清理结果分开表达：

| 输入/决策                                | 最终 status | stopReason / 语义                            |
| ---------------------------------------- | ----------- | -------------------------------------------- |
| 正常 stop                                | completed   | stop；只有此映射表示成功                     |
| 抛异常或 loop error                      | failed      | error，保留原始 cause 和调用身份             |
| 达到轮次限制、最终截断                   | failed      | max_turns / length，报告执行限制，不表示成功 |
| 接受用户取消或 session 关闭取消          | interrupted | aborted；另存用户取消/session 关闭的来源     |
| run deadline 到期                        | interrupted | timeout，不混同用户取消或网络错误            |
| 未请求取消却收到 provider aborted        | failed      | error；不能凭 SDK 文本认定是用户取消         |
| pending/deferred，或不合法的终结 toolUse | failed      | error；toolUse 正常情况下只是循环中间态      |

runtime 是权威转换方：接受停止决策时从 created/running 进入 stopping 并锁定原因，清理结束或预算耗尽才提交一次最终事件；完成先被接受则不能再重写。取消前已结束的父 run 保持原终态；若其后代仍活动，按归属停止后代并返回仅影响后代的结果，不伪造父 run 的第二次终态。重复请求复用同一次收尾，无剩余活动工作时为可识别无操作。

增加独立清理结果（无需清理、已确认、未确认及资源/错误列表），使 `interrupted + timeout + 未确认` 能被区分；未确认不等于成功停止。实际迟到退出仅更新资源事实和容量，不再改 run 终态。增加停止中通知并同步 lifecycle → session event → projection → view → report，`agent_run_finished` 仍只发一次。M1 同步更新状态联合的穷尽消费者；旧 snapshot 缺少新字段时为“未记录”，不得推断已确认清理。

### 9.2 取消 interface 与职责

- headless 保留 `AgentRuntime.run(agent, run)` 的调用方式，允许附加可选 signal；增加按 run id 请求取消的入口。controller 增加 `cancelRun`，内部使用同一 runtime 和 app 归属协调能力。取消在首次 await 前登记，返回可等待的结果，区分接受、已停止/无操作、仅后代、未知 id，并携带停止确认信息；调用方不访问内部 Map。具体类型名可随现有命名确定，语义不可削减。
- 直接 `agentLoop` 消费者可传可选 signal，并得到一致的 stopReason；它不另建 session 或 run 终态所有者。runtime 私有持有控制器/deadline/完成句柄；同一 Agent 的消息不能被两个活动 run 并发修改。
- `ProviderCallOptions`、loop options、`ToolInvocationContext`、权限 context 和 TextGenerator 增加可选 signal。askUser/permission bridge 增加兼容旧回调的可选取消上下文，取消必须移除等待项；不依赖 UI 特判。已安装 pi-ai 1.4.0 的 `dist/types.d.ts:ProviderRequestOptions` 有 signal、timeoutMs、maxRetries；保持 `maxRetries: 0` 和 coil 单一恢复预算。SDK 实际取消仍须 T008 本地 HTTP 验证。
- M1 保留 `ToolHandler` 和 `invokeTool` 的字符串成功返回。用独立类型的控制异常携带取消/超时/停止未确认及调用身份，让 runtime/loop 通用 catch 显式上抛，不靠文本分类。M2 再统一普通工具错误；不提前引入通用结果框架或 schema 库。
- run 内压缩归 run；自动命名、手动压缩、ping 归 session。前者随 run 停止，后者随关闭停止；命名失败仍可非致命，但关闭取消不可被 catch 吞成“已清理”。压缩在提交 splice 前复查信号和消息所有权。
- 后代保存 session/run/父调用归属，正常父完成不清除归属。显式取消抑制该范围的自动唤醒；关闭抑制整个 session。不可取消操作的迟到结果不再写活动消息或覆写终态，资源继续保持可观察；实际退出前保留容量。未确认的同 Agent 执行不允许再次进入，但独立 run 不被误取消。
- M1 对取消批次保留已得到的 tool results；给未派发调用补 `isError` 的“未执行：运行已取消”，给在途未确认调用补真实的“结果未知”，均按 toolCallId 配对。不能将未派发调用记成执行完成或伪造成功；下一次对话须使用完整消息配对。

### 9.3 清理预算、关闭与平台

初始默认资源清理预算为 **5,000ms**，同一取消/关闭范围共享绝对截止时间；并行请求停止，不能对每个后代累加 5 秒。受管本地进程先 SIGTERM，最多等 **2,000ms**，未退出则 SIGKILL，再等最多 **1,000ms**，均受剩余总预算约束。重复取消不延长截止时间。

关闭顺序为：禁止新 turn/辅助请求/工作 → 请求全部所属工作停止并收集确认 → 在剩余资源预算内关闭共享 MCP/provider → 保存收尾。若前序耗尽预算，仍发起共享资源关闭，但不再无界等待，并列出未确认资源。close 复用一个收尾 Promise；保留 `Promise<void>`，失败以聚合错误报告全部重要执行/清理/保存问题，不由 finally 覆盖原错误。

资源清理后，保存另给最多 **5,000ms** 的等待预算，因此正常异步调度下关闭等待上限为约 10 秒。文件系统写入未必可撤销：保存超时只能报告“保存未确认”，跟踪迟到完成/失败，不重复启动 flush、不重新开放 session，也不宣称磁盘写入已停止。这是 M1 的有限关闭与错误可见性，不提前承诺 M3 的事务/恢复保证。阻塞事件循环的同步自定义工具不在可抢占停止保证内；只能限制后续派发，不能承诺 wall-clock 硬中断。

平台目标为 macOS 和 Linux：只对本引擎创建、保持在受管进程组内的 shell 及后代建立终止策略；不杀无关进程，不承诺脱离进程组/自行 daemonize 的后代、远端副作用或回滚。MCP 单请求取消不杀共享 server，远端停止无法确认则如实报告。session 关闭才释放共享 client，并确认本地 server 退出。

当前仅有 macOS arm64 的既有测试通过；Linux 是现有 Ubuntu/Node 22 CI 的验证目标，尚无本轮执行结果。上述清理策略在两平台分别通过真实进程与后代 fixture 前，不对外声明支持；Windows 不承诺进程树清理，无法确认时报告未确认。T012/T020 的失败是平台验收阻塞，不能靠调低预期清零。

### 9.4 子代理迁移与公共兼容

把依赖 Agent 的 fork、runner 和父身份解析移到 `src/core/agent/` 内的协调模块，由 `src/core/app/context.ts` 装配。工具目录只保留 schema/输入解析及中立启动能力类型；能力接受 prompt/options/invocation identity，不接受 Agent/Session。app 注入闭包在允许依赖 Agent 的位置读取当前身份，继续由 agentLoop 唯一绑定 ALS，不向 loop 增加子代理分支。保留固定 profile，并补父工具范围交集。删除旧 tools 协调文件和反向 import，不留永久转发层。

用户已批准限定兼容调整：`BuiltinServices`、`loadBuiltinTools`、`createSubagentTools/createSubagentTool` 的 runner/权限装配参数改为注入启动能力；自定义装配调用者需从传 runner 改为提供启动能力，权限由协调方继承，不由模型输入指定。仓内 app、测试、示例同次迁移，README 记录变更；保留 `AppContext.subAgentRunner` 供 host 协调，其类型迁至 agent 协调模块，只暴露公开能力，不再作为工具依赖。内部深路径移动不保留旧导入，新增目录须有 barrel。

保留 core 导入时的懒配置、provider 注入、`run`/`close` 既有调用形状和普通字符串工具 handler；新增状态/事件联合会影响穷尽 switch，需同步消费者。公共取消结果与控制错误通过所属 barrel 和 `src/core/index.ts` 导出，私有控制表不导出。现有公开 run 转换 helper 需加终态保护，内部权威决策仍只经 runtime；不再把直接修改返回记录当取消接口。

### 9.5 M1 冻结范围与后续入口

M1 限于 T005–T020：单一终态、信号到实际消费者、最小工具控制结果与消息收尾、进程/MCP 停止确认、子代理协调迁移与基本容量/归属、controller/headless/TUI 接入、无凭据演示及回归。M1 不依赖 M2 的完整错误框架或 M4 的完整可靠交付才实现取消。

M1 必须沿公开入口验证 V01–V06，加上 V08 的取消配对和 V14 的基本归属；使用可控 Promise、真实本地 HTTP、真实进程/后代与 MCP fixture，不能只验证字段。保留表 3.4 的正常路径证据并补缺口；基线没有需要预先修复的失败。M2 才处理全量结果/校验，M3 才决定权威持久化协议，M4 才完善跨恢复的结果交接；M0 不预选其实现。

后续设计决策必须在对应阶段编码前写清楚：

| 决策                                           | 最迟阶段               | 决策依据                             |
| ---------------------------------------------- | ---------------------- | ------------------------------------ |
| run 状态、结束原因与事件字段的映射             | M0 已冻结；M1 验证     | 第 9.1 节；消费者与终态竞争检查      |
| 取消 interface、资源归属与有限清理预算         | M0 已冻结；M1 验证     | 第 3.2、9.2–9.3 节；真实消费者检查   |
| 子进程终止的平台范围与后代清理能力             | M0 策略已冻结；M1 取证 | 第 9.3 节；未验证平台不声明支持      |
| 工具结构化结果与现有字符串返回的演进方式       | M2                     | 调用方复杂度、错误可分类性及迁移范围 |
| 权威持久化记录、检查点、去重及未知结果核实入口 | M3                     | P1–P5 故障窗口与现有格式兼容性       |
| 异步结果消费与唤醒去重机制                     | M4                     | 存活会话和恢复场景的实际保证范围     |

### 9.6 M1 实施出口与证据边界

用户随后明确授权完成 M1；T005–T020 已实现并通过本机阶段验收，逐项证据保存在 TASKS，不改变第 9.1–9.5 节的行为契约。

- 运行控制表与可序列化记录分离；`AgentRuntime` 是最终运行事件的唯一生产者。`ExecutionScope` 跟踪实际完成而非仅停止等待，直接 loop 与 managed run 共享同 Agent 准入保护。
- headless 使用 `app.agentRuntime` 或在 app 装配时注入相同 runtime；取消已完成父 run 时只停止活动后代。工具装配接受 `StartSubagent`，协调实现位于 `src/core/agent/subagent.ts` 和 `subagentRunner.ts`，旧 tools 协调文件已删除。
- `ExecutionStoppedError` 保留取消/超时及确认信息；字符串成功返回未重构为 M2 的完整结果框架。取消批次已配对，迟到结果不再改写消息；未确认操作实际结束前不释放 Agent 或子代理容量。
- 269 个测试、两套类型检查、lint、format、build 和构建产物消费示例均通过。本地 HTTP 检查穿过真实 pi-ai adapter；进程和 MCP 检查使用真实子进程；TUI 检查使用 80×24、NO_COLOR=1 的实际 Ink PTY，包含关闭失败而非只验证成功快照。
- 当前进程组退出证据仅来自 macOS arm64、Node 24.21.0。Linux 是现有 CI 的后续验证目标，Windows 进程树停止未承诺；未运行线上模型冒烟。旧会话无 cleanup 记录时仍为未记录，不推断已确认。
- 本阶段没有实施 M2 的完整错误分类、M3 的权威持久化/崩溃恢复或 M4 的完整结果交接。关闭的保存超时只报告未确认；不保证撤销文件写入，不自动回滚副作用。

### 9.7 M2 工具契约决策

用户在 M2 入口明确选择“统一结构化结果”，批准 `ToolHandler` 和 `ToolRuntime.invokeTool()` 的返回类型破坏性变更；仓内生产者、消费者、fixture 和示例同次迁移，不保留字符串返回兼容层。M2 范围为 T021–T026，不包含 M3–M5、提交或发布。

- 统一结果为 `{ status, output, stopReason? }`；`stopReason` 在控制结果中保留 `aborted/timeout`。状态沿用生命周期的 `completed`、`blocked`、`permission_denied`、`error`、`cancelled`、`timeout`、`unconfirmed`，增加 `unavailable`、`invalid_input`、`not_executed`。仅 `completed` 映射为模型 `isError: false`；文本不参与分类。MCP 使用协议 `isError`，shell 使用退出码。
- 普通 handler 返回结构化成功或可修正失败。已知可修正异常使用 `ToolExecutionError`；未知异常（包括内部不变量、任务存储错误）以 `ToolInvocationError` 保留原始 cause、工具名和调用身份，上抛终止运行。错误诊断不序列化原始参数或 cause；文件操作的已知路径/I/O 错误是模型可修正结果，任务存储 I/O 故障不是。
- M1 的 `ExecutionStoppedError` 保留为控制传输；handler 返回取消/超时/未确认状态时 runtime 将其转为同一控制异常，不能成为普通失败后继续派发；在消息/事件出口统一映射到上述状态，携带停止原因。批次停止或致命失败时补齐所有调用的错误结果，明确已派发与未派发；迟到结果不覆写。
- 门禁顺序：取消检查 → agent 工具范围 → 管理 `PreToolUse` hook → 工具可用性与参数校验 → 权限规则/用户确认 → 再查取消 → handler。runtime 提供验证后门禁回调供 loop 编排权限；直接调用 runtime 仍是宿主受信入口，不隐式取得 Agent 身份。`PostToolUse` 仅在 handler 已派发且返回普通结果后触发，仍接收展示文本，不据文本判断成功。
- registry 注册时编译 schema，runtime 在唯一派发入口校验，无强制类型转换、默认值注入或无效项过滤。工具中的 schema 负责静态参数约束，handler 只处理动态业务条件。校验反馈只含路径和规则，不回显参数值；整个任务批次的静态参数必须先验证后写入。
- 已检查 pi-ai 1.4.0 的 `validateToolArguments`：它会转换类型、移除 optional null，并在失败时附带完整参数。因此不直接复用该包装器。复用其已有 TypeBox 1.3.27 编译器，声明同版本直接依赖，以 `Check/Errors` 严格校验现有 JSON Schema，不新增另一套引擎。schema 编译失败属于注册故障，不误报模型输入错误。注册方负责提供合法 schema；本阶段不新增 schema 元模式校验或对所有方言的兼容承诺。
- 生命周期和投影使用同一状态类型，新增可选 `dispatched`、`stopReason` 字段（旧记录缺失表示未记录），模型结果 `details` 同步状态和派发事实；报告同步呈现，开始事件仅表示进入门禁而非副作用已发生。

### 9.8 M2 实施出口与证据边界

T021–T026 已完成；逐项测试和命令见 TASKS。结构化结果覆盖内置工具、自定义工具、MCP 和控制异常；校验、权限门禁、消息配对、事件与投影使用同一契约。旧字符串 handler、宽松输入辅助函数和文本前缀分类已删除。

- V07：严格类型、嵌套任务参数、schema 编译失败、权限/管理/范围拒绝、成功错误前缀与无前缀失败、实际 shell 非零退出、真实任务存储故障、cause/调用身份和诊断脱敏。
- V08：成功/拒绝/失败混合批次，取消、超时、停止未确认和致命故障后的完整 tool-call 配对、下一次请求和未派发计数；`PostToolUse` 不为未派发调用触发。
- 真实 stdio MCP 请求超时不会关闭共享连接，结束原因仍为 timeout、远端停止未确认；本地文件、真实进程和 M1 取消回归通过。TypeBox 仅从已有依赖版本提升为直接依赖，没有升级其他依赖。
- 283 个测试、两套类型检查、lint 和格式检查通过；构建后的自定义工具及取消示例实际运行通过。平台仍只按本机 macOS arm64 / Node 24.21.0 取证，未运行线上模型、Linux 或 Windows。
- 本阶段不提供副作用事务、崩溃恢复或跨恢复交付保证，不进入 M3–M5。

### 9.9 M3 持久化与恢复协议

会话的权威记录是现有 `events.jsonl` 的版本 1 日志。域事件仍由 `SessionProjectionStore.record` 产生。每批事件之后追加一条以换行结束的检查点，记录连续序号、事件字节摘要、上下文槽位和摘要，以及主代理是否还有未保存的模型响应。序号确定批次顺序，域事件 ID 在重试时保持不变。检查点确认后才释放内存中的这批事实。

完整 pi-ai 主代理消息保存在两个交替使用的私有 JSON 槽位中。上下文有变化时，先原子替换上一检查点未引用的槽位，再追加并同步日志。上下文相同的检查点可以共用槽位。模型参数、签名、完整工具结果等随消息保存，事件仍只携带必要的执行身份和摘要。恢复只读取最后一个已验证检查点引用的槽位。`session.json`、`conversation.json`、`lead-messages.json` 和 `snapshot.json` 是提交后的派生文件，可通过再次 flush 刷新。

会话写入串行化。追加失败后保留原批次和起始字节位置，重试只补齐与原批次逐字节相符的缺失后缀。遇到不匹配或超长的后缀即报错。检查点失败会阻止当前控制器继续执行。显式 flush 可以确认待写数据，重新打开会话时再根据保存证据判断能否继续。纯 `agentLoop`、未接入持久化的 `AgentRuntime` 和宿主直接派发工具的入口没有会话恢复保证。

底层 `SessionStore.appendEvents()` 保留旧格式写入能力，新版日志会拒绝无检查点的直接追加。嵌入方使用 `SessionController` 对应入口记录新版会话事件，通过 `flush()` 确认保存。

主代理请求模型前保存输入和待响应标记。工具经过范围、参数和权限门禁后，在派发前等待意图写入确认。该检查点同时保存已收到的主代理响应；结果检查点包含完整主代理工具结果及执行结论。子代理和后台工作的创建经过同一门禁，子代理内的工具派发也受保护。模型的最终答复和会话展示消息在轮次结束时一起保存。恢复只使用已经确认的上下文，未保存的模型响应可能需要重新请求。

恢复重放完整检查点之前的域事件，从同一个点恢复消息。完整记录损坏、序号或摘要不符时明确报错。缺少终止换行或检查点的尾部不会纳入恢复，并提示忽略的字节数。首次写入时先保留原日志，再从可信前缀继续。旧格式仅导入会话身份与对话，兼容 pi-ai 和 Anthropic 消息。升级前保留原始文件，历史执行状态不作为安全恢复证据。

没有意图的调用在恢复时补为未执行。已有意图但缺少可靠结果的调用，以及未结算的后台工作与子代理，列为结果未知。保存的工具结果用于补齐模型上下文，无需再次调用。结果未知会阻止后续轮次和自动唤醒。用户可记录核实或放弃，决定写入确认后才移除待处理项。两种处理都保留历史事实，若用户另行请求重做，仍经过正常权限流程。

M3 验收通过 V09–V12。真实子进程覆盖 P4 的五个中断位置，实测旧格式升级、并发和部分写入、截断与损坏诊断，以及 headless 和实际终端的恢复门禁。平台、命令和证据位置见 TASKS T027–T036。异步结果在恢复后的交付由 M4 完善。

### 9.10 M4 异步结果交接与唤醒

沿用同步的子代理准入：容量判断、创建记录和注册执行之间没有异步让出点；满额立即拒绝，不排队。`active` 表示实际执行仍占有资源，与运行记录的逻辑终态分开。停止未确认的工作继续占用槽位，真实执行结束后才允许补位。取消只处理所属 run 的活动工作；父正常完成保留工作，session 关闭覆盖全部所属工作。共享 MCP 连接仍由 app/session 关闭。

inbox 以工作种类和 ID 作为稳定身份，分别保存活动集合和已结算结果。重复 register/settle 不重新打开工作，也不重复通知。结果被交付或被禁止唤醒后仍可通过 `appContext.inbox.getResults()` 检查；`suppress` 不再删除结果，`suppressAll` 同样覆盖后续迟到完成。已有非持久化 `drainNotifications()` 仍表示立即消费，不提供会话保存保证。

controller 默认安装异步结果注入 hook；完整的任务提醒 hooks 仍由原有 `registerRuntimeHooks()` 安装，两者重复安装均无效。结果在主代理下一次模型请求前转为带标签的用户消息；子代理不能消费主代理结果。`hasPendingAsyncWork()` 同时涵盖活动工作和可交付结果，`waitForAsyncWork()` 在出现可交付结果时返回，不必等待其他工作全部结束。

`handleAutoWake()` 在 core 中合并并发请求；忙碌时等待当前轮次，然后重新检查结果、取消、关闭、恢复和写入门禁，不重入主代理。多个结果可在一次请求中交付。没有可交付结果、关闭或对应取消使请求失效时返回 `undefined`，调用方须处理 `SessionAutoWakeResult | undefined`。正常用户轮次仍在改变消息前独占准入。取消当前主运行会使等待中的唤醒失效；取消旧 run 或子代理只抑制其结果，不撤销其他 run 的唤醒。宿主仍显式调用唤醒入口；不新增自主执行定时器或工作队列。

持久化模式下，注入只预留结果；主消息捕获同时记录该上下文包含的结果身份，只有对应检查点确认后才标记交付。另一个已排队的旧上下文 flush 不能确认较新的交接。完整结果、交付标记和唤醒抑制标记与主消息一起写入现有私有检查点槽位，使用 `{ version: 1, messages, asyncResults }` 内容封装；没有异步结果时保留消息数组，加载兼容 M3 的数组槽位。公开 `lead-messages.json` 仍是 pi-ai 消息数组。事件与快照只保存原有摘要，结果消息在投影中只显示标签。

空闲完成也进入同一串行确认流程，事实仍经 `SessionProjectionStore.record`。写入失败保留内存结果并关闭后续派发门禁，等待、后续轮次和关闭会报告保存错误。部分追加可用原有 flush 协议确认重试。恢复只使用最后一个可信检查点：已保存但尚未交付的完整结果可再次注入，已确认交接不重复应用；尚未保存的完成仍按 M3 的未决工作处理，需要核实。恢复后是否再次请求模型取决于已保存的消息和待响应标记，不承诺跨崩溃 exactly-once 模型调用或唤醒。

M4 验收覆盖 V13–V16：并发准入、两个 run 的真实工作隔离、共享 MCP 的两个在途调用、headless 唤醒竞争、写入故障和三处真实进程崩溃交接窗口，以及权限等待子代理、shell、MCP 和完成通知的组合关闭。清理超时保持未确认，重复关闭不重新释放资源，预算内观测到的独立清理和保存错误都保留。超过预算的资源关闭仍只报告未确认，不能把调用方结束等待视为实际资源退出。命令、平台和逐项证据见 TASKS T037–T043。

## 10. 最终完成定义

当范围内的里程碑完成、对应验收场景通过、公共说明与实际行为一致，且没有已知失败反例推翻保证时，本轮完成。

最终交付应能回答：

- 哪些执行状态由谁拥有，为什么这样分工？
- 取消到底停止了什么，哪些操作仍然不确定？
- 哪些事实已经可靠保存，恢复时为什么不会盲目重放副作用？
- 并发工作如何受限、结束、交回结果和释放资源？
- 哪些复杂性由 coil 承担，哪些交给 pi-ai、MCP 或操作系统，依据是什么？

不以新增功能数量、代码行数、抽象层数或替换依赖数量衡量完成度。
