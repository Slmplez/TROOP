# Windows Hooks 与模型端工作流维护

TROOP 0.7.0；父规格 [#24](https://github.com/Slmplez/TROOP/issues/24)，Hooks [#26](https://github.com/Slmplez/TROOP/issues/26)，工作流维护 [#27](https://github.com/Slmplez/TROOP/issues/27)。承接 #8 的本地替代契约和 0.6.0 资料库。

## 工作流维护

模型继续使用旧参数：update_state 的 target=workflow，action=write 时 name、description、body 必填，id 可选；action=delete 时 id 必填。不要求旧调用增加 content。省略 id 创建名称对应的 slug，已有同 ID 不静默覆盖；改写使用明确 id。工作流无 trigger，自动化不能通过此路径改成普通技能。

每次模型请求开始冻结当时可见资料的修订。省略 expected_revision 时使用该快照；显式 expected_revision 必须是与快照相符的十进制字符串。模型回答期间或工具等待期间发生用户编辑，旧提案拒绝，不覆盖用户新内容。当前 Agent 已关闭、已删除的资料不能被模型维护；只读子代理不能通过 update_state 修改共享配方。

保存创建不可变版本，保留辅助文件和元数据，live 条目转成副本但不回写来源。事务同时提交当前版本指针、全部文件、ToolInvocation 结果和事件；故障没有幽灵版本。原任务的配方快照不被重写，新任务取新版本。模型端每次正文最多 8000 UTF-8 字节、名称 80 字符、描述 1536 字符，参数整体最多 12KB；更大资料仍可由文件导入。

## Hook 配置与授权

“Hooks”页管理 command/prompt 规则、事件、Agent/工作区范围、matcher、timeout、loop_limit 和 failClosed。默认新表单停用；勾选启用并保存后，匹配任务会自动执行这份规则，不另加统一首次确认弹窗。command 明确标为 Windows 本机，以当前用户权限运行；不是 OS 沙箱。模型不能经 update_state 创建或启用 Hook。

规则限 64 份，每个任务最多匹配 32 份。新任务冻结规则及修订，子代理继承；设置修改、停用或删除撤销旧修订，在途请求取消，迟到内容不应用，新修订供新任务使用。删除配置保留历史调用、指令和结果。旧 Linux 命令可作为 legacy-linux 资料明确保存，始终停用，不自动转换或执行；本版不自动扫描或导入旧应用的 hooks.json。

matcher 为空或 \* 匹配全部；工具事件按 TROOP 工具名匹配，其他事件按事件名匹配。使用有大小预算的 Rust regex，支持常见正则，不支持 JS lookaround/backreference；不支持的模式报错，旧资料可以原样保留为停用配置，不伪装为已转换。

timeout 未配置时使用 60 秒任务期限。配置的正数秒数保留，允许小数；执行总期限最多 3600 秒，超过该期限的配置仍受此任务上限约束。loop_limit 未配置或 null 不额外设置单规则次数；仍受每 Run 128 个 Hook 记录、每棵树 256 个和原模型/工具预算约束。没有自动重试。

## 接入事件

| 事件                             | 本机触发点                                                                    |
| -------------------------------- | ----------------------------------------------------------------------------- |
| workspaceOpen                    | 新根任务关联工作区时；不是登记目录或切换界面                                  |
| sessionStart                     | 每个 Run 首次执行前，包括子代理                                               |
| beforeSubmitPrompt               | 初始目标，以及安全边界接纳补充指令前                                          |
| preToolUse                       | 有效工具计划执行/审批前                                                       |
| beforeShellExecution             | run_command / start_background 的具体操作前                                   |
| beforeReadFile                   | read_file / read_skill / read_skill_file 前                                   |
| subagentStart                    | spawn_agent 创建所属子代理前                                                  |
| postToolUse / postToolUseFailure | 已执行工具的成功 / 失败结果提交后、交给模型前；不对拒绝派发的计划伪造执行结果 |
| afterShellExecution              | 前台命令结束；后台命令在实际终结、接纳结果前触发                              |
| afterFileEdit                    | write_file 成功后                                                             |
| preCompact                       | 已提交历史的压缩启动前                                                        |
| afterAgentResponse               | 已接收模型响应后，包括带工具计划的响应                                        |
| afterAgentThought                | 响应包含不透明推理块时，仅传“存在且已归档”标记，绝不传推理或签名正文          |
| subagentStop                     | 子 Run 自然结束前，错误向其执行状态传播                                       |
| stop                             | 模型准备自然结束时，可有有界 followup_message                                 |
| sessionEnd                       | 自然完成且没有后续补充工作时                                                  |

MCP 和 Tab 编辑器的 beforeMCPExecution、afterMCPExecution、beforeTabFileRead、afterTabFileEdit 可保存为停用资料，界面明确未接入，不能启用。本版不宣称相关模块已经实现。显式停止、取消、异常退出后不再启动 stop/sessionEnd 脚本；用户停止通道独立于 Hook，撤销授权后不产生新的收尾副作用。

## 执行、结果与错误

command 使用现有独立 Worker、Windows Job 和控制通道，stdin 为有界 JSON 事件数据，不插入 PowerShell 命令字符串。命令自身单独作为显式配置代码。输入最多 10KB，必要时携带清楚的摘录/截断标记；Worker 请求另受帧限制。stdout 最多 4000 字节，stderr 3000 字节，截断或非零退出标记失败。空 stdout 表示 {}，其余须是一个 JSON 对象。后台作业与 Hook 命令共用宿主执行队列，整棵进程树停止前不释放资源。

prompt 使用任务已选服务和凭据引用，可显式指定同服务的模型 ID；不自动换服务或查找其他凭据。不提供工具，受同一四流额度和 timeout 约束。调用账本记录状态、额外模型请求与返回用量；不完整请求的用量可能缺失。事件只含目标、工具参数/结果、可见输出和关联 ID，不传配置密钥或不透明推理。

权限事件支持 allow/deny/ask。deny 阻断对应操作，ask 进入既有具体 ToolInvocation 审批；allow 只表示 Hook 没有阻断，不能替代原文件/命令审批。preToolUse 的 updated_input 重新走工具参数检查，变更后清除旧审批，界面展示最终冻结参数及原模型参数。非法更新不执行原操作来掩盖错误。

默认 Hook 自身错误按事件区分：权限前置错误 fail-open，配置 failClosed 后阻断；post 错误留账继续，不因错误重放已发生操作；subagentStart/Stop 错误传播。beforeSubmitPrompt 的 continue=false 阻断本次执行；可用的 additional_context 作为数据进入相应历史/工具结果，不增加权限。补充指令和 post Hook 相遇时先保留真实工具结果，之后再接纳输入与附加上下文，不破坏三协议的工具结果顺序。

只读子代理不执行 command Hook，留下明确的权限错误并按相应事件错误策略处理；不能借 Hook 继承宿主写权限。prompt Hook 仍可检查事件。工具和规则的启停、任务停止及版本检查分别成立，fail-open 不能绕过 Core 工具策略。

每次调用有稳定 Run/event-key/rule 身份、规则修订和 Worker 回执。Ready 阶段先落盘再允许派发；停止等待实际 Job 退出。超时但已确认停止的命令保留效果不明标记，按事件错误策略处理且不重试；未确认停止、异常退出或在途规则撤销形成 indeterminate，要求用户核对作用与整个进程树停止后再手动继续。重启只恢复记录，未派发项取消，旧调用不重放。任务页可查看、分页、展开详情和保存核对。

内部协议与 SQLite schema 均为 7；新增 hooks/hook_calls，旧资料不回填运行规则。固定 IPC 为 hooks.list/definition/save/remove/calls/call/reconcile；Renderer 不获得通用 Shell 或任意文件通道。

## 范围

0.7.0 完成父规格 #24 的本机 Hook 与模型端工作流维护子项；MCP、调度、旧配置自动导入、正式桌面输入和安装包仍在后续范围。公开验收覆盖自有三协议服务与本机流程；任意第三方服务和长期负载仍需独立证据。Windows 继续使用单屏基线，Docker 与整体 UI 优化未扩展。
