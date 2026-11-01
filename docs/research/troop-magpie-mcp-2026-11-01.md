# TROOP：Magpie MCP 设计研究

日期：2026-11-01。固定源码：`yetone/magpie@1fac66c06d11de9e4232270862da0fa0a3ad90f6`。方法：GitHub 插件读取固定提交的第一方源码、文档及测试；没有下载执行代码、安装软件、运行上游测试或连接真实 MCP 服务。

## 结论与适用边界

可借鉴 Magpie 的服务配置编辑、连接诊断、工具目录和禁用控制、OAuth 生命周期、惰性连接及有界等待。应在 Rust Core 实现 TROOP 自己的 MCP 客户端与 ToolInvocation 账本，由 Electron 提供配置和系统密钥 broker。Magpie 是把多个现有 Agent 接到共同配置、认证和网关的产品；其多 Agent 配置同步和共享 MCP 路由不是 TROOP 必须继承的结构。下文“借鉴/改造/不采用”均为研究建议，未修改迁移方案或形成新的已确认决策。

本研究遵守父任务的当前范围：保留 Grok Bot 行为，只有已明确确认的 Windows 宿主 stdio/Hook、错过 cron 跳过与手动补跑、DST 一次/跳过、导入技能可本地管理等变化例外；Docker 工作暂停。MCP 研究不替代这些其他能力的规格或验证。已读本仓库 AGENTS.md、domain.md、GLOSSARY.md、迁移方案及 ADR-0001～0004；“结果不明”沿用 GLOSSARY.md，不能把超时直接当作无副作用失败。

## 1. 配置与用户入口

| 项目 | 固定源码事实 | TROOP 建议 |
| --- | --- | --- |
| 服务模型 | Server 分别保存 stdio 的 command/args/env、HTTP/SSE 的 URL/headers、Agents、DisabledTools、OAuth app、StartupTimeout、Local 和 Hub 策略。[internal/library/mcp.go:31–84](https://github.com/yetone/magpie/blob/1fac66c06d11de9e4232270862da0fa0a3ad90f6/internal/library/mcp.go#L31-L84) | 借鉴结构化配置，加入稳定 ServerId、执行目标、工作目录和秘密引用；不得仅用显示名称作凭据/连接身份。 |
| 编辑与导入 | UI 支持命令及参数、环境变量、URL、headers；只为 http 提供集中 OAuth 登录；可粘贴若干常见 JSON 容器格式并规范化成内部服务。[internal/gui/assets/plugins/library/client.js:2572–2601](https://github.com/yetone/magpie/blob/1fac66c06d11de9e4232270862da0fa0a3ad90f6/internal/gui/assets/plugins/library/client.js#L2572-L2601) [internal/gui/assets/plugins/library/client.js:2735–2758](https://github.com/yetone/magpie/blob/1fac66c06d11de9e4232270862da0fa0a3ad90f6/internal/gui/assets/plugins/library/client.js#L2735-L2758) | 借鉴“表单 + 粘贴配置”，导入后展示目标、凭据和将执行命令的预览；导入不是执行授权。 |
| 超时字段 | StartupTimeout 注释明确仅写入 Codex 的 startup_timeout_sec，0 留给该 Agent 默认；UI 有对应说明。它不是 Magpie 路由全局可调工具时限。[internal/library/mcp.go:50–53](https://github.com/yetone/magpie/blob/1fac66c06d11de9e4232270862da0fa0a3ad90f6/internal/library/mcp.go#L50-L53) [internal/gui/assets/plugins/library/client.js:2760–2771](https://github.com/yetone/magpie/blob/1fac66c06d11de9e4232270862da0fa0a3ad90f6/internal/gui/assets/plugins/library/client.js#L2760-L2771) | 改造为 Core 的连接、发现、调用、停止各阶段独立预算，避免把某个外部 Agent 的字段搬成产品语义。 |
| 工具开关 | UI 显示工具名、说明、开关、重新检查；提示无法按工具禁用的外部 Agent 仍会收到全部工具。[internal/gui/assets/plugins/library/client.js:2167–2229](https://github.com/yetone/magpie/blob/1fac66c06d11de9e4232270862da0fa0a3ad90f6/internal/gui/assets/plugins/library/client.js#L2167-L2229) | 借鉴可见目录和重新检查；TROOP 自有运行时必须统一强制禁用，不应出现界面禁用而运行时仍执行。 |

诊断使用 CheckServers，最多四个服务并发检查；缓存与配置/认证有关，取消的页面检查不作为新结果写入，超时不缓存以便下次再查。检查初始化声明 MCP 2025-06-18，能力为空；诊断目录最多保留 500 个工具、描述 500 字符、最多 10 页。这里的“可连接/可发现”不证明真实工具业务成功。[internal/library/mcp_check.go:90–94](https://github.com/yetone/magpie/blob/1fac66c06d11de9e4232270862da0fa0a3ad90f6/internal/library/mcp_check.go#L90-L94) [internal/library/mcp_check.go:135–188](https://github.com/yetone/magpie/blob/1fac66c06d11de9e4232270862da0fa0a3ad90f6/internal/library/mcp_check.go#L135-L188) [internal/library/mcp_check.go:305–329](https://github.com/yetone/magpie/blob/1fac66c06d11de9e4232270862da0fa0a3ad90f6/internal/library/mcp_check.go#L305-L329)

## 2. 三种传输与进程归属

- stdio：hub 启动受控进程树，发送 initialize/initialized 后复用连接。startServer 展开环境变量，缺失时报错；本机继承环境，默认 cwd 固定为 home，接 stderr 尾部。它没有按会话项目 cwd 自动隔离。[internal/library/mcp_hub.go:632–662](https://github.com/yetone/magpie/blob/1fac66c06d11de9e4232270862da0fa0a3ad90f6/internal/library/mcp_hub.go#L632-L662) [internal/library/mcp_check.go:540–623](https://github.com/yetone/magpie/blob/1fac66c06d11de9e4232270862da0fa0a3ad90f6/internal/library/mcp_check.go#L540-L623)
- Streamable HTTP：保存会话 ID/协议版本，POST 接受 JSON 或 SSE 响应；结束时带 session ID 发 DELETE，最长 3 秒。[internal/library/mcp_check.go:790–833](https://github.com/yetone/magpie/blob/1fac66c06d11de9e4232270862da0fa0a3ad90f6/internal/library/mcp_check.go#L790-L833) [internal/library/mcp_check.go:838–955](https://github.com/yetone/magpie/blob/1fac66c06d11de9e4232270862da0fa0a3ad90f6/internal/library/mcp_check.go#L838-L955)
- 旧 HTTP+SSE：先 GET text/event-stream，等待 endpoint 事件，再向该地址 POST，读取 message 事件。连接启动预算与长连接生命周期分开。[internal/library/mcp_hub.go:856–941](https://github.com/yetone/magpie/blob/1fac66c06d11de9e4232270862da0fa0a3ad90f6/internal/library/mcp_hub.go#L856-L941)
- 分发明确区分 stdio、sse，其余走 HTTP。当前集中 OAuth token 注入只在 Transport == http 时发生；不能据此说 SSE 已有同等 OAuth 自动刷新。SSE 可以有配置 headers。[internal/library/mcp_hub.go:632–645](https://github.com/yetone/magpie/blob/1fac66c06d11de9e4232270862da0fa0a3ad90f6/internal/library/mcp_hub.go#L632-L645) [internal/library/mcp_check.go:735–752](https://github.com/yetone/magpie/blob/1fac66c06d11de9e4232270862da0fa0a3ad90f6/internal/library/mcp_check.go#L735-L752)

建议保留 Grok Bot 需要的传输兼容，Rust Core 管理所有连接；明确 Windows 宿主 stdio 的授权、cwd、环境白名单/秘密引用和进程树归属。Magpie 的 home cwd、继承全部环境不能直接复制为 TROOP 的任务权限模型。恢复连接仅恢复通信，不能自动续跑已有副作用调用。

## 3. 发现、名字、禁用和资源/提示词

hub 并行发现服务工具，按 Agent 选择服务；公共 endpoint 的 Agent ID 为空，服务范围是整个 Library，包含未勾选任何 Agent 的共享服务。工具在列表和实际调用两处检查 DisabledTools。[internal/library/mcp_hub.go:183–261](https://github.com/yetone/magpie/blob/1fac66c06d11de9e4232270862da0fa0a3ad90f6/internal/library/mcp_hub.go#L183-L261)

工具名构造成 `<server>__<tool>`，最多 64 字符，冲突加 `_2` 等后缀。**源码将不安全字符换成连字符 `-`**；该提交文档表格称换成 `_`，应以代码为准。列表复制原工具 spec，缺省补 object inputSchema。[internal/gateway/hub_mcp.go:145–162](https://github.com/yetone/magpie/blob/1fac66c06d11de9e4232270862da0fa0a3ad90f6/internal/gateway/hub_mcp.go#L145-L162) [internal/gateway/hub_mcp.go:197–220](https://github.com/yetone/magpie/blob/1fac66c06d11de9e4232270862da0fa0a3ad90f6/internal/gateway/hub_mcp.go#L197-L220) [docs/subsystems/mcp-router.md:1–25](https://github.com/yetone/magpie/blob/1fac66c06d11de9e4232270862da0fa0a3ad90f6/docs/subsystems/mcp-router.md#L1-L25)

后端分页 tools/list 最多沿用 maxToolPages；缓存目录，stdio/SSE 收到 notifications/tools/list_changed 使下次重新读取。HTTP 这条连接实现是逐 POST 读响应，没有在 httpConn 中实现对应常驻通知订阅。不要把文档笼统“服务器通知使缓存失效”外推成所有传输都覆盖。[internal/library/mcp_hub.go:522–569](https://github.com/yetone/magpie/blob/1fac66c06d11de9e4232270862da0fa0a3ad90f6/internal/library/mcp_hub.go#L522-L569) [internal/library/mcp_hub.go:738–764](https://github.com/yetone/magpie/blob/1fac66c06d11de9e4232270862da0fa0a3ad90f6/internal/library/mcp_hub.go#L738-L764) [internal/library/mcp_hub.go:945–1006](https://github.com/yetone/magpie/blob/1fac66c06d11de9e4232270862da0fa0a3ad90f6/internal/library/mcp_hub.go#L945-L1006)

**聚合 hub 只公开 tools**：initialize 仅声明 tools，支持 ping/tools/list/tools/call，其他方法 -32601，没有 resources/prompts API。后端主动请求也仅处理 ping，其余拒绝；不是完整 MCP 双向客户端（例如 sampling/elicitation）。[internal/gateway/hub_mcp.go:174–248](https://github.com/yetone/magpie/blob/1fac66c06d11de9e4232270862da0fa0a3ad90f6/internal/gateway/hub_mcp.go#L174-L248) [internal/library/mcp_hub.go:738–759](https://github.com/yetone/magpie/blob/1fac66c06d11de9e4232270862da0fa0a3ad90f6/internal/library/mcp_hub.go#L738-L759)

这不能外推成 Magpie 所有路径都移除资源/提示词：认证代理 /mcp/<server> 是保持 HTTP 方法、会话头与正文的透明转发，另一条 stdio→HTTP 桥有独立实现。[internal/gateway/mcp.go:57–62](https://github.com/yetone/magpie/blob/1fac66c06d11de9e4232270862da0fa0a3ad90f6/internal/gateway/mcp.go#L57-L62) [internal/gateway/mcp.go:104–123](https://github.com/yetone/magpie/blob/1fac66c06d11de9e4232270862da0fa0a3ad90f6/internal/gateway/mcp.go#L104-L123) [internal/library/mcp_run.go:577–600](https://github.com/yetone/magpie/blob/1fac66c06d11de9e4232270862da0fa0a3ad90f6/internal/library/mcp_run.go#L577-L600)

TROOP 应借鉴“稳定原名 + 显示命名空间 + 调用前禁用复核”，使用持久 ServerId/ToolId 避免目录增删导致冲突后缀改变身份。资源与提示词是否为 Grok Bot 当前承诺能力必须按原行为清单确定；不能因为 Magpie hub 没有便删去。MCP 工具元数据不能自动成为本机执行授权。

## 4. OAuth、密钥与并发刷新

mcpauth 注释及实现包含受保护资源/授权服务器发现、动态客户端注册、PKCE S256、state、resource；支持用户自有 OAuth app，回调监听 127.0.0.1，动态端口或指定端口。登录回调核验 state，重复回调不再兑换；取消和保存由 flow 锁裁定，取消已完成后不会再保存。[internal/mcpauth/mcpauth.go:1–14](https://github.com/yetone/magpie/blob/1fac66c06d11de9e4232270862da0fa0a3ad90f6/internal/mcpauth/mcpauth.go#L1-L14) [internal/mcpauth/mcpauth.go:831–937](https://github.com/yetone/magpie/blob/1fac66c06d11de9e4232270862da0fa0a3ad90f6/internal/mcpauth/mcpauth.go#L831-L937) [internal/mcpauth/mcpauth.go:963–981](https://github.com/yetone/magpie/blob/1fac66c06d11de9e4232270862da0fa0a3ad90f6/internal/mcpauth/mcpauth.go#L963-L981)

凭据记录包含 access/refresh/clientSecret 等，JSON 序列化到 mcp-signins.json，并保留上一良好版本；文件用 0600、目录 0700，原子写入。有跨进程文件锁避免认证文件更新覆盖。**这是文件权限与原子性，不是系统密钥库或加密存储的证据**；Windows ACL 效果未在本研究测试。用户 OAuth app 的 clientSecret 还存在 Server 配置模型中，不能仅把 token 文件迁到密钥库便认为所有秘密已处理。[internal/mcpauth/mcpauth.go:103–176](https://github.com/yetone/magpie/blob/1fac66c06d11de9e4232270862da0fa0a3ad90f6/internal/mcpauth/mcpauth.go#L103-L176) [internal/library/mcp.go:76–84](https://github.com/yetone/magpie/blob/1fac66c06d11de9e4232270862da0fa0a3ad90f6/internal/library/mcp.go#L76-L84)

Token 到期前两分钟刷新；每服务进程内锁及跨进程续期锁，刷新前重读以避免重复使用轮换 refresh token；写回时校验 access token 仍是原版本，避免覆盖期间的重新登录/退出。无 refresh token 或永久拒绝会标 dead，临时错误返回。[internal/mcpauth/mcpauth.go:61–65](https://github.com/yetone/magpie/blob/1fac66c06d11de9e4232270862da0fa0a3ad90f6/internal/mcpauth/mcpauth.go#L61-L65) [internal/mcpauth/mcpauth.go:274–352](https://github.com/yetone/magpie/blob/1fac66c06d11de9e4232270862da0fa0a3ad90f6/internal/mcpauth/mcpauth.go#L274-L352)

HTTP 请求被 401 拒绝后刷新并重发一次，再次拒绝标记凭据失效；认证代理也有相同一次刷新重发。[internal/library/mcp_check.go:838–866](https://github.com/yetone/magpie/blob/1fac66c06d11de9e4232270862da0fa0a3ad90f6/internal/library/mcp_check.go#L838-L866) [internal/gateway/mcp.go:125–139](https://github.com/yetone/magpie/blob/1fac66c06d11de9e4232270862da0fa0a3ad90f6/internal/gateway/mcp.go#L125-L139)

建议借鉴状态机、单次登录、多调用刷新合并、过期/临时失败区分和取消提交规则；用 Electron 系统密钥 broker 保存用途绑定的秘密，Core 保留引用与版本，renderer 不持久化 token。禁止照搬明文配置秘密/多份 lastgood token 文件。刷新并不授予新的工具权限，退出登录必须使缓存凭据代际失效。

## 5. 取消、重连与超时

| 固定源码行为 | 对 TROOP 的影响 |
| --- | --- |
| hub 列表预算 40 秒、调用预算 50 秒；后端连接启动 stdio 30 秒、远程 60 秒。后端 connect 启动使用独立 context，调用者取消后可继续建连供下次使用。[internal/gateway/hub_mcp.go:118–124](https://github.com/yetone/magpie/blob/1fac66c06d11de9e4232270862da0fa0a3ad90f6/internal/gateway/hub_mcp.go#L118-L124) [internal/library/mcp_hub.go:405–460](https://github.com/yetone/magpie/blob/1fac66c06d11de9e4232270862da0fa0a3ad90f6/internal/library/mcp_hub.go#L405-L460) [internal/library/mcp_check.go:80–87](https://github.com/yetone/magpie/blob/1fac66c06d11de9e4232270862da0fa0a3ad90f6/internal/library/mcp_check.go#L80-L87) | 借鉴有界等待；授权撤销时不能让晚到启动绕过新的权限检查。工具时限需按实际工具配置，不能所有业务统一 50 秒。 |
| stdio/SSE ask 的 context 结束会异步发送 notifications/cancelled，最多再等 5 秒；返回“未及时回答”，连接继续可用。[internal/library/mcp_hub.go:767–803](https://github.com/yetone/magpie/blob/1fac66c06d11de9e4232270862da0fa0a3ad90f6/internal/library/mcp_hub.go#L767-L803) | 取消通知只是请求停止，不能证明远端已停止或未产生副作用；需 ToolInvocation 状态及结果不明。 |
| 死连接下次调用重新连接；无调用 10 分钟结束连接，目录缓存保留；关闭 hub、修改服务、停机结束连接。[internal/library/mcp_hub.go:58–75](https://github.com/yetone/magpie/blob/1fac66c06d11de9e4232270862da0fa0a3ad90f6/internal/library/mcp_hub.go#L58-L75) [internal/library/mcp_hub.go:408–426](https://github.com/yetone/magpie/blob/1fac66c06d11de9e4232270862da0fa0a3ad90f6/internal/library/mcp_hub.go#L408-L426) [internal/library/mcp_hub.go:472–529](https://github.com/yetone/magpie/blob/1fac66c06d11de9e4232270862da0fa0a3ad90f6/internal/library/mcp_hub.go#L472-L529) | 借鉴惰性连接和受控回收，按 TROOP 所属进程管理，不结束用户原有进程。 |
| HTTP 会话收到 404 且有旧 session，会重新 initialize 并重发原方法一次；401 刷新也重发原正文。[internal/library/mcp_hub.go:965–1001](https://github.com/yetone/magpie/blob/1fac66c06d11de9e4232270862da0fa0a3ad90f6/internal/library/mcp_hub.go#L965-L1001) [internal/library/mcp_check.go:848–862](https://github.com/yetone/magpie/blob/1fac66c06d11de9e4232270862da0fa0a3ad90f6/internal/library/mcp_check.go#L848-L862) | 必须改造：不能把重新建连与重放有副作用 tools/call 捆绑。应区分明确未接纳、幂等请求和结果不明，避免重复创建/发送。 |

静态所见 HTTP 调用靠 HTTP request context 中止等待；httpConn.ask 路径未显示发送 MCP notifications/cancelled。没有找到持久 ToolInvocation 账本、幂等键或副作用核对是此 hub 的契约，不能将 Magpie 的网络恢复作为 TROOP Execution Reconciliation 的替代。

## 6. MCP router 与模型网关的关系

Magpie 可选 router 把外部 Agent 原有多个 MCP 条目改成一个 Streamable HTTP endpoint；默认关闭，关闭时还原各服务条目。direct 策略保留独立条目，适合依赖 cwd 或会话状态的服务器；后端池按服务名共享，不是按 Run/工作区分池。[internal/library/mcp_hub.go:55–107](https://github.com/yetone/magpie/blob/1fac66c06d11de9e4232270862da0fa0a3ad90f6/internal/library/mcp_hub.go#L55-L107) [internal/library/mcp.go:63–68](https://github.com/yetone/magpie/blob/1fac66c06d11de9e4232270862da0fa0a3ad90f6/internal/library/mcp.go#L63-L68) [internal/library/mcp_hub.go:341–362](https://github.com/yetone/magpie/blob/1fac66c06d11de9e4232270862da0fa0a3ad90f6/internal/library/mcp_hub.go#L341-L362)

认证代理 /mcp/<name>、stdio 桥 /mcp/run/<name>、聚合 router /mcp/magpie/hub 是不同路径。stdio 桥要求 local、无 Origin、loopback Host；认证代理允许受控制的局域网共享并替换 Authorization。聚合 router 的公共 URL 可供有网关权限的调用者访问全部共享 Library 服务，这比每个内部 Agent 的勾选范围大。[internal/gateway/mcp.go:42–75](https://github.com/yetone/magpie/blob/1fac66c06d11de9e4232270862da0fa0a3ad90f6/internal/gateway/mcp.go#L42-L75) [internal/gateway/mcp.go:104–123](https://github.com/yetone/magpie/blob/1fac66c06d11de9e4232270862da0fa0a3ad90f6/internal/gateway/mcp.go#L104-L123) [internal/library/mcp_hub.go:183–197](https://github.com/yetone/magpie/blob/1fac66c06d11de9e4232270862da0fa0a3ad90f6/internal/library/mcp_hub.go#L183-L197)

router 和模型网关共用 HTTP 宿主及日志/限流设施，但模型访问与 MCP 调用不应混为一项工具执行语义。TROOP 当前是自己运行 Agent 的 Rust Core + Electron，不需要为了复用 Magpie 而引入所有外部 Agent 配置写入、LAN 共享、模型中继或 plugin host。默认不采用“一个共享进程服务所有工作区”和“公共入口服务全部配置”的边界；若以后需要对外提供 MCP，另行明确授权范围及会话隔离。

## 7. 测试证据与未验证部分

本研究只读测试源码，没有运行这些测试，也没有查询得到这份提交全部测试的成功记录。

| 已读测试代码 | 覆盖意图与证据上限 |
| --- | --- |
| [internal/library/mcp_hub_test.go:51–138](https://github.com/yetone/magpie/blob/1fac66c06d11de9e4232270862da0fa0a3ad90f6/internal/library/mcp_hub_test.go#L51-L138) | fake stdio + httptest HTTP 验证关闭、Agent 范围、工具禁用、多个 Agent 共享 PID、无 Agent 服务可经公共入口调用。 |
| [internal/library/mcp_hub_test.go:143–216](https://github.com/yetone/magpie/blob/1fac66c06d11de9e4232270862da0fa0a3ad90f6/internal/library/mcp_hub_test.go#L143-L216) | fake 服务退出、永不回答、超时后仍复用、短 idle 后重启及目录缓存；不证明真实服务器能正确取消。 |
| [internal/library/mcp_check_test.go:141–155](https://github.com/yetone/magpie/blob/1fac66c06d11de9e4232270862da0fa0a3ad90f6/internal/library/mcp_check_test.go#L141-L155) [internal/library/mcp_check_test.go:302–315](https://github.com/yetone/magpie/blob/1fac66c06d11de9e4232270862da0fa0a3ad90f6/internal/library/mcp_check_test.go#L302-L315) [internal/library/mcp_check_test.go:373–386](https://github.com/yetone/magpie/blob/1fac66c06d11de9e4232270862da0fa0a3ad90f6/internal/library/mcp_check_test.go#L373-L386) | stdio/HTTP/SSE 检查的模拟场景；不是真实第三方服务兼容矩阵。 |
| [internal/gateway/hub_mcp_test.go:93–109](https://github.com/yetone/magpie/blob/1fac66c06d11de9e4232270862da0fa0a3ad90f6/internal/gateway/hub_mcp_test.go#L93-L109) [internal/gateway/hub_mcp_test.go:273–281](https://github.com/yetone/magpie/blob/1fac66c06d11de9e4232270862da0fa0a3ad90f6/internal/gateway/hub_mcp_test.go#L273-L281) | fakeHub 的路由/防护测试；不是 gateway→真实 MCP→外部副作用的集成证明。 |
| [internal/mcpauth/mcpauth_test.go:129–166](https://github.com/yetone/magpie/blob/1fac66c06d11de9e4232270862da0fa0a3ad90f6/internal/mcpauth/mcpauth_test.go#L129-L166) [internal/mcpauth/mcpauth_cancel_test.go:36–52](https://github.com/yetone/magpie/blob/1fac66c06d11de9e4232270862da0fa0a3ad90f6/internal/mcpauth/mcpauth_cancel_test.go#L36-L52) | 模拟授权服务的刷新和取消测试意图；不证明 Windows 密钥安全或真实供应商长期刷新稳定。 |

TROOP 开发验收应补：原 Grok Bot 的配置/工具显示和禁用行为对照；Windows 宿主 stdio 进程树、cwd/环境隔离及关机清理；真实 HTTP/SSE 服务的协议和认证兼容；工具结果/附件透传；取消前后副作用核对；401/404 不安全重放；目录更新与缓存；权限撤销/退出登录竞态；锁定/托盘退出对受影响任务的行为。测试必须按观察证据报告，不能用测试数量或源码接线宣称生产成熟。
