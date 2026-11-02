# Skills 与工作流验收

2026-11-02，TROOP 0.6.0，Windows x64、Node 24.4.1、Rust 1.92 MSVC、Electron 42.1.0。[实现 #25](https://github.com/Slmplez/TROOP/issues/25)。

## 覆盖

- 新增 19 项真实 Core/SQLite/Windows 集成测试，使用确定性三协议 HTTP/SSE 服务；包括模型目录、正文/辅助文件工具结果、实际任务快照、子代理继承。
- 导入预览后源内容变化拒绝；CAS 编辑/删除与来源冲突不静默覆盖；版本和全部文件事务回滚；副本不修改来源，重启可用。
- Agent 关闭阻止发现、展开和强制工具调用；已开始任务删除后不能新加载。manual-only 显式调用和最长名称/旧链接匹配覆盖。
- live 新任务更新版本、旧任务保留配方和辅助文件；失效来源可见且排除，复制技能不依赖来源继续存在。
- trigger 原文与归类保留，不调度、不作为技能加载；路径穿越和真实 Windows junction 拒绝，超限清单报错。
- Unicode 续页、二进制标识、大 frontmatter/文件清单的 IPC 预算、物化文件篡改拒绝覆盖。
- 自有 PowerShell 辅助脚本只有在具体 run_command 获批后才写入专用工作区产物；导入和读取保持惰性。
- 补充输入接收后发生启停变化、使安全边界展开超限时，保留原输入和错误，不执行配方，也不使 Core 退出。

## 桌面与升级

新增 9 项 Electron 验收通过生产 Renderer/preload/main/Core：目录预览、确认导入、Agent 开关、版本编辑/历史、同 ID 冲突、Run Now 实际执行与任务跳转、新建技能、三档布局、删除/重载不重放。截图使用自有测试资料。沿用已选 framed-sheet 与字体；唯一界面问题是关闭按钮文字过淡，修正为可读的禁用态。技能页源码 lint 为 0 FAIL / 0 WARN；实际 Electron 检查与人工截图核对覆盖 1440/768/660，按现有 Windows 最小窗口约束不扩展手机设计，不宣称独立 inspect.mjs 全站审计。

schema 5→6 在两份隔离副本验证：上一轮用户备份副本和包含记忆/摘要/执行的桌面账本副本。升级前后全部 17 张既有表逐行哈希一致，新技能库为空；原始来源只读，不修改用户原库或自动重启用户实例。

最终结果：123 项集成测试（原有 104 + 新增 19）、9 项 Rust 测试、44 项 Electron 检查（原有 35 + 新增 9）通过；离线锁定构建、Clippy all-targets -D warnings、Rustfmt、Prettier 全范围检查通过。两份 schema 5→6 副本验证通过。

证据仅保存在忽略的 .tmp-troop-skills/，包含 tests.log、full-tests.log、rust-tests.log、latest-skills-smoke.json、latest-migration.json 及截图；临时资料不发布。

## 限制

没有新增真实远程模型、Hooks、MCP、调度、后台服务或 Docker 验收。资料读取不证明任意技能文本会被模型正确选择和执行；不承诺完整 YAML、网络 live source、原商业账号技能迁移或任意脚本的沙箱隔离。模型端 update_state workflow 维护保留为后续兼容任务，父规格 #24 继续开放。
