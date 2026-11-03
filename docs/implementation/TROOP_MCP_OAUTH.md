# MCP OAuth 登录、刷新与撤销

2026-11-03，TROOP 0.9.0。父规格 #42，实现 #45，承接 #44。完成 Rust OAuth 客户端和异步 Core 管理接口；MCP Agent 调用、按需自动刷新及 Electron 的外部浏览器按钮和管理页由 #46/#47 接入。

## 登录与授权绑定

仅支持 HTTP/SSE MCP 的 OAuth；stdio 继续用明确配置的环境凭据。通过受保护资源元数据发现授权服务器，兼容 MCP 401 中 Bearer resource_metadata；若列出多个服务器，必须明确选择其中一个 issuer。授权服务器元数据校验 issuer、code 和 PKCE S256，支持 RFC8414 路径及 OIDC 元数据回退。resource 必须与配置的 MCP URL 一致；不把其他服务的 token 透传过来。

支持用户自有 public client、client_secret_basic、client_secret_post。显式选择动态注册时只注册 public PKCE client，不静默申请或保存 confidential client 身份。注册结果必须匹配本次 loopback redirect。暂不管理动态客户端注册的删除，也不支持需要 initial access token 的注册流程；此时使用服务提供的自有客户端信息。

每次创建独立 127.0.0.1 随机端口监听器、state 与高熵 verifier，S256 challenge、resource 和精确 redirect 同时带入请求。回调校验方法、路径、Host、唯一 state/code；支持并检查响应 iss，元数据声明必须提供时不可省略。无效探测不消耗有效回调，最多 64 次；用户拒绝后结束流程。code 只兑换一次，不自动重发。回调页面只返回固定提示，不回显 query、code 或 token。

通过元数据得到的端点须为 HTTPS；本机 loopback HTTP 用于本机服务及测试。端点 query、userinfo、fragment、重定向和跨源 protected-resource metadata 当前拒绝；不宣称这些受限形态已兼容。授权端点仍由外部浏览器承载，Core 不提供嵌入式登录表单或自动同意授权。

## 控制接口与并发

固定 Core 方法：mcp.oauth.begin/status/cancel/refresh/disconnect。begin 绑定 ServerId、expected_revision 和 auth_revision；当前连接有凭据时先明确断开，避免新登录悄悄替换旧授权。状态不包含 token、client secret 或 vault 引用；授权 URL 只存在于当前任务内存中，完成/取消后不保留。

网络工作在后台 Task 内进行，不阻塞 Core 读取停止和状态请求；新登录/刷新最多四个并行操作，每服务只允许一个。刷新请求按同一原修订合并，不并发使用轮换刷新令牌。断开优先清除本地授权，远端撤销不占用模型流额度；整库服务上限仍为 64。当前合并范围是同一 Core，同数据目录由原有 writer lock 排他持有，不将授权库作为跨实例共享刷新服务。

HTTP 请求 15 秒，发现/注册总等待 45 秒，用户登录 5 分钟，单个回调请求 2 秒；响应最多 64 KiB。客户端注册、code 兑换、刷新、撤销均没有自动网络重试。资源 401 仅表示需恢复认证，不授权重新发送旧 tools/call；#46 接线时仍须遵守这一限制。

## 凭据与恢复

token、refresh token 和 client secret 只保存在 Windows 凭据存储。Grant 绑定 resource/issuer/client/endpoint；大令牌按 UTF-8 安全边界分块，每块 2400 字节，整份凭据最多 64 KiB，单个 token 最多 16KB。SQLite 仅保存用途绑定、状态、修订和秘密引用；公共 DTO 去掉引用。服务配置中的手动 Authorization header 与 OAuth 不能混用。

写入沿用 #44 的凭据清理日志，记录先于 vault 写入，凭据指针与授权状态事务提交；事务失败清理新引用。配置修订变化使旧授权失效，等待中的登录/刷新取消，迟到结果不保存。取消与授权服务器已产生的远端效果分别处理；本地取消或保存失败不承诺撤回服务端已经给予的同意。

刷新只接受当前 connected 授权。新 refresh token 替换旧值，未返回新 refresh token 时保留原值；有效 scope 不能超过原请求范围。invalid_grant 标记 reauth_required；通信错误、服务器失败、取消或中断标记 refresh_uncertain，禁止自动再次使用旧轮换令牌，需要断开并重新连接。

断开先事务移除本地凭据引用，再尝试撤销 refresh/access token。状态区分 confirmed、unsupported、unknown，不将本地清理冒充服务端撤销。程序退出或崩溃时不重放未完成请求；重启后的 authorizing/refreshing/revoking 分别变成 interrupted/refresh_uncertain/revocation_unknown，旧监听器不重建。协议/schema 为 9，新增 mcp_oauth；schema 8 升级不自动连接服务。

## 验收范围

自有授权服务器覆盖：public/confidential 客户端、动态注册、S256/resource/issuer、错误及重复回调参数、scope 拒绝、长令牌分块、刷新合并、取消/配置变化、进程异常退出、撤销中断、SQLite 提交失败、并发容量、独立 ping 和升级保留。浏览器导航由自有 HTTP 夹具模拟，真实 loopback TCP/HTTP、Core、SQLite 和 Windows vault 参与验证；不冒充第三方登录或实际浏览器按钮验收。

真实第三方 OAuth 兼容本项为 not_run：未使用个人账号或注册真实 OAuth 应用，未发送真实第三方授权请求。客户端注册策略、实际 refresh/revoke 和浏览器交互由 [#48](https://github.com/Slmplez/TROOP/issues/48) 保留独立验收门槛。当前使用随机 loopback 端口，服务要求固定端口或其他 redirect 形式时不能据此认定兼容。

协议来源：[MCP 2025-06-18 Authorization](https://modelcontextprotocol.io/specification/2025-06-18/basic/authorization)、[原生应用 OAuth RFC8252](https://www.rfc-editor.org/rfc/rfc8252)、[撤销 RFC7009](https://www.rfc-editor.org/rfc/rfc7009)。

最终结果：新增 28 项 OAuth 集成测试，完整 Node 回归 211/211 通过；Rust 工作区 19 项、Electron 基础 16 项通过。离线锁定构建、workspace/all-targets Clippy `-D warnings`、Rustfmt、Prettier 均通过。记录在忽略目录 .tmp-troop-mcp/oauth-\*.log；生产用户实例与原数据库未重启或升级。

## 0.10.2 令牌兼容修正

访问令牌按不透明值处理，原样保存和发送，不解码、不规范化，也不假定其标点符合 Base64。可接受非空、最多 16KB 的可见 ASCII 非空白内容；空格、制表符、换行、控制字符及非 ASCII 内容仍拒绝，拒绝时不持久化凭据。该规则用于兼容可安全放入 HTTP Authorization 请求头的服务令牌，并非宣称扩展后的字符集合符合 RFC6750 的 b64token 语法。

新增自有服务回归验证带标点令牌的登录、同 Grant 刷新及实际 MCP 请求，并验证四类不安全输入不会入库。完整 Node 回归 259 项、Rust 20 项、Electron 管理页 10 组通过；Clippy all-targets `-D warnings`、Rustfmt 和 Prettier 通过。协议和数据库版本保持 10。以上只证明自有服务兼容，真实第三方与默认浏览器验收继续由 #48 单独记录。
