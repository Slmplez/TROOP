# Rust 模型网关与持久化流式对话

2026-11-01；版本 0.2.0。规范与任务的状态以 [规格 #13](https://github.com/Slmplez/TROOP/issues/13)、[实现 #14](https://github.com/Slmplez/TROOP/issues/14) 为准。沿用已确认的 #8 设计，基于 #11/#12 的独立源码基础。

## 交付范围

网关由 Rust Core 内部调用，不开放模型代理 HTTP listener，不要求独立 Magpie。用户可把已运行的 Magpie 或兼容服务配置为 endpoint。支持三个显式文本协议：

| 配置值 | 基础地址后追加的路径 | 输出 |
| --- | --- | --- |
| `chat_completions` | `/chat/completions` | `choices[0].delta.content/refusal`、结束原因、usage、`[DONE]` |
| `responses` | `/responses` | 文本/拒绝增量、completed/incomplete/failed、usage；请求 `store:false` |
| `anthropic` | `/messages` | 初始 text block、text_delta、message_delta/stop、usage；版本头 `2023-06-01` |

模型 ID 由用户填写，不内置动态模型名单。Chat Completions 默认使用 `max_completion_tokens`，可显式选择旧版 `max_tokens`；不会因服务拒绝参数自动改写并重发。当前只声明文本能力，工具请求或不支持的内容类型明确失败，不能执行 Agent 工具。

每次用户发送形成一个 turn，包含用户消息、助手文本和一次模型尝试：provider ID/revision/name、model/protocol、开始与结束时间、状态、结束原因和供应商返回的基本输入/输出 token 用量。没有用量时保留缺失，不估算账单。

## 请求与取消

- Rust 使用异步 HTTP，Core 单独读取控制消息与网络更新。每会话最多一个活动生成，全局最多四个。
- 只请求用户选定的 provider/model。一轮请求预算为一次；无自动重试、换账号或跨 provider/model fallback。
- 外部网关可能在一次 HTTP 内执行自己的路由/重试；本版本不控制或计量其内部尝试，不宣称供应商 exactly-once。用户需独立配置该网关的预算。
- 禁用 HTTP 重定向与传输层重试；默认验证 TLS。只允许 HTTPS，明确 loopback (`localhost` / `127.0.0.1` / `::1`) 可用 HTTP。基础地址不含用户信息、查询或 fragment，也不包含 API 接口后缀。
- 使用系统/环境代理；loopback 直连。连接时限 10 秒，总请求时限 600 秒，无数据时限配置为 5–300 秒（默认 60）。
- SSE 按字节组帧后解码 UTF-8，支持拆分字符、CR/LF、注释和多行 data；单事件上限 64 KiB、总接收上限 2 MB、单回复文本上限 24 KB。超过上限明确失败，保留此前接收的文本。
- 停止会撤销本任务拥有的网络 future、等待本地任务结束，再持久化取消状态。不能把客户端停止等同供应商停止计费。
- 应用显式退出取消流；控制管道 EOF 中断流；Core 崩溃后保留已落盘的部分文本，启动时将未完成回合标记 interrupted，不重新请求。
- `client_turn_id` 全局唯一；同 ID 与相同会话/provider/文本返回原 receipt，同 ID 不同内容拒绝，不会重复投递 HTTP。超时后先核对；“重新提问”只复制问题到输入框，由用户再次发送。

## 数据与凭据

SQLite schema 1→2 以事务升级，保留工作区。增加 providers、conversations、turns；Core 仍是唯一写入者。移除工作区只取消对话的关联；删除对话经原生确认移除其本机历史。

API key 使用当前用户的 Windows Credential Manager generic credential，目标为 TROOP 拥有的随机引用。不读取其他应用的凭据，不扫描账户配置。SQLite 只保存引用；provider 的公共 DTO 不返回引用或秘密。除用户主动保存时的受限 IPC 传输外，API key 不在响应、日志或模型消息中回显；服务端错误正文不转发至 Renderer/数据库。发送期间冻结配置与密钥快照；使用中的服务配置需先停止再更改/删除。

消息按游标分页，响应按序列化字节预算限制在 IPC 帧内。输入消息不超过 12000 UTF-8 字节；上下文使用本对话已完成/达到输出限制的回合，历史最多 192 KB 后要求新建对话。取消、失败、中断回合留在历史中，不隐式加入新请求。没有隐式历史裁剪或假装已压缩。

## 桌面接线

内部协议升级为 2；不兼容的旧 Core/桌面组合拒绝握手。固定 IPC 方法覆盖 provider 与 chat 操作，不暴露通用 invoke、网络请求、Shell 或任意文件接口。

`chat.changed` 通知含 generation、递增序号、会话/turn ID 和状态。主进程拒绝旧代际或倒退事件；Renderer 按通知读取 Core 的持久化消息快照，以约 100ms 通知节奏显示增量，不在 UI 再拼一份业务账本。连接状态另有递增修订，迟到的初始快照不能覆盖较新状态。

提供模型服务管理、会话创建/选择/删除/分页、按会话保留内存草稿、模型选择、增量文本、停止、错误、用量和历史恢复。窄窗口使用会话选择器，消息区独立滚动并在用户读历史时停止自动滚动。当前按纯文本呈现，Markdown 标记保留原样。

Agent 回合、工具执行、记忆、Skills、MCP、附件、富文本、历史搜索/归档、持久草稿、OAuth、多账号池与自动路由不在此次增量中。Docker 继续暂停；不以本项代替 #9/#10 的完整双环境契约和首版门禁。
