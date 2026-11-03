# MCP 资料库、修订与系统凭据

2026-11-03，TROOP 0.8.0。父规格 #42，实现 #44，传输基础 #43。当前完成 Core 管理接口；MCP 的 OAuth、Agent 调用、Hooks 事件及 Electron 管理页分别由 #45～#47 承接，不能将本项称为全部 MCP 完成。

## 配置与身份

ServerId 为独立 UUID，显示名称相同不混淆身份。配置保存、Agent 分配、工具禁用、启停及删除均检查 expected_revision 并生成新修订。删除保留停用墓碑与不含秘密的历史；不复活旧身份。Store 的 mcp_authorize 按当前 Agent、精确修订、enabled/deleted 与原工具名检查；正式 Run 的冻结目录和调用前复核由 #46 接线。

明确区分 stdio/windows-host、stdio/legacy-linux、http/sse/remote。Windows command/cwd 使用绝对路径，args 保持数组；Linux 配置只允许停用保存，不改写命令或路径。每库最多 64 个有效服务；默认调用超时 180 秒，启动超时 30 秒，允许显式配置。当前管理接口只管理资料，不启动命令、连接服务或调用工具；enabled 是后续执行层必须复核的开关。

env_keys/header_keys 只声明名称；值通过独立 secrets 参数写入系统凭据存储，空缺时只保留同服务当前绑定。移除名称会撤销并清理原秘密。Windows 环境键大小写冲突拒绝，header 名必须小写；保留协议头不能覆盖。为避免把认证内容放进配置，远程 URL 不接受 userinfo、fragment、query，查询参数端点需要显式改用相应服务的无查询地址。command/args、名称和路径是可见配置，不应包含秘密。

## 导入与管理协议

固定 Core 方法为 mcp.list/get/save/remove/revisions/preview/import。CoreSupervisor 使用固定白名单；尚未增加 Renderer 入口。查询分页按条数和 40KB 内容预算限制，保留可继续的 offset。

导入接受 mcpServers/servers 包裹的映射或直接服务名映射，识别 command/args/cwd/env/url/headers/type/transport/disabled/timeout_seconds。未知字段或不支持的传输拒绝，避免静默丢配置；当前不解释环境变量模板。预览只返回脱敏定义、秘密键名和摘要，不写库、不写凭据、不执行。应用导入需要原始资料与相同 location/cwd，再检查摘要并选择明确 index；新建或更新目标由用户明确指定，更新检查修订。每次只提交一项，整项事务成功或回滚。导入始终停用且未分配 Agent，启用使用单独的后续保存。

## 秘密生命周期

MCP 与模型凭据使用独立用途命名空间。SQLite 仅保存秘密引用，历史和序列化 DTO 都不含引用或值。每个新秘密使用新引用；写入前持久化清理日志，配置事务提交时激活该引用，同时登记失效旧引用。配置/历史提交失败清理新引用并保留旧绑定，异常退出后启动和下次管理操作回收未激活引用。清理失败保留日志，响应中 credential_cleanup_pending 可见，不把逻辑删除称为物理擦除。

所有 env/header 值默认作为秘密处理，每值最多 2500 UTF-8 字节。认证头拒绝控制字符；环境值不执行或插值。管理输入的秘密包装在释放时清零，不承诺清除系统或协议解析器曾经产生的全部内存副本。真实远程认证、OAuth token 和刷新仍属 #45。

## 参数验证

发现目录时先编译各工具 inputSchema，不能返回伪完整目录；调用方使用同模块 validate 校验实际参数。使用锁定的 jsonschema 0.60.2，关闭 resolve-http/resolve-file 等默认特性。支持本地引用、组合、嵌套、数值/字符串/数组约束和所选 draft 的标准语义；不以只检查 required/type 代替完整验证。

根必须为 object，Schema/参数最多 32KB；Schema 深度最多 32、节点 4096。外部引用、递归旧 draft 关键字、自定义 vocabulary、未知 format 和 Rust regex 不支持的表达式拒绝；不静默忽略这些限制。未知 annotation 的常规 JSON Schema 行为仍由验证库处理。Schema 编译与参数检查不授予调用权限；有界模型参数、任务资源预算和实际审批由 #46 承接。

依据：[jsonschema 0.60.2 官方文档](https://docs.rs/jsonschema/0.60.2/jsonschema/)。新增依赖均精确锁定，下载完成后使用离线锁定构建验证。

## 升级与验收

内部协议和 SQLite schema 为 8；schema 7→8 新增 mcp_servers/mcp_revisions/mcp_secret_gc，旧表保留，不扫描或自动导入旧配置。0.7 Core 对已升级副本拒绝打开；生产用户实例与原数据库未重启或升级。新功能使用版本号独立的 Core 二进制。

验收使用自有服务与测试凭据：CRUD、同名身份、修订冲突、重启、Agent/工具撤销、Windows vault 命名空间、孤立凭据回收、事务故障、Linux 停用、导入摘要与脱敏、路径命令不执行、非法输入、IPC 大资料分页及旧表逐行哈希比较。具体日志保存在忽略目录 .tmp-troop-mcp/，不公开测试进程外的配置或服务使用记录。

最终验证：183 项 Node 集成测试通过（含新增资料库 10 项、目录外部 Schema 拒绝 1 项），Rust 工作区 17 项测试通过；Electron 基础回归 16 项通过。离线锁定构建、Clippy workspace/all-targets `-D warnings`、Rustfmt 与全范围 Prettier 通过。桌面新增管理页未实现，因此没有将启动回归称为 MCP 管理页验收。
