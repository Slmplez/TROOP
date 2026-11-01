# TROOP Agent 契约证据

2026-11-01。[决策任务：确定 Agent 执行状态、恢复和并发契约](https://github.com/Slmplez/TROOP/issues/4)。

主要文档：[CONTRACT.md](CONTRACT.md)。用户确认的四项取舍和实现约束、证据限制都在其中。本目录是设计与实验附件，不是生产实现或第二套任务状态。

## 文件

| 文件 | 内容 |
|---|---|
| CONTRACT.md | 执行、取消、恢复、任务归属、资源并发与跨进程契约 |
| replay.mjs / replay-results.json | 真实 Agent + 人工模型/工具的四场景回放和一次 flush 故障注入 |
| wake-replay.mjs / wake-results.json | 真实 wake 消费类 + 人工宿主服务的五场景磁盘标记回放 |

## 复现

需要原重建源码工作区，基准 Git HEAD 为 `710e2f9ee7a42f139a597ce15fc1edb66b77a350`；该次工作未改动受测生产源码。证据分支刻意只包含本目录，不携带旧源码历史或生产产物，单独克隆证据分支不能运行这些脚本。

在安装了原工作区锁定依赖（包括 esbuild）的仓库根目录，用 Node 26.5.0 执行：

```powershell
& ./offline/vendor/node/win32-x64/node.exe .scratch/troop-agent-contract/replay.mjs
& ./offline/vendor/node/win32-x64/node.exe .scratch/troop-agent-contract/wake-replay.mjs
```

脚本创建 `.tmp-agent-contract/` 临时构建/人工 marker，并更新对应 JSON。断言失败会返回非零退出码；取消场景预期是 Agent 抛出 canceled，不能把该预期取消当测试失败。所有输入为人工数据，不调用模型提供方、真实工具或个人配置；全局 fetch 被阻断。wake 临时目录每次不同。

## 观察摘要与限制

文本、工具循环、工具等待、工具取消的行为断言通过。真实 checkpoint 辅助函数吞掉人工 flush 异常；wake 消费在人工 runner 失败前已移除持久 marker，失败后此路径不自行重试。后两项是记录现有不足的观察断言，通过不等于可靠性合格。

这些实验没有验证 Rust、SQLite 提交、进程崩溃恢复、真实提供方、Shell 进程树、桌面控制或完整 UI。wake 使用真实磁盘读写，但不证明 fsync、断电耐久或全系统永久丢失。后续故障注入与端到端验收见契约第 10、12 节。
