# MCP Agent 接线、审批和 Hooks

2026-11-03，TROOP 0.10.0，内部协议与 SQLite schema 10。父规格 [#42](https://github.com/Slmplez/TROOP/issues/42)，实现 [#46](https://github.com/Slmplez/TROOP/issues/46)。承接 0.8 服务资料库与 0.9 OAuth。本文记录本机 Core 的实现与自有夹具验收；服务管理页和真实第三方服务验收分别属于 #47、#48。

## 任务目录与权限

根 Run 启动时冻结已启用且分配给所选 Agent 的服务 ID、配置修订、认证身份与 Agent 分配。最多八项服务；依次发现目录后才发起任务模型请求。发现失败会中断任务并记录原因，不用残缺目录继续执行。继承子代理沿用父 Run 的冻结选择和目录，但实际调用使用独立所属连接；只读子代理不取得可执行 MCP 能力，也不能通过猜测父工具名调用。服务的 readOnlyHint 等注解不会代替权限检查或免除审批。

工具模型名采用 `mcp_<服务UUID去横线>_<原名SHA256前16位>`，服务间同名工具分别路由。向模型暴露原 inputSchema 和有界描述，不把服务器 instructions 当作授权指令。每 Run 最多 128 个工具、目录总量 128KB；超额明确中断，用户需减少分配或停用部分工具。工具名含控制字符、目录含已知凭据字面值、非法或不支持的 Schema 均拒绝。

每次计划与实际派发前均检查工具 Schema、服务启停、Agent 分配、配置修订、工具禁用与认证身份。参数最多 12KB；基础 Schema 能力和限制沿用 [MCP 资料库](TROOP_MCP_LIBRARY.md)。派发前再次读取目录并核对完整目录摘要，目录变化使旧计划失效。新建或新分配的服务不会进入已经启动的 Run。

所有外部 MCP 工具均逐次批准。任务页显示服务身份、修订、Windows 本机或远程位置、传输、原始工具名和最终参数；允许与拒绝使用现有固定审批 IPC。Core 持久化 invocation 和具体审批后才安排任务；连接完成预检后，还要把 `running` 和 `mcp_dispatched` 账本提交成功，才释放 tools/call 派发门。存储失败时不发送外部调用。

## Hooks

`beforeMCPExecution` 与 `afterMCPExecution` 已启用，现有 17 项事件继续支持，共 19 项；Tab 文件事件仍停用。匹配器使用冻结的模型工具名，因此 `^mcp_` 可匹配 MCP 工具。输入包含 invocation 的服务路由、原工具和最终参数。

调用前按既有顺序执行 preToolUse，再执行 beforeMCPExecution。preToolUse 修改参数后重新验证 Schema、更新审批展示并清除旧审批。beforeMCPExecution 支持 allow/ask/deny 和 additional_context；allow 不绕过具体操作审批。已确认返回的调用经过通用 postToolUse 或 postToolUseFailure，并触发 afterMCPExecution；isError 是已完成的工具失败。未派发、结果不明、显式停止或崩溃不会启动新的 MCP 后置脚本。后置 Hook 失败不会重做外部调用。

## 连接、取消与资源队列

HTTP、POST SSE、旧 HTTP+SSE 和 Windows stdio 均使用同一 Agent 适配层。连接归属于 Run，保留协议会话与 stdio 服务状态，连续调用可复用；不同 Run 不共享连接。终结任务先关闭所属连接，结束清理后才发布终态并启动符合条件的记忆维护。关闭或派发结果不明会保留核对状态。

连接启动、目录发现、tools/call 与本机工具、command Hooks、后台命令共享一个活动派发队列。连接启动与目录遍历分别有总时限，工具调用使用配置时限；Core 控制通道异步处理停止。空闲的 stdio 会话保留进程，服务器自身的后台行为无法由该队列完全串行化。已配置的 Windows 服务是当前用户的宿主能力，不是 OS 沙箱，不能据此承诺其只访问所选工作区。

stdio 经独立 Worker 启动，先建立 Job Object，再启动配置的命令。停止、所属父任务停止、配置撤销、退出和 Core 通道死亡会关闭所属树。停止整个父任务向其子代理传播。无法确认所属进程停止的 Session 阻止后续宿主派发，必须核对。HTTP 停止只能终止本地等待和通信，无法证明远端效果取消；已派发且不明的调用继续保留人工核对要求。

不会因超时、401、目录变化、断线、停止或崩溃自动重放 tools/call。重启只恢复记录，未完成调用成为不明结果；stdio 未结束 Session 也成为待核对。先核对 invocation，必要时另核对所属 Session，再手动继续 Run。继续将核对记录作为历史接纳，旧调用不重新排入队列；新模型计划若产生新调用仍需新审批。

## OAuth 与凭据

服务 `auth_mode` 支持 automatic、none、headers、oauth。automatic 在已有 OAuth 身份时使用该身份；none/headers 明确使用配置方式，不能悄然开始 OAuth。stdio 不使用 OAuth。配置修订和认证身份同时冻结，不能在旧计划中换账号、换服务或把另一服务 token 带入。

OAuth Grant 具有持久 binding ID，正常刷新保留身份。到期前 120 秒按需发起或等待同身份刷新；每 Run 每服务最多启动四次刷新，全局最多四项认证操作。刷新期间不放行旧认证修订的调用，发出请求前重新取得受控凭据。断开、撤销、换身份和配置变化使旧计划失效。tools/call 返回 401 时只使同修订凭据过期，当前调用仍要求核对；不会刷新后再发原调用。后续新的获批调用可以请求刷新。

密钥继续保存在 Windows 凭据存储。已知配置秘密和本次 token 的字面回显会在结果入账前去除，二进制附件含已知秘密字节时省略；这不保证识别经过编码、变换或未知来源的秘密。持久目录和调用记录不存秘密引用或 token。OAuth 完整约束见 [0.9 OAuth 记录](TROOP_MCP_OAUTH.md)。

## 结果与附件

文本、结构化内容和资源元数据以有界 JSON 进入真实模型工具历史。结果必须具备 content 数组或 structuredContent 对象，isError 若存在必须为布尔；不支持的或畸形整体结果按不明处理。当前不会完整验证每一种内容块扩展或 outputSchema。

图片、音频和内嵌资源 blob 不作为 Shell、路径或自动抓取的 URL 执行。解码后的单个二进制附件最多 48KB，每次最多 32 项；移除 base64 后的大 JSON 结果可归档，单项最多 512KiB。历史保留有界摘录、截断标记和附件清单。归档 bytes、SHA-256、Run/invocation 所有权及调用最终结果在同一个 SQLite 事务提交；事件写入失败会全部回滚。

模型可通过 `read_mcp_artifact` 读取当前 Run 的 UTF-8 结果，每页最多 4000 字节，检查 UTF-8 边界和内容哈希；二进制只返回元数据，不直接作为模型视觉输入。固定 Core `agent.mcp-artifact` 可为用户按页返回二进制 base64。不存在通用文件路径读取、跨 Run 附件授权或自动远程资源下载。

Core 还提供 `agent.mcp-catalogue`（一工具/页）、`agent.mcp-sessions`（20项/页）、`agent.mcp-reconcile`；管理接口加入监督器固定白名单。新的服务管理、附件查看和 Session 核对界面归 #47，本版仅打通已有任务页中的具体调用审批。

## 数据升级与边界

schema 9→10 新增 mcp_connections 与 mcp_artifacts；既有表与服务身份保留。旧 Grant 缺少 binding ID 时使用既有秘密引用的稳定摘要兼容，随后刷新保持该身份。协议与 DB 均为 10，使用独立的 0.10.0 Core 文件；不启动或升级用户现有应用实例。

另一开发分支的 Herdr schema 8/9/10 使用不同表布局，不能仅按数字当作本机 MCP 数据库。Core 在变更 journal_mode 等 PRAGMA 前拒绝 external_profiles 布局、缺失必要 MCP 表的部分布局与更高版本 DB。统一分支使用协议/DB 11 并负责后续统一迁移，本分支不尝试改写未知来源数据。

## 验收

测试只使用自有 loopback MCP/模型/OAuth 服务、临时资料和随机假凭据；未调用个人第三方服务，不在本记录披露其使用或配置。最终 243 项 Node 集成测试通过（新增 MCP Agent 32 项），20 项 Rust 工作区测试通过；Clippy all-targets `-D warnings`、Rustfmt 和全范围 Prettier 通过。Electron 基础回归 16 项、既有 Agent 6 项和新增 MCP 审批 3 项通过。

新增集成测试覆盖：三种模型协议、HTTP/SSE/stdio、同名隔离、最终参数审批、Hook ask/deny/修改/后置失败、目录及配置撤销、只读子代理、独立所属连接、父任务停止、真实孙进程心跳停止、Core 崩溃、人工核对不重放、宿主资源队列、401/到期刷新/断开身份、凭据回显、附件所有权与分页、派发门故障和附件/结果事务故障。另有真实 Electron 测试经过正式窗口、preload、监督器与 Core，验证审批展示、按钮派发一次、刷新不重放及终结连接清理。

日志与截图位于忽略目录 .tmp-troop-mcp，不发布测试数据或配置副本。命令：

```powershell
cargo test --workspace --offline --locked
cargo clippy --workspace --all-targets --offline --locked -- -D warnings
npm --prefix apps/desktop test
npm --prefix apps/desktop run format:check
npm --prefix apps/desktop run smoke:mcp-agent
```

Docker、多屏、整体 UI 重设计保持暂停。#47 管理界面和 #48 真实第三方 OAuth/服务兼容仍待单独验收。
