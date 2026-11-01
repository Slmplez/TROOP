# 模型网关与流式对话验收

2026-11-01；版本 0.2.0；[任务 #14](https://github.com/Slmplez/TROOP/issues/14)。Windows x64，Node 24.4.1 / npm 11.4.2 / Rust 1.92.0 MSVC / Electron 42.1.0。

## 证据范围

| 检查 | 本轮结果 |
| --- | --- |
| Rust 单元测试 | 7 项：SSE 字节分片/CRLF/多行与超限、endpoint 校验、协议字段/ID、未来 schema 拒绝、v1→v2 迁移并保留对话 |
| Node 集成 | 29 项：原基础回归 + 真实 Rust/SQLite/HTTP/SSE/Windows 凭据测试 |
| Electron 冒烟 | 16 项：真实窗口/固定 IPC/Core/SQLite/托盘/正式入口，新增表单配置、部分输出、历史重载、停止、重新提问不自动发送及活动生成期间退出 |
| Clippy / 格式 | workspace/all-targets `-D warnings`，Rustfmt 与 Prettier |
| 界面 | 实际 Electron 两页面 × 1440 / 768 / 390 宽度测量、截图检查；静态 app lint 无 FAIL/WARN |

网络测试是由本机 Node HTTP 服务提供的确定性 SSE，而非预置到 Renderer 的文字：请求真实经过 Rust HTTP 客户端、协议适配、流解析、Core 持久化、IPC 和 React。三协议分别验证文本分片、上下文、结束与基本用量；本轮没有调用商业模型或使用真实用户 API key，不能据此声称任意提供方/模型已实测兼容。

## 故障与秘密检查

- 部分文本后取消：控制请求继续响应、网络连接关闭、保留文本且不接收迟到结果。
- Core 杀死后重启：未完成回合为 interrupted，不自动请求模型；已有消息保留。
- 同 client turn ID 重复提交：返回同一回合，HTTP 请求计数不增加；内容变化拒绝。
- 坏 SSE、超大事件、断流、401、429、重定向、流内错误、工具输出和空闲超时：状态明确失败，一次请求，不重放。
- 一会话单流、全局四流；长回复分页不超 IPC 帧；达到模型输出限额保留 incomplete。
- Windows Credential Manager 使用随机的自有假密钥，验证出站认证；服务端回显密钥的错误正文被舍弃；公共 DTO 与 SQLite/其日志文件扫描不含假密钥。测试按 provider 清理其自有凭据，不枚举其他凭据。
- 独占的 `core.lock` 不纳入数据库内容扫描；读取该锁被 Windows 拒绝是预期的排他行为。
- 旧代际通知被主进程拒绝，不能注入 Renderer；旧进程 close 不破坏新进程状态。
- 界面退出期间的活动 turn 在 Core 正常关闭后重新打开验证为 cancelled；检查无所属 Core 孤儿写入者。

## 界面与运行限制

沿用 framed-sheet（原 seed 2014131340）、IBM Plex Sans + 本机中文回退、TROOP 标记、浅灰绿外框。新增页面的问题分别为“使用哪个模型服务”和“此对话说了什么/是否仍在生成”。采用同一真实 HTTP 测试服务生成检查用消息，产品不预填这些数据。

技能的原始 probe/judge 函数运行在实际 Electron Renderer 内。测量 0 FAIL；保留一个 panel-void WARN：短对话在全高、可增长的消息滚动区留下空白，底部固定输入区是实际操作布局，不以模拟消息填满。窄窗口收起历史列表为选择器；390px 为布局压力测试，未新增多屏、DPI 或移动平台验收。

原始报告和截图在忽略的 `.tmp-troop-bootstrap/`，本轮 HTTP 测试配置在 `.tmp-troop-chat/`。这些目录不进入源码分支。原生目录选择器仍由自有夹具替换；新删除确认的业务拒绝/执行路径有 Core 验证，未宣称所有原生系统对话框均已人工操作。

尚需用户在新版“模型”页填写所选服务地址、协议、模型 ID 和密钥，才能进行指定真实提供方的兼容验收。应在应用内输入密钥，不需要发送到开发聊天。没有签名安装包或干净机器验收；Agent/记忆/Skills/MCP 与 Docker 不在本次结果内。
