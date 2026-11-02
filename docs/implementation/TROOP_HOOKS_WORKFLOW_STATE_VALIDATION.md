# Windows Hooks 与工作流维护验收

2026-11-02，TROOP 0.7.0，Windows x64、Node 24.4.1、Rust 1.92 MSVC、Electron 42.1.0。实现 #26/#27；父规格 #24。

## 确定性集成

新增 27 项测试：20 项 Hook 与 7 项工作流维护。三协议均使用真实 Core、SQLite、HTTP/SSE 和生产 Worker，不调用私人模型。

- 17 个已支持事件在同一实际任务树中均有成功调用证据，含真实前/后台命令、文件成功/失败、子代理和压缩；不透明推理与签名不进入 Hook 输入。
- deny 不派发写入；ask 让自动读取等待具体审批；allow 不绕过原审批，updated_input 在审批前冻结。
- fail-open/failClosed/post 错误区别，JSON stdin、附加上下文、正则、loop_limit、超时与输出上限，均核对真实状态。
- 四个 prompt Hook 共用四流额度，第五个排队；取消/配置撤销/迟到响应不套用旧结果。真实 heartbeat 验证进程树停止。
- Core 崩溃后 Hook 标为结果不明，原脚本不重放；核对后继续。Ready 提交故障时命令未获得 go，不产生幽灵文件。
- post Hook 期间新输入到达，已有成功结果不被写成“未执行”，模型收到合法的工具结果顺序。
- workflow.write/rewrite/delete 使用旧参数；并发用户编辑拒绝，辅助文件保留、live 来源不写回，资料与工具账本事务一起回滚。禁用及只读子代理不能维护共享配方。

## 桌面与升级

新增 9 项 Electron 验收：配置/范围/启停/删除、动态 ask 审批、实际停止、效果核对、历史保留、模型维护后资料库可见、Linux 停用资料、三档窗口、重载不重放。1440/768/660 宽度无横向溢出，人工核对自有截图；沿用既有 framed-sheet 与字体，仅统一新表单控件。源码 lint 0 FAIL / 0 WARN。按现有 Windows 最小窗口范围验证，不宣称独立 inspect.mjs 全站审计。

schema 6→7 的两份隔离副本比较全部 21 张旧表逐行哈希一致；包含此前用户备份副本与实际 Skills/Workflows 账本。原始来源只读，用户原始库不升级、不重启；新 Hook 库为空，不自动运行旧配置。

最终结果：150 项集成测试（原有 123 + 新增 27）、9 项 Rust 测试、53 项 Electron 检查（原有 44 + 新增 9）通过；离线锁定构建、Clippy all-targets -D warnings、Rustfmt、Prettier 全范围检查通过。新增 regex 1.13.1 使用现有离线缓存并锁定依赖。

被忽略的 .tmp-troop-hooks/ 保存 full-tests.log、new-tests.log、rust-tests.log、latest-hooks-smoke.json、latest-migration.json、截图及回执；不随源码发布。

## 公开证据范围

本报告公开自有 HTTP/SSE 夹具、Windows 进程、SQLite 与 Electron 的验证结果。其他环境的配置和运行记录不属于公开报告内容；不能将这里的三协议夹具结论等同任意第三方服务兼容。MCP、调度、长期负载和安装包不在本项验收范围。
