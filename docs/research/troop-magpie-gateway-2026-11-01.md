# TROOP 借鉴 Magpie 网关：固定版本源码研究

日期：2026-11-01。对象：yetone/magpie，提交 `1fac66c06d11de9e4232270862da0fa0a3ad90f6`。方法：通过 GitHub connector 读取固定提交的文档和 Go 源码；未安装依赖、未运行上游程序、未用真实凭据或发模型请求。下述“有实现”均为静态证据，不等于在 Windows 或真实供应商上已验证。许可证另由主报告核对。

## 结论与边界

Magpie 的 gateway 首先是**运行在用户机器上的模型提供方代理和协议转换层**：把 API key、订阅账户、本机模型和路由组统一成一个模型目录，接受 OpenAI、Anthropic 和 Gemini 请求。它还在同一 HTTP listener 下承载可选 MCP router、工具和诊断接口。因此“模型网关”“MCP router”“代理配置桥”“网络共享”是四种不同能力，不能只因使用同一端口就一并搬入 TROOP。[集成契约](https://github.com/yetone/magpie/blob/1fac66c06d11de9e4232270862da0fa0a3ad90f6/docs/integrating.md#L14-L42)、[MCP router](https://github.com/yetone/magpie/blob/1fac66c06d11de9e4232270862da0fa0a3ad90f6/docs/subsystems/mcp-router.md#L1-L18)

建议本期**借鉴模型边界、目录、请求尝试轨迹、提交输出后停止自动故障切换等设计，在 Rust Core 中独立实现需要的部分**。把外部 Magpie 作为用户可选 provider 也是合理选项，两者不互斥。本研究没有决定将 Magpie 作为必需组件，也没有提出替换 Core 的主任务状态机。后者与本仓库 [迁移方案](../RUST_ELECTRON_MIGRATION_PLAN.zh-CN.md) 的 Core 职责、唯一状态写入权威及 [托盘/显式退出 ADR](../adr/0003-tray-residency-and-explicit-exit.md) 必须继续一致。当前推进仅考虑 Windows 宿主；Docker 暂停是本次研究约束，不据上游支持 Docker 推导部署需求。

## 网关到底承载什么

| 能力 | 固定提交的行为 | 对 TROOP 的含义 |
|---|---|---|
| 模型入口 | 默认 `127.0.0.1:3425`；settings 的 port 可覆盖；`GET /api/hello` 标识 name/version；应用或 `magpie serve` 必须运行。 | 可在 Core 的提供方适配器中探测；不能把服务未运行当作连接成功。[来源](https://github.com/yetone/magpie/blob/1fac66c06d11de9e4232270862da0fa0a3ad90f6/docs/integrating.md#L21-L42) |
| 多协议模型服务 | `/v1/chat/completions`、`/v1/responses`、`/v1/messages` 和 count_tokens、`/v1beta/models/{model}:generateContent` / streamGenerateContent、`/v1/models`。原生协议直接透传，否则转换流、工具、图片、reasoning。 | 兼容入口不代表任意模型支持所有能力；Core 仍需能力检查、协议契约测试。[来源](https://github.com/yetone/magpie/blob/1fac66c06d11de9e4232270862da0fa0a3ad90f6/docs/integrating.md#L29-L64) |
| MCP router | 默认关闭；Streamable HTTP 路径 `/mcp/magpie/hub/<agent>`，通用路径 `/mcp/magpie/hub` 暴露整个 Library。tools/list 与 tools/call；不实现 resources/prompts。 | 这是独立 MCP 代理能力，不能当作纯模型 provider 自动启用。[来源](https://github.com/yetone/magpie/blob/1fac66c06d11de9e4232270862da0fa0a3ad90f6/docs/subsystems/mcp-router.md#L3-L18) |
| 应用桥接 | agent adapter 可改其他应用配置、生成用户确认的导入链接或调用应用本机 API；没有运行时注册 agent 的 API。 | TROOP 添加一个 Magpie provider 无需上游 adapter；在 Magpie 的 Agents 页出现才需要上游源码集成。[来源](https://github.com/yetone/magpie/blob/1fac66c06d11de9e4232270862da0fa0a3ad90f6/docs/integrating.md#L89-L132) |
| 网络访问 | 本机接口可按设置共享到网络，远端需要 gateway key；支持固定绑定地址。 | 不是 Windows 桌面远控协议。本期无需 LAN listener、隧道或远端授权面。[源码](https://github.com/yetone/magpie/blob/1fac66c06d11de9e4232270862da0fa0a3ad90f6/internal/gateway/lan.go#L27-L58)、[远端定义](https://github.com/yetone/magpie/blob/1fac66c06d11de9e4232270862da0fa0a3ad90f6/internal/gateway/lan.go#L108-L121) |

## 配置、路由与可观测性

- provider 配置拥有 URL、协议与用户 key，保存在 `providers.json`；目录返回 provider/model 或 group id、reasoning levels、context window、max output、modalities，调用方应读目录而不是内置名单。[配置](https://github.com/yetone/magpie/blob/1fac66c06d11de9e4232270862da0fa0a3ad90f6/internal/provider/provider.go#L1-L7)、[目录](https://github.com/yetone/magpie/blob/1fac66c06d11de9e4232270862da0fa0a3ad90f6/docs/integrating.md#L54-L64)
- 同一 provider 的多个 key/account 可按智能、顺序、轮转、用量、余量节奏、权重、耗尽优先等方式分配；失败者进入按原因区分的休息期。先尝试同 provider 的其他账户，再用显式 fallback 模型。[路由字段](https://github.com/yetone/magpie/blob/1fac66c06d11de9e4232270862da0fa0a3ad90f6/internal/provider/provider.go#L113-L131)、[候选顺序](https://github.com/yetone/magpie/blob/1fac66c06d11de9e4232270862da0fa0a3ad90f6/internal/gateway/fallback.go#L3-L14)、[休息期](https://github.com/yetone/magpie/blob/1fac66c06d11de9e4232270862da0fa0a3ad90f6/internal/gateway/routing.go#L3-L12)
- group 保存成员、动态匹配、路由策略、affinity、首内容时限、Patience、手动选择与规则；首内容包括文本、reasoning 或工具调用。Patience 允许无回复时重新尝试暂时失败的候选。[group 定义](https://github.com/yetone/magpie/blob/1fac66c06d11de9e4232270862da0fa0a3ad90f6/internal/provider/group.go#L167-L225)
- `X-Magpie-Session` 将会话与 route trace 关联；`/v1/magpie/route` 可长轮询，在首 token 之前展示选中的模型和 fallback；usage/quotas 有 caller 的范围限制。[集成契约](https://github.com/yetone/magpie/blob/1fac66c06d11de9e4232270862da0fa0a3ad90f6/docs/integrating.md#L66-L82)

**建议推论**：TROOP 可复用“用户意图模型 id / 实际提供方模型 / 每次尝试”分离的表示。Core 自己记录 Run 与 ToolInvocation，外部网关 trace 只作为模型尝试诊断；不得把网关会话 id 当作执行恢复记录。多账户池、分类器、订阅额度与配额更新不应成为首个 Windows 模型调用的前置条件。

## 流、取消、错误与重试

普通原则是**还没给调用方输出回复时才切换**，避免一个答案由两个模型拼接；同账户失败和跨模型 fallback 也分开。源码还包含专用的缓冲、reasoning、长流和 provider 修复路径，不能仅由原则注释承诺所有协议组合语义相同。[fallback 契约](https://github.com/yetone/magpie/blob/1fac66c06d11de9e4232270862da0fa0a3ad90f6/internal/gateway/fallback.go#L3-L14)、[holdWriter 的特殊路径](https://github.com/yetone/magpie/blob/1fac66c06d11de9e4232270862da0fa0a3ad90f6/internal/gateway/fallback.go#L2329-L2355)

取消链路从入站 `r.Context()` 派生每次尝试的 context，传给 `http.NewRequestWithContext`；发现客户端取消后记录 canceled 并退出候选循环，不再请求另一提供方。该证据支持“停止继续发送模型尝试”，不证明远端供应商已停止计费，更不证明已执行工具可回滚。[每次尝试](https://github.com/yetone/magpie/blob/1fac66c06d11de9e4232270862da0fa0a3ad90f6/internal/gateway/gateway.go#L3208-L3227)、[上游请求](https://github.com/yetone/magpie/blob/1fac66c06d11de9e4232270862da0fa0a3ad90f6/internal/gateway/gateway.go#L4845-L4853)、[取消不重试](https://github.com/yetone/magpie/blob/1fac66c06d11de9e4232270862da0fa0a3ad90f6/internal/gateway/gateway.go#L3406-L3413)

错误保持调用协议的结构；已送 HTTP 流头时只能送流内 error，context overflow 会专门映射成压缩可识别的 code/type。重试判断将 401/402/403/404/408/429/5xx 等视为其他候选可能解决的错误，但 prompt/context overflow 不在同账户间重试。短暂错误按退避和 Retry-After 再试，受最大间隔与次数约束。[流内错误](https://github.com/yetone/magpie/blob/1fac66c06d11de9e4232270862da0fa0a3ad90f6/internal/gateway/gateway.go#L8498-L8510)、[协议错误](https://github.com/yetone/magpie/blob/1fac66c06d11de9e4232270862da0fa0a3ad90f6/internal/gateway/gateway.go#L8595-L8647)、[可重试分类](https://github.com/yetone/magpie/blob/1fac66c06d11de9e4232270862da0fa0a3ad90f6/internal/gateway/fallback.go#L1615-L1647)、[退避](https://github.com/yetone/magpie/blob/1fac66c06d11de9e4232270862da0fa0a3ad90f6/internal/gateway/fallback.go#L1740-L1768)

还有更底层的自动重放：transport 为可重放请求添加不发给供应商的空 X-Idempotency-Key，让 Go 在失效 keep-alive 连接上更快重试 POST。**这不是供应商承诺的幂等键**。TROOP 不能照搬它来证明 exactly-once；外部 Magpie 模式下 Core 重试再叠加网关重试，可能增加模型费用或重复远端状态。[transport 实现](https://github.com/yetone/magpie/blob/1fac66c06d11de9e4232270862da0fa0a3ad90f6/internal/gateway/upstream_transport.go#L145-L168)。Core 应只有一份明确的重试预算，UI 可看到每次尝试；取消后不重放旧 generation。

## 认证、凭据与信任边界

本机非浏览器客户端可使用任意 token，`magpie-troop` 主要是应用身份/计量标签，**不构成本机调用方身份认证**。网络调用需要 enabled gateway key；源码先判 IP allowlist、重绑定 Host、代理/转发来源，然后识别 caller。浏览器页面另有 Origin、allowlist 与 key 检查。不能把“loopback”说成“只有 TROOP 能调用”。[token 契约](https://github.com/yetone/magpie/blob/1fac66c06d11de9e4232270862da0fa0a3ad90f6/docs/integrating.md#L44-L52)、[LAN guard](https://github.com/yetone/magpie/blob/1fac66c06d11de9e4232270862da0fa0a3ad90f6/internal/gateway/lan.go#L328-L401)、[CORS guard](https://github.com/yetone/magpie/blob/1fac66c06d11de9e4232270862da0fa0a3ad90f6/internal/gateway/cors.go#L44-L90)

provider 的 Key 字段明确序列化为 JSON，store 将整个配置 JSON marshal 后交给 writePrivate；gateway caller keys 也 JSON marshal 并以 0600 写文件。本次没有获得这些路径使用 Windows Credential Manager/DPAPI 的证据，不能声称其满足 TROOP“不静默明文落盘”要求；文件权限与静态加密是不同要求，Windows ACL 也需单独验证。[Key 字段](https://github.com/yetone/magpie/blob/1fac66c06d11de9e4232270862da0fa0a3ad90f6/internal/provider/provider.go#L65-L81)、[provider 保存](https://github.com/yetone/magpie/blob/1fac66c06d11de9e4232270862da0fa0a3ad90f6/internal/provider/provider.go#L702-L726)、[caller key 保存](https://github.com/yetone/magpie/blob/1fac66c06d11de9e4232270862da0fa0a3ad90f6/internal/access/access.go#L705-L723)

上游请求由网关新建，按需保留客户端标识 header，注释明确不转发调用方给 Magpie 的 key；仍需单独检查所有 account/plugin/redirect 路径。[新建请求](https://github.com/yetone/magpie/blob/1fac66c06d11de9e4232270862da0fa0a3ad90f6/internal/gateway/gateway.go#L4845-L4874)、[Codex header 选择](https://github.com/yetone/magpie/blob/1fac66c06d11de9e4232270862da0fa0a3ad90f6/internal/gateway/gateway.go#L4882-L4901)。静态所见的 HTTP client 只设置 Transport，没有显式 CheckRedirect；这不足以证明严格的跨源凭据禁止转发策略，TROOP 需要自己的 allowlist/redirect 测试。[client 构建](https://github.com/yetone/magpie/blob/1fac66c06d11de9e4232270862da0fa0a3ad90f6/internal/gateway/gateway.go#L545-L555)

可选 prompt masking 会替换密钥等正文再发供应商，但默认关闭；它不能替代凭据存储和日志控制。[上游说明](https://github.com/yetone/magpie/blob/1fac66c06d11de9e4232270862da0fa0a3ad90f6/README.md#L129-L147)。若只使用外部模型网关，TROOP 不应启用 MCP hub：远端 gateway key 持有人在 hub 开启时可调用 Library 的命令服务器，以本机用户权限运行。[MCP 信任边界](https://github.com/yetone/magpie/blob/1fac66c06d11de9e4232270862da0fa0a3ad90f6/docs/subsystems/mcp-router.md#L34-L41)

## 生命周期及 Windows 可行性

Magpie 支持在应用内或 `magpie serve` 中运行网关，serve 的 web 管理页是显式选项。[CLI](https://github.com/yetone/magpie/blob/1fac66c06d11de9e4232270862da0fa0a3ad90f6/internal/cli/web_cli.go#L203-L246)。但完整 gateway 启动不仅是 HTTP 代理，还启动配额/账户维护、供应商列表更新、partner 列表拉取、插件与 Bun 更新等后台循环；将整个服务直接嵌进 TROOP 会带入额外运行与联网面。[启动后台循环](https://github.com/yetone/magpie/blob/1fac66c06d11de9e4232270862da0fa0a3ad90f6/internal/gateway/gateway.go#L735-L749)

关闭网关时按 drain 时限等 HTTP 请求、单独 drain WebSocket、abort subscription、落盘 affinity，再停止 hub。普通退出 drain 是 2 秒；Unix handover 上限 15 分钟。Windows 不支持监听 socket handoff，源码退化为等待 gateway idle 后重启，不能宣称 Windows 无损滚动重启。[shutdown](https://github.com/yetone/magpie/blob/1fac66c06d11de9e4232270862da0fa0a3ad90f6/internal/gateway/gateway.go#L769-L794)、[时限](https://github.com/yetone/magpie/blob/1fac66c06d11de9e4232270862da0fa0a3ad90f6/internal/gateway/handover.go#L18-L32)、[平台限制](https://github.com/yetone/magpie/blob/1fac66c06d11de9e4232270862da0fa0a3ad90f6/internal/handoff/handoff.go#L1-L24)

Windows 可以运行桌面应用或前台 serve；项目自己的 daemon install 只支持 Linux/macOS 等 manager，Windows 明确返回 unsupported，并引导登录自启或 WSL。无需因此引入 WSL：TROOP 本期要求用户会话内托盘驻留，本来不承诺退出后继续执行。[Windows daemon](https://github.com/yetone/magpie/blob/1fac66c06d11de9e4232270862da0fa0a3ad90f6/internal/daemon/daemon.go#L56-L73)。本研究未下载可执行文件，尚未验证 native Windows 的服务发现、端口冲突、取消延迟、ACL 和退出行为。

MCP hub 的命令后端在第一次 list/call 时启动、每 server 共享一个进程，默认 home 工作目录；10 分钟空闲后结束；50 秒调用超时会留下后端运行。它没有通用 per-project/session 后端隔离，也不能被视作工具已经停止的保证。[生命周期与目录](https://github.com/yetone/magpie/blob/1fac66c06d11de9e4232270862da0fa0a3ad90f6/docs/subsystems/mcp-router.md#L10-L18)、[调用与超时](https://github.com/yetone/magpie/blob/1fac66c06d11de9e4232270862da0fa0a3ad90f6/docs/subsystems/mcp-router.md#L27-L41)。这些行为与 TROOP Task 所有权、停止及不明结果核对要求需要重新设计，不能直接充当受控工具执行器。

## 两条可选路线及架构影响

| 路线 | 实施边界 | 是否改变既有架构 |
|---|---|---|
| 借鉴设计，Rust 独立实现（建议先做） | Core 内定义 ModelProvider、能力目录、Normalized request/event、有限 fallback、带取消的每次尝试及诊断；Electron 继续做窗口/托盘/密钥 broker。先完成一个真实 provider 的流和工具契约，逐步补协议。 | 保持模型、重试、Run 与主状态归 Core；无新常驻服务、无额外 listener。需要自己的适配器和契约测试，不能继承上游兼容性声明。 |
| 外部 Magpie 可选 provider | 用户安装运行 Magpie，Core 只接 loopback provider，读取 hello/catalog，保留用户原有 providers；显式选择后服务失联就报错，不在同一回合静默换直连。 | 模型凭据、provider 路由与部分尝试状态属于 Magpie；Core 仍掌握任务状态。需要说明两层重试、实际模型可观测性、版本/能力检查与外部服务关闭语义。[上游也建议保留自有 providers](https://github.com/yetone/magpie/blob/1fac66c06d11de9e4232270862da0fa0a3ad90f6/docs/integrating.md#L85-L87) |
| 打包/强依赖 Magpie 服务 | 由 TROOP 管理 Go 二进制、升级、数据目录、端口、后台循环、凭据与可选插件。 | 明显扩大原本 Rust Core + Electron 的运行边界，需要新的 ADR/决策任务；不是“换一个 URL”。当前没有证据支持把它作为默认方案。 |

建议下一步验证用例（尚未执行）：目录变化/模型能力不匹配、流中工具参数与终止事件、首 token 前失败/输出后断流、等待期间取消、网络断开与重复 POST、端口被其他进程占用、Windows 显式退出、日志脱敏/跨源 redirect、DPAPI/ACL，以及外部 Magpie 未运行或升级后的兼容性。它们验证模型边界；宿主桌面授权与输入停止继续归 TROOP 原执行契约。
