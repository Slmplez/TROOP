# MCP 传输基础

2026-11-03。父规格 #42，传输任务 #43。`troop-mcp` 是独立内部库；本次没有增加应用 IPC、配置页或模型工具，不表示整个 MCP 已接入。

## 接口与责任

`Client::http` 明确选择 Streamable HTTP 或旧 HTTP+SSE；`Client::stdio` 使用宿主提供的专用 Worker 可执行文件。初始化声明 2025-06-18，接受 2024-11-05、2025-03-26、2025-06-18。支持 initialize/initialized、tools/list 分页、tools/call、ping；不声明 sampling/elicitation/resources/prompts。主动 ping 回复空结果，其余服务端请求返回 -32601，不执行额外本机代码。HTTP GET 通知订阅与流续传不在本模块当前能力内。

连接串行，不能跨任务共享可变会话。调用方负责稳定 ServerId/配置修订、凭据读取、任务归属、参数 Schema 验证、具体操作审批、目录快照与持久化账本；本库的发现和 tool call 接口不能直接暴露给 Renderer 或模型。工具列表检查对象 Schema、重名及预算，不冒充完整 JSON Schema 验证器。

HTTP 同时接受 JSON/SSE POST 响应，维护 session 和协商的协议版本头，关闭时有界 DELETE。旧 SSE endpoint 必须同源，重定向不跟随；自定义 Host/session/协议等保留头拒绝。HTTPS 为默认，明文仅允许 loopback。错误不回显服务 URL、响应正文或认证头。凭据由后续资料库模块提供，不能把内存 headers/env 配置原样持久化。

stdio 仅 Windows，command/cwd 必须绝对路径；command+args 直接启动，不拼接 Shell。独立 Worker 在启动配置命令前加入 kill-on-close Job；不继承 Job handle。子进程只继承明确列出的 Windows 执行环境及用户显式环境覆盖，不继承应用的任意环境。stderr 丢弃；stdout 只接受有界 JSON 行。父控制管道 EOF/父进程消失使 Worker 退出，整个所属 Job 终止；不控制用户既有进程。

Worker 宿主必须把 `--mcp-stdio-worker` 分派到 `worker::run()`，返回后立即退出进程。当前仅测试 harness 接线，正式 Core 待后续任务实现。进程隔离不是 OS 权限沙箱，脚本仍以当前用户权限运行。

## 失败与取消

所有调用带显式 deadline。超时尽力发送 notifications/cancelled，取消通知不证明远端停止或无副作用。HTTP 401/404、断线、错身份、超限或超时后会话失效；丢弃进行中的 request future 同样使会话失效。后续请求在本地拒绝，重连必须创建新 Client，不自动重发旧 tools/call。

tools/call 的通信错误返回 indeterminate；尚未派发或已失效会话的本地拒绝为 false。正常 MCP isError 作为工具结果保留。调用方必须提交调用前的持久化派发记录，异常后人工核对；不能将本库的错误布尔值替代执行账本。显式 close 发送仍在途调用的取消通知并关闭连接/终止所属 Worker；Drop 可终止 stdio Worker，但异步 HTTP 清理需调用方 close。

单帧/事件 64 KiB，请求参数 32KB，单响应阶段流量 2 MiB、1024 条消息；目录最多 10 页/500 个工具，游标循环拒绝。超过预算报错，不返回伪完整目录。各次连接/初始化/通知及分页请求分别使用调用方期限，目录总期限应由调用方外层任务预算约束。

## 验收与后续

新增测试使用真实库、HTTP/SSE、Windows Worker 与 Job：三传输初始化/发现/Unicode、分页、取消、错误不重发、通知、服务端能力拒绝、跨源/版本/重定向/超限、目录错误、命令参数/cwd/环境和超时/父崩溃后的孙进程 heartbeat 停止。测试不访问真实提供方，不读取用户 MCP 配置。

协议依据：[MCP 2025-06-18 transports](https://modelcontextprotocol.io/specification/2025-06-18/basic/transports)。后续仍需资料库与系统凭据、OAuth、Agent/Hooks/审批、Electron 和真实第三方兼容；保留 #42 开放。

本次结果：22 项新增传输集成测试通过，完整 Node 回归 172/172 通过；Rust 工作区 12 项测试通过（含新增 SSE 3 项）。新模块 all-targets Clippy `-D warnings`、Rustfmt 与新增文件 Prettier 检查通过。证据在忽略目录 `.tmp-troop-mcp/full-tests.log`；没有新增真实服务兼容结论，没有更新用户运行实例或原数据库。
