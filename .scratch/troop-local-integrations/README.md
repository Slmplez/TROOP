# 本地集成、记忆与自动化设计附件

任务：[确定本地集成、记忆与自动化替代边界](https://github.com/Slmplez/TROOP/issues/8)。本目录是决策附件，任务状态只在 GitHub 维护。

**尚未定稿。** 用户要求记忆、Skills/Workflows/Hooks、MCP 与自动化保持 Grok Bot 机制，并追加 Magpie 的 Skills、MCP 和网关作为参考。已完成旧版源码盘点及三份固定版本 Magpie 研究，当前等待对借鉴方式和网关路线的回答。

- [契约草案](CONTRACT.draft.md)：兼容矩阵、用户已回答的三项本地替代、错误恢复与验收边界。
- [Magpie 借鉴方案](MAGPIE-ADOPTION.draft.md)：推荐的 Rust 方案、借鉴/改造边界及增量验收。
- [旧源码盘点记录](source-inventory.json)：本地基线源码哈希及研究状态，不代表运行验证。
- [Skills 研究](../../docs/research/troop-magpie-skills-2026-11-01.md)。
- [MCP 研究](../../docs/research/troop-magpie-mcp-2026-11-01.md)。
- [模型网关研究](../../docs/research/troop-magpie-gateway-2026-11-01.md)。

外部源码固定在 `yetone/magpie@1fac66c06d11de9e4232270862da0fa0a3ad90f6`。没有运行 Magpie、模型、MCP 或 Docker，没有读取个人配置或凭据。研究报告中的“测试覆盖”指阅读测试源码，不代表本轮执行通过。

用户已经回答的 Windows 本机入口、本地补跑/DST 规则、可管理的本地导入技能保留；Docker 操作仍暂停。本研究不自动引入其他 Agent 配置改写、账号发现、外部常驻服务或新的技术栈。
