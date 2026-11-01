# 本地集成、记忆与自动化契约

日期：2026-11-01。用户已确认本文件的旧机制兼容方向、三项本地替代，以及 Magpie 借鉴方式与 Rust 内置网关路线。唯一任务状态源：[确定本地集成、记忆与自动化替代边界](https://github.com/Slmplez/TROOP/issues/8)。本文件作为正式规格输入；运行验收仍由后续实现完成。

## 用户已明确的方向

记忆、Skills/Workflows/Hooks、自动化、MCP 均以 Grok Bot 原机制为兼容目标：自动记忆不增加逐条保存确认，Skills 保留用户共享库与 Agent 开关，工作流保留既有调用方式。具体替代边界见下文。当前不安装、不启动、不验证 Docker，也不修改 Docker 原型或其任务。

已确定的应用生命周期继续有效：关闭窗口保留托盘与调度；显式退出、关机期间不执行任务；没有后台系统服务；崩溃后先核对、手动继续。商业账号、官方市场/relay/云同步移除，第三方服务自身的正常认证保留。

用户确认借鉴 [yetone/magpie](https://github.com/yetone/magpie) 的 Skills、MCP 与网关，研究固定在 `1fac66c06d11de9e4232270862da0fa0a3ad90f6`。采用“一处管理、按 Agent 分配”的资料库，运行时继续检查启停、权限和执行账本；模型网关在 Rust Core 内实现，外部 Magpie 作为用户显式配置的可选模型端点。具体模块与验收见 [Magpie 采用方案](MAGPIE-ADOPTION.md)。

## 兼容矩阵

| 功能 | 应保留的原机制 | 本地独立替代 / 限定 |
|---|---|---|
| 显式记忆 | update_state 直接写入或遗忘；默认 agent scope，另有 user/project scope | 不增加统一的“候选确认后才保存”；项目成员资格与作用域检查保留 |
| 自动记忆 | 回合结算后自动提取，过滤不合适回合；显式事实与删除记录有保护 | 保留自动维护能力；不能把记忆自动写入改为默认人工确认 |
| 记忆结构 | profile、按月 log、episode；Agent 私有，另有用户共享与已加入项目共享 | 原数据布局和可读写语义作为导入/兼容输入；新存储可变，但不能混淆三类作用域 |
| 高级记忆维护 | 原 dreaming 为实验 gate 控制的证据/提案/验证路径，区别于旧每回合 extraction | 不依赖原认证实验开关或固定商业模型；默认行为/导入映射在规格中明确，不能宣称旧账号 gate 已知 |
| 记忆注入 | profile/recent 的数量与字符预算，按 compaction epoch 冻结快照 | 当前重建入口存在 null store 接线缺口，正式实现要补齐，不能把空注入认作期望行为 |
| 用户 Skills/Workflows | 全局用户库，Agent 保存禁用列表，默认启用；显式导入本地指令文件 | 保留 SKILL.md、辅助文件、Agent 级开关、手工导入及 live source 指针 |
| 工作流调用 | @workflow 与 Run Now 展开 recipe；禁用项不展开；有 trigger 的工作流属于自动化 | 保留调用方式、来源标识和可见状态；不要求新增下载器或市场 |
| 来源优先级 | 同 ID 用户库遮蔽 managed，再遮蔽 plugin；自动化与普通技能分开 | 用户已选：手动导入已有技能为可启停、编辑、删除的本地技能，保留来源信息，移除原组织强制锁定；同 ID 不静默覆盖 |
| Hooks | command/prompt、事件 matcher、timeout、loop_limit、failClosed；工具前 deny 阻断 | 默认错误语义按事件类型保留；Hook 自身失败不能绕过 TROOP 已有工具授权；旧 ask 缺口需与已确定审批等待契约统一 |
| Hooks 可执行性 | schema 和 remote executor 抽象存在，当前 host 本地执行接线未找到 | 必须实现本地 runner/取消/超时，不能把读取插件 hooks.json 当执行通过；不凭空添加统一首次确认交互 |
| MCP 配置与工具 | stdio、HTTP/SSE 配置，工具发现/启停、账号连接/断开，超时和结果不明 | 保留用户配置能力；去掉官方 Dashboard 和代理后，配置、transport 和认证由独立适配承接 |
| MCP 执行位置 | 原 HTTP/SSE 经后端，stdio 推送 Box；桌面适配明确不直接执行 | 用户已选：先支持明确标注的 Windows 本机 stdio/Hook 入口；原 Linux 配置保留但不自动转换或执行；第三方 HTTP/SSE 按独立客户端接入 |
| 自动化创建与调度 | 一次性/周期、cron/别名/@every、时区、下次运行预览、启停、手动运行 | 用户已选：退出/休眠错过默认跳过并记录，可手动补跑；DST 重复只运行一次、缺失时刻跳过；不声称这是原云端规则 |
| 重叠与队列 | 同 routine 非事件触发 in-flight 去重；同会话 background lane 串行，用户消息优先 | 保留运行归属与优先级，持久化去重与原因；不承诺外部副作用 exactly-once |
| 事件批次 | 原 750 ms debounce、最多 500 待处理项、每批最多 25，批次串行 | 参数作为兼容默认；Slack/GitHub 旧 relay 不视为已移植的第三方原生事件服务 |
| 通知 | 新完成消息或等待输入触发；隐藏/关闭/前台焦点抑制，Agent+类型 5 秒节流；完成 silent，待输入 critical | 保留本地通知体验；原移动推送依赖官方服务，不伪装为已有独立推送；失败是否通知不额外改成每次弹窗 |

## 源码依据与接线限制

以下均为静态源码事实，未读取私人配置、账号 gate 或真实服务，未执行模型请求。

- 记忆文件与 scope：`source/host/extensions/memory/memory-service.ts:9,54,72,89,133`；`agent-state.ts:29,44`；`project-membership.ts:5`。
- 自动提取与 episode：`source/host/runner/turn-settle.ts:363`、`turn-memory.ts:42,99`、`sand-memory.ts:41,107`。
- dreaming：`source/host/extensions/memory/production.ts:42`、`memory-synthesis-service.ts:9,243`；原 gate 为 `sand_memory_dreaming`，不是用户已明确选择的独立本地模式。
- **实际接线缺口**：`source/host/host-runner-composition.ts:1683-1687,1701-1703,2028`；不能仅凭 prompt assembly helper 宣称当前自动记忆和技能发现全部生效。
- Skills/Workflows：`source/host/workflows/workflow-library.ts:3,6`、`workflow-store.ts:31,39,42,45,52,56`、`source/host/agents/agent-workflow-enablement.ts:1`、`source/host/extensions/transcript/workflow-commands.ts:20,260,306`。
- Hooks：`source/packages/hooks/validators/hooksConfig.ts:4,11`、`source/packages/cursor-plugins/loader.ts:87,89`、`source/packages/agent/tools/core/remote-hooks.ts:55,65,120,180,210`。默认执行异常 fail-open，显式 failClosed 才 deny；post hook 错误记录继续，subagent start/stop 错误传播，不得简化为一个统一错误策略。
- MCP 类型及官方依赖：`source/shared/node/cursor-backend/account-mcp.ts:4`、`source/electron-main/mcp/desktop-mcp-manager.ts:62,106`、`source/shared/node/mcp/tools-discovery.ts:159,397`、`source/shared/node/cursor-backend/backend-mcp-exec.ts:5,60,62`、`source/shared/node/mcp/mcp-oauth-loopback.ts:44,167`。
- 定时计算与云触发：`source/shared/automation-schedule.ts:2`、`source/host/extensions/automations/sand-automation-cloud-sync.ts:274,370-376,425`、`sand-automation-fire-consumer.ts:85,99,127`。
- 自动化执行与通知：`source/host/extensions/transcript/automation-run-path.ts:111,177,359,374`、`automation-event-fires.ts:8,118`、`run-scheduler.ts:199`、`source/shared/os-notification.ts:1`、`source/electron-main/notifications/os-notification-manager.ts:85`。

## 用户已确认的本地替代取舍

1. 先支持明确标注的 Windows 本机 stdio MCP 与 Hook 执行入口，使用 Windows 兼容命令。保留旧 Linux 配置与来源，但不静默转换路径、命令或执行位置。
2. 保留托盘驻留，显式退出停止调度；退出/休眠错过默认跳过并记录，可手动补跑。DST 重复时刻只运行一次、缺失时刻跳过。cron/@every/时区、非重叠及会话队列机制按原功能保留。
3. 将已有 managed/plugin 技能通过显式导入转为可启停、编辑、删除的本地技能，不延续原组织的强制启用锁定；普通用户技能库、Agent 禁用列表、@workflow 与 Run Now 机制不改变。

“Box”是旧版工具执行所用 Linux 环境，原配置可以连接远程 Box 或本机容器，不是 Windows 系统沙盒。旧 stdio 路由到 Box 是源码事实；Hook 远程抽象存在不代表所有事件已在当前包运行。新本机入口本身不是 OS 沙箱。

其余机制以旧功能为准，重建代码中的 null store、未实现分支和未连接接口作为待补齐缺口，不复制成新产品的预期行为。上游共享目录的可见性、MCP 自动重放和外部服务依赖不替代本产品的权限与恢复契约。

## 错误与恢复验收

- 记忆：显式写入/遗忘、自动提取、项目成员检查、Agent 与用户共享边界、显式事实与 tombstone、提取失败不破坏已完成回合；注入接线和 compaction 快照实际生效。
- 技能：导入 live source、同 ID 来源优先级、Agent 开关、@workflow/Run Now、辅助文件、自动化区别；失效来源有可解释状态。
- Hooks：每个承诺事件均有调用证据；deny/ask/执行错误/failClosed、timeout/取消/进程树、大输出、递归限制；已发生工具效果不能由 post hook 失败触发重复执行。
- MCP：同名工具隔离、配置增删/启停、取消/断线/重连、HTTP/SSE 与 stdio 路径和环境、参数及 Schema、180 秒旧超时兼容与结果不明；权限与执行位置可见。
- 认证：第三方 OAuth code/state/回调/刷新/撤销需真实服务验证；不能因测试替身通过就宣称所有提供方兼容。密钥不进入日志、模型上下文或共享技能文件。
- 自动化：确定性时钟测试 cron/@every/时区/DST/错过/重叠、重复事件与重启、排队时修改规则、暂停/删除、等待审批；模型和工具使用人工替身，不发送真实外部动作。
- 通知：焦点/隐藏/开关/节流、新消息/待输入、点击跳转和真实 Windows 送达单独验证；静默监控不把无变化写成新的完成提醒。

## 行为边界补充（兼容原机制与既有执行契约）

- 长期记忆、会话历史和压缩摘要分开。记忆遗忘影响后续检索与注入，不会假称撤回已经写进历史消息、导出或备份的内容。自动维护失败不让已完成回合变为失败；显式用户编辑有可见错误。
- Agent 私有记忆可随该 Agent 跨会话复用，不擅自改成“每个工作区一份且相互不可见”。项目共享只对已加入该项目的 Agent 开放；用户共享与 Agent 私有记忆保留原来的不同作用域。
- 原自动提取与 dreaming 不是同一算法。保留两类能力，原账号实验 gate 不作为新产品依赖；可确认的旧开关状态可映射，无法确定时不声称知道用户原 gate。独立配置默认走常规自动提取，不强制开启高级合成，也不新增写入前确认。
- 技能的文字指令不会自动扩大任务授权。辅助脚本属于执行能力；Hook 规则、任务权限、停止状态分别检查。Hook 的 fail-open 仅指 Hook 自身错误处理，不能作为应用工具权限失效时继续执行的依据。
- Windows 的本机 MCP 或 Hook 如被选择支持，应明确以当前用户权限执行。应用的工具调用策略不等于 OS 沙箱；不声称仅靠进程分离便能限制任意本机脚本的所有文件与网络访问。
- 本机 stdio 的 command/args/cwd/env 按显式配置解析，不拼接 shell 字符串；更改连接配置生成新修订，旧连接和未完成调用保持原身份核对。第三方服务传来的 instructions、输出、附件不能授予新工具权限。
- MCP 超时、断线和取消不等于外部动作没发生；可以重连和重新发现工具，不能把旧写调用自动重新投递。OAuth 连接、刷新与撤销按服务实现，原账号服务中的凭据不能假装已经迁移成功。
- 同自动化“运行中”包含排队、等待审批和等待用户输入；后续定时触发不偷偷创建并发执行。暂停停止接收新触发，当前运行是否停止使用单独的停止动作，保留产物与历史。
- 自动化首次启用与导入恢复不同：旧导入计划保持暂停，既有导入契约不变。触发本机桌面动作仍遵守按任务授权、锁屏暂停、解锁刷新及不重放；调度触发本身不是桌面授权。
- 自动化从开始运行前冻结定义修订、时区、目标工作区和权限引用；运行中修改下一轮规则，不改变已经提交动作的参数。完成与失败均进本地历史，通知是否弹出仍遵守原开关/焦点/隐藏/节流策略。
- 旧 Hook 明确配置的 timeout/loop_limit 按其值保留；未配置时使用统一任务/工具 deadline 与取消约束，规格需列出实际配置值，不捏造旧验证器的默认值。递归不能绕过整个任务的预算或取消。
- 同 ID 技能导入先形成冲突预览，保留来源与版本，不静默覆盖用户库；live source 文件发生变化可见，新执行取新快照，已开始的工具调用继续绑定原参数与授权。导入材料不是自动执行新脚本的授权。

## 验证层次

| 层次 | 可以确认 | 不能据此宣称 |
|---|---|---|
| 本轮源码盘点 | 接口、文件结构、分支和依赖的静态事实 | 当前重建包的所有接线已生效，或原云端策略已知 |
| 正式开发中的确定性替身 | 作用域、状态机、调度时钟、取消、重连与授权组合 | 所有模型/第三方 MCP 的真实行为一致 |
| 本机集成 | Rust Core、存储、脚本进程树、本机通知和 UI 的真实接线 | 未验证平台、沙箱或第三方服务同样通过 |
| 真实服务兼容 | 指定提供方、协议版本和认证流程的实际结果 | 任意 OAuth 服务都支持，或外部副作用可以回滚 |

不为决策任务增加长期运行认证、真实账号登录或桌面测试。上述证据关口进入正式开发验收，本轮先确定契约。

## 本轮不做

不运行 Docker，不安装应用，不进行新的桌面输入演练，不调用真实第三方服务，不实现正式 Rust 业务模块。本轮先形成可实施且兼容旧机制的契约与验收矩阵。
