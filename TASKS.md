# Agent runtime 架构优化与可靠性打磨任务清单

状态：M0 已完成，M1–M5 未开始。依据：[SPEC.md](SPEC.md)、[PLAN.md](PLAN.md)。代码基线：`54551bc`。

本次用户授权完成 M0，并允许最多一个并行子代理；实际使用一个只读子代理提供资源路径证据。SPEC 第 9 节默认行为及限定兼容演进已由用户确认。本次不授权 M1 实现、提交或发布，后续任务仍按依赖推进。

## 1. 使用约定

- `SPEC.md` 是行为契约，`PLAN.md` 是阶段顺序与设计方向，本文是细粒度任务状态和验证证据的来源。公共能力说明仍在 `README.md`。
- 按依赖执行；依赖栏中的任务必须完成。阶段验收任务依赖本阶段全部任务，而不只是最后一项。跨阶段不得绕过验收。
- 每项实现任务包含聚焦测试、实现和调用方同步；先建立能拒绝错误实现的预期，再完成修改。只写出失败测试不算实现任务完成。
- 完成后勾选任务，并在该任务下记录简短证据：实际测试文件/用例、已执行命令及结果、仍存在的限制。阻塞项保持未勾选，注明原因；不把未执行写成通过。
- 设计决策写回 SPEC；若改变范围或行为，先评审再更新三份文件。PLAN 只同步阶段汇总，避免重复维护逐项进度。
- 路径是当前代码定位，迁移后更新引用。标为“拟新增”的文件不是现有文件，也不要求为凑文件数量而创建。
- 默认串行推进；多个任务触及相同类型、loop、controller 或存储时不得并行写入。本文不额外授予子代理授权。
- M0 只读源代码，可运行既有检查、更新设计文档，不新增生产代码或测试。后续所有改动遵守 `AGENTS.md`。

### 通用完成门槛

实现任务：完成声明的行为和消费者迁移，相关聚焦检查通过，最终 diff 无无关修改。新的 interface、事件或结果类型必须同步处理调用方与必要 fixture，不能留下永久双轨。

阶段验收统一执行：

```bash
pnpm test
pnpm exec tsc --noEmit
pnpm typecheck:tests
pnpm lint
pnpm format:check
```

最终交付增加 `pnpm build` 和构建产物的实际消费检查。聚焦测试使用 `pnpm exec tsx --test tests/<file>.test.ts`，可以同次指定多个文件。基线失败按相关性分类，影响本阶段保证的失败必须解决或报告阻塞。

真实进程、文件和协议检查不能用纯 mock 替代。竞态使用可控 Promise 或握手信号，真实进程测试设置有限超时并在失败时清理。平台能力以实际证据为准。

## 2. M0：只读审查与设计入口

- [x] **T001 建立实现前基线**
  - 来源：PLAN M0-01；SPEC A2、验证门槛。依赖：无。
  - 范围：`AGENTS.md`、`package.json`、`.github/workflows/ci.yml`、现有测试。
  - 完成条件：核对工作区与指令，执行通用阶段检查，记录通过/失败/未执行及环境条件；将失败区分为本轮相关、既存无关、环境阻塞，不顺手修复。
  - 验证：检查记录包含实际命令、退出结果和失败定位；本任务不以所有基线检查通过为完成条件，但不能隐瞒阻塞。
  - 证据：HEAD 为 `54551bc`；初始仅 `PLAN.md`、`SPEC.md`、`TASKS.md` 为未跟踪用户文件，无已跟踪修改。已读全局和仓库 AGENTS；仓内未发现嵌套 AGENTS。保留三份文件并在其上增量编辑，不暂存或提交。
  - 环境：本机 Darwin arm64、Node `v24.21.0`、pnpm `11.0.9`，已有依赖包含 pi-ai `1.4.0`；未安装/升级依赖，未新增模型凭据。CI 配置为 Ubuntu + Node 22、冻结 lockfile 安装，包含两项类型检查、lint、format、build、test；未执行远端 CI。
  - 实际基线：`pnpm test` 退出 0（237 通过，0 失败/跳过/取消）；`pnpm exec tsc --noEmit` 退出 0；`pnpm typecheck:tests` 退出 0；`pnpm lint` 退出 0；`pnpm format:check` 退出 0。
  - 分类：本轮相关失败、既存无关失败、环境阻塞均无。未执行 `pnpm build`、在线模型冒烟、新取消/进程树/崩溃测试或实际 TUI 检查；这些不属于 M0 基线，不能据本地通过宣称 Linux/Windows 停止能力。

- [x] **T002 绘制六条执行路径与资源所有权图**
  - 来源：PLAN M0-02；SPEC A1。依赖：T001。
  - 范围：`src/core/agent/`、`src/core/loop/`、`src/core/session/`、`src/core/app/context.ts`、`src/core/async/`、工具与 TUI 调用入口。
  - 完成条件：追踪用户消息、自动唤醒、工具、子代理、关闭、恢复；标明可变状态、控制句柄、权限等待、定时器、进程、MCP 连接和待写事件的唯一所有者及转交关系，补入 SPEC。
  - 验证：每条路径可定位到代码；明确谁启动、谁停止、谁确认终态、谁持久化，不只给目录图。
  - 证据：SPEC 第 3.1 节逐条追踪用户消息、自动唤醒、工具、子代理、关闭、恢复；第 3.2 节列出 run/messages、控制句柄、请求、timer、权限、进程、MCP、inbox 和待写事实的现状所有者与 M1 交接。主代理复核源码，唯一只读子代理补充 subagent/background/MCP/inbox 路径，未并行写仓库。
  - 限制：现有实现没有统一取消控制，部分资源没有可回收句柄；图中明确标出缺口，未将目标所有权写成已实现能力。此任务为源码审查，无新增测试。

- [x] **T003 核实架构偏差与测试缺口**
  - 来源：PLAN M0-02；SPEC A2、A3、A4。依赖：T002。
  - 范围：`src/core/tools/subagent/`、`src/core/tools/runtime.ts`、`src/core/agent/lifecycle.ts`、`src/core/session/projection/`、相关测试。
  - 完成条件：复核 SPEC 第 3 节观察；列出确认问题、待验证风险、保留项；明确工具对 Agent 的依赖调整方向及仅验证状态字段的测试缺口。
  - 验证：每项拟重构都有代码证据、受影响契约、最小修改建议和验证方式；不通过放宽架构约束解决偏差。
  - 证据：SPEC 第 3 节原九项观察全部复核；第 3.3 节 R1–R9 给出问题、契约、最小调整与后续任务，第 3.4 节逐项区分既有测试保证和缺口。确认工具依赖 Agent/currentAgent、重复终态、记录中断提前释放槽位、缺 signal、flush 先 drain 等；额外确认子代理未取 parent.allowedTools 交集，纳入原有 T015 权限只收窄要求。
  - 验证方式：源码和既有测试只读交叉检查；T001 全量测试已覆盖现有用例。没有专门运行竞态或故障复现；唤醒遗漏、并发 flush、初始化/关闭竞争、迟到压缩分别标为待验证风险，不声称新增保证通过。

- [x] **T004 确认 M0 结论与 M1 实施契约**
  - 来源：PLAN M0-03；SPEC 第 9 节、L1–L5。依赖：T001、T002、T003。
  - 范围：SPEC 设计决策、PLAN M0 汇总。
  - 完成条件：评审取消范围、满额拒绝及非目标；记录状态映射、取消 interface、清理预算、平台策略和公共兼容方案；冻结 M1 最小重构范围。待确认事项仍未解决时，本任务保持阻塞。
  - 验证：有明确决策依据；基线中影响 M1 的失败有处理安排。此门槛通过不等于自动获得实现授权。
  - 决策证据：用户明确选择“全部采用”“有限清理、按证据声明”“批准限定演进”。SPEC 第 9.1–9.5 节冻结状态/原因/事件映射、取消与辅助请求归属、5 秒共享资源清理及另 5 秒保存预算、TERM/KILL 策略、macOS/Linux 取证目标、公共工厂迁移方案及 M1 最小范围；无未解决的 M0 评审阻塞。
  - 验收：基线五项全过；文档修改后再次执行 `pnpm format:check`，并审查 Markdown 渲染、引用、任务依赖和相对初始文档的差异；只更新三份设计文档，生产代码、测试与 README 未改。PLAN 已同步 M0 出口；T005–T047 保持未完成。
  - 限制：清理预算是获批设计而非实测保证，平台支持和真实取消在 M1 验证；M2/M3/M4 设计决策仍待各阶段入口。当前授权到 M0 为止。

## 3. M1：生命周期与全链路取消

- [ ] **T005 建立受保护的运行状态转换**
  - 来源：PLAN M1-01；SPEC L1、L2、A1；V01、V04。依赖：T004。
  - 范围：`src/core/agent/run.ts`、`src/core/agent/runtime.ts`、`src/core/loop/options.ts`。
  - 完成条件：分开可序列化记录与控制句柄，建立权威终态决策；覆盖完成、取消、超时、失败的先后顺序及重复调用；取消被接受后迟到结果不能改成成功。
  - 验证：扩展 `tests/agent-runtime.test.ts`；显式控制竞争顺序，不以任意 sleep 推断行为。

- [ ] **T006 同步结束原因、事件、投影与报告**
  - 来源：PLAN M1-01；SPEC L1、L2；V01、V04。依赖：T005。
  - 范围：`src/core/agent/lifecycle.ts`、`src/core/loop/response.ts`、session 类型、事件、投影与 `src/core/session/report.ts`。
  - 完成条件：错误、超时、执行限制不误报成功；同一存活 run 只有一个最终运行事件，消费者采用同一语义；删除重复终态写入路径。
  - 验证：`tests/runtime-lifecycle.test.ts`、`tests/session-projection.test.ts`、`tests/session-report.test.ts`，同时保留正常路径回归。

- [ ] **T007 将取消传递到 pi-ai adapter**
  - 来源：PLAN M1-02；SPEC L3、L4；V02。依赖：T006。
  - 范围：`src/core/providers/types.ts`、`src/core/providers/pi.ts`、`src/core/providers/errors.ts`、`src/core/loop/recovery.ts`。
  - 完成条件：核对已安装 SDK 的取消选项，贯通 `AbortSignal`；主动取消与请求失败、超时分开，不进入网络恢复；保留 HTTP 状态、`retry-after` 和单一重试预算。
  - 验证：扩展 `tests/pi-provider.test.ts`、`tests/error-recovery.test.ts`，包含调用前已取消及请求途中取消。

- [ ] **T008 验证真实 adapter 的请求取消**
  - 来源：PLAN M1-02；SPEC 证据层级；V02。依赖：T007。
  - 范围：`tests/pi-provider.test.ts` 或同目录聚焦集成测试、本地 HTTP fixture。
  - 完成条件：通过真实 pi-ai adapter 连接受控本地服务，取消请求并观测连接/请求结束；验证没有后续重试，完整清理服务和连接。
  - 验证：无需模型凭据；不得用替换 `Provider` 或仅断言选项中存在 signal 代替实际消费者验证。不得将本地证据称为线上厂商验证。

- [ ] **T009 取消退避、deadline 与权限等待**
  - 来源：PLAN M1-02；SPEC L3；V03、V04。依赖：T008。
  - 范围：`src/core/loop/loop.ts`、`src/core/loop/deadline.ts`、`src/core/loop/recovery.ts`、`src/core/permission/`。
  - 完成条件：等待可取消、定时器与监听器可清理；实际派发前复查信号；迟到允许不执行工具；超时走清理但保持独立结束原因。
  - 验证：`tests/agent.test.ts`、`tests/error-recovery.test.ts`；计数证明取消后模型、工具、重试调用数不再增加。

- [ ] **T010 纳入压缩和辅助模型请求**
  - 来源：PLAN M1-02；SPEC L3；V03。依赖：T009。
  - 范围：`src/core/providers/text.ts`、`src/core/context/compact.ts`、`src/core/session/controller.ts`、`src/core/session/commands/`。
  - 完成条件：运行内压缩属于对应取消范围；自动命名、手动压缩和 `/ping` 的所有权明确，关闭时不遗留请求；迟到结果不修改已停止工作拥有的消息状态。
  - 验证：压缩相关测试与 `tests/session-controller.test.ts`；比较取消前后消息内容，证明没有迟到覆写。

- [ ] **T011 建立最小工具取消契约**
  - 来源：PLAN M1-03；SPEC L3、L4、T3；V06。依赖：T010。
  - 范围：`src/core/tools/input.ts`、`src/core/tools/runtime.ts`、`src/core/loop/loop.ts`。
  - 完成条件：信号进入 handler；取消、超时等控制结果不被通用 catch 吞成字符串；只引入 M1 所需分类，不提前重写所有工具错误。
  - 验证：拟新增 `tests/tool-cancellation.test.ts`；覆盖协作停止、handler 迟到完成和未派发调用。

- [ ] **T012 实现前台与后台进程的实际清理**
  - 来源：PLAN M1-03；SPEC L4；V05。依赖：T011。
  - 范围：`src/core/tools/file/bash.ts`、`src/core/tools/background/backgroundManager.ts`；拟新增 `tests/process-cancellation.test.ts`。
  - 完成条件：保存句柄，按已决策策略终止、有限等待、必要时升级终止；以实际退出确认收尾；统一重复清理处理，不建立通用调度框架。
  - 验证：真实进程及受管后代 fixture；分别覆盖主动取消、超时、重复取消和终止失败。按 macOS/Linux 实际结果记录支持范围，断言失败也清理 fixture。

- [ ] **T013 处理不可取消工具与共享 MCP 请求**
  - 来源：PLAN M1-03；SPEC L4、C2；V06。依赖：T012。
  - 范围：`src/core/tools/mcp/`、工具运行时、取消测试。
  - 完成条件：不支持取消时返回停止未确认/结果未知，阻止后续派发；不把 Promise 竞争当停止证明；单请求取消不关闭共享连接。
  - 验证：不可取消 handler 的受控迟到结果，以及本地 MCP fixture 中另一在途调用可继续完成。

- [ ] **T014 收尾取消后的 tool-call 上下文**
  - 来源：PLAN M1-03；SPEC T4；V08 的取消部分。依赖：T013。
  - 范围：`src/core/loop/loop.ts`、消息构建与生命周期映射。
  - 完成条件：批次中未派发工具不执行；按 M1 决策补充真实取消结果或安全整理消息；下一次模型调用上下文合法，无伪造成功结果。
  - 验证：`tests/agent.test.ts`、工具取消测试；检查完整消息配对、执行计数及继续对话路径。

- [ ] **T015 调整子代理协调职责与依赖方向**
  - 来源：PLAN M1-04；SPEC A3。依赖：T014。
  - 范围：`src/core/tools/subagent/`、`src/core/app/context.ts`、`src/core/tools/builtins.ts`、agent 及相关 barrel。
  - 完成条件：按 M0 结论移动依赖 Agent 的协调逻辑；工具只依赖注入的启动能力和中立参数；唯一 ALS 绑定点保持不变，loop 无子代理特判；同步调用方后删除旧路径。
  - 验证：`tests/runtime-boundaries.test.ts`、`tests/builtin-tool-ownership.test.ts`、`tests/subagent-runner.test.ts`；补 import 方向检查，验证工具权限只收窄。

- [ ] **T016 贯通后代工作归属、取消与基本容量保护**
  - 来源：PLAN M1-04；SPEC L5、C1、C2、C4；V14 基本路径。依赖：T015。
  - 范围：迁移后的子代理协调模块、后台工作、`src/core/async/asyncWorkInbox.ts`、session 消费者。
  - 完成条件：记录 session/run/父调用归属和完成句柄；取消 run 级联活动后代，正常完成不取消显式异步工作；取消后的结果不唤醒；实际未退出的工作不提前释放槽位。
  - 验证：子代理和 session/controller 测试；同时验证正常完成、显式取消、关闭三种语义，不能只检查记录字段。

- [ ] **T017 提供 headless/controller 取消与幂等关闭入口**
  - 来源：PLAN M1-05；SPEC L5；V01–V06 消费者路径。依赖：T016。
  - 范围：`src/core/session/controller.ts`、`src/core/session/runner.ts`、`src/core/index.ts`、view events。
  - 完成条件：区分停止等待、取消 run、关闭 session；关闭先拒绝新工作，有限收尾，再关闭共享连接并保存；保留重要清理错误，不因 finally 覆盖原始失败。
  - 验证：`tests/session-controller.test.ts`；通过公开入口检查重复关闭、关闭期间请求、停止未确认与多个清理失败，不访问内部 Map 驱动行为。

- [ ] **T018 接入现有 TUI 的取消和关闭状态**
  - 来源：PLAN M1-05；SPEC G6、L5。依赖：T017。
  - 范围：`src/tui/useSession.ts`、`src/tui/sessionActions.ts`、`src/tui/permissionBridge.ts`、`src/tui/components/App.tsx` 和相关展示组件。
  - 完成条件：仅使用 controller/view events；明确显示正在停止、已停止、停止未确认和关闭失败；保留停止等待的独立行为，不重设计界面。
  - 验证：TUI actions、permission bridge、组件测试及实际终端检查；覆盖权限、运行和等待阶段、80 列及无颜色呈现。

- [ ] **T019 提供第一版取消演示与使用说明**
  - 来源：PLAN M1-06；SPEC G6。依赖：T018。
  - 范围：拟新增 `examples/cancel-run.ts`、`README.md`。
  - 完成条件：无凭据演示启动受控工作、取消、退出确认；说明范围、平台、停止未确认和不回滚副作用；临时 workspace 不影响用户文件。
  - 验证：实际执行示例并核对输出；不宣称 M3/M4 尚未实现的保证。

- [ ] **T020 M1 阶段验收**
  - 来源：PLAN M1-06；SPEC V01、V02、V03、V04、V05、V06。
  - 依赖：T005、T006、T007、T008、T009、T010、T011、T012、T013、T014、T015、T016、T017、T018、T019。
  - 完成条件：全部 M1 契约和实际消费者证据齐备，执行通用阶段检查，复查 diff；不存在端到端取消依赖 M2/M4 才能工作的情况。
  - 验证：记录各 V 编号对应测试及平台结果，更新 PLAN M1 汇总。至此可形成独立求职展示版本。

## 4. M2：工具执行契约

- [ ] **T021 决定工具结果与校验职责的演进方案**
  - 来源：PLAN M2-01；SPEC T1、T2、A4。依赖：T020。
  - 范围：`src/core/tools/types.ts`、`src/core/tools/input.ts`、`src/core/tools/registry.ts`、已有依赖与工具 schema。
  - 完成条件：把结果分类、模型侧映射、校验位置、hook/权限顺序及公共兼容方案写回 SPEC；先评估现有能力，不预选新验证库或自制完整 schema 引擎。
  - 验证：覆盖内置工具、自定义工具、MCP 和 M1 控制结果的映射；破坏性变更先确认。

- [ ] **T022 实现结构化执行结果并统一调用方**
  - 来源：PLAN M2-01；SPEC T1；V07。依赖：T021。
  - 范围：工具类型、runtime、内置工具组、`src/core/tools/mcp/handler.ts`、loop 消费端、`examples/custom-tool.ts`。
  - 完成条件：成功、不可用、无效输入、拒绝、失败、取消、超时、停止未确认可区分；生产者和消费者同次迁移；不靠 `Error:` 前缀控制执行。
  - 验证：工具注册、MCP provider 和 loop 测试；普通输出含 `Error:` 不应误分类，真实失败不因文本缺少前缀而误报成功。

- [ ] **T023 实现单一参数校验与执行门禁顺序**
  - 来源：PLAN M2-01；SPEC T2；V07。依赖：T022。
  - 范围：registry/runtime、工具输入、hooks、permission 和子代理 profiles。
  - 完成条件：无效参数不执行 handler；工具范围、管理阻止与权限规则全部保留，子代理权限不扩大；返回可修正诊断而非模糊失败。
  - 验证：拟新增 `tests/tool-runtime.test.ts` 或扩展现有测试，使用 handler 副作用计数验证拒绝、无效输入与授权顺序。

- [ ] **T024 区分普通工具错误与致命故障**
  - 来源：PLAN M2-02；SPEC T3；V07。依赖：T023。
  - 范围：`src/core/tools/errors.ts`、`src/core/tools/file/bash.ts`、runtime/loop 错误传播和报告。
  - 完成条件：模型可修正错误可反馈；取消、内部不变量和存储故障不吞成普通结果；保留 cause 与调用身份；shell 非零退出即使有输出也不能成功。
  - 验证：不同错误分类及进程非零退出用例；诊断保留必要信息但不泄露凭据。

- [ ] **T025 完善失败批次的上下文与事件关联**
  - 来源：PLAN M2-02；SPEC T4；V08。依赖：T024。
  - 范围：`src/core/loop/loop.ts`、`src/core/loop/response.ts`、生命周期和投影。
  - 完成条件：覆盖批次中成功、拒绝、失败、取消的组合；未执行调用可识别，消息配对合法；M1 最小分类并入统一契约，无双轨遗留。
  - 验证：`tests/agent.test.ts`、`tests/runtime-lifecycle.test.ts`；断言下一次请求的完整消息和实际工具调用次数。

- [ ] **T026 M2 阶段验收**
  - 来源：PLAN M2-01、M2-02；SPEC V07、V08。
  - 依赖：T021、T022、T023、T024、T025。
  - 完成条件：工具契约和消费者迁移完成，通用阶段检查及 M1 回归通过；更新 PLAN M2 汇总。
  - 验证：自定义工具示例仍可用，既有 MCP 和权限路径无回退，最终 diff 无文本分类控制分支残留。

## 5. M3：持久化与安全恢复

- [ ] **T027 定义持久化协议与恢复证据**
  - 来源：PLAN M3-01；SPEC P1、P3、P4、P5。依赖：T026。
  - 范围：session 类型、事件、projection、store、controller。
  - 完成条件：在 SPEC 写清权威记录、完整 pi-ai 消息证据、事件身份/顺序、检查点、格式版本、flush 确认与恢复算法；区分纯 headless 非持久化和 session 持久化保证。
  - 验证：逐一推演 P4 五个故障窗口和旧格式输入；不能将摘要型 lifecycle 事件当成完整消息备份，不引入数据库。

- [ ] **T028 实现最小记录格式与故障测试入口**
  - 来源：PLAN M3-01；SPEC P3、P5；V09、V12。依赖：T027。
  - 范围：`src/core/session/types.ts`、`src/core/session/sessionEvents.ts`、`src/core/session/store/`、现有 store/projection 测试。
  - 完成条件：实现已决策的元数据和兼容加载；建立明确的追加失败、部分成功、快照失败同步点及临时目录 fixture；不扩大公共 interface 只为测试内部状态。
  - 验证：完整消息与执行证据可往返，旧 fixture 可读，原始文件保留；测试入口能稳定触发约定故障点。

- [ ] **T029 建立可等待且失败可见的持久化确认契约**
  - 来源：PLAN M3-02；SPEC P2、T3；V09。依赖：T028。
  - 范围：通用 runtime/loop 契约、`src/core/agent/lifecycle.ts`、session 装配与事件入口。
  - 完成条件：必要确认和观察通知分开；确认可等待、失败可上抛，不走 `safeEmitRuntimeLifecycle()` 吞错路径；事实仍经 `SessionProjectionStore.record`，loop 不导入 Session/store。
  - 验证：注入确认失败时调用者收到原始故障；UI 观察者失败仍不改变执行；无旁路事件日志。

- [ ] **T030 让副作用派发等待意图保存**
  - 来源：PLAN M3-02；SPEC P2、P4；V09、V10。依赖：T029。
  - 范围：工具派发、session 持久化装配、子代理与后台启动消费者。
  - 完成条件：意图可靠记录后才启动副作用，结果写入确认后才报告已保存；确认失败停止后续派发；子代理/后台创建同样覆盖，不把内存记录当持久化。
  - 验证：故障注入检查文件写、进程启动、子代理启动计数；意图写失败必须为零，结果写失败不重跑工具或报告安全保存。

- [ ] **T031 实现有序 flush、失败保留与重复识别**
  - 来源：PLAN M3-03；SPEC P1、P2、P3；V09、V11。依赖：T030。
  - 范围：`src/core/session/controller.ts`、`src/core/session/projection/projectionStore.ts`、`src/core/session/store/sessionStore.ts`。
  - 完成条件：串行化写入确认，确认后释放待写事实；并发 flush 不以旧快照覆盖新状态；部分追加需检测已写前缀或保守阻塞，不盲目重发整个批次。
  - 验证：重复/并发 flush、追加成功快照失败、追加结果不确定等测试；检查稳定事件身份、恢复点和错误可见性，保留失败现场。

- [ ] **T032 从一致性点恢复并诊断损坏**
  - 来源：PLAN M3-04；SPEC P3；V10、V12。依赖：T031。
  - 范围：store 加载、纯投影、`src/core/session/controller.ts`。
  - 完成条件：依据已决策权威记录重建；区分尾部截断和中部损坏；只能恢复可信前缀时提示缺失范围，不能恢复则明确失败；不拼接不同代文件为成功状态。
  - 验证：临时目录中制造事件、消息与快照不一致，验证恢复点与诊断；不覆盖原始损坏数据。

- [ ] **T033 提供未知结果核实与继续入口**
  - 来源：PLAN M3-04；SPEC P4；V10。依赖：T032。
  - 范围：session/controller、命令入口、view events、最小 TUI 交互。
  - 完成条件：未决副作用阻止自动继续/唤醒；用户可核实或放弃，重新执行再次经过权限；不靠重新打开会话触发重跑，不从工具描述推断幂等性。
  - 验证：headless 与 TUI 路径均能识别未知状态；各处理选择及拒绝重新授权有测试，终端实际呈现与状态一致。

- [ ] **T034 验证旧会话的兼容与保证降级**
  - 来源：PLAN M3-04；SPEC P5；V12。依赖：T033。
  - 范围：`src/core/session/store/legacyMessages.ts`、session 加载、`tests/session-legacy-migration.test.ts`、`tests/tui-resume.test.ts`。
  - 完成条件：pi-ai 与 legacy transcript fixture 可读；缺少执行证据时仅恢复对话并说明限制；不删除旧会话、不把未知状态归为成功。
  - 验证：测试原始数据不被静默改变，继续对话仍遵守权限和消息契约。

- [ ] **T035 运行真实进程崩溃窗口测试**
  - 来源：PLAN M3-04；SPEC P4；V10、V11、V12。依赖：T034。
  - 范围：拟新增 `tests/session-crash-recovery.test.ts`、TypeScript 子进程 fixture、临时 workspace。
  - 完成条件：在意图保存前、意图后未确认开始、副作用后结果保存前、结果保存后快照前、模型响应保存前五个同步点中断进程并恢复。
  - 验证：副作用标记或计数证明已保存结果不重跑、未知结果不自动执行；所有测试有限时并清理自建进程和临时文件，不以 mock 抛错代替崩溃。

- [ ] **T036 M3 阶段验收**
  - 来源：PLAN M3-01、M3-02、M3-03、M3-04；SPEC V09、V10、V11、V12。
  - 依赖：T027、T028、T029、T030、T031、T032、T033、T034、T035。
  - 完成条件：通用阶段检查和前阶段回归通过，记录实际恢复保证与限制；更新 PLAN M3 汇总。
  - 验证：完整执行真实崩溃演示；没有靠吞错、清理旧数据、降低验收标准得到的成功结果。

## 6. M4：异步工作可靠性

- [ ] **T037 完善并发准入与停止中容量占用**
  - 来源：PLAN M4-01；SPEC C1；V13。依赖：T036。
  - 范围：迁移后的子代理协调模块及工作状态记录。
  - 完成条件：容量判断和启动注册不可交错；满额明确拒绝，不新增排队；实际执行未结束不释放槽位；停止未确认的后续准入策略写清并落实。
  - 验证：`tests/subagent-runner.test.ts`；并发启动、停止中再启动、实际结束后再启动及正常完成均有测试。

- [ ] **T038 验证工作隔离与共享资源归属**
  - 来源：PLAN M4-01；SPEC L5、C2；V14、V16。依赖：T037。
  - 范围：run/session 归属、后台工作、`src/core/app/context.ts`、MCP 客户端。
  - 完成条件：取消目标 run 只影响其活动后代；正常父完成保留异步工作；session 关闭覆盖全部所属工作；单 MCP 请求取消不关闭共享连接。
  - 验证：两个不同 run 的在途工作与本地 MCP 并发调用；验证真实活动状态，而不只比较任务记录。

- [ ] **T039 实现异步结果的一次结算与消费保护**
  - 来源：PLAN M4-02；SPEC C3、C4；V15、V16。依赖：T038。
  - 范围：`src/core/async/asyncWorkInbox.ts`、子代理/后台结算、`src/core/hooks/runtimeHooks.ts`。
  - 完成条件：稳定身份防止重复入队、重复消费；活动工作集合和待消费结果分开；子代理失败是可关联结果，不产生未处理拒绝。
  - 验证：`tests/async-work-inbox.test.ts`、子代理测试，覆盖重复回调、多工作同时完成、失败及迟到结果。

- [ ] **T040 将非重入唤醒策略落实到 core**
  - 来源：PLAN M4-02；SPEC C3；V15。依赖：T039。
  - 范围：`src/core/session/controller.ts`、`src/core/session/runner.ts`、`src/tui/sessionActions.ts`。
  - 完成条件：主运行准入和唤醒去重不依赖 TUI；忙碌期间不重入，多结果可合并唤醒；取消/关闭后不唤醒，被保留结果仍可检查。
  - 验证：使用 headless controller 模拟同时到达的用户请求和结果通知，断言执行并发、消息及唤醒次数；保留 TUI 回归。

- [ ] **T041 将异步结果交接纳入持久化确认**
  - 来源：PLAN M4-02；SPEC C3、P3、P4；V15。依赖：T040。
  - 范围：inbox、消息注入 hooks、session 持久化和恢复。
  - 完成条件：结果从队列转入消息到确认保存的全过程遵循 M3 协议；drain 后、消息保存前出错不能静默丢结果；恢复的去重与未决范围明确。
  - 验证：在交接各同步点故障注入并恢复，检查结果既不丢失也不重复应用；不宣称跨崩溃 exactly-once 唤醒。

- [ ] **T042 验证关闭与组合故障**
  - 来源：PLAN M4-03；SPEC C4、L5；V14、V16。依赖：T041。
  - 范围：session/controller、子代理、后台进程、MCP、对应集成 fixture。
  - 完成条件：同时包含权限等待子代理、运行中的 shell、共享 MCP 与完成通知时，重复关闭、清理超时、迟到完成、写入失败均能收尾且不伪报成功。
  - 验证：有限超时下检查一次终态、真实资源状态、重要错误保留和无意外唤醒；失败后清理测试自身资源。

- [ ] **T043 M4 阶段验收**
  - 来源：PLAN M4-01、M4-02、M4-03；SPEC V13、V14、V15、V16。
  - 依赖：T037、T038、T039、T040、T041、T042。
  - 完成条件：通用阶段检查与 M1/M3 回归通过，更新 PLAN M4 汇总，异步工作管理没有新增隐式队列或双重状态所有者。
  - 验证：每项 V 均有实际测试入口，M1 基本取消和 M3 恢复保证未回退。

## 7. M5：交付与工程展示

- [ ] **T044 完善无凭据演示和既有示例**
  - 来源：PLAN M5；SPEC G6。依赖：T043。
  - 范围：`examples/headless-agent.ts`、`examples/custom-tool.ts`、拟新增 `examples/cancel-run.ts`、`examples/recover-session.ts`。
  - 完成条件：既有示例兼容当前 interface；取消和恢复演示使用 scripted provider、真实本地进程和临时目录；未知副作用需要核实，不自动重跑。
  - 验证：实际运行新演示且无凭据依赖；已有真实模型示例如缺凭据，明确未验证范围，并用构建产物的无凭据消费检查验证公共 interface。

- [ ] **T045 检查公共导出、懒配置与构建消费**
  - 来源：PLAN M5；SPEC A3、兼容性要求。依赖：T044。
  - 范围：各 `index.ts`、`src/core/index.ts`、配置模块、构建产物和示例。
  - 完成条件：只暴露必要 interface、core 无 UI 依赖；缺少模型配置时 import 不失败，首次使用仍按约定报错；所有新增目录有正确 barrel，无新增手写 `.js` 源码。
  - 验证：`pnpm build` 后通过公共导出运行无凭据消费者；相关边界与 startup 测试通过，不能仅以源码测试代替构建集成。

- [ ] **T046 更新公共说明并核对规格声明**
  - 来源：PLAN M5；SPEC G6、最终完成定义。依赖：T045。
  - 范围：`README.md`、SPEC 设计决策与限制、PLAN 阶段汇总。
  - 完成条件：说明模块职责、嵌入方式、取消/恢复语义、已验证平台、迁移方式与限制；只描述有证据的能力，不宣称沙箱、自动回滚或跨系统 exactly-once。
  - 验证：按 README 顺序复查命令、输出和示例；检查日志与素材不含凭据或用户数据，文档和实现一致。

- [ ] **T047 完成最终验收与范围审查**
  - 来源：PLAN M5；SPEC V01–V16、最终完成定义。
  - 依赖：T020、T026、T036、T043、T044、T045、T046。
  - 完成条件：通用阶段检查、构建、相关示例、真实终端检查全部按范围完成；审查最终 diff，无遗留重复路径、无关修改或未披露阻塞；更新 PLAN M5 汇总。
  - 验证：逐项核对下一节映射，留下实际证据位置，区分通过/失败/未执行。不得自动提交、推送或发布；有已知反例时保持本任务未完成。

## 8. 验收追踪与阶段出口

| SPEC 验收 | 主要任务               | 阶段出口           |
| --------- | ---------------------- | ------------------ |
| V01       | T005、T006、T017       | T020，后续阶段回归 |
| V02       | T007、T008             | T020               |
| V03       | T009、T010             | T020               |
| V04       | T005、T006、T009       | T020               |
| V05       | T012、T016、T017       | T020               |
| V06       | T011、T013、T017       | T020               |
| V07       | T022、T023、T024       | T026               |
| V08       | T014、T025             | T026               |
| V09       | T028、T029、T030、T031 | T036               |
| V10       | T030、T032、T033、T035 | T036               |
| V11       | T031、T035             | T036               |
| V12       | T028、T032、T034、T035 | T036               |
| V13       | T016、T037             | T043               |
| V14       | T016、T038、T042       | T043               |
| V15       | T039、T040、T041       | T043               |
| V16       | T038、T039、T042       | T043               |

架构要求 A1–A4 由 T002–T004 建立依据，T005、T015、T021、T027、T029、T045 落实，所有阶段出口复查。每项重构仍需说明具体依据，不能因为任务存在就自动扩大实现范围。

| 阶段 | 任务范围  | 出口 | 当前状态 |
| ---- | --------- | ---- | -------- |
| M0   | T001–T004 | T004 | 已完成   |
| M1   | T005–T020 | T020 | 未开始   |
| M2   | T021–T026 | T026 | 未开始   |
| M3   | T027–T036 | T036 | 未开始   |
| M4   | T037–T043 | T043 | 未开始   |
| M5   | T044–T047 | T047 | 未开始   |

M0 的 T001–T004 已完成，证据见各任务及 SPEC 第 3、9 节。下一项为 T005；开始 M1 需获得该阶段实施授权。本次未新增生产代码或测试，未提交、推送或发布。
