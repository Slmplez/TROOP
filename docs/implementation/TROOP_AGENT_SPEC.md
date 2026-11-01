# Windows 本机 Agent 执行与工具

版本 0.3.0；[规格 #18](https://github.com/Slmplez/TROOP/issues/18)、[实现 #19](https://github.com/Slmplez/TROOP/issues/19)。本功能包落实已确认的 #4 执行契约的本机基础部分；不表示完整迁移地图或双环境契约已完成。

## 执行边界

任务独立于普通对话，由用户选择固定服务、工作区和目标。Core 接收并持久化幂等请求后返回 Run ID；保存服务配置快照及凭据引用。模型 API key 只在 Rust 网关读取，Worker 不接收密钥。重复 client_run_id 和相同参数返回原任务，不同参数拒绝。

任务阶段为 queued/running/waiting/cancelling/completed/failed/cancelled/interrupted，等待原因另存 approval/tool/resource。Core 单一写入 Run、工具、审批及执行事件；模型步骤具有 attempt ID，恢复增加 epoch。完成模型步骤、准备全部工具与更新上下文在同一事务中提交；工具结果、上下文接纳与事件也在同一事务中提交。

三种已有协议均接入工具定义、分片参数和结果回传。只在完整结束、完整 JSON 及身份校验后准备调用，不执行未结束参数。Responses 保留原生输出/推理项并核对最终参数一致性；Anthropic 保留有序 text/thinking/redacted_thinking/tool_use 块及完整签名，再原样带入下一工具回合。普通对话入口仍不执行工具。

## 工具与授权

| 工具 | 范围 | 审批 |
| --- | --- | --- |
| list_directory | 工作区相对路径；100 项或 6KB 结果预算 | 启动任务时授予读取范围 |
| read_file | UTF-8 文件 ≤8KB，返回全文及 SHA-256 | 同上 |
| search_text | 字面匹配；有界遍历、30 条/6KB 结果预算 | 同上 |
| write_file | 内容 ≤8KB；旧内容哈希匹配或新文件 create_new | 逐调用批准冻结参数 |
| run_command | Windows PowerShell，60 秒，UTF-8 输出，stdout/stderr 各 3000 字节 | 逐调用批准完整命令 |
| git_status | 工作区外的 PATH Git；禁用 fsmonitor/子模块递归，保留仓库状态语义 | 逐次批准宿主程序调用及其仓库过滤器范围 |

文件入口拒绝绝对路径、父级逃逸、ADS、设备名、重解析点及直接访问 `.git`。现有文件通过同一文件句柄核对哈希并写入；Windows 句柄阻止其他写入/删除共享。校验不能隔离所有外部程序或恶意路径竞态，工具不是 OS 文件沙箱；命令能力明确覆盖宿主，用户在批准时可见这一范围。

Git 状态查询本身不请求 Git 写操作，但 Git 可能调用仓库配置的外部过滤器，因此不纳入自动读取授权。冻结记录中包含实际 Git 参数，界面展示并要求逐次批准；工作区内的同名程序不会成为 Git 执行文件。

审批绑定 Invocation ID、epoch 及存储中的不可变参数。Renderer 只提交批准/拒绝，不提交替换参数；重复相同决定幂等，矛盾或失效决定拒绝。拒绝结果返回模型，但不自动批准新计划。

## Worker、停止与资源

Core 先提交 dispatched 意图，再建立独立 Worker。Worker 在 Windows Job Object 内接纳请求，持久保存 accepted 回执并等待 Core；Core 提交 running 后才发送 go。Worker 在效果产生前保存 running，结果落盘后回传。相同调用已有回执则拒绝重新执行。

Worker 的 Job 使用 kill-on-close，覆盖它启动的受管命令树；控制管道 EOF、取消和超时使 Worker 退出。命令工具不支持脱离任务的后台运行；借助外部服务产生的副作用不能由 Job Object 撤销。本 Worker 是任务内的短生命周期进程，不是未来 Docker/远程 Worker 的持久队列或通用 exactly-once 实现。

Core 保留 Job 句柄，只向 Worker 复制该句柄。收到结果或停止请求后终止整个受管 Job，并查询 ActiveProcesses=0 才释放执行队列；这个停止确认先写入回执，再提交业务结果。只有带完整结果及进程树停止确认的回执才可直接核对接纳，否则仍需人工核对。

所有本机工具在 Core 内共用宿主执行域排他队列，保守覆盖目录别名、父子工作区及 Git 共用管理目录。结果未提交或停止未确认时不重新授予；重启发现未确认派发的工具会保留全域隔离，等待核对。外部程序不参加该队列。

停止先持久化 cancel 意图，关闭派发，再取消模型并停止 Worker。已完成效果保留；被中止的副作用操作可以仍为 indeterminate，而受管 Worker 已确认停止。不能确认停止时保留 interrupted 与隔离。取消/失败意图不被恢复或补充指令清除。显式退出停止当前作业并保存 interrupted，关闭窗口到托盘不停止任务。

## 恢复与补充指令

启动只恢复记录，不自动请求模型或重发工具。遗留 dispatched/running 调用变为 indeterminate，任务为 interrupted。核对有效 Worker 最终回执后可接纳成功/失败；回执自身仍标记不确定时，必须由用户核对实际效果和停止状态并记录说明。prepared 的旧计划在手动继续时失效，写入未执行的工具结果；已成功和不确定的旧调用均不重新派发。只有无 cancel/failure 意图且核对通过的任务可进入新 epoch。

补充输入具有独立幂等标识并先持久化，在模型结束、工具结果提交、下一工具派发前采纳。已经启动的写操作不会因普通补充消息强行中断；尚未派发的旧计划失效，旧审批不会套用到新计划。立即停止有单独入口。

## 预算与接口

每次任务最多 16 模型步骤、32 工具、8 条补充输入；每个模型响应最多 8 个工具。最多 16 活动任务，普通对话和 Agent 合计最多 4 模型流。上下文序列化上限 192KB，单模型文本 24KB；不自动重试、回退或重新路由。所有预算在继续后仍累计。

内部协议 3，固定 `agent.start/list/get/content/events/event/invocation/approve/steer/cancel/reconcile/resume`。任务历史分页 30 条，事件分页 15 条；长文本独立读取，快照不把参数和全部历史塞入一帧。公开 DTO 不包含配置中的凭据引用或私有模型上下文。

## 后续范围

本版没有子代理、独立后台作业、记忆、Skills、Hooks、MCP、定时调度、桌面控制正式接线、历史导入或签名安装包。Docker 与 UI 美化暂停，Windows 采用既定单屏基线。#9/#10 完整契约与发布门槛保持开放。
