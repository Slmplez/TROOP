# 模型网关来源与依赖

2026-11-01。

新增网关、SSE 解析、Windows 凭据封装、会话存储、异步 Core、IPC 和 React 页面为 TROOP 独立实现；没有复制旧应用 bundle 或 Magpie 的 Go/Wails 源码。基于已发布的独立基础根提交 `156a3d5d46c0f5e610ff8d5fa128a625816f6e2b` 继续开发，不继承旧产品历史。

## 官方协议与平台依据

- [OpenAI 流式 Responses](https://developers.openai.com/api/docs/guides/streaming-responses)：按事件类型处理文本与结束，工具事件与文本区分。
- [OpenAI Chat Completions 流事件](https://developers.openai.com/api/reference/resources/chat/subresources/completions/streaming-events)：delta、结束原因、额外 usage chunk；取消/中断后可能收不到用量。
- [Anthropic 消息流](https://platform.claude.com/docs/en/build-with-claude/streaming)：message/content block 生命周期、text_delta、usage、ping 与流内错误。
- [Reqwest ClientBuilder 0.13.5](https://docs.rs/reqwest/0.13.5/reqwest/struct.ClientBuilder.html)：TLS、代理、重定向、超时和禁止重试的显式策略。
- [Windows CredWriteW](https://learn.microsoft.com/en-us/windows/win32/api/wincred/nf-wincred-credwritew)：当前用户登录会话的系统凭据集；配合 CredReadW/CredDeleteW 与对应 windows-sys 声明使用。

官方文档用于接口实现；真实提供方兼容结果与文档依据分别记录，未使用文档示例中的模型名作为产品默认。

## 新直接依赖

`reqwest 0.13.5`（json/stream/native-tls/system-proxy）、`tokio 1.53.2`、`futures-util 0.3.34`、`uuid 1.28.0`、`zeroize 1.9.1`、Windows 下的 `windows-sys 0.61.2`。完整传递版本和 checksum 在 `Cargo.lock`；Windows 使用系统 TLS/证书能力。没有关闭证书校验，没有新增必需云端服务。

Electron、React、字体与其许可证继续沿用基础版本来源记录。没有替仓库指定新的整体开源许可证；第三方许可继续保留。发布仅包含新源码、锁文件、测试及文档，排除真实凭据、数据库、二进制、node_modules、旧应用代码和所有临时验收目录。
