# 本地集成、记忆与自动化设计附件

任务：[确定本地集成、记忆与自动化替代边界](https://github.com/Slmplez/TROOP/issues/8)。本目录是决策附件，任务状态只在 GitHub 维护。

**设计取舍已获用户确认。** 保持 Grok Bot 的记忆与调用机制，使用统一 Skills/MCP 资料库和按 Agent 分配；模型网关内置 Rust，外部 Magpie 可选。已完成旧版源码盘点、三份固定版本研究、必要本地替代及开发验收矩阵。正式业务模块尚未实现。

- [集成契约](CONTRACT.md)：兼容矩阵、三项本地替代、错误恢复与验收边界。
- [Magpie 采用方案](MAGPIE-ADOPTION.md)：Rust 模块设计、借鉴/改造边界及增量验收。
- [旧源码盘点记录](source-inventory.json)：本地基线源码哈希及研究状态，不代表运行验证。
- [Skills 研究](../../docs/research/troop-magpie-skills-2026-11-01.md)。
- [MCP 研究](../../docs/research/troop-magpie-mcp-2026-11-01.md)。
- [模型网关研究](../../docs/research/troop-magpie-gateway-2026-11-01.md)。

外部源码固定在 `yetone/magpie@1fac66c06d11de9e4232270862da0fa0a3ad90f6`。没有运行 Magpie、模型、MCP 或 Docker，没有读取个人配置或凭据。研究报告中的“测试覆盖”指阅读测试源码，不代表本轮执行通过。

用户已经回答的 Windows 本机入口、本地补跑/DST 规则、可管理的本地导入技能保留；Docker 操作仍暂停。本研究不自动引入其他 Agent 配置改写、账号发现、外部常驻服务或新的技术栈。
