# Agent runtime 架构优化与可靠性打磨实施计划

状态：M0、M1 已完成，M2–M5 未开始。依据：[SPEC.md](SPEC.md)。代码基线：`54551bc`。

本文件是内部实施计划，描述工作顺序、预期修改范围和验证方式，不替代规格。M0 已完成只读审查、基线检查及设计评审；本次按用户新增授权完成 M1，实现契约与平台限制见 SPEC 第 9 节。M2–M5、提交和发布不在本次授权内。

## 1. 执行原则

- 先完成 M0，再以“生命周期与取消”为第一个纵向交付；不先做全仓重构。
- 架构调整必须服务于具体任务。每项调整说明当前问题、目标 interface、删除的重复职责和验证方式；无证据的问题不进入改动范围。
- 每个里程碑保持项目可运行，调用方、事件、持久化类型、示例和测试同步演进。
- `SPEC.md` 记录行为契约与设计决策，本文记录阶段顺序与汇总，[TASKS.md](TASKS.md) 记录细粒度任务状态和验收证据位置，`README.md` 记录已实现的公共能力。不重复维护逐项进度或另建报告体系。
- 下文路径是当前实现的定位，不是强制保留的目录方案。新测试或示例路径均标为“拟新增”，最终命名遵循实际模块职责。
- 继续使用 pnpm、pi-ai、自研 loop、Ink 和本地文件存储；不自动升级依赖或引入替代框架。
- 默认串行实施。独立测试准备可以并行，但共享类型、loop、controller 和存储契约的修改必须有序；本文不构成子代理委派授权。

## 2. 阶段顺序与依赖

```text
M0 只读架构审查与实施前决策
 └─ M1 生命周期、全链路取消、客户端接入
     └─ M2 工具执行契约
         └─ M3 持久化与安全恢复
             └─ M4 异步工作管理
                 └─ M5 示例、文档与交付验证
```

| 阶段 | 主要产物                                            | 退出条件                                           |
| ---- | --------------------------------------------------- | -------------------------------------------------- |
| M0   | 职责与资源所有权图、证据清单、首轮重构范围          | A1–A4 有落实方案；规格默认行为明确；基线失败已分类 |
| M1   | 可以真实取消的运行、必要架构调整、headless/TUI 接入 | V01–V06 通过；最小演示可运行；不伪报执行停止       |
| M2   | 统一的工具结果、参数校验与错误传播契约              | V07–V08 通过；M1 回归通过                          |
| M3   | 有明确恢复点的写入与恢复流程                        | V09–V12 通过；未知副作用不自动重放                 |
| M4   | 可靠的并发准入、结果交付与关闭                      | V13–V16 通过；运行记录与实际执行状态一致           |
| M5   | 可复现示例、准确 README、完整验证证据               | 全部范围内验收通过；构建产物可被实际消费           |

M1 必须包括子代理与后台工作的基本归属、取消传播、收尾和唤醒抑制。M4 是这些机制的进一步打磨，不能成为 M1 的隐藏依赖。

M1 也必须完成取消所需的最小控制结果分类和上下文整理；M2 再统一所有工具错误，不能把取消后的合法对话推迟到 M2。

## 3. M0：只读架构审查

### M0-01 建立基线

- [x] 检查工作区状态、适用指令、当前依赖与 CI；保留用户已有修改。
- [x] 运行第 9 节的实现基线检查，分别记录通过、失败和未执行项。
- [x] 将失败分为本轮相关、既存无关、环境阻塞；不为清零检查顺手修复无关问题。

交付：在本文更新简短基线结论，附失败测试名或命令，不提交完整运行日志。无关失败不必阻断所有准备，但影响验收的失败必须处理或明确阻塞。

### M0-02 核实职责、执行路径和资源归属

检查范围：

- `src/core/agent/`、`src/core/loop/`、`src/core/session/controller.ts`、`src/core/session/runner.ts`。
- `src/core/app/context.ts`、`src/core/tools/runtime.ts`、`src/core/tools/subagent/`、`src/core/tools/background/`。
- `src/core/async/asyncWorkInbox.ts`、`src/core/hooks/runtimeHooks.ts`。
- `src/core/session/projection/`、`src/core/session/store/`、`src/tui/sessionActions.ts`。

任务：

- [x] 追踪用户消息、自动唤醒、工具调用、子代理、关闭、恢复六条路径。
- [x] 标明 run 状态、控制句柄、子进程、定时器、权限等待、MCP 连接和待写事件的所有者。
- [x] 逐项复核 SPEC 第 3 节观察，区分确认问题、待验证风险和保留现状。
- [x] 检查工具目录依赖 `Agent`、`currentAgent` 的位置，并提出符合单向依赖规则的最小调整。
- [x] 检查现有测试是否验证真实执行而不仅是状态字段，列出必要补充。

交付：把所有权图和有证据的结论补入 `SPEC.md`；每项重构关联条款和受影响路径。不以类数量或目录结构直接判定问题。

### M0-03 确认默认行为与实施设计入口

- [x] 评审 SPEC 第 9 节的取消范围、满额拒绝策略和非目标；尚未确认时，不把它们写成已批准决策。
- [x] 记录 M1 的状态映射、取消 interface、清理预算及进程支持平台。
- [x] 说明计划修改的公共导出及兼容策略；仅内部变化无需制造兼容层。

M0 只读源代码，不添加生产代码或新测试。M0 结束后，已获授权范围内的常规实现不需逐任务重复批准；改变规格行为、扩大范围或超出已确认公共兼容调整时另行确认。

M0 出口汇总：本机 macOS arm64、Node 24.21.0、pnpm 11.0.9 下，237 个测试、src/test 类型检查、lint、format 均通过，无基线失败或环境阻塞。SPEC 第 3.1–3.4 节已补齐六条路径、资源所有权、R1–R9 重构依据和测试缺口。用户已确认默认行为、有限清理预算/平台策略及限定 interface 演进，M1 最小范围冻结于 SPEC 第 9.1–9.5 节。检查命令、限制和授权记录以 TASKS T001–T004 为准；本轮仅修改三份设计文档。

## 4. M1：生命周期与全链路取消

### M1-01 确立单一运行控制与终态决策

依赖：M0。对应：L1、L2、A1–A4；验证：V01、V04。

主要范围：`src/core/agent/run.ts`、`src/core/agent/runtime.ts`、`src/core/loop/options.ts`、`src/core/agent/lifecycle.ts`，及 session 事件和投影消费者。

- [x] 先补终态竞争测试：正常完成先到、取消先到、超时先到、重复取消、迟到异常。
- [x] 将执行中控制句柄与可序列化运行记录分开；取消控制器不写入持久化数据。
- [x] 确定一个权威终态决策位置；loop 报告结果，外围不再分别覆盖相同 run 的终态。
- [x] 映射错误、超时和达到限制等结束原因，不把所有正常返回归为成功。
- [x] 同步事件类型、投影、报告和公开导出；同一存活 run 只发布一次最终运行事件。

优先扩展 `tests/agent-runtime.test.ts`、`tests/runtime-lifecycle.test.ts`、`tests/session-projection.test.ts`、`tests/session-report.test.ts`。

### M1-02 贯通模型、退避、权限与辅助请求的取消

依赖：M1-01。对应：L3、L4；验证：V02、V03、V04。

主要范围：`src/core/providers/types.ts`、`src/core/providers/pi.ts`、`src/core/providers/text.ts`、`src/core/loop/loop.ts`、`src/core/loop/deadline.ts`、`src/core/loop/recovery.ts`、`src/core/context/compact.ts`、`src/core/permission/`。

- [x] 用 `AbortSignal` 贯通调用上下文；核对已安装 pi-ai 的实际选项，不凭印象适配。
- [x] 区分主动取消、超时与 provider 请求失败；保留 HTTP 状态和 `retry-after`，继续由 coil 控制重试预算。
- [x] 将重试等待、权限等待和 deadline 接入取消与清理；在模型和工具实际派发前检查信号。
- [x] 取消后不触发重试、降级或压缩补救；迟到权限答复不得派发工具。
- [x] 让运行内压缩请求接收同一取消范围；检查自动命名、手动压缩和 `/ping` 的生命周期归属，session 关闭时不遗留辅助请求。
- [x] 防止已停止的压缩或模型请求迟到后继续修改消息状态；不能仅结束调用方等待。

测试：扩展 `tests/pi-provider.test.ts`、`tests/error-recovery.test.ts`、`tests/agent.test.ts`、压缩相关测试。增加可控本地 HTTP 集成检查，穿过真实 pi-ai adapter 观察请求取消；fake provider 仅用于 loop 契约测试。

### M1-03 建立工具取消与实际进程清理

依赖：M1-01、M1-02。对应：L3、L4、T3、T4；验证：V05、V06，并提前覆盖 V08 的取消部分。

主要范围：`src/core/tools/input.ts`、`src/core/tools/runtime.ts`、`src/core/tools/file/bash.ts`、`src/core/tools/background/backgroundManager.ts`、`src/core/tools/mcp/`。

- [x] 将信号传至工具 handler；运行取消和系统控制错误不能被通用 catch 转成普通工具错误。
- [x] 保存前台与后台进程句柄，采用共享的实际进程管理逻辑时保持 interface 小而明确，不泛化为任务平台。
- [x] 实现终止请求、有限等待、必要的升级终止与最终退出确认；记录清理失败或停止未确认。
- [x] 使用受控进程 fixture 验证进程及所声明支持的后代清理策略。不得只断言 `interrupted` 字段或发送过 kill。
- [x] 对不支持取消的工具和远端 MCP 操作保守报告，限制继续派发；取消一个 MCP 请求不关闭共享连接。
- [x] 为未执行和已中断的 tool calls 确定合法的消息收尾，取消后可以继续对话，不伪造成功结果。

拟新增 `tests/tool-cancellation.test.ts`、`tests/process-cancellation.test.ts`；fixture 使用 TypeScript 或现有工具支持的形式，不新增手写 `.js`。每个测试负责回收自身进程，即使断言失败也执行清理。

### M1-04 调整子代理协调位置，补齐基本取消范围

依赖：M1-01 至 M1-03。对应：A3、L5、C2、C4；验证：V05、V06 和 V14 的基本传播路径。

主要范围：`src/core/tools/subagent/`、`src/core/tools/builtins.ts`、`src/core/app/context.ts`、`src/core/agent/`、`src/core/tools/background/`。

- [x] 按 M0 结论把依赖 `Agent` 的子代理创建与运行协调放到允许依赖 agent 的位置，工具只依赖注入的启动能力及中立参数。
- [x] 保持 `agentLoop` 是唯一 ALS 绑定点；不得通过工具运行时重新绑定身份，也不向 loop 增加子代理特判。
- [x] 为活动子代理和后台工作记录 run/session 归属与完成句柄，使显式取消可以级联到相应后代。
- [x] 保留父 run 正常结束后的异步执行；取消 run 或关闭 session 时抑制相关自动唤醒。
- [x] 先实现基本容量保护：实际执行尚未结束的工作不能因“逻辑中断”立即释放槽位。
- [x] 删除被新所有权替代的重复终态写入路径，同时更新 barrel、工具装配、profiles 和调用方。

测试：`tests/subagent-runner.test.ts`、`tests/runtime-boundaries.test.ts`、`tests/builtin-tool-ownership.test.ts`、`tests/session-controller.test.ts`。补充真实 import 方向检查，不靠放宽断言绕过约束。

### M1-05 接入 session、headless 与现有 TUI

依赖：M1-01 至 M1-04。对应：L5、G6；验证：V01–V06 的消费者路径。

主要范围：`src/core/session/controller.ts`、`src/core/session/runner.ts`、`src/core/session/viewEvents.ts`、`src/tui/useSession.ts`、`src/tui/sessionActions.ts`、`src/tui/permissionBridge.ts`、`src/tui/components/App.tsx`、`src/core/index.ts`。

- [x] 对外区分停止等待、取消 run、关闭 session；不把现有等待中断偷偷改成执行取消。
- [x] headless 入口和 controller 使用同一取消机制，不暴露内部 Map 或可变 run 供调用者修改。
- [x] 关闭时先拒绝新工作，执行取消与有限收尾，再关闭共享工具连接并保存状态；重复关闭不重复释放。
- [x] 保留并发收尾中的全部重要错误，不能因 finally 中另一异常掩盖原始失败。
- [x] TUI 仅消费 controller 和 view events，准确显示正在停止、已停止、停止未确认及关闭失败；不做视觉重设计。
- [x] 用现有框架验证等待、权限弹窗、执行和关闭阶段的按键行为，不由 UI 直接控制 loop。

测试：扩展 session/controller、TUI actions、permission bridge 和组件测试；实际运行终端检查新状态，覆盖 80 列及无颜色场景。

### M1-06 交付第一个可展示版本

- [x] V01–V06 及相关回归通过，第 9 节阶段检查完成。
- [x] 提供无凭据取消示例，拟新增 `examples/cancel-run.ts`：启动受控工作、发起取消、打印结果与清理确认。
- [x] 在 README 记录取消范围、已验证平台、未确认状态与“不回滚副作用”的限制。
- [x] 审查最终 diff，确保没有遗留两套状态所有者或误扩展范围。

M1 可以独立用于工程展示，但不声称 M3 的崩溃恢复或 M4 的完整交付语义已实现。

M1 出口汇总：T005–T020 已完成。runtime 统一终态与取消；信号贯通模型、压缩、权限、工具及辅助请求；子代理协调迁至 agent 层，前后台进程按私有进程组清理，MCP 单调用取消保留共享连接。269 个测试、src/test 类型检查、lint、format、build 和通过 dist 公共导出的无凭据示例均通过。已在 macOS arm64/Node 24.21.0 验证真实 HTTP、进程/后代和 MCP；80×24、NO_COLOR=1 的真实 Ink PTY 检查覆盖取消、仅停止等待、停止未确认和关闭失败。Linux 仍待 CI 取证，未声明 Windows 进程树或线上模型保证。逐项证据与限制以 TASKS T005–T020 为准。

## 5. M2：工具执行契约

### M2-01 统一结果与参数校验

依赖：M1。对应：T1、T2；验证：V07。

主要范围：`src/core/tools/types.ts`、`src/core/tools/input.ts`、`src/core/tools/runtime.ts`、`src/core/tools/registry.ts`、各工具组、`src/core/tools/mcp/handler.ts`。

- [ ] 明确成功、不可用、输入无效、拒绝、失败、取消、超时、停止未确认的内部表示及模型侧映射。
- [ ] 先检查现有 schema 和依赖能否支持所需验证，明确单一校验责任；不直接新增验证库或自制完整 JSON Schema 引擎。
- [ ] 统一内置工具与 MCP adapter 的结果；迁移时更新所有调用方，包括 `examples/custom-tool.ts`。
- [ ] 无效输入不得执行 handler；保留 hooks、工具范围限制和权限检查的既有阻止规则。
- [ ] 删除以 `Error:` 文本前缀控制执行的分支；文本只用于展示或模型反馈。

### M2-02 明确错误传播与上下文一致性

依赖：M2-01。对应：T3、T4；验证：V07、V08。

主要范围：`src/core/loop/loop.ts`、`src/core/loop/response.ts`、`src/core/tools/errors.ts`、生命周期事件、session 投影与报告。

- [ ] 区分模型可修正错误与 runtime 不变量、持久化等致命故障，保留 cause 与调用身份。
- [ ] 检查 shell 非零退出且有输出的情况，不能因存在 stdout/stderr 就映射为成功。
- [ ] 扩展批次中途失败和取消测试，验证消息配对、未派发工具无副作用、事件可关联。
- [ ] 把 M1 的最小取消分类并入统一契约，不留两套结果语义。

优先扩展 `tests/tool-registry.test.ts`、`tests/mcp-provider.test.ts`、`tests/agent.test.ts`、`tests/runtime-lifecycle.test.ts`；必要时拟新增 `tests/tool-runtime.test.ts`。通过 V07–V08 及 M1 回归后交付。

## 6. M3：持久化与安全恢复

### M3-01 设计并验证持久化协议

依赖：M2。对应：P1、P3、P4、P5。

主要范围：`src/core/session/types.ts`、`src/core/session/sessionEvents.ts`、`src/core/session/projection/`、`src/core/session/store/`、`src/core/session/controller.ts`。

- [ ] 在 SPEC 中明确权威记录、事件身份/顺序、检查点、格式版本、flush 确认和恢复算法。
- [ ] 检查当前摘要型 lifecycle 事件是否足以重建完整 pi-ai 消息；不得假设摘要可以还原工具参数、完整结果或 provider 元数据。
- [ ] 选择足够恢复消息与工具执行证据的最小记录方式，保持单一事件入口和纯投影，不引入数据库。
- [ ] 定义 append 部分成功、快照失败、并发 flush 和旧会话加载的结果；先建立故障 fixture 与预期，再实现格式演进。

设计必须说明 session 持久化模式与纯 headless 非持久化模式的保证差别，不为保留后者而虚报恢复能力。

### M3-02 实现可等待的执行前持久化确认

依赖：M3-01。对应：P2、P4、T3；验证：V09、V10。

主要范围：runtime/loop 的通用执行契约、`src/core/agent/lifecycle.ts`、session 装配和存储入口。

- [ ] 建立“记录执行意图 → 等待可靠保存 → 派发副作用 → 记录结果 → 确认保存”的流程。
- [ ] 在依赖注入处连接持久化能力，loop 和工具不得导入 Session 或具体文件存储。
- [ ] 持久化确认必须可等待且会传播失败，不能复用当前 `safeEmitRuntimeLifecycle()` 的吞错观察路径充当保证。
- [ ] 必要控制路径与可失败的 UI 观察路径分开，但事实仍经 `SessionProjectionStore.record`，不得另开旁路事件日志。
- [ ] 子代理和后台工作创建等副作用同样纳入执行证据；未保存意图不得启动，结果写失败后停止继续派发并报告。

### M3-03 实现有序写入、失败保留与去重

依赖：M3-01、M3-02。对应：P1–P3；验证：V09、V11。

- [ ] 在权威写入方串行化 flush，保持已确认事件与快照版本一致，避免旧状态覆盖新状态。
- [ ] 待写事实在确认后才释放；追加结果不确定时检测已写前缀或保守阻塞，不盲目重试整个批次。
- [ ] 单文件原子替换与跨文件一致性分别测试，事件身份和重试逻辑共同避免不可识别重复。
- [ ] 保留损坏或失败现场，错误返回调用者；不清理用户历史数据来通过测试。

### M3-04 实现恢复与未知结果处理

依赖：M3-01 至 M3-03。对应：P3–P5；验证：V10、V12。

- [ ] 从可验证的一致性点恢复；区分完整事件、尾部截断和日志中部损坏。
- [ ] 意图存在但无可靠结果的调用标记未知，阻止自动执行和自动唤醒，禁止从工具描述推断幂等性。
- [ ] 提供 headless/controller 可调用的核实或放弃入口，并接入最小 TUI 交互；重新执行重新授权。
- [ ] 兼容 pi-ai 和 legacy 消息 fixture，旧数据不足时仅恢复对话并说明限制。
- [ ] 用真实子进程在可控同步点退出，覆盖 SPEC P4 全部故障窗口；仅用 mock 抛错不足以证明崩溃恢复。

测试：扩展 `tests/session-store.test.ts`、`tests/session-projection-store.test.ts`、`tests/session-controller.test.ts`、`tests/session-legacy-migration.test.ts`、`tests/tui-resume.test.ts`；拟新增 `tests/session-crash-recovery.test.ts`。

M3 退出条件：V09–V12 与此前回归通过；用真实临时目录复现“副作用已发生但结果未保存”，恢复后不重复执行。

## 7. M4：异步工作可靠性

### M4-01 完善并发准入与工作归属

依赖：M3，复用 M1-04。对应：C1、C2；验证：V13、V14。

- [ ] 将容量判断与启动注册作为不可交错的准入动作，达到上限明确拒绝，不添加隐式队列。
- [ ] 以真实结算/资源状态释放槽位，停止未确认的工作保持可见，并明确其后续准入策略。
- [ ] 验证取消目标 run 不影响其他 run 拥有的工作；session 关闭覆盖所有所属工作。
- [ ] 共享 MCP 连接仍由 session/app 所有，单调用取消不得误关闭连接。

### M4-02 完善结果结算、消费和自动唤醒

依赖：M4-01。对应：C3、C4；验证：V15、V16。

主要范围：迁移后的子代理协调模块、`src/core/async/asyncWorkInbox.ts`、`src/core/hooks/runtimeHooks.ts`、`src/core/session/runner.ts`、`src/core/session/controller.ts`、`src/tui/sessionActions.ts`。

- [ ] 按稳定工作身份保护结算和消费，重复回调不重复入队；已结算结果与运行中的 pending 状态分开。
- [ ] 把主运行准入和唤醒重入保护放在 core，不依赖某个 TUI 的调用顺序。
- [ ] 结果从 inbox 到消息上下文的转移纳入 M3 的确认/恢复规则，避免 drain 后、消息保存前丢失结果。
- [ ] 多任务同时完成可合并唤醒；取消或关闭之后不再唤醒，被保留结果可供检查。
- [ ] 子代理失败返回可关联的失败结果，无未处理的 Promise rejection。

### M4-03 验证关闭与组合故障

- [ ] 组合验证权限等待中的子代理、执行中的 shell、共享 MCP 请求以及同时完成的后台任务。
- [ ] 覆盖重复关闭、关闭与完成竞争、清理超时、收尾写入失败；保持一次终态与真实资源状态。
- [ ] 用 sessionController 的 headless 消费者验证自动唤醒和关闭，不仅测试 TUI。

测试：`tests/async-work-inbox.test.ts`、`tests/subagent-runner.test.ts`、`tests/session-controller.test.ts`、`tests/runtime-boundaries.test.ts`、`tests/mcp-stdio-client.test.ts`、`tests/tui-session-actions.test.ts`。

M4 退出条件：V13–V16 通过，M1 的取消传播和 M3 的恢复保证无回退。不宣称跨崩溃 exactly-once 消费或自动唤醒。

## 8. M5：交付与工程展示

- [ ] 更新 README：核心职责、嵌入入口、取消与恢复语义、已验证平台、兼容变化及明确限制。
- [ ] 保持 `examples/headless-agent.ts`、`examples/custom-tool.ts` 可用，实际消费构建后的公共导出。
- [ ] 完善 M1 的无凭据取消演示；拟新增 `examples/recover-session.ts`，演示未知副作用需要核实而非自动重跑。
- [ ] 演示使用临时 workspace、scripted provider 和本地进程，不依赖真实凭据，不包含敏感日志或用户数据。
- [ ] 检查内部 barrel 与 `src/core/index.ts`，只导出调用者确实需要的 interface；无 UI 依赖、无新增导入即读取凭据行为。
- [ ] 执行完整检查、构建、示例和最终 diff 审查，核对 SPEC 每个验收编号。

交付重点是可复现的行为与取舍，不新增营销性能力承诺，不以漂亮演示替代失败路径测试。

## 9. 验证策略与追踪

### 9.1 每个实现任务

先编写能拒绝错误实现的聚焦测试，再完成最小实现和必要重构。示例命令：

```bash
pnpm exec tsx --test tests/agent-runtime.test.ts
pnpm exec tsx --test tests/pi-provider.test.ts tests/error-recovery.test.ts
```

根据任务替换测试路径，不机械执行所有无关测试。竞态使用可控 Promise、显式信号或进程握手；不要靠任意 sleep 掩盖竞态。所有真实进程测试必须设置有限超时和失败清理。

### 9.2 每个实现里程碑退出

```bash
pnpm test
pnpm exec tsc --noEmit
pnpm typecheck:tests
pnpm lint
pnpm format:check
```

最终交付另运行 `pnpm build` 并实际执行相关示例。没有模型凭据时依旧应能运行确定性测试；本地 HTTP、MCP、进程和文件集成检查不能被纯 mock 测试替代。

子进程终止策略优先验证当前本地 macOS 和已有 Linux CI。只有拿到对应证据才声明平台支持；不因 TypeScript 编译通过就声称 Windows 进程树清理可用。必要的 CI 调整在 M1/M5 一并实施，不自动扩展为跨平台重写。

### 9.3 验收映射

| SPEC 验收 | 主要责任任务             | 关键证据                                        |
| --------- | ------------------------ | ----------------------------------------------- |
| V01       | M1-01、M1-05；每阶段回归 | 正常工具循环、headless 和 session 路径          |
| V02–V03   | M1-02                    | 真实 adapter 取消、退避和权限取消、辅助请求清理 |
| V04       | M1-01、M1-02             | 各种竞争顺序下唯一终态                          |
| V05–V06   | M1-03 至 M1-05           | 真实进程退出、未知停止状态、关闭结果            |
| V07       | M2-01、M2-02             | 分类与校验、拒绝无副作用、错误传播              |
| V08       | M1-03、M2-02             | 批次中断后合法消息和未派发调用证明              |
| V09       | M3-02、M3-03             | 写失败可见、失败阻止副作用、待写事实保留        |
| V10       | M3-02、M3-04             | 真实进程故障窗口和不重复副作用                  |
| V11       | M3-03                    | 并发/重复 flush、部分写入与一致恢复点           |
| V12       | M3-04                    | 旧格式 fixture、截断和损坏数据处理              |
| V13–V14   | M1-04、M4-01             | 容量准入、实际退出、父子与 session 取消范围     |
| V15–V16   | M4-02、M4-03             | 去重、非重入唤醒、失败交付与共享连接隔离        |

M0 已执行第 9.2 节五项基线检查，并检查 Markdown 格式、渲染、路径引用、任务依赖和变更范围；M1 随后补齐对应实际消费者检查并通过阶段验收。M2–M5 的新增保证仍须在各自阶段验证，不能以既有测试通过代替。

## 10. 风险、变更控制与停止条件

| 风险                           | 处理方式                                                           |
| ------------------------------ | ------------------------------------------------------------------ |
| 架构审查变成无边界重构         | 只纳入有证据且影响当期契约的问题；剩余问题登记，不顺手处理         |
| M1 同时重写全部工具错误与存储  | 只引入取消所需最小契约；工具统一留给 M2，持久化协议留给 M3         |
| 新事件或结果类型破坏已有消费者 | 同阶段更新生产方、消费者、fixture 和公开示例，不长期维护双轨       |
| 只终止父 shell，后代仍运行     | 使用真实进程树 fixture；按已验证平台声明能力，未知状态不得伪报成功 |
| 观察回调吞错导致持久化承诺失效 | M3 使用可等待的必要控制路径，UI 观察失败仍与执行隔离               |
| 恢复需要的信息未保存           | M3-01 先验证完整消息与工具执行证据能否重建，再确定存储协议         |
| 完成父 run 时误取消异步子工作  | 正常完成与显式取消分开建模，分别验证 L5 三种作用范围               |
| 为求职展示一直推迟交付         | M1 形成第一版展示；后续阶段分别交付，不要求一次完成所有能力        |

每个阶段开始前重新检查工作区与规格，保留期间新增的用户修改。若实现所需变更超出 SPEC，先解释影响并调整经确认的规格，不暗改验收标准。

不在本计划执行中自动提交、推送、发布或删除用户会话。局部试验失败时只清理本任务创建的临时资源，不回滚用户工作。

## 11. 当前状态与下一步

逐项执行与验证记录见 [TASKS.md](TASKS.md)，以下仅在阶段出口完成后同步。

- [x] M0：只读架构审查。
- [x] M1：生命周期与全链路取消。
- [ ] M2：工具执行契约。
- [ ] M3：持久化与安全恢复。
- [ ] M4：异步工作可靠性。
- [ ] M5：交付与工程展示。

M0、M1 已完成；M2–M5 未开始。下一步是获准后从 TASKS T021 决定 M2 的工具结果与校验演进方案。本次不自动进入 M2，不提交或发布。
