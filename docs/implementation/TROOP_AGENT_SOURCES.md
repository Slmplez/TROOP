# 本机 Agent 实现依据

2026-11-01。接口事实和本机/真实服务验收分开记录。

- [Claude 流事件](https://platform.claude.com/docs/en/build-with-claude/streaming)：完整接收工具参数 JSON 后再构建调用，不能把分片当成可执行请求。
- [Claude 思考内容](https://platform.claude.com/docs/en/build-with-claude/thinking)：工具回合保留完整 thinking/redacted_thinking 块与签名；本版不向界面或公开验收材料输出这些内容。
- [OpenAI Function calling](https://developers.openai.com/api/docs/guides/function-calling)：工具定义、调用身份与工具结果的回合关系。
- [Chat Completions 流事件](https://developers.openai.com/api/reference/resources/chat/subresources/completions/streaming-events)、[Responses 流事件](https://developers.openai.com/api/reference/resources/responses/streaming-events)：增量参数与完成事件。Responses 原生推理项随上下文保留，最终参数与已拼接参数不一致时拒绝执行。
- [Windows Job Objects](https://learn.microsoft.com/en-us/windows/win32/procthread/job-objects)：使用 kill-on-close 管理受管进程树；不据此承诺撤销外部服务产生的效果。
- [Job 状态查询](https://learn.microsoft.com/en-us/windows/win32/api/jobapi2/nf-jobapi2-queryinformationjobobject)与 [ActiveProcesses](https://learn.microsoft.com/en-us/windows/win32/api/winnt/ns-winnt-jobobject_basic_accounting_information)：Core 核对 Job 内活动进程归零后才交出执行资源。
- [Git 配置](https://git-scm.com/docs/git-config)：fsmonitor 和过滤器具有程序执行语义，因此 Git 查询也进入逐次审批；不自动信任仓库附带的程序。

新增依赖为 RustCrypto `sha2 0.10.9`，用于文件前置版本的 SHA-256；采用其 MIT OR Apache-2.0 许可，依赖版本及传递包固定于 Cargo.lock。Windows API 来自既有 `windows-sys 0.61.2` 的 JobObjects/Threading 功能。其余 Rust、Electron、React、字体及许可沿用既有来源记录。

发布仅包含独立 TROOP 源码、锁文件、测试和脱敏文档，不包含旧应用源码历史、用户数据库、密钥、Worker 回执、构建产物、依赖目录或暂停的 UI 草稿。未替仓库指定新的整体开源许可证。
